import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupplierDto } from '@supplycast/shared';
import { Notice, errText, inputCls } from '../../components/ui';
import { formatMoney } from '../../lib';
import { Can } from '../auth/Can';
import { allProducts, mdApi } from './api';

function Links({ supplier }: { supplier: SupplierDto }) {
  const qc = useQueryClient();
  const links = useQuery({
    queryKey: ['supplier-products', supplier.id],
    queryFn: () => mdApi.supplierProducts(supplier.id),
  });
  const products = useQuery({ queryKey: ['products', 'all'], queryFn: allProducts });
  const [productId, setProductId] = useState('');
  const [lead, setLead] = useState(String(supplier.defaultLeadTimeDays));
  const [moq, setMoq] = useState('1');
  const [cost, setCost] = useState('0');
  const [cap, setCap] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['supplier-products'] });
    void qc.invalidateQueries({ queryKey: ['product-suppliers'] });
  };
  const add = useMutation({
    mutationFn: () =>
      mdApi.linkProduct(supplier.id, {
        productId,
        leadTimeDays: Number(lead),
        minOrderQty: Number(moq),
        unitCostCents: Math.round(Number(cost) * 100),
        weeklyCapacity: cap ? Number(cap) : null,
      }),
    onSuccess: () => {
      setErr(null);
      setProductId('');
      refresh();
    },
    onError: (e) => setErr(errText(e)),
  });
  const primary = useMutation({
    mutationFn: (id: string) => mdApi.updateLink(id, { isPrimary: true }),
    onSuccess: refresh,
  });
  const del = useMutation({ mutationFn: mdApi.deleteLink, onSuccess: refresh });
  return (
    <div
      className="mt-2 space-y-2 rounded bg-gray-50 p-3 text-sm"
      data-testid={`links-${supplier.name}`}
    >
      {err && <Notice kind="error">{err}</Notice>}
      {links.data && links.data.items.length > 0 ? (
        <table className="w-full text-left">
          <thead className="text-gray-500">
            <tr>
              <th>Product</th>
              <th>Lead time</th>
              <th>MOQ</th>
              <th>Unit cost</th>
              <th>Weekly cap.</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.data.items.map((l) => (
              <tr key={l.id} data-testid={`link-${l.productSku}`}>
                <td>
                  {l.productSku} — {l.productName}
                  {l.isPrimary && (
                    <span className="ml-1 rounded bg-green-100 px-1 text-xs">primary</span>
                  )}
                </td>
                <td>{l.leadTimeDays} d</td>
                <td>{l.minOrderQty}</td>
                <td>{formatMoney(l.unitCostCents)}</td>
                <td>{l.weeklyCapacity ?? '—'}</td>
                <td className="space-x-1 text-right">
                  <Can permission="masterdata:write">
                    {!l.isPrimary && (
                      <button
                        onClick={() => primary.mutate(l.id)}
                        className="rounded border px-2 py-0.5"
                      >
                        Make primary
                      </button>
                    )}
                    <button
                      onClick={() => del.mutate(l.id)}
                      className="rounded border border-red-300 px-2 py-0.5 text-red-700"
                    >
                      Unlink
                    </button>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-gray-500">No products linked.</p>
      )}
      <Can permission="masterdata:write">
        <form
          aria-label={`Link product to ${supplier.name}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
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
            Lead time (days)
            <input
              type="number"
              min={1}
              max={365}
              required
              value={lead}
              onChange={(e) => setLead(e.target.value)}
              className={`${inputCls} w-20`}
            />
          </label>
          <label>
            MOQ
            <input
              type="number"
              min={0}
              step="any"
              value={moq}
              onChange={(e) => setMoq(e.target.value)}
              className={`${inputCls} w-20`}
            />
          </label>
          <label>
            Unit cost ($)
            <input
              type="number"
              min={0}
              step="0.01"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              className={`${inputCls} w-20`}
            />
          </label>
          <label>
            Weekly capacity
            <input
              type="number"
              min={0}
              step="any"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className={`${inputCls} w-24`}
            />
          </label>
          <button type="submit" className="rounded border px-3 py-1">
            Link product
          </button>
        </form>
      </Can>
    </div>
  );
}

export function SuppliersPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['suppliers'], queryFn: mdApi.suppliers });
  const [name, setName] = useState('');
  const [lead, setLead] = useState('14');
  const [rel, setRel] = useState('95');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    setErr(null);
    void qc.invalidateQueries({ queryKey: ['suppliers'] });
  };
  const bad = (e: unknown) => {
    setErr(errText(e));
    setMsg(null);
  };
  const create = useMutation({
    mutationFn: () =>
      mdApi.createSupplier({
        name,
        defaultLeadTimeDays: Number(lead),
        reliabilityPct: Number(rel),
      }),
    onSuccess: () => {
      setName('');
      done('Supplier created.');
    },
    onError: bad,
  });
  const del = useMutation({
    mutationFn: mdApi.deleteSupplier,
    onSuccess: () => done('Supplier deleted.'),
    onError: bad,
  });
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Suppliers</h1>
      {msg && <Notice kind="success">{msg}</Notice>}
      {err && <Notice kind="error">{err}</Notice>}
      <Can permission="masterdata:write">
        <form
          aria-label="New supplier"
          className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </label>
          <label>
            Default lead time (days)
            <input
              type="number"
              required
              value={lead}
              onChange={(e) => setLead(e.target.value)}
              className={`${inputCls} w-24`}
            />
          </label>
          <label>
            Reliability %
            <input
              type="number"
              min={0}
              max={100}
              step="any"
              value={rel}
              onChange={(e) => setRel(e.target.value)}
              className={`${inputCls} w-24`}
            />
          </label>
          <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
            Add supplier
          </button>
        </form>
      </Can>
      {isLoading ? (
        <p>Loading…</p>
      ) : data && data.items.length === 0 ? (
        <p className="text-sm text-gray-500">No suppliers yet.</p>
      ) : (
        <ul className="space-y-2">
          {data?.items.map((s) => (
            <li
              key={s.id}
              className="rounded border border-gray-200 p-3"
              data-testid={`supplier-${s.name}`}
            >
              <div className="flex items-center justify-between text-sm">
                <span>
                  <strong>{s.name}</strong> — {s.defaultLeadTimeDays} days, {s.reliabilityPct}%
                  reliable
                </span>
                <span className="space-x-1">
                  <button
                    onClick={() => setOpen(open === s.id ? null : s.id)}
                    className="rounded border px-2 py-0.5"
                  >
                    {open === s.id ? 'Hide products' : 'Products'}
                  </button>
                  <Can permission="masterdata:write">
                    <button
                      onClick={() => del.mutate(s.id)}
                      className="rounded border border-red-300 px-2 py-0.5 text-red-700"
                    >
                      Delete
                    </button>
                  </Can>
                </span>
              </div>
              {open === s.id && <Links supplier={s} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
