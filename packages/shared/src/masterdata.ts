import { z } from 'zod';

const cents = z.number().int().min(0).max(100_000_000);
const quantity = z.number().min(0).max(1_000_000_000);
const positive = z.number().gt(0).max(1_000_000_000);
const id = z.string().min(1).max(64);
const name = (max = 120) => z.string().trim().min(1, 'Required').max(max);

export const categoryInputSchema = z.object({
  name: name(80),
  parentId: id.nullable().optional(),
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export const categoryPatchSchema = categoryInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const productInputSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required').max(64),
  name: name(),
  categoryId: id.nullable().optional(),
  unitCostCents: cents.default(0),
  unitPriceCents: cents.default(0),
  isComponent: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type ProductInput = z.infer<typeof productInputSchema>;
export const productPatchSchema = productInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const LOCATION_TYPES = ['WAREHOUSE', 'STORE', 'PLANT'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
export const locationInputSchema = z.object({
  code: z.string().trim().min(1, 'Code is required').max(32),
  name: name(),
  type: z.enum(LOCATION_TYPES).default('WAREHOUSE'),
});
export type LocationInput = z.infer<typeof locationInputSchema>;
export const locationPatchSchema = locationInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const leadTime = z
  .number()
  .int()
  .min(1, 'Lead time must be at least 1 day')
  .max(365, 'Lead time cannot exceed 365 days');
export const supplierInputSchema = z.object({
  name: name(),
  defaultLeadTimeDays: leadTime,
  reliabilityPct: z.number().min(0).max(100).default(95),
});
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export const supplierPatchSchema = supplierInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const supplierProductInputSchema = z.object({
  productId: id,
  leadTimeDays: leadTime,
  minOrderQty: quantity.default(1),
  unitCostCents: cents.default(0),
  weeklyCapacity: positive.nullable().optional(),
  isPrimary: z.boolean().default(false),
});
export type SupplierProductInput = z.infer<typeof supplierProductInputSchema>;
export const supplierProductPatchSchema = supplierProductInputSchema
  .omit({ productId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const bomInputSchema = z.object({
  parentProductId: id,
  componentProductId: id,
  quantityPer: positive,
});
export type BomInput = z.infer<typeof bomInputSchema>;
export const bomPatchSchema = z.object({ quantityPer: positive });

export const inventoryInputSchema = z.object({
  productId: id,
  locationId: id,
  onHand: quantity,
  safetyStock: quantity.default(0),
  asOfDate: z.coerce.date().optional(),
});
export type InventoryInput = z.infer<typeof inventoryInputSchema>;

export const openOrderInputSchema = z.object({
  productId: id,
  locationId: id,
  supplierId: id.nullable().optional(),
  quantity: positive,
  expectedDate: z.coerce.date(),
});
export type OpenOrderInput = z.infer<typeof openOrderInputSchema>;
export const openOrderPatchSchema = openOrderInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface CategoryDto {
  id: string;
  name: string;
  parentId: string | null;
  productCount: number;
}
export interface ProductDto {
  id: string;
  sku: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  unitCostCents: number;
  unitPriceCents: number;
  isComponent: boolean;
  isActive: boolean;
}
export interface LocationDto {
  id: string;
  code: string;
  name: string;
  type: LocationType;
}
export interface SupplierDto {
  id: string;
  name: string;
  defaultLeadTimeDays: number;
  reliabilityPct: number;
}
export interface SupplierProductDto {
  id: string;
  supplierId: string;
  supplierName?: string;
  productId: string;
  productSku?: string;
  productName?: string;
  leadTimeDays: number;
  minOrderQty: number;
  unitCostCents: number;
  weeklyCapacity: number | null;
  isPrimary: boolean;
}
export interface BomNode {
  productId: string;
  sku: string;
  name: string;
  quantityPer: number;
  /** Total quantity of this component per 1 unit of the root product. */
  totalQuantity: number;
  bomItemId: string | null;
  children: BomNode[];
}
export interface InventoryDto {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  onHand: number;
  safetyStock: number;
  asOfDate: string;
}
export interface OpenOrderDto {
  id: string;
  productId: string;
  productSku: string;
  locationId: string;
  locationCode: string;
  supplierId: string | null;
  supplierName: string | null;
  quantity: number;
  expectedDate: string;
  isLate: boolean;
}
