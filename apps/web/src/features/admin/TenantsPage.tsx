import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatDate } from '../../lib';
import { adminApi } from './api';

export function TenantsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (search) qs.set('search', search);
  if (status) qs.set('status', status);
  if (plan) qs.set('plan', plan);
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'tenants', qs.toString()],
    queryFn: () => adminApi.tenants(qs.toString()),
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Tenants</h1>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          Search
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Name, slug or user email"
            className="mt-1 block rounded border px-2 py-1"
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="mt-1 block rounded border px-2 py-1"
          >
            <option value="">All</option>
            <option>ACTIVE</option>
            <option>SUSPENDED</option>
          </select>
        </label>
        <label>
          Plan
          <select
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              setPage(1);
            }}
            className="mt-1 block rounded border px-2 py-1"
          >
            <option value="">All</option>
            {['free', 'starter', 'pro', 'enterprise'].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p role="alert">{(error as Error).message}</p>}
      {isLoading ? (
        <p>Loading…</p>
      ) : data && data.items.length === 0 ? (
        <p className="text-sm text-gray-500">No tenants match.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2">Tenant</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Users</th>
              <th>Last activity</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((t) => (
              <tr key={t.id} className="border-b" data-testid="tenant-row">
                <td className="py-2">
                  <Link to={`/admin/tenants/${t.id}`} className="text-blue-600 underline">
                    {t.name}
                  </Link>
                </td>
                <td>
                  {t.plan?.name ?? '—'}
                  {t.subscriptionStatus === 'TRIALING' ? ' (trial)' : ''}
                </td>
                <td>{t.status}</td>
                <td>{t.userCount}</td>
                <td>{formatDate(t.lastActivityAt)}</td>
                <td>{formatDate(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center gap-3 text-sm">
        <button
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
          className="rounded border px-3 py-1 disabled:opacity-40"
        >
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button
          disabled={page >= pages}
          onClick={() => setPage((p) => p + 1)}
          className="rounded border px-3 py-1 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </section>
  );
}
