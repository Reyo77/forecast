import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ProductDto } from '@supplycast/shared';
import { Notice, Pager, errText, inputCls } from '../../components/ui';
import { formatMoney } from '../../lib';
import { Can } from '../auth/Can';
import { mdApi } from './api';

const toCents = (v: string) => Math.round(Number(v || 0) * 100);

function ProductForm({
  initial,
  categories,
  onSave,
  onCancel,
}: {
  initial?: ProductDto;
  categories: { id: string; name: string; parentId: string | null }[];
  onSave: (b: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '');
  const [cost, setCost] = useState(initial ? String(initial.unitCostCents / 100) : '');
  const [price, setPrice] = useState(initial ? String(initial.unitPriceCents / 100) : '');
  const [isComponent, setComponent] = useState(initial?.isComponent ?? false);
  return (
    <form
      aria-label={initial ? 'Edit product' : 'New product'}
      className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          sku,
          name,
          categoryId: categoryId || null,
          unitCostCents: toCents(cost),
          unitPriceCents: toCents(price),
          isComponent,
        });
      }}
    >
      <label>
        SKU
        <input required value={sku} onChange={(e) => setSku(e.target.value)} className={inputCls} />
      </label>
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
        Category
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className={inputCls}
        >
          <option value="">None</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.parentId ? '— ' : ''}
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Unit cost ($)
        <input
          type="number"
          min={0}
          step="0.01"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          className={`${inputCls} w-24`}
        />
      </label>
      <label>
        Unit price ($)
        <input
          type="number"
          min={0}
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className={`${inputCls} w-24`}
        />
      </label>
      <label className="pb-1">
        <input
          type="checkbox"
          checked={isComponent}
          onChange={(e) => setComponent(e.target.checked)}
        />{' '}
        Component
      </label>
      <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
        Save
      </button>
      <button type="button" onClick={onCancel} className="rounded border px-3 py-1.5">
        Cancel
      </button>
    </form>
  );
}

