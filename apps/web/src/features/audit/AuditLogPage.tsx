import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Paged } from '@supplycast/shared';
import { api } from '../../api/client';

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: string;
  actor: { id: string; name: string; email: string } | null;
}

export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (action) qs.set('action', action);
  if (from) qs.set('from', new Date(from).toISOString());
  if (to) qs.set('to', new Date(`${to}T23:59:59`).toISOString());

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', qs.toString()],
    queryFn: () => api<Paged<AuditRow>>(`/audit-logs?${qs}`),
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Audit log</h1>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          Action
          <input
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            placeholder="e.g. user."
            className="mt-1 block rounded border px-2 py-1"
          />
        </label>
        <label>
          From
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className="mt-1 block rounded border px-2 py-1"
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            className="mt-1 block rounded border px-2 py-1"
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {(error as Error).message}
        </p>
      )}
      {isLoading ? (
        <p>Loading…</p>
      ) : data && data.items.length === 0 ? (
        <p className="text-sm text-gray-500">No audit entries match.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2">When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id} className="border-b" data-testid="audit-row">
                <td className="py-2">{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.actor?.email ?? '—'}</td>
                <td className="font-mono">{r.action}</td>
                <td>{r.entityType}</td>
                <td className="max-w-xs truncate font-mono text-xs">
                  {r.metadata ? JSON.stringify(r.metadata) : ''}
                </td>
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
