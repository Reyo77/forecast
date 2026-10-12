import { z } from 'zod';
import type { ScopedClient } from '../../db/scoped';
import type { AiToolDeclaration } from '../../ai/types';

/**
 * The assistant never writes SQL. It can only call these fixed, read-only functions; each runs
 * through the tenant-scoped client, validates its arguments, and returns small JSON results.
 */
export interface ToolContext {
  db: ScopedClient;
  now: Date;
}

const limit = (def = 5) => z.number().int().min(1).max(20).default(def);
const WEEK = 7 * 86400_000;
const dollars = (cents: number) => Math.round(cents) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodType<Record<string, unknown>>;
  run: (ctx: ToolContext, args: never) => Promise<Record<string, unknown>>;
}

const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  additionalProperties: false,
});

export const TOOLS = {
  getTopProductsByRevenue: {
    description:
      'Products with the highest sales revenue (US dollars) over the last N weeks of recorded history.',
    parameters: obj({
      limit: { type: 'integer', description: 'How many products (1-20, default 5)' },
      weeks: { type: 'integer', description: 'Look-back window in weeks (1-156, default 26)' },
    }),
    schema: z
      .object({ limit: limit(), weeks: z.number().int().min(1).max(156).default(26) })
      .strict(),
    run: async (ctx, a: { limit: number; weeks: number }) => {
      const latest = await ctx.db.salesRecord.aggregate({ _max: { date: true } });
      if (!latest._max.date) return { products: [], note: 'No sales history yet' };
      const from = new Date(latest._max.date.getTime() - (a.weeks - 1) * WEEK);
      const groups = await ctx.db.salesRecord.groupBy({
        by: ['productId'],
        where: { date: { gte: from } },
        _sum: { revenueCents: true, quantity: true },
      });
      const ranked = groups
        .sort((x, y) => Number(y._sum.revenueCents ?? 0) - Number(x._sum.revenueCents ?? 0))
        .slice(0, a.limit);
      const products = await ctx.db.product.findMany({
        where: { id: { in: ranked.map((g) => g.productId) } },
        select: { id: true, sku: true, name: true },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      return {
        weeks: a.weeks,
        products: ranked.map((g) => ({
          sku: byId.get(g.productId)?.sku,
          name: byId.get(g.productId)?.name,
          revenueUsd: dollars(Number(g._sum.revenueCents ?? 0)),
          units: r1(Number(g._sum.quantity ?? 0)),
        })),
      };
    },
  },
  getWorstAccuracy: {
    description:
      'Product/location series with the worst forecast accuracy (highest WAPE) in the latest finished forecast run.',
    parameters: obj({
      limit: { type: 'integer', description: 'How many series (1-20, default 5)' },
    }),
    schema: z.object({ limit: limit() }).strict(),
    run: async (ctx, a: { limit: number }) => {
      const run = await ctx.db.forecastRun.findFirst({
        where: { status: 'DONE' },
        orderBy: { createdAt: 'desc' },
      });
      if (!run) return { series: [], note: 'No finished forecast run yet' };
      const rows = await ctx.db.forecastAccuracy.findMany({
        where: { runId: run.id, wape: { not: null } },
        orderBy: { wape: 'desc' },
        take: a.limit,
        include: { product: true, location: true },
      });
      return {
        runDate: run.createdAt.toISOString().slice(0, 10),
        series: rows.map((r) => ({
          sku: r.product.sku,
          location: r.location.code,
          model: r.modelUsed,
          wapePct: r1((r.wape ?? 0) * 100),
          biasPct: r.bias === null ? null : r1(r.bias * 100),
        })),
      };
    },
  },
  getAtRiskProducts: {
    description:
      'Products at risk of stocking out in the most recent finished what-if scenario run (first stockout date, units short, revenue at risk).',
    parameters: obj({
      limit: { type: 'integer', description: 'How many products (1-20, default 5)' },
    }),
    schema: z.object({ limit: limit() }).strict(),
    run: async (ctx, a: { limit: number }) => {
      const run = await ctx.db.scenarioRun.findFirst({
        where: { status: 'DONE' },
        orderBy: { createdAt: 'desc' },
        include: { scenario: true },
      });
      if (!run?.atRisk) return { products: [], note: 'No scenario has been run yet' };
      const rows = (
        run.atRisk as {
          scenario: {
            productId: string;
            locationId: string;
            firstStockoutWeek: number;
            shortage: number;
            revenueAtRiskCents: number;
          }[];
        }
      ).scenario.slice(0, a.limit);
      const [products, locations] = await Promise.all([
        ctx.db.product.findMany({ select: { id: true, sku: true } }),
        ctx.db.location.findMany({ select: { id: true, code: true } }),
      ]);
      const p = new Map(products.map((x) => [x.id, x.sku]));
      const l = new Map(locations.map((x) => [x.id, x.code]));
      return {
        scenario: run.scenario.name,
        products: rows.map((r) => ({
          sku: p.get(r.productId),
          location: l.get(r.locationId),
          firstStockoutWeekNumber: r.firstStockoutWeek + 1,
          unitsShort: r1(r.shortage),
          revenueAtRiskUsd: dollars(r.revenueAtRiskCents),
        })),
      };
    },
  },
  getSalesTrend: {
    description:
      'Weekly sales (units and revenue in US dollars) for the last N weeks, for one product (by SKU) or for everything.',
    parameters: obj({
      productSku: { type: 'string', description: 'Optional SKU' },
      weeks: { type: 'integer', description: 'Number of weeks (4-104, default 12)' },
    }),
    schema: z
      .object({
        productSku: z.string().min(1).max(64).optional(),
        weeks: z.number().int().min(4).max(104).default(12),
      })
      .strict(),
    run: async (ctx, a: { productSku?: string; weeks: number }) => {
      const product = a.productSku
        ? await ctx.db.product.findFirst({ where: { sku: a.productSku } })
        : null;
      if (a.productSku && !product) return { error: `No product with SKU ${a.productSku}` };
      const latest = await ctx.db.salesRecord.aggregate({ _max: { date: true } });
      if (!latest._max.date) return { weeks: [], note: 'No sales history yet' };
      const from = new Date(latest._max.date.getTime() - (a.weeks - 1) * WEEK);
      const groups = await ctx.db.salesRecord.groupBy({
        by: ['date'],
        where: { date: { gte: from }, ...(product && { productId: product.id }) },
        _sum: { quantity: true, revenueCents: true },
        orderBy: { date: 'asc' },
      });
      return {
        sku: product?.sku ?? 'all products',
        weeks: groups.map((g) => ({
          weekStart: g.date.toISOString().slice(0, 10),
          units: r1(Number(g._sum.quantity ?? 0)),
          revenueUsd: dollars(Number(g._sum.revenueCents ?? 0)),
        })),
      };
    },
  },
  getLowStockProducts: {
    description: 'Inventory positions that are below their safety stock (or empty), worst first.',
    parameters: obj({ limit: { type: 'integer', description: 'How many (1-20, default 5)' } }),
    schema: z.object({ limit: limit() }).strict(),
    run: async (ctx, a: { limit: number }) => {
      const levels = await ctx.db.inventoryLevel.findMany({
        include: { product: true, location: true },
      });
      const low = levels
        .map((l) => ({
          sku: l.product.sku,
          location: l.location.code,
          onHand: Number(l.onHand),
          safetyStock: Number(l.safetyStock),
        }))
        .filter((l) => l.onHand < l.safetyStock || l.onHand === 0)
        .sort((x, y) => x.onHand / (x.safetyStock || 1) - y.onHand / (y.safetyStock || 1))
        .slice(0, a.limit);
      return { products: low };
    },
  },
  getLateOpenOrders: {
    description: 'Open purchase orders whose expected date has already passed.',
    parameters: obj({ limit: { type: 'integer', description: 'How many (1-20, default 5)' } }),
    schema: z.object({ limit: limit() }).strict(),
    run: async (ctx, a: { limit: number }) => {
      const today = new Date(
        Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), ctx.now.getUTCDate()),
      );
      const rows = await ctx.db.openOrder.findMany({
        where: { expectedDate: { lt: today } },
        orderBy: { expectedDate: 'asc' },
        take: a.limit,
        include: { product: true, location: true, supplier: true },
      });
      return {
        lateOrders: rows.map((o) => ({
          sku: o.product.sku,
          location: o.location.code,
          supplier: o.supplier?.name ?? null,
          quantity: Number(o.quantity),
          expectedDate: o.expectedDate.toISOString().slice(0, 10),
          daysLate: Math.floor((today.getTime() - o.expectedDate.getTime()) / 86400_000),
        })),
      };
    },
  },
} satisfies Record<string, Tool>;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export const toolDeclarations = (): AiToolDeclaration[] =>
  TOOL_NAMES.map((name) => ({
    name,
    description: TOOLS[name].description,
    parameters: TOOLS[name].parameters,
  }));

/** Runs an allowlisted tool for the current tenant. Unknown names and bad arguments are rejected, never executed. */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
): Promise<{ ok: boolean; response: Record<string, unknown> }> {
  if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) {
    return {
      ok: false,
      response: { error: `Unknown function "${name}". Allowed: ${TOOL_NAMES.join(', ')}` },
    };
  }
  const tool = TOOLS[name as ToolName] as Tool;
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success)
    return {
      ok: false,
      response: {
        error: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      },
    };
  try {
    return { ok: true, response: await tool.run(ctx, parsed.data as never) };
  } catch {
    return { ok: false, response: { error: 'The lookup failed' } };
  }
}
