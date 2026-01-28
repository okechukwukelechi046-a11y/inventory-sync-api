import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UpdateStockDto } from './dto/update-stock.dto';
import { ReserveStockDto } from './dto/reserve-stock.dto';
import { StockLevelResponse } from './responses/stock-level.response';
import { InventoryItemResponse } from './responses/inventory-item.response';

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('stock/:productId')
  @UseGuards(ApiKeyGuard)
  @ApiOperation({ summary: 'Get current stock level for a product' })
  @ApiResponse({
    status: 200,
    description: 'Stock level retrieved',
    type: StockLevelResponse,
  })
  @ApiQuery({
    name: 'warehouseId',
    required: false,
    description: 'Filter by warehouse',
  })
  async getStockLevel(
    @Param('productId') productId: string,
    @Query('warehouseId') warehouseId?: string,
  ): Promise<StockLevelResponse> {
    const stock = await this.inventoryService.getStockLevel(
      productId,
      warehouseId,
    );
    return {
      productId,
      warehouseId,
      availableStock: stock,
      timestamp: new Date().toISOString(),
    };
  }

  @Post('stock')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'inventory_manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update stock level' })
  @ApiResponse({
    status: 200,
    description: 'Stock updated successfully',
    type: InventoryItemResponse,
  })
  async updateStock(
    @Body() updateStockDto: UpdateStockDto,
  ): Promise<InventoryItemResponse> {
    const item = await this.inventoryService.updateStock(updateStockDto);
    return this.mapToResponse(item);
  }

  @Post('reserve')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reserve stock for an order' })
  @ApiResponse({
    status: 201,
    description: 'Stock reserved successfully',
  })
  async reserveStock(
    @Body() reserveStockDto: ReserveStockDto,
  ): Promise<{ reservationId: string; expiresAt: string }> {
    const reservationId = await this.inventoryService.reserveStock(
      reserveStockDto,
    );
    
    const reservation = await this.inventoryService.getReservation(reservationId);
    
    return {
      reservationId,
      expiresAt: reservation.expiresAt.toISOString(),
    };
  }

  @Get('items')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get inventory items with filtering' })
  @ApiQuery({
    name: 'warehouseId',
    required: false,
  })
  @ApiQuery({
    name: 'lowStock',
    required: false,
    type: Boolean,
  })
  async getInventoryItems(
    @Query('warehouseId') warehouseId?: string,
    @Query('lowStock') lowStock?: boolean,
  ): Promise<InventoryItemResponse[]> {
    const items = await this.inventoryService.getInventoryItems(
      warehouseId,
      lowStock,
    );
    return items.map(item => this.mapToResponse(item));
  }

  private mapToResponse(item: any): InventoryItemResponse {
    return {
      id: item._id.toString(),
      productId: item.productId,
      warehouseId: item.warehouseId,
      quantity: item.quantity,
      reserved: item.reserved,
      available: item.quantity - item.reserved,
      lowStockThreshold: item.lowStockThreshold,
      lastUpdated: item.lastUpdated.toISOString(),
    };
  }
}
