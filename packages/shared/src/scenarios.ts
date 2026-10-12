import { z } from 'zod';

const id = z.string().min(1).max(64);
const optionalDate = z.coerce.date().optional();

const scopeTarget = z.union([
  z.object({ scope: z.literal('ALL') }),
  z.object({ scope: z.enum(['PRODUCT', 'CATEGORY', 'LOCATION']), id }),
]);
export type ScopeTarget = z.infer<typeof scopeTarget>;

const dateRange = { startDate: optionalDate, endDate: optionalDate };
const rangeOk = (p: { startDate?: Date; endDate?: Date }) =>
  !p.startDate || !p.endDate || p.startDate <= p.endDate;
const rangeMsg = { message: 'End date must not be before the start date', path: ['endDate'] };

export const LEVER_TYPES = [
  'DEMAND_CHANGE',
  'SUPPLIER_DELAY',
  'LEAD_TIME_CHANGE',
  'CAPACITY_CAP',
  'SERVICE_LEVEL',
  'PRICE_CHANGE',
] as const;
export type LeverType = (typeof LEVER_TYPES)[number];

export const LEVER_LABELS: Record<LeverType, string> = {
  DEMAND_CHANGE: 'Demand change',
  SUPPLIER_DELAY: 'Supplier delay',
  LEAD_TIME_CHANGE: 'Lead time change',
  CAPACITY_CAP: 'Capacity cap',
  SERVICE_LEVEL: 'Service level',
  PRICE_CHANGE: 'Price change',
};

export const leverInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('DEMAND_CHANGE'),
    target: scopeTarget,
    params: z
      .object({ percent: z.number().min(-100).max(1000), ...dateRange })
      .refine(rangeOk, rangeMsg),
  }),
  z.object({
    type: z.literal('SUPPLIER_DELAY'),
    target: z.object({ supplierId: id }),
    params: z
      .object({ extraDays: z.number().int().min(1).max(365), ...dateRange })
      .refine(rangeOk, rangeMsg),
  }),
  z.object({
    type: z.literal('LEAD_TIME_CHANGE'),
    target: z.object({ supplierProductId: id }),
    params: z.object({
      leadTimeDays: z
        .number()
        .int()
        .min(1, 'Lead time must be at least 1 day')
        .max(365, 'Lead time cannot exceed 365 days'),
    }),
  }),
  z.object({
    type: z.literal('CAPACITY_CAP'),
    target: z.object({ supplierId: id }),
    params: z.object({ weeklyQuantity: z.number().gt(0).max(1_000_000_000) }),
  }),
  z.object({
    type: z.literal('SERVICE_LEVEL'),
    target: z.object({}).default({}),
    params: z.object({
      serviceLevel: z
        .number()
        .min(0.5, 'Service level must be at least 50%')
        .max(0.999, 'Service level must be below 100%'),
    }),
  }),
  z.object({
    type: z.literal('PRICE_CHANGE'),
    target: scopeTarget,
    params: z
      .object({
        percent: z.number().min(-90).max(500),
        elasticity: z.number().min(0).max(5).default(1),
        ...dateRange,
      })
      .refine(rangeOk, rangeMsg),
  }),
]);
export type LeverInput = z.infer<typeof leverInputSchema>;

export const scenarioInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(1000).optional(),
  baseForecastRunId: id,
});
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;
export const scenarioPatchSchema = scenarioInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface PlanKpisDto {
  stockoutWeeks: number;
  fillRate: number;
  avgInventoryValueCents: number;
  revenueAtRiskCents: number;
  plannedOrders: number;
  totalDemand: number;
  totalShortage: number;
}
export interface AtRiskDto {
  productId: string;
  productSku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  firstStockoutWeek: number;
  firstStockoutDate: string;
  shortage: number;
  revenueAtRiskCents: number;
}
export interface WeekTotal {
  weekStart: string;
  demand: number;
  onHand: number;
  shortage: number;
}
export interface LeverDto {
  id: string;
  type: LeverType;
  target: Record<string, unknown>;
  params: Record<string, unknown>;
  summary: string;
}
export interface ScenarioDto {
  id: string;
  name: string;
  description: string | null;
  baseForecastRunId: string;
  status: 'DRAFT' | 'RUNNING' | 'READY' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  leverCount: number;
  latestKpis: { baseline: PlanKpisDto; scenario: PlanKpisDto } | null;
}
export interface ScenarioRunDto {
  id: string;
  scenarioId: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  kpis: { baseline: PlanKpisDto; scenario: PlanKpisDto } | null;
  atRisk: { baseline: AtRiskDto[]; scenario: AtRiskDto[] } | null;
  totals: { baseline: WeekTotal[]; scenario: WeekTotal[] } | null;
  levers: LeverDto[];
}

/** Difference between a scenario KPI and the baseline, with a sign-aware "better/worse" verdict. */
export function kpiDelta(
  key: keyof PlanKpisDto,
  baseline: number,
  scenario: number,
): { absolute: number; percent: number | null; verdict: 'better' | 'worse' | 'same' } {
  const absolute = scenario - baseline;
  const percent = baseline === 0 ? null : (absolute / Math.abs(baseline)) * 100;
  if (Math.abs(absolute) < 1e-9)
    return { absolute: 0, percent: percent === null ? null : 0, verdict: 'same' };
  // Higher is better only for fill rate; for the others lower is better. Orders and demand are neutral.
  if (key === 'totalDemand' || key === 'plannedOrders')
    return { absolute, percent, verdict: 'same' };
  const higherIsBetter = key === 'fillRate';
  const better = higherIsBetter ? absolute > 0 : absolute < 0;
  return { absolute, percent, verdict: better ? 'better' : 'worse' };
}
