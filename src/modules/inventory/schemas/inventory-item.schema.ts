import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes } from 'mongoose';

export type InventoryItemDocument = InventoryItem & Document;

@Schema({ timestamps: true })
export class InventoryItem {
  @Prop({ required: true, index: true })
  productId: string;

  @Prop({ required: true, index: true })
  warehouseId: string;

  @Prop({ required: true, default: 0, min: 0 })
  quantity: number;

  @Prop({ required: true, default: 0, min: 0 })
  reserved: number;

  @Prop({ default: 10 })
  lowStockThreshold: number;

  @Prop({ default: true })
  isActive: boolean;

  @Prop([
    {
      operation: { type: String, enum: ['ADD', 'SUBTRACT', 'RESERVE', 'RELEASE'] },
      quantity: Number,
      reason: String,
      referenceId: String,
      timestamp: { type: Date, default: Date.now },
    },
  ])
  history: Array<{
    operation: string;
    quantity: number;
    reason?: string;
    referenceId?: string;
    timestamp: Date;
  }>;

  @Prop({ type: Date, default: Date.now })
  lastUpdated: Date;
}

export const InventoryItemSchema = SchemaFactory.createForClass(InventoryItem);

// Compound indexes for performance
InventoryItemSchema.index({ productId: 1, warehouseId: 1 }, { unique: true });
InventoryItemSchema.index({ warehouseId: 1, isActive: 1 });
InventoryItemSchema.index({ productId: 1, isActive: 1 });
