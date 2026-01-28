import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InventoryItem } from './schemas/inventory-item.schema';
import { StockUpdate } from './schemas/stock-update.schema';
import { ReserveStockDto } from './dto/reserve-stock.dto';
import { UpdateStockDto } from './dto/update-stock.dto';
import { LowStockEvent } from './events/low-stock.event';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StockReservation } from './schemas/stock-reservation.schema';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  private readonly CACHE_TTL = 300; // 5 minutes
  private readonly RESERVATION_TTL = 1800; // 30 minutes

  constructor(
    @InjectModel(InventoryItem.name)
    private inventoryItemModel: Model<InventoryItem>,
    @InjectModel(StockReservation.name)
    private stockReservationModel: Model<StockReservation>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @InjectQueue('stock-updates') private stockQueue: Queue,
    private eventEmitter: EventEmitter2,
  ) {}

  async getStockLevel(
    productId: string,
    warehouseId?: string,
  ): Promise<number> {
    const cacheKey = `stock:${productId}:${warehouseId || 'all'}`;
    
    try {
      // Try cache first
      const cachedStock = await this.cacheManager.get<number>(cacheKey);
      if (cachedStock !== undefined && cachedStock !== null) {
        return cachedStock;
      }

      // Build query
      const query: any = { productId, isActive: true };
      if (warehouseId) {
        query.warehouseId = warehouseId;
      }

      // Aggregate available stock
      const result = await this.inventoryItemModel.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalStock: { $sum: '$quantity' },
            reserved: { $sum: '$reserved' },
          },
        },
      ]);

      const availableStock = result[0] 
        ? result[0].totalStock - result[0].reserved
        : 0;

      // Cache result
      await this.cacheManager.set(cacheKey, availableStock, this.CACHE_TTL);

      return availableStock;
    } catch (error) {
      this.logger.error(`Failed to get stock level: ${error.message}`, error.stack);
      throw error;
    }
  }

  async updateStock(updateStockDto: UpdateStockDto): Promise<InventoryItem> {
    const session = await this.inventoryItemModel.db.startSession();
    
    try {
      session.startTransaction();

      const { productId, warehouseId, quantity, operation, reason, referenceId } = updateStockDto;

      // Find or create inventory item
      let item = await this.inventoryItemModel.findOneAndUpdate(
        { productId, warehouseId },
        {},
        { upsert: true, new: true, session },
      );

      // Calculate new quantity
      let newQuantity = item.quantity;
      let newReserved = item.reserved;

      switch (operation) {
        case 'ADD':
          newQuantity += quantity;
          break;
        case 'SUBTRACT':
          if (newQuantity - item.reserved < quantity) {
            throw new Error('Insufficient stock available');
          }
          newQuantity -= quantity;
          break;
        case 'RESERVE':
          if (newQuantity - item.reserved < quantity) {
            throw new Error('Insufficient stock to reserve');
          }
          newReserved += quantity;
          break;
        case 'RELEASE':
          if (newReserved < quantity) {
            throw new Error('Cannot release more than reserved');
          }
          newReserved -= quantity;
          break;
        default:
          throw new Error('Invalid operation');
      }

      // Update item
      item = await this.inventoryItemModel.findOneAndUpdate(
        { _id: item._id },
        {
          quantity: newQuantity,
          reserved: newReserved,
          lastUpdated: new Date(),
          $push: {
            history: {
              operation,
              quantity,
              reason,
              referenceId,
              timestamp: new Date(),
            },
          },
        },
        { new: true, session },
      );

      // Create stock update record
      const stockUpdate = new this.inventoryItemModel.constructor({
        productId,
        warehouseId,
        operation,
        quantity,
        newQuantity: newQuantity,
        newReserved: newReserved,
        reason,
        referenceId,
        timestamp: new Date(),
      });

      await stockUpdate.save({ session });

      // Clear cache
      await this.clearStockCache(productId, warehouseId);

      // Check for low stock
      const availableStock = newQuantity - newReserved;
      if (availableStock <= item.lowStockThreshold) {
        this.eventEmitter.emit(
          'stock.low',
          new LowStockEvent({
            productId,
            warehouseId,
            availableStock,
            threshold: item.lowStockThreshold,
          }),
        );
      }

      // Add to processing queue for async operations
      await this.stockQueue.add('process-stock-update', {
        productId,
        warehouseId,
        operation,
        quantity,
        timestamp: new Date(),
      });

      await session.commitTransaction();

      this.logger.log(
        `Stock updated: ${operation} ${quantity} units of ${productId} in ${warehouseId}`,
      );

      return item;
    } catch (error) {
      await session.abortTransaction();
      this.logger.error(`Stock update failed: ${error.message}`, error.stack);
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async reserveStock(reserveStockDto: ReserveStockDto): Promise<string> {
    const { productId, quantity, warehouseId, ttlSeconds = this.RESERVATION_TTL } = reserveStockDto;

    // Check available stock
    const availableStock = await this.getStockLevel(productId, warehouseId);
    if (availableStock < quantity) {
      throw new Error(`Insufficient stock. Available: ${availableStock}, Requested: ${quantity}`);
    }

    // Create reservation
    const reservation = new this.stockReservationModel({
      productId,
      quantity,
      warehouseId,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      status: 'ACTIVE',
    });

    await reservation.save();

    // Update stock (reserve operation)
    await this.updateStock({
      productId,
      warehouseId,
      quantity,
      operation: 'RESERVE',
      reason: 'Order reservation',
      referenceId: reservation._id.toString(),
    });

    // Schedule expiration check
    setTimeout(async () => {
      await this.checkReservationExpiry(reservation._id.toString());
    }, ttlSeconds * 1000);

    return reservation._id.toString();
  }

  private async clearStockCache(productId: string, warehouseId?: string): Promise<void> {
    const keys = [
      `stock:${productId}:all`,
      warehouseId && `stock:${productId}:${warehouseId}`,
    ].filter(Boolean);

    await Promise.all(keys.map(key => this.cacheManager.del(key)));
  }

  private async checkReservationExpiry(reservationId: string): Promise<void> {
    const reservation = await this.stockReservationModel.findById(reservationId);
    
    if (reservation && reservation.status === 'ACTIVE') {
      reservation.status = 'EXPIRED';
      await reservation.save();

      // Release reserved stock
      await this.updateStock({
        productId: reservation.productId,
        warehouseId: reservation.warehouseId,
        quantity: reservation.quantity,
        operation: 'RELEASE',
        reason: 'Reservation expired',
        referenceId: reservationId,
      });

      this.logger.log(`Reservation ${reservationId} expired and stock released`);
    }
  }
}
