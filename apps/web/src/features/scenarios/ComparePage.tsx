import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { errText } from '../../components/ui';
import { scenarioApi } from './api';
import { DeltaBadge, KPI_LABELS, formatKpi } from './Kpis';
import { AtRiskTable } from './ScenarioPage';

export function ComparePage() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
  const { data, isLoading, error } = useQuery({
    queryKey: ['compare', ids.join(',')],
    queryFn: () => scenarioApi.compare(ids),
    enabled: ids.length > 0,
  });
  const [tab, setTab] = useState(0);
  if (ids.length === 0) return <p role="alert">Pick at least one scenario to compare.</p>;
  if (isLoading) return <p>Loading…</p>;
  if (error || !data) return <p role="alert">{errText(error)}</p>;
  const colors = ['var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
  const axis = { fontSize: 12, fill: 'var(--chart-ink-2)' };
  const chart = data.baseline.totals.map((w, i) => ({
    weekStart: w.weekStart,
    baseline: w.onHand,
    ...Object.fromEntries(data.scenarios.map((s, j) => [`s${j}`, s.totals[i]?.onHand ?? 0])),
  }));
  const active = data.scenarios[Math.min(tab, data.scenarios.length - 1)]!;

  return (
    <section className="space-y-6">
      <div>
        <Link to="/scenarios" className="text-sm text-blue-600 underline">
          ← Scenarios
        </Link>
        <h1 className="mt-1 text-2xl font-bold">Scenario comparison</h1>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="kpi-compare">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2">KPI</th>
              <th>Baseline</th>
              {data.scenarios.map((s) => (
                <th key={s.id}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {KPI_LABELS.map(({ key, label }) => (
              <tr key={key} className="border-b align-top" data-testid={`row-${key}`}>
                <td className="py-2 font-medium">{label}</td>
                <td>{formatKpi(key, data.baseline.kpis[key])}</td>
                {data.scenarios.map((s) => (
                  <td key={s.id} data-testid={`cell-${key}-${s.name}`}>
                    <div className="font-semibold">{formatKpi(key, s.kpis[key])}</div>
                    <DeltaBadge k={key} baseline={data.baseline.kpis[key]} value={s.kpis[key]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <figure className="rounded-lg border border-gray-200 p-4">
        <figcaption className="mb-2 font-semibold">
          Projected inventory (all products, units)
        </figcaption>
        <div
          style={{ height: 320 }}
          role="img"
          aria-label="Projected inventory per week: baseline and scenarios"
        >
          <ResponsiveContainer>
            <LineChart data={chart}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis
                dataKey="weekStart"
                tick={axis}
                tickFormatter={(d: string) => d.slice(5)}
                stroke="var(--chart-grid)"
              />
              <YAxis tick={axis} width={64} stroke="var(--chart-grid)" />
              <Tooltip />
              <Legend />
              <Line
                dataKey="baseline"
                name="Baseline"
                stroke="var(--series-1)"
                strokeWidth={2}
                dot={false}
              />
              {data.scenarios.map((s, j) => (
                <Line
                  key={s.id}
                  dataKey={`s${j}`}
                  name={s.name}
                  stroke={colors[j]}
                  strokeWidth={2}
                  strokeDasharray={j ? '6 4' : undefined}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </figure>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Products at risk</h2>
        <div role="tablist" className="mb-3 flex gap-2 border-b">
          {data.scenarios.map((s, i) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={tab === i}
              onClick={() => setTab(i)}
              className={`px-3 py-2 text-sm ${tab === i ? 'border-b-2 border-blue-600 font-semibold' : 'text-gray-600'}`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <ul className="mb-2 text-xs text-gray-600">
          {active.levers.map((l, i) => (
            <li key={i}>• {l.summary}</li>
          ))}
        </ul>
        <AtRiskTable rows={active.atRisk} />
      </div>
    </section>
  );
}
