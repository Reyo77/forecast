import type { ScopedClient } from '../../db/scoped';

/** Plain-English description of one lever, resolving ids to names via `names`. */
export function leverSummary(
  l: { type: string; target: Record<string, unknown>; params: Record<string, unknown> },
  names: Map<string, string>,
): string {
  const t = l.target as Record<string, string>;
  const p = l.params as Record<string, number | string | undefined>;
  const scope = (x: Record<string, string>) =>
    x.scope === 'ALL' ? 'everything' : `${x.scope!.toLowerCase()} ${names.get(x.id!) ?? x.id}`;
  const range =
    p.startDate || p.endDate
      ? ` (${p.startDate ? String(p.startDate).slice(0, 10) : 'start'} → ${p.endDate ? String(p.endDate).slice(0, 10) : 'end'})`
      : '';
  switch (l.type) {
    case 'DEMAND_CHANGE':
      return `Demand ${Number(p.percent) >= 0 ? '+' : ''}${p.percent}% for ${scope(t)}${range}`;
    case 'SUPPLIER_DELAY':
      return `${names.get(t.supplierId!) ?? 'Supplier'} is ${p.extraDays} days late${range}`;
    case 'LEAD_TIME_CHANGE':
      return `Lead time becomes ${p.leadTimeDays} days (${names.get(t.supplierProductId!) ?? 'supplier link'})`;
    case 'CAPACITY_CAP':
      return `${names.get(t.supplierId!) ?? 'Supplier'} capped at ${p.weeklyQuantity} units/week`;
    case 'SERVICE_LEVEL':
      return `Target service level ${(Number(p.serviceLevel) * 100).toFixed(1)}%`;
    case 'PRICE_CHANGE':
      return `Price ${Number(p.percent) >= 0 ? '+' : ''}${p.percent}% for ${scope(t)} (elasticity ${p.elasticity ?? 1})${range}`;
    default:
      return l.type;
  }
}

export async function loadNames(db: ScopedClient): Promise<Map<string, string>> {
  const [products, categories, locations, suppliers, links] = await Promise.all([
    db.product.findMany({ select: { id: true, sku: true } }),
    db.category.findMany({ select: { id: true, name: true } }),
    db.location.findMany({ select: { id: true, code: true } }),
    db.supplier.findMany({ select: { id: true, name: true } }),
    db.supplierProduct.findMany({
      select: {
        id: true,
        supplier: { select: { name: true } },
        product: { select: { sku: true } },
      },
    }),
  ]);
  const m = new Map<string, string>();
  products.forEach((p) => m.set(p.id, p.sku));
  categories.forEach((c) => m.set(c.id, c.name));
  locations.forEach((l) => m.set(l.id, l.code));
  suppliers.forEach((s) => m.set(s.id, s.name));
  links.forEach((l) => m.set(l.id, `${l.supplier.name} / ${l.product.sku}`));
  return m;
}
