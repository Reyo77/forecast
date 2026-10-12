import { api } from '../../api/client';

export interface ReorderItem {
  sku: string;
  productName: string;
  locationCode: string;
  supplierName: string | null;
  orderDate: string;
  arrivalDate: string;
  quantity: number;
  estCostCents: number;
  urgent: boolean;
}
export interface ReorderPlan {
  run: { id: string; asOf: string; horizonWeeks: number } | null;
  items: ReorderItem[];
  totals: { orders: number; units: number; costCents: number; urgent: number };
}
export interface AbcRow {
  productId: string;
  sku: string;
  name: string;
  revenueCents: number;
  units: number;
  sharePct: number;
  cumulativePct: number;
  class: 'A' | 'B' | 'C';
}
export interface AbcResponse {
  from: string | null;
  to: string | null;
  rows: AbcRow[];
  summary: { class: 'A' | 'B' | 'C'; products: number; revenueCents: number; sharePct: number }[];
}

export const insightsApi = {
  reorderPlan: () => api<ReorderPlan>('/insights/reorder-plan'),
  abc: () => api<AbcResponse>('/insights/abc'),
};
