import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Notice, errText, inputCls } from '../../components/ui';
import { formatDate } from '../../lib';
import { Can } from '../auth/Can';
import { allProducts, mdApi } from './api';

export function InventoryPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'levels' | 'orders'>('levels');
  const levels = useQuery({ queryKey: ['inventory', 'all'], queryFn: () => mdApi.inventory() });
  const orders = useQuery({ queryKey: ['open-orders'], queryFn: mdApi.openOrders });
  const products = useQuery({ queryKey: ['products', 'all'], queryFn: allProducts });
  const locations = useQuery({ queryKey: ['locations'], queryFn: mdApi.locations });
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: mdApi.suppliers });
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [onHand, setOnHand] = useState('');
  const [safety, setSafety] = useState('0');
  const [supplierId, setSupplierId] = useState('');
  const [qty, setQty] = useState('');
  const [date, setDate] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    setErr(null);
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['open-orders'] });
  };
  const bad = (e: unknown) => {
    setErr(errText(e));
    setMsg(null);
  };
  const save = useMutation({
    mutationFn: () =>
      mdApi.saveInventory({
        productId,
        locationId,
        onHand: Number(onHand),
        safetyStock: Number(safety),
      }),
    onSuccess: () => done('Stock level saved.'),
    onError: bad,
  });
  const delLevel = useMutation({
    mutationFn: mdApi.deleteInventory,
    onSuccess: () => done('Stock level removed.'),
    onError: bad,
  });
  const addOrder = useMutation({
    mutationFn: () =>
      mdApi.createOrder({
        productId,
        locationId,
        supplierId: supplierId || null,
        quantity: Number(qty),
        expectedDate: new Date(date).toISOString(),
      }),
    onSuccess: () => done('Open order added.'),
    onError: bad,
  });
  const delOrder = useMutation({
    mutationFn: mdApi.deleteOrder,
    onSuccess: () => done('Open order removed.'),
    onError: bad,
  });

  const pick = (
    <>
      <label>
        Product
        <select
          required
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className={inputCls}
        >
          <option value="">Select…</option>
          {products.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} — {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Location
        <select
          required
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className={inputCls}
        >
          <option value="">Select…</option>
          {locations.data?.items.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Inventory</h1>
      <div role="tablist" className="flex gap-2 border-b">
        {(['levels', 'orders'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm ${tab === t ? 'border-b-2 border-blue-600 font-semibold' : 'text-gray-600'}`}
          >
            {t === 'levels' ? 'Stock levels' : 'Open orders'}
          </button>
        ))}
      </div>
      {msg && <Notice kind="success">{msg}</Notice>}
      {err && <Notice kind="error">{err}</Notice>}

      {tab === 'levels' ? (
        <>
          <Can permission="inventory:write">
            <form
              aria-label="Set stock level"
              className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              {pick}
              <label>
                On hand
                <input
                  type="number"
                  min={0}
                  step="any"
                  required
                  value={onHand}
                  onChange={(e) => setOnHand(e.target.value)}
                  className={`${inputCls} w-24`}
                />
              </label>
              <label>
                Safety stock
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={safety}
                  onChange={(e) => setSafety(e.target.value)}
                  className={`${inputCls} w-24`}
                />
              </label>
              <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
                Save level
              </button>
            </form>
          </Can>
          {levels.data && levels.data.items.length === 0 ? (
            <p className="text-sm text-gray-500">No stock levels recorded.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b text-gray-500">
                <tr>
                  <th className="py-2">Product</th>
                  <th>Location</th>
                  <th>On hand</th>
                  <th>Safety stock</th>
                  <th>As of</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {levels.data?.items.map((i) => (
                  <tr
                    key={i.id}
                    className="border-b"
                    data-testid={`level-${i.productSku}-${i.locationCode}`}
                  >
                    <td className="py-2">
                      {i.productSku} — {i.productName}
                    </td>
                    <td>{i.locationCode}</td>
                    <td>{i.onHand}</td>
                    <td>{i.safetyStock}</td>
                    <td>{formatDate(i.asOfDate)}</td>
                    <td className="text-right">
                      <Can permission="inventory:write">
                        <button
                          onClick={() => delLevel.mutate(i.id)}
                          className="rounded border px-2 py-0.5"
                        >
                          Remove
                        </button>
                      </Can>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <>
          <Can permission="inventory:write">
            <form
              aria-label="Add open order"
              className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                addOrder.mutate();
              }}
            >
              {pick}
              <label>
                Supplier
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">None</option>
                  {suppliers.data?.items.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Quantity
                <input
                  type="number"
                  min={0}
                  step="any"
                  required
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className={`${inputCls} w-24`}
                />
              </label>
              <label>
                Expected date
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className={inputCls}
                />
              </label>
              <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
                Add order
              </button>
            </form>
          </Can>
          {orders.data && orders.data.items.length === 0 ? (
            <p className="text-sm text-gray-500">No open orders.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b text-gray-500">
                <tr>
                  <th className="py-2">Product</th>
                  <th>Location</th>
                  <th>Supplier</th>
                  <th>Qty</th>
                  <th>Expected</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.data?.items.map((o) => (
                  <tr key={o.id} className="border-b" data-testid={`order-${o.id}`}>
                    <td className="py-2">{o.productSku}</td>
                    <td>{o.locationCode}</td>
                    <td>{o.supplierName ?? '—'}</td>
                    <td>{o.quantity}</td>
                    <td>
                      {formatDate(o.expectedDate)}
                      {o.isLate && (
                        <span
                          className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800"
                          data-testid="late-badge"
                        >
                          Late
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      <Can permission="inventory:write">
                        <button
                          onClick={() => delOrder.mutate(o.id)}
                          className="rounded border px-2 py-0.5"
                        >
                          Remove
                        </button>
                      </Can>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
