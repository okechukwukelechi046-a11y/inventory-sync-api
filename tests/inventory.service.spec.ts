import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { InventoryItem } from '../src/modules/inventory/schemas/inventory-item.schema';
import { StockReservation } from '../src/modules/inventory/schemas/stock-reservation.schema';

describe('InventoryService', () => {
  let service: InventoryService;
  let inventoryModel: any;
  let reservationModel: any;
  let cacheManager: any;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    inventoryModel = {
      findOneAndUpdate: jest.fn(),
      aggregate: jest.fn(),
      db: {
        startSession: jest.fn().mockReturnValue({
          startTransaction: jest.fn(),
          commitTransaction: jest.fn(),
          abortTransaction: jest.fn(),
          endSession: jest.fn(),
        }),
      },
    };

    reservationModel = {
      save: jest.fn(),
      findById: jest.fn(),
    };

    cacheManager = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    eventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        {
          provide: getModelToken(InventoryItem.name),
          useValue: inventoryModel,
        },
        {
          provide: getModelToken(StockReservation.name),
          useValue: reservationModel,
        },
        {
          provide: CACHE_MANAGER,
          useValue: cacheManager,
        },
        {
          provide: EventEmitter2,
          useValue: eventEmitter,
        },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  describe('getStockLevel', () => {
    it('should return cached stock if available', async () => {
      cacheManager.get.mockResolvedValue(50);
      
      const result = await service.getStockLevel('prod123', 'warehouse1');
      
      expect(result).toBe(50);
      expect(cacheManager.get).toHaveBeenCalledWith('stock:prod123:warehouse1');
    });

    it('should calculate stock from database if not cached', async () => {
      cacheManager.get.mockResolvedValue(null);
      inventoryModel.aggregate.mockResolvedValue([{
        totalStock: 100,
        reserved: 20,
      }]);

      const result = await service.getStockLevel('prod123');
      
      expect(result).toBe(80);
      expect(cacheManager.set).toHaveBeenCalled();
    });
  });

  describe('updateStock', () => {
    it('should add stock correctly', async () => {
      const mockItem = {
        _id: 'item123',
        productId: 'prod123',
        warehouseId: 'warehouse1',
        quantity: 50,
        reserved: 10,
        lowStockThreshold: 10,
        save: jest.fn(),
      };

      inventoryModel.findOneAndUpdate.mockResolvedValue(mockItem);

      const updateDto = {
        productId: 'prod123',
        warehouseId: 'warehouse1',
        quantity: 20,
        operation: 'ADD',
        reason: 'Restock',
      };

      const result = await service.updateStock(updateDto);
      
      expect(inventoryModel.findOneAndUpdate).toHaveBeenCalled();
      expect(cacheManager.del).toHaveBeenCalled();
    });

    it('should throw error for insufficient stock', async () => {
      const mockItem = {
        quantity: 10,
        reserved: 5,
      };

      inventoryModel.findOneAndUpdate.mockResolvedValue(mockItem);

      const updateDto = {
        productId: 'prod123',
        warehouseId: 'warehouse1',
        quantity: 10,
        operation: 'SUBTRACT',
        reason: 'Sale',
      };

      await expect(service.updateStock(updateDto)).rejects.toThrow(
        'Insufficient stock available',
      );
    });
  });
});
