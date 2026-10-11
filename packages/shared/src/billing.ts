import { z } from 'zod';

export const METRICS = [
  'users',
  'skus',
  'locations',
  'scenarios',
  'forecastRuns',
  'aiRequests',
] as const;
export type Metric = (typeof METRICS)[number];

/** Metrics counted from live rows (not per billing period). */
export const COUNT_METRICS = ['users', 'skus', 'locations', 'scenarios'] as const;
/** Metrics that reset every billing period (calendar month, UTC). */
export const PERIOD_METRICS = ['forecastRuns', 'aiRequests'] as const;

export const METRIC_LABELS: Record<Metric, string> = {
  users: 'Users',
  skus: 'SKUs',
  locations: 'Locations',
  scenarios: 'Saved scenarios',
  forecastRuns: 'Forecast runs this month',
  aiRequests: 'AI requests this month',
};

const limit = z.number().int().min(0).max(1_000_000_000);

export const limitsSchema = z.object({
  users: limit,
  skus: limit,
  locations: limit,
  scenarios: limit,
  forecastRuns: limit,
  aiRequests: limit,
  historyMonths: limit,
});
export type Limits = z.infer<typeof limitsSchema>;

export const customLimitsSchema = limitsSchema.partial();
export type CustomLimits = z.infer<typeof customLimitsSchema>;

export const DEFAULT_PLANS: {
  code: string;
  name: string;
  priceCents: number;
  isCustom: boolean;
  sortOrder: number;
  limits: Limits;
}[] = [
  {
    code: 'free',
    name: 'Free',
    priceCents: 0,
    isCustom: false,
    sortOrder: 1,
    limits: {
      users: 2,
      skus: 50,
      locations: 1,
      forecastRuns: 10,
      scenarios: 3,
      aiRequests: 20,
      historyMonths: 12,
    },
  },
  {
    code: 'starter',
    name: 'Starter',
    priceCents: 4900,
    isCustom: false,
    sortOrder: 2,
    limits: {
      users: 5,
      skus: 500,
      locations: 3,
      forecastRuns: 100,
      scenarios: 20,
      aiRequests: 300,
      historyMonths: 36,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceCents: 19900,
    isCustom: false,
    sortOrder: 3,
    limits: {
      users: 20,
      skus: 5000,
      locations: 10,
      forecastRuns: 1000,
      scenarios: 100,
      aiRequests: 2000,
      historyMonths: 60,
    },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceCents: 0,
    isCustom: true,
    sortOrder: 4,
    limits: {
      users: 100,
      skus: 100000,
      locations: 100,
      forecastRuns: 10000,
      scenarios: 1000,
      aiRequests: 20000,
      historyMonths: 120,
    },
  },
];

export const planInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,30}$/, 'Use 2-30 lowercase letters, numbers or dashes'),
  name: z.string().trim().min(1).max(60),
  priceCents: z.number().int().min(0).max(100_000_00),
  limits: limitsSchema,
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  isCustom: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(100),
});
export type PlanInput = z.infer<typeof planInputSchema>;

export const planPatchSchema = planInputSchema
  .omit({ code: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type PlanPatch = z.infer<typeof planPatchSchema>;

export const changePlanSchema = z.object({
  planCode: z.string().trim().toLowerCase().min(1).max(30),
});

export const adminSubscriptionSchema = z
  .object({
    planCode: z.string().trim().toLowerCase().min(1).max(30).optional(),
    customLimits: customLimitsSchema.nullable().optional(),
    status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface PlanDto {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  limits: Limits;
  isActive: boolean;
  isPublic: boolean;
  isCustom: boolean;
  sortOrder: number;
}

export interface UsageLine {
  metric: Metric;
  limit: number;
  current: number;
}

export interface SubscriptionDto {
  status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  plan: PlanDto;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  periodStart: string;
  periodEnd: string;
  pendingPlan: PlanDto | null;
  limits: Limits;
  usage: UsageLine[];
  simulatedPayments: boolean;
}

export interface InvoiceDto {
  id: string;
  number: string;
  amountCents: number;
  status: 'PENDING' | 'PAID' | 'VOID';
  description: string;
  planName: string;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  createdAt: string;
  tenantId?: string;
}
