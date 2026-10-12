import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { BomNode } from '@supplycast/shared';
import { Notice, errText, inputCls } from '../../components/ui';
import { formatMoney } from '../../lib';
import { Can } from '../auth/Can';
import { allProducts, mdApi } from './api';

function Tree({
  nodes,
  onRemove,
  canEdit,
}: {
  nodes: BomNode[];
  onRemove: (id: string) => void;
  canEdit: boolean;
}) {
  return (
    <ul className="ml-4 border-l pl-3">
      {nodes.map((n) => (
        <li
          key={`${n.productId}-${n.bomItemId}`}
          className="py-1 text-sm"
          data-testid={`bom-${n.sku}`}
        >
          <span className="font-mono">{n.sku}</span> {n.name} — {n.quantityPer} per parent
          {n.children.length > 0 || n.quantityPer !== n.totalQuantity ? (
            <span className="text-gray-500"> ({n.totalQuantity} total per 1 unit)</span>
          ) : null}
          {canEdit && n.bomItemId && (
            <button
              onClick={() => onRemove(n.bomItemId!)}
              aria-label={`Remove ${n.sku}`}
              className="ml-2 text-xs text-red-700 underline"
            >
              remove
            </button>
          )}
          {n.children.length > 0 && (
            <Tree nodes={n.children} onRemove={onRemove} canEdit={canEdit} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function ProductDetailPage() {
  const { id } = useParams() as { id: string };
  const qc = useQueryClient();
  const product = useQuery({ queryKey: ['product', id], queryFn: () => mdApi.product(id) });
  const bom = useQuery({ queryKey: ['bom', id], queryFn: () => mdApi.bom(id) });
  const suppliers = useQuery({
    queryKey: ['product-suppliers', id],
    queryFn: () => mdApi.productSuppliers(id),
  });
  const inventory = useQuery({
    queryKey: ['inventory', 'product', id],
    queryFn: () => mdApi.inventory(`&productId=${id}`),
  });
  const products = useQuery({ queryKey: ['products', 'all'], queryFn: allProducts });
  const [component, setComponent] = useState('');
  const [qty, setQty] = useState('1');
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bom'] });
  };
  const add = useMutation({
    mutationFn: () =>
      mdApi.addBom({
        parentProductId: id,
        componentProductId: component,
        quantityPer: Number(qty),
      }),
    onSuccess: () => {
      setErr(null);
      setComponent('');
      refresh();
    },
    onError: (e) => setErr(errText(e)),
  });
  const remove = useMutation({
    mutationFn: mdApi.deleteBom,
    onSuccess: refresh,
    onError: (e) => setErr(errText(e)),
  });

  if (product.isLoading) return <p>Loading…</p>;
  if (product.error || !product.data) return <p role="alert">{errText(product.error)}</p>;
  const p = product.data.product;
  return (
    <section className="space-y-6">
      <div>
        <Link to="/products" className="text-sm text-blue-600 underline">
          ← Products
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          {p.sku} — {p.name}
        </h1>
        <p className="text-sm text-gray-600">
          {p.categoryName ?? 'No category'} · cost {formatMoney(p.unitCostCents)} · price{' '}
          {formatMoney(p.unitPriceCents)} · {p.isActive ? 'active' : 'inactive'}
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Bill of materials</h2>
        {err && <Notice kind="error">{err}</Notice>}
        {bom.data && bom.data.tree.length > 0 ? (
          <div data-testid="bom-tree">
            <Tree nodes={bom.data.tree} canEdit onRemove={(i) => remove.mutate(i)} />
          </div>
        ) : (
          <p className="text-sm text-gray-500">No components defined.</p>
        )}
        <Can permission="masterdata:write">
          <form
            aria-label="Add component"
            className="mt-3 flex flex-wrap items-end gap-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <label>
              Component
              <select
                required
                value={component}
                onChange={(e) => setComponent(e.target.value)}
                className={inputCls}
              >
                <option value="">Select…</option>
                {products.data?.items
                  .filter((x) => x.id !== id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.sku} — {x.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Quantity per unit
              <input
                type="number"
                min={0.0001}
                step="any"
                required
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className={`${inputCls} w-24`}
              />
            </label>
            <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
              Add component
            </button>
          </form>
        </Can>
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Suppliers</h2>
        {suppliers.data && suppliers.data.items.length > 0 ? (
          <ul className="text-sm">
            {suppliers.data.items.map((s) => (
              <li key={s.id} className="py-1" data-testid={`psupplier-${s.supplierName}`}>
                {s.supplierName} — {s.leadTimeDays} days, MOQ {s.minOrderQty},{' '}
                {formatMoney(s.unitCostCents)}
                {s.isPrimary && (
                  <span className="ml-1 rounded bg-green-100 px-1 text-xs">primary</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">
            No suppliers linked. Link one from the{' '}
            <Link to="/suppliers" className="underline">
              Suppliers
            </Link>{' '}
            page.
          </p>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Stock</h2>
        {inventory.data && inventory.data.items.length > 0 ? (
          <ul className="text-sm">
            {inventory.data.items.map((i) => (
              <li key={i.id}>
                {i.locationCode}: {i.onHand} on hand (safety {i.safetyStock})
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">No stock recorded.</p>
        )}
      </div>
    </section>
  );
}
