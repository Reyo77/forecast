import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AtRiskDto } from '@supplycast/shared';
import { Notice, errText, inputCls } from '../../components/ui';
import { formatMoney } from '../../lib';
import { Can } from '../auth/Can';
import { scenarioApi } from './api';
import { KpiCards } from './Kpis';
import { LeverForm } from './LeverForm';

export function AtRiskTable({ rows }: { rows: AtRiskDto[] }) {
  const [sort, setSort] = useState<'week' | 'shortage' | 'revenue'>('week');
  const [dir, setDir] = useState<1 | -1>(1);
  const sorted = useMemo(() => {
    const val = (r: AtRiskDto) =>
      sort === 'week'
        ? r.firstStockoutWeek
        : sort === 'shortage'
          ? r.shortage
          : r.revenueAtRiskCents;
    return [...rows].sort((a, b) => (val(a) - val(b)) * dir);
  }, [rows, sort, dir]);
  const th = (key: typeof sort, label: string) => (
    <button
      onClick={() => {
        if (sort === key) setDir((d) => (d === 1 ? -1 : 1));
        else {
          setSort(key);
          setDir(key === 'week' ? 1 : -1);
        }
      }}
      aria-label={`Sort by ${label}`}
      className="font-semibold"
    >
      {label}
      {sort === key ? (dir === 1 ? ' ▲' : ' ▼') : ''}
    </button>
  );
  if (rows.length === 0)
    return (
      <p className="text-sm text-green-700" data-testid="no-risk">
        No products at risk of stocking out.
      </p>
    );
  return (
    <table className="w-full text-left text-sm" data-testid="at-risk-table">
      <thead className="border-b text-gray-500">
        <tr>
          <th className="py-2">Product</th>
          <th>Location</th>
          <th>{th('week', 'First stockout')}</th>
          <th>{th('shortage', 'Shortage')}</th>
          <th>{th('revenue', 'Revenue at risk')}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr
            key={`${r.productId}|${r.locationId}`}
            className="border-b"
            data-testid={`risk-${r.productSku}-${r.locationCode}`}
          >
            <td className="py-1">
              {r.productSku} <span className="text-gray-500">{r.productName}</span>
            </td>
            <td>{r.locationCode}</td>
            <td>
              {r.firstStockoutDate} (wk {r.firstStockoutWeek + 1})
            </td>
            <td>{Math.round(r.shortage).toLocaleString()}</td>
            <td>{formatMoney(r.revenueAtRiskCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ScenarioPage() {
  const { id } = useParams() as { id: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['scenario', id],
    queryFn: () => scenarioApi.get(id),
    refetchInterval: (query) => (query.state.data?.scenario.status === 'RUNNING' ? 1500 : false),
  });
  const [err, setErr] = useState<string | null>(null);
  const [productId, setProductId] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['scenario', id] });
  const addLever = useMutation({
    mutationFn: (l: unknown) => scenarioApi.addLever(id, l),
    onSuccess: () => {
      setErr(null);
      void refresh();
    },
    onError: (e) => setErr(errText(e)),
  });
  const removeLever = useMutation({
    mutationFn: (leverId: string) => scenarioApi.removeLever(id, leverId),
    onSuccess: () => void refresh(),
    onError: (e) => setErr(errText(e)),
  });
  const run = useMutation({
    mutationFn: () => scenarioApi.run(id),
    onSuccess: () => {
      setErr(null);
      void refresh();
    },
    onError: (e) => setErr(errText(e)),
  });
  const del = useMutation({
    mutationFn: () => scenarioApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scenarios'] });
      navigate('/scenarios');
    },
    onError: (e) => setErr(errText(e)),
  });

  const latest = q.data?.latestRun ?? null;
  const done = latest?.status === 'DONE' ? latest : null;
  const atRisk = done?.atRisk?.scenario ?? [];
  const firstProduct = atRisk[0]?.productId ?? '';
  const chosen = productId || firstProduct;
  const series = useQuery({
    queryKey: ['scenario-series', latest?.id, chosen],
    queryFn: () => scenarioApi.series(latest!.id, chosen),
    enabled: !!done && !!chosen,
  });

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error || !q.data) return <p role="alert">{errText(q.error)}</p>;
  const { scenario, levers } = q.data;
  const axis = { fontSize: 12, fill: 'var(--chart-ink-2)' };
  const running =
    scenario.status === 'RUNNING' || latest?.status === 'RUNNING' || latest?.status === 'PENDING';

  return (
    <section className="space-y-6">
      <div>
        <Link to="/scenarios" className="text-sm text-blue-600 underline">
          ← Scenarios
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{scenario.name}</h1>
          <span
            className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium"
            data-testid="scenario-status"
          >
            {scenario.status}
          </span>
          <div className="ml-auto flex gap-2">
            <Can permission="scenario:write">
              <button
                onClick={() => run.mutate()}
                disabled={running || run.isPending}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-60"
              >
                {running ? 'Running…' : 'Run scenario'}
              </button>
              <button
                onClick={() => del.mutate()}
                className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
              >
                Delete
              </button>
            </Can>
          </div>
        </div>
        {scenario.description && <p className="text-sm text-gray-600">{scenario.description}</p>}
      </div>
      {err && <Notice kind="error">{err}</Notice>}

      <div>
        <h2 className="mb-2 text-lg font-semibold">Levers</h2>
        {levers.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="no-levers">
            No levers yet — the scenario equals the baseline plan.
          </p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="lever-list">
            {levers.map((l) => (
              <li
                key={l.id}
                className="flex items-center gap-2 rounded border border-gray-200 px-3 py-1.5"
                data-testid="lever"
              >
                <span>{l.summary}</span>
                <Can permission="scenario:write">
                  <button
                    onClick={() => removeLever.mutate(l.id)}
                    aria-label={`Remove lever ${l.summary}`}
                    className="ml-auto text-xs text-red-700 underline"
                  >
                    remove
                  </button>
                </Can>
              </li>
            ))}
          </ul>
        )}
        <Can permission="scenario:write">
          <div className="mt-3">
            <LeverForm busy={addLever.isPending} onSubmit={(l) => addLever.mutate(l)} />
          </div>
        </Can>
      </div>

      {latest?.status === 'FAILED' && (
        <Notice kind="error">{latest.error ?? 'The run failed'}</Notice>
      )}
      {latest && latest.status !== 'DONE' && latest.status !== 'FAILED' && (
        <p className="text-sm text-amber-700" data-testid="run-progress">
          Computing the baseline and scenario plans…
        </p>
      )}

      {done && done.kpis && (
        <>
          <div>
            <h2 className="mb-2 text-lg font-semibold">Results vs baseline</h2>
            <KpiCards baseline={done.kpis.baseline} scenario={done.kpis.scenario} />
            {scenario.status === 'DRAFT' && (
              <p className="mt-2 text-xs text-amber-700">
                Levers changed since this run — run the scenario again to update.
              </p>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-lg font-semibold">Products at risk (scenario)</h2>
            <AtRiskTable rows={atRisk} />
          </div>
          <div className="space-y-2 rounded-lg border border-gray-200 p-4">
            <label className="text-sm">
              Projected inventory for
              <select
                aria-label="Product to chart"
                value={chosen}
                onChange={(e) => setProductId(e.target.value)}
                className={`${inputCls} ml-2 inline-block`}
              >
                {[
                  ...new Map(
                    [...(done.atRisk?.baseline ?? []), ...atRisk].map((r) => [r.productId, r]),
                  ).values(),
                ].map((r) => (
                  <option key={r.productId} value={r.productId}>
                    {r.productSku}
                  </option>
                ))}
              </select>
            </label>
            {series.data && (
              <div
                style={{ height: 300 }}
                role="img"
                aria-label="Projected on-hand inventory, baseline versus scenario"
              >
                <ResponsiveContainer>
                  <ComposedChart
                    data={series.data.weeks.map((w) => ({
                      weekStart: w.weekStart,
                      baseline: w.baseline.onHand,
                      scenario: w.scenario.onHand,
                    }))}
                  >
                    <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                    <XAxis
                      dataKey="weekStart"
                      tick={axis}
                      tickFormatter={(d: string) => d.slice(5)}
                      stroke="var(--chart-grid)"
                    />
                    <YAxis tick={axis} width={56} stroke="var(--chart-grid)" />
                    <Tooltip />
                    <Legend />
                    <Line
                      dataKey="baseline"
                      name="Baseline"
                      stroke="var(--series-1)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      dataKey="scenario"
                      name="Scenario"
                      stroke="var(--series-2)"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
