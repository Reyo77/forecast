import fc from 'fast-check';
import { buildBomTree, explodeBom, hasCycle, wouldCreateCycle, type BomEdge } from './bom';

const e = (parentId: string, componentId: string, quantityPer = 1): BomEdge => ({
  parentId,
  componentId,
  quantityPer,
});

describe('wouldCreateCycle', () => {
  it('rejects a product containing itself', () =>
    expect(wouldCreateCycle([], 'A', 'A')).toBe(true));
  it('rejects a direct cycle (A uses B, then B uses A)', () =>
    expect(wouldCreateCycle([e('A', 'B')], 'B', 'A')).toBe(true));
  it('rejects an indirect cycle (A→B→C→D, then D uses A)', () => {
    const edges = [e('A', 'B'), e('B', 'C'), e('C', 'D')];
    expect(wouldCreateCycle(edges, 'D', 'A')).toBe(true);
    expect(wouldCreateCycle(edges, 'D', 'B')).toBe(true);
  });
  it('allows a diamond and unrelated additions', () => {
    const edges = [e('A', 'B'), e('A', 'C'), e('B', 'D')];
    expect(wouldCreateCycle(edges, 'C', 'D')).toBe(false);
    expect(wouldCreateCycle(edges, 'X', 'A')).toBe(false);
  });
  it('terminates on existing graphs that already share nodes', () => {
    expect(wouldCreateCycle([e('A', 'B'), e('A', 'C'), e('B', 'D'), e('C', 'D')], 'D', 'Z')).toBe(
      false,
    );
  });
});

describe('hasCycle', () => {
  it('detects direct, indirect and self cycles; passes DAGs', () => {
    expect(hasCycle([e('A', 'B'), e('B', 'A')])).toBe(true);
    expect(hasCycle([e('A', 'B'), e('B', 'C'), e('C', 'A')])).toBe(true);
    expect(hasCycle([e('A', 'A')])).toBe(true);
    expect(hasCycle([e('A', 'B'), e('A', 'C'), e('B', 'D'), e('C', 'D')])).toBe(false);
    expect(hasCycle([])).toBe(false);
  });
});

describe('explodeBom', () => {
  it('multiplies quantities through multiple levels', () => {
    // 1 bike = 2 wheels; 1 wheel = 36 spokes + 1 rim
    const edges = [e('bike', 'wheel', 2), e('wheel', 'spoke', 36), e('wheel', 'rim', 1)];
    const out = explodeBom(edges, 'bike', 1);
    expect(out.get('wheel')).toBe(2);
    expect(out.get('spoke')).toBe(72);
    expect(out.get('rim')).toBe(2);
    expect(out.get('bike')).toBeUndefined();
  });
  it('scales with the parent quantity', () => {
    expect(explodeBom([e('A', 'B', 2.5)], 'A', 4).get('B')).toBe(10);
  });
  it('sums a component reached through several paths (diamond)', () => {
    const edges = [e('A', 'B', 1), e('A', 'C', 1), e('B', 'D', 2), e('C', 'D', 3)];
    expect(explodeBom(edges, 'A', 1).get('D')).toBe(5);
  });
  it('is empty for a product without a BOM and ignores unrelated parents', () => {
    expect(explodeBom([e('X', 'Y')], 'A').size).toBe(0);
  });
  it('throws on cyclic data instead of looping forever', () => {
    expect(() => explodeBom([e('A', 'B'), e('B', 'A')], 'A')).toThrow(/cycle/);
  });
});

describe('buildBomTree', () => {
  it('nests components with per-root totals', () => {
    const tree = buildBomTree(
      [
        { ...e('A', 'B', 2), id: '1' },
        { ...e('B', 'C', 3), id: '2' },
      ],
      'A',
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      productId: 'B',
      quantityPer: 2,
      totalQuantity: 2,
      edgeId: '1',
    });
    expect(tree[0]!.children[0]).toMatchObject({
      productId: 'C',
      quantityPer: 3,
      totalQuantity: 6,
    });
  });
  it('throws on cycles', () =>
    expect(() => buildBomTree([e('A', 'B'), e('B', 'A')], 'A')).toThrow());
});

describe('properties', () => {
  // Edges only go from a lower index to a higher one, so the graph is acyclic by construction.
  const dag = fc
    .array(
      fc.tuple(
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 1, max: 5 }),
      ),
      { maxLength: 20 },
    )
    .map((arr) => arr.filter(([a, b]) => a < b).map(([a, b, q]) => e(`n${a}`, `n${b}`, q)));

  it('forward-only edge sets never contain a cycle', () => {
    fc.assert(fc.property(dag, (edges) => !hasCycle(edges)));
  });

  it('adding the reverse of any existing edge always creates a cycle', () => {
    fc.assert(
      fc.property(dag, (edges) =>
        edges.every((x) => wouldCreateCycle(edges, x.componentId, x.parentId)),
      ),
    );
  });

  it('explosion quantities are positive, finite and scale linearly with the root quantity', () => {
    fc.assert(
      fc.property(dag, fc.integer({ min: 1, max: 50 }), (edges, k) => {
        const one = explodeBom(edges, 'n0', 1);
        const many = explodeBom(edges, 'n0', k);
        for (const [id, q] of one) {
          expect(q).toBeGreaterThan(0);
          expect(Number.isFinite(q)).toBe(true);
          expect(many.get(id)).toBeCloseTo(q * k, 6);
        }
        expect([...many.keys()].sort()).toEqual([...one.keys()].sort());
      }),
    );
  });

  it('every explosion key is reachable from the root', () => {
    fc.assert(
      fc.property(dag, (edges) => {
        const out = explodeBom(edges, 'n0');
        for (const id of out.keys()) expect(edges.some((x) => x.componentId === id)).toBe(true);
      }),
    );
  });
});
