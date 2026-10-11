import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { METRICS, METRIC_LABELS, type Limits } from '@supplycast/shared';
import { formatMoney } from '../../lib';
import { adminApi, type AdminPlan } from './api';

const blankLimits = (): Limits => ({
  users: 5,
  skus: 500,
  locations: 3,
  scenarios: 20,
  forecastRuns: 100,
  aiRequests: 300,
  historyMonths: 36,
});
const LIMIT_KEYS = [...METRICS, 'historyMonths'] as (keyof Limits)[];
const label = (k: keyof Limits) =>
  k === 'historyMonths' ? 'History (months)' : METRIC_LABELS[k as (typeof METRICS)[number]];

function PlanForm({
  initial,
  onSave,
  onCancel,
  isNew,
}: {
  initial?: AdminPlan;
  onSave: (v: {
    code: string;
    name: string;
    priceCents: number;
    limits: Limits;
    isActive: boolean;
    isPublic: boolean;
    isCustom: boolean;
  }) => void;
  onCancel?: () => void;
  isNew?: boolean;
}) {
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [price, setPrice] = useState(String((initial?.priceCents ?? 0) / 100));
  const [limits, setLimits] = useState<Limits>(initial?.limits ?? blankLimits());
  const [isActive, setActive] = useState(initial?.isActive ?? true);
  const [isPublic, setPublic] = useState(initial?.isPublic ?? true);
  const [isCustom] = useState(initial?.isCustom ?? false);
  return (
    <form
      aria-label={isNew ? 'New plan' : `Edit ${initial?.name}`}
      className="space-y-3 rounded border border-gray-200 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          code,
          name,
          priceCents: Math.round(Number(price) * 100),
          limits,
          isActive,
          isPublic,
          isCustom,
        });
      }}
    >
      <div className="flex flex-wrap gap-3">
        {isNew && (
          <label>
            Code
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mt-1 block rounded border px-2 py-1"
            />
          </label>
        )}
        <label>
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block rounded border px-2 py-1"
          />
        </label>
        <label>
          Price (USD / month)
          <input
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="mt-1 block w-28 rounded border px-2 py-1"
          />
        </label>
        {LIMIT_KEYS.map((k) => (
          <label key={k}>
            {label(k)}
            <input
              type="number"
              min={0}
              value={limits[k]}
              onChange={(e) => setLimits({ ...limits, [k]: Number(e.target.value) })}
              className="mt-1 block w-24 rounded border px-2 py-1"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <label>
          <input type="checkbox" checked={isActive} onChange={(e) => setActive(e.target.checked)} />{' '}
          Active
        </label>
        <label>
          <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />{' '}
          Public
        </label>
        <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-white">
          Save
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded border px-3 py-1.5">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function PlansAdminPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: adminApi.plans,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    setErr(null);
    setEditing(null);
    setCreating(false);
    void qc.invalidateQueries({ queryKey: ['admin', 'plans'] });
    void qc.invalidateQueries({ queryKey: ['plans'] });
  };
  const bad = (e: unknown) => {
    setErr((e as Error).message);
    setMsg(null);
  };
  const create = useMutation({
    mutationFn: adminApi.createPlan,
    onSuccess: () => done('Plan created.'),
    onError: bad,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; body: Parameters<typeof adminApi.updatePlan>[1] }) =>
      adminApi.updatePlan(v.id, v.body),
    onSuccess: () => done('Plan saved.'),
    onError: bad,
  });
  const del = useMutation({
    mutationFn: adminApi.deletePlan,
    onSuccess: () => done('Plan deleted.'),
    onError: bad,
  });

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p role="alert">{(error as Error).message}</p>;
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Plans</h1>
        <button
          onClick={() => setCreating((c) => !c)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
        >
          New plan
        </button>
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
      {creating && (
        <PlanForm
          isNew
          onCancel={() => setCreating(false)}
          onSave={(v) => create.mutate({ ...v, sortOrder: 100 })}
        />
      )}
      <ul className="space-y-3">
        {data?.items.map((p) => (
          <li
            key={p.id}
            data-testid={`admin-plan-${p.code}`}
            className="rounded-lg border border-gray-200 p-4"
          >
            {editing === p.id ? (
              <PlanForm
                initial={p}
                onCancel={() => setEditing(null)}
                onSave={(v) =>
                  update.mutate({
                    id: p.id,
                    body: {
                      name: v.name,
                      priceCents: v.priceCents,
                      limits: v.limits,
                      isActive: v.isActive,
                      isPublic: v.isPublic,
                    },
                  })
                }
              />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {p.name} <span className="font-normal text-gray-500">({p.code})</span>
                  </p>
                  <p className="text-sm text-gray-600">
                    {p.isCustom ? 'Custom price' : formatMoney(p.priceCents)} · {p.limits.users}{' '}
                    users · {p.limits.skus.toLocaleString()} SKUs · {p.subscriberCount}{' '}
                    subscriber(s) · {p.isActive ? 'active' : 'inactive'} ·{' '}
                    {p.isPublic ? 'public' : 'private'}
                  </p>
                </div>
                <div className="flex gap-2 text-sm">
                  <button onClick={() => setEditing(p.id)} className="rounded border px-3 py-1">
                    Edit
                  </button>
                  <button
                    onClick={() => update.mutate({ id: p.id, body: { isActive: !p.isActive } })}
                    className="rounded border px-3 py-1"
                  >
                    {p.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    onClick={() => del.mutate(p.id)}
                    className="rounded border border-red-300 px-3 py-1 text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
