/** Pure bill-of-materials helpers: no database access. */

export interface BomEdge {
  parentId: string;
  componentId: string;
  quantityPer: number;
}

function childrenIndex(edges: BomEdge[]): Map<string, BomEdge[]> {
  const idx = new Map<string, BomEdge[]>();
  for (const e of edges) {
    const list = idx.get(e.parentId);
    if (list) list.push(e);
    else idx.set(e.parentId, [e]);
  }
  return idx;
}

/**
 * Would adding parent -> component create a cycle? True when component == parent, or when
 * `parent` is already reachable from `component` (direct or indirect: A uses B uses A).
 */
export function wouldCreateCycle(edges: BomEdge[], parentId: string, componentId: string): boolean {
  if (parentId === componentId) return true;
  const idx = childrenIndex(edges);
  const seen = new Set<string>();
  const stack = [componentId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === parentId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of idx.get(cur) ?? []) stack.push(e.componentId);
  }
  return false;
}

/** Whether the whole edge set contains any cycle (used to validate data and in property tests). */
export function hasCycle(edges: BomEdge[]): boolean {
  const idx = childrenIndex(edges);
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const e of idx.get(n) ?? []) if (visit(e.componentId)) return true;
    state.set(n, 2);
    return false;
  };
  const nodes = new Set(edges.flatMap((e) => [e.parentId, e.componentId]));
  for (const n of nodes) if (visit(n)) return true;
  return false;
}

/**
 * Multi-level explosion: total quantity of every (direct or indirect) component needed for
 * `quantity` units of `rootId`. A component reachable by several paths is summed.
 * Throws if the BOM contains a cycle.
 */
export function explodeBom(edges: BomEdge[], rootId: string, quantity = 1): Map<string, number> {
  const idx = childrenIndex(edges);
  const totals = new Map<string, number>();
  const walk = (id: string, qty: number, path: Set<string>) => {
    for (const e of idx.get(id) ?? []) {
      if (path.has(e.componentId)) throw new Error('BOM cycle detected');
      const need = qty * e.quantityPer;
      totals.set(e.componentId, (totals.get(e.componentId) ?? 0) + need);
      walk(e.componentId, need, new Set(path).add(e.componentId));
    }
  };
  walk(rootId, quantity, new Set([rootId]));
  return totals;
}

export interface BomTreeNode {
  productId: string;
  quantityPer: number;
  totalQuantity: number;
  edgeId?: string;
  children: BomTreeNode[];
}

/** Nested tree for display; `totalQuantity` is per 1 unit of the root. */
export function buildBomTree(edges: (BomEdge & { id?: string })[], rootId: string): BomTreeNode[] {
  const idx = childrenIndex(edges);
  const build = (id: string, mult: number, path: Set<string>): BomTreeNode[] =>
    (idx.get(id) ?? []).map((e) => {
      if (path.has(e.componentId)) throw new Error('BOM cycle detected');
      const total = mult * e.quantityPer;
      return {
        productId: e.componentId,
        quantityPer: e.quantityPer,
        totalQuantity: total,
        edgeId: (e as { id?: string }).id,
        children: build(e.componentId, total, new Set(path).add(e.componentId)),
      };
    });
  return build(rootId, 1, new Set([rootId]));
}

/**
 * Adds component demand to a set of per-node weekly demand series. For every finished-product node
 * (product|location) the parent's demand is exploded through the BOM into its (multi-level)
 * components at the same location. Returns a new map; the input is not modified.
 */
export function explodeDemand(
  edges: BomEdge[],
  independent: Map<string, number[]>,
  weeks: number,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const add = (key: string, series: number[]) => {
    const cur = out.get(key) ?? new Array<number>(weeks).fill(0);
    for (let t = 0; t < weeks; t++) cur[t]! += series[t] ?? 0;
    out.set(key, cur);
  };
  const parentsWithBom = new Set(edges.map((e) => e.parentId));
  const cache = new Map<string, Map<string, number>>();
  for (const [key, series] of independent) {
    add(key, series);
    const [productId, locationId] = key.split('|') as [string, string];
    if (!parentsWithBom.has(productId)) continue;
    let comps = cache.get(productId);
    if (!comps) {
      comps = explodeBom(edges, productId, 1);
      cache.set(productId, comps);
    }
    for (const [compId, perUnit] of comps)
      add(
        `${compId}|${locationId}`,
        series.map((q) => q * perUnit),
      );
  }
  return out;
}