export function ProductsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newCat, setNewCat] = useState('');
  const [newCatParent, setNewCatParent] = useState('');

  const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (q) qs.set('q', q);
  if (categoryId) qs.set('categoryId', categoryId);
  if (active) qs.set('isActive', active);
  const products = useQuery({
    queryKey: ['products', qs.toString()],
    queryFn: () => mdApi.products(qs.toString()),
  });
  const cats = useQuery({ queryKey: ['categories'], queryFn: mdApi.categories });
  const categories = cats.data?.items ?? [];

  const done = (m: string) => {
    setMsg(m);
    setErr(null);
    setCreating(false);
    setEditing(null);
    void qc.invalidateQueries({ queryKey: ['products'] });
    void qc.invalidateQueries({ queryKey: ['categories'] });
    void qc.invalidateQueries({ queryKey: ['billing'] });
  };
  const bad = (e: unknown) => {
    setErr(errText(e));
    setMsg(null);
  };
  const create = useMutation({
    mutationFn: mdApi.createProduct,
    onSuccess: () => done('Product created.'),
    onError: bad,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; b: unknown }) => mdApi.updateProduct(v.id, v.b),
    onSuccess: () => done('Product saved.'),
    onError: bad,
  });
  const del = useMutation({
    mutationFn: mdApi.deleteProduct,
    onSuccess: () => done('Product deleted.'),
    onError: bad,
  });
  const addCat = useMutation({
    mutationFn: () => mdApi.createCategory({ name: newCat, parentId: newCatParent || null }),
    onSuccess: () => {
      setNewCat('');
      done('Category created.');
    },
    onError: bad,
  });
  const delCat = useMutation({
    mutationFn: mdApi.deleteCategory,
    onSuccess: () => done('Category deleted.'),
    onError: bad,
  });

  const pages = products.data
    ? Math.max(1, Math.ceil(products.data.total / products.data.pageSize))
    : 1;
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Products</h1>
        <Can permission="masterdata:write">
          <button
            onClick={() => setCreating((c) => !c)}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white"
          >
            New product
          </button>
        </Can>
      </div>
      {msg && <Notice kind="success">{msg}</Notice>}
      {err && <Notice kind="error">{err}</Notice>}
      {creating && (
        <ProductForm
          categories={categories}
          onCancel={() => setCreating(false)}
          onSave={(b) => create.mutate(b)}
        />
      )}

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          Search
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="SKU or name"
            className={inputCls}
          />
        </label>
        <label>
          Category
          <select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
            className={inputCls}
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parentId ? '— ' : ''}
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={active}
            onChange={(e) => {
              setActive(e.target.value);
              setPage(1);
            }}
            className={inputCls}
          >
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </label>
      </div>

      {products.isLoading ? (
        <p>Loading…</p>
      ) : products.data && products.data.items.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="empty-products">
          No products found.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2">SKU</th>
              <th>Name</th>
              <th>Category</th>
              <th>Cost</th>
              <th>Price</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {products.data?.items.map((p) => (
              <tr key={p.id} className="border-b align-top" data-testid={`product-${p.sku}`}>
                {editing === p.id ? (
                  <td colSpan={7} className="py-2">
                    <ProductForm
                      initial={p}
                      categories={categories}
                      onCancel={() => setEditing(null)}
                      onSave={(b) => update.mutate({ id: p.id, b })}
                    />
                  </td>
                ) : (
                  <>
                    <td className="py-2">
                      <Link className="text-blue-600 underline" to={`/products/${p.id}`}>
                        {p.sku}
                      </Link>
                    </td>
                    <td>
                      {p.name}
                      {p.isComponent && (
                        <span className="ml-1 rounded bg-gray-100 px-1 text-xs">component</span>
                      )}
                    </td>
                    <td>{p.categoryName ?? '—'}</td>
                    <td>{formatMoney(p.unitCostCents)}</td>
                    <td>{formatMoney(p.unitPriceCents)}</td>
                    <td>{p.isActive ? 'Active' : 'Inactive'}</td>
                    <td className="space-x-1 text-right">
                      <Can permission="masterdata:write">
                        <button
                          onClick={() => setEditing(p.id)}
                          className="rounded border px-2 py-0.5"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => update.mutate({ id: p.id, b: { isActive: !p.isActive } })}
                          className="rounded border px-2 py-0.5"
                        >
                          {p.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          onClick={() => del.mutate(p.id)}
                          className="rounded border border-red-300 px-2 py-0.5 text-red-700"
                        >
                          Delete
                        </button>
                      </Can>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager page={page} pages={pages} onPage={setPage} />

      <details className="rounded border border-gray-200 p-4" open>
        <summary className="cursor-pointer font-semibold">Categories</summary>
        <ul className="mt-2 space-y-1 text-sm" data-testid="category-list">
          {categories.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2"
              style={{ paddingLeft: c.parentId ? 20 : 0 }}
            >
              <span>{c.name}</span>
              <span className="text-gray-500">({c.productCount})</span>
              <Can permission="masterdata:write">
                <button
                  onClick={() => delCat.mutate(c.id)}
                  aria-label={`Delete category ${c.name}`}
                  className="text-xs text-red-700 underline"
                >
                  delete
                </button>
              </Can>
            </li>
          ))}
          {categories.length === 0 && <li className="text-gray-500">No categories yet.</li>}
        </ul>
        <Can permission="masterdata:write">
          <form
            className="mt-3 flex flex-wrap items-end gap-2 text-sm"
            aria-label="New category"
            onSubmit={(e) => {
              e.preventDefault();
              addCat.mutate();
            }}
          >
            <label>
              Category name
              <input
                required
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                className={inputCls}
              />
            </label>
            <label>
              Parent
              <select
                value={newCatParent}
                onChange={(e) => setNewCatParent(e.target.value)}
                className={inputCls}
              >
                <option value="">(top level)</option>
                {categories
                  .filter((c) => !c.parentId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <button type="submit" className="rounded border px-3 py-1">
              Add category
            </button>
          </form>
        </Can>
      </details>
    </section>
  );
}
