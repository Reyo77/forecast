import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { METRICS, METRIC_LABELS } from '@supplycast/shared';
import { CopyLink } from '../../components/CopyLink';
import { formatDate, formatMoney } from '../../lib';
import { useAuth } from '../auth/AuthContext';
import { adminApi } from './api';

export function TenantDetailPage() {
  const { id } = useParams() as { id: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { startImpersonation } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'tenant', id],
    queryFn: () => adminApi.tenant(id),
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [limits, setLimits] = useState<Record<string, string>>({});

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const ok = (m: string) => {
    setMsg(m);
    setErr(null);
    void refresh();
  };
  const bad = (e: unknown) => {
    setErr((e as Error).message);
    setMsg(null);
  };

  const suspend = useMutation({
    mutationFn: () => adminApi.suspend(id),
    onSuccess: () => ok('Tenant suspended. It takes effect on their next request.'),
    onError: bad,
  });
  const reactivate = useMutation({
    mutationFn: () => adminApi.reactivate(id),
    onSuccess: () => ok('Tenant reactivated.'),
    onError: bad,
  });
  const reset = useMutation({
    mutationFn: () => adminApi.ownerResetLink(id),
    onSuccess: (r) => {
      setLink(r.link);
      ok(`Reset link created for ${r.ownerEmail}.`);
    },
    onError: bad,
  });
  const saveSub = useMutation({
    mutationFn: () => {
      const custom: Record<string, number> = {};
      for (const [k, v] of Object.entries(limits)) if (v !== '') custom[k] = Number(v);
      return adminApi.setSubscription(id, {
        ...(planCode && { planCode }),
        customLimits: Object.keys(custom).length ? custom : null,
      });
    },
    onSuccess: () => ok('Subscription updated.'),
    onError: bad,
  });
  const invoice = useMutation({
    mutationFn: (v: { id: string; status: 'PAID' | 'VOID' }) => adminApi.setInvoice(v.id, v.status),
    onSuccess: () => ok('Invoice updated.'),
    onError: bad,
  });
  const impersonate = useMutation({
    mutationFn: () => startImpersonation(id),
    onSuccess: () => navigate('/'),
    onError: bad,
  });

  if (isLoading) return <p>Loading…</p>;
  if (error || !data) return <p role="alert">{(error as Error)?.message ?? 'Not found'}</p>;
  const { tenant, users, invoices, subscription } = data;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{tenant.name}</h1>
          <p className="text-sm text-gray-600" data-testid="tenant-status">
            {tenant.status} · created {formatDate(tenant.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tenant.status === 'ACTIVE' ? (
            <button
              onClick={() => suspend.mutate()}
              className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
            >
              Suspend
            </button>
          ) : tenant.status === 'SUSPENDED' ? (
            <button
              onClick={() => reactivate.mutate()}
              className="rounded border px-3 py-1.5 text-sm"
            >
              Reactivate
            </button>
          ) : null}
          <button onClick={() => reset.mutate()} className="rounded border px-3 py-1.5 text-sm">
            Owner reset link
          </button>
          <button
            onClick={() => impersonate.mutate()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
          >
            View as owner (read-only)
          </button>
        </div>
      </div>
      {msg && (
        <p role="status" className="rounded bg-green-50 p-2 text-sm text-green-800">
          {msg}
        </p>
      )}
      {err && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
          {err}
        </p>
      )}
      {link && <CopyLink label="Owner password reset link (valid 24 hours)" link={link} />}

      {subscription && (
        <div className="rounded-lg border border-gray-200 p-4">
          <h2 className="font-semibold">Subscription</h2>
          <p className="text-sm text-gray-600" data-testid="sub-summary">
            {subscription.plan.name} · {subscription.status.toLowerCase()} · period ends{' '}
            {formatDate(subscription.periodEnd)}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
            <label>
              Plan
              <select
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value)}
                className="mt-1 block rounded border px-2 py-1"
              >
                <option value="">(unchanged)</option>
                {['free', 'starter', 'pro', 'enterprise'].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {METRICS.map((m) => (
              <label key={m}>
                {METRIC_LABELS[m]} limit
                <input
                  type="number"
                  min={0}
                  placeholder={String(subscription.limits[m])}
                  value={limits[m] ?? ''}
                  onChange={(e) => setLimits({ ...limits, [m]: e.target.value })}
                  className="mt-1 block w-28 rounded border px-2 py-1"
                />
              </label>
            ))}
            <button
              onClick={() => saveSub.mutate()}
              className="rounded bg-blue-600 px-3 py-1.5 text-white"
            >
              Save
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Custom limits override the plan. Leave all blank to clear them.
          </p>
        </div>
      )}

      <div>
        <h2 className="mb-2 font-semibold">Users</h2>
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2">Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b">
                <td className="py-2">{u.name}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{u.isActive ? 'Active' : 'Deactivated'}</td>
                <td>{formatDate(u.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="mb-2 font-semibold">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-gray-500">No invoices.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className="border-b" data-testid={`inv-${i.number}`}>
                  <td className="py-2">{i.number}</td>
                  <td>{i.planName}</td>
                  <td>{formatMoney(i.amountCents)}</td>
                  <td>{i.status}</td>
                  <td className="text-right">
                    {i.status === 'PENDING' && (
                      <button
                        onClick={() => invoice.mutate({ id: i.id, status: 'PAID' })}
                        className="mr-2 rounded border px-2 py-0.5"
                      >
                        Mark paid
                      </button>
                    )}
                    {i.status !== 'VOID' && (
                      <button
                        onClick={() => invoice.mutate({ id: i.id, status: 'VOID' })}
                        className="rounded border px-2 py-0.5"
                      >
                        Void
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
