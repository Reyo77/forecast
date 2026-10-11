import type { Plan, Invoice } from '@prisma/client';
import type { InvoiceDto } from '@supplycast/shared';
import type { Tx } from '../../db/tx';

export function formatInvoiceNumber(year: number, n: number): string {
  return `INV-${year}-${String(n).padStart(6, '0')}`;
}

/** Sequential per-year invoice numbers. The upsert row-lock serialises concurrent creators. */
export async function nextInvoiceNumber(tx: Tx, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  await tx.$executeRaw`INSERT INTO InvoiceSequence (year, last) VALUES (${year}, 1) ON DUPLICATE KEY UPDATE last = last + 1`;
  const row = await tx.invoiceSequence.findUniqueOrThrow({ where: { year } });
  return formatInvoiceNumber(year, row.last);
}

/** Payments are simulated, so every invoice is created already PAID. */
export async function createPaidInvoice(
  tx: Tx,
  args: {
    tenantId: string;
    subscriptionId: string;
    plan: Plan;
    periodStart: Date;
    periodEnd: Date;
    now: Date;
    description?: string;
  },
): Promise<Invoice> {
  return tx.invoice.create({
    data: {
      tenantId: args.tenantId,
      subscriptionId: args.subscriptionId,
      number: await nextInvoiceNumber(tx, args.now),
      amountCents: args.plan.priceCents,
      status: 'PAID',
      planName: args.plan.name,
      description: args.description ?? `${args.plan.name} plan (monthly)`,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      paidAt: args.now,
    } as never,
  });
}

export function toInvoiceDto(i: Invoice): InvoiceDto {
  return {
    id: i.id,
    number: i.number,
    amountCents: i.amountCents,
    status: i.status,
    description: i.description,
    planName: i.planName,
    periodStart: i.periodStart.toISOString(),
    periodEnd: i.periodEnd.toISOString(),
    paidAt: i.paidAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
    tenantId: i.tenantId,
  };
}

/**
 * Monthly recurring revenue: for each tenant take its latest PAID invoice and count it while
 * its period covers `now`. VOID and PENDING invoices never count.
 */
export function calculateMrr(
  invoices: {
    tenantId: string;
    amountCents: number;
    status: string;
    periodStart: Date;
    periodEnd: Date;
  }[],
  now: Date,
): number {
  const latest = new Map<string, (typeof invoices)[number]>();
  for (const inv of invoices) {
    if (inv.status !== 'PAID' || inv.periodStart > now || inv.periodEnd <= now) continue;
    const cur = latest.get(inv.tenantId);
    if (!cur || inv.periodStart > cur.periodStart) latest.set(inv.tenantId, inv);
  }
  return [...latest.values()].reduce((sum, i) => sum + i.amountCents, 0);
}
