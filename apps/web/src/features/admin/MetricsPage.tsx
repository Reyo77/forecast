import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney } from '../../lib';
import { ChartTooltip } from '../../components/charts';
import { adminApi } from './api';

function Tile({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4" data-testid={`tile-${id}`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function ChartCard({
  title,
  table,
  children,
}: {
  title: string;
  table: React.ReactNode;
  children: React.ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="rounded-lg border border-gray-200 p-4">
      <figcaption className="mb-2 flex items-center justify-between">
        <span className="font-semibold">{title}</span>
        <button className="text-xs text-blue-600 underline" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'View as table'}
        </button>
      </figcaption>
      {asTable ? table : children}
    </figure>
  );
}

export function MetricsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: adminApi.metrics,
  });
  if (isLoading) return <p>Loading…</p>;
  if (error || !data) return <p role="alert">{(error as Error)?.message}</p>;
  const m = data;
  const axis = { fontSize: 11, fill: '#64748b' };
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-bold">Platform overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile id="mrr" label="MRR" value={formatMoney(m.mrrCents)} />
        <Tile id="tenants" label="Tenants" value={String(m.totalTenants)} />
        <Tile id="users" label="Users" value={String(m.totalUsers)} />
        <Tile
          id="conversion"
          label="Trial conversion"
          value={`${Math.round(m.trials.conversionRate * 100)}% (${m.trials.converted}/${m.trials.started})`}
        />
        <Tile id="failed-jobs" label="Failed jobs" value={String(m.failedJobs.count)} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Tenants by plan"
          table={
            <table className="w-full text-sm" data-testid="plan-table">
              <tbody>
                {m.tenantsByPlan.map((p) => (
                  <tr key={p.code}>
                    <td>{p.plan}</td>
                    <td className="text-right">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          {m.tenantsByPlan.length === 0 ? (
            <p className="text-sm text-gray-500">No tenants yet.</p>
          ) : (
            <div style={{ height: 220 }} role="img" aria-label="Bar chart of tenants by plan">
              <ResponsiveContainer>
                <BarChart data={m.tenantsByPlan} layout="vertical" margin={{ left: 16 }}>
                  <CartesianGrid horizontal={false} stroke="transparent" strokeDasharray="3 4" />
                  <XAxis type="number" allowDecimals={false} tick={axis} stroke="transparent" />
                  <YAxis
                    type="category"
                    dataKey="plan"
                    tick={axis}
                    stroke="transparent"
                    width={90}
                  />
                  <Tooltip
                    content={<ChartTooltip />}
                    cursor={{ fill: 'var(--chart-grid)', opacity: 0.4 }}
                  />
                  <Bar
                    dataKey="count"
                    name="Tenants"
                    fill="var(--series-1)"
                    radius={[0, 4, 4, 0]}
                    barSize={18}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>
        <ChartCard
          title="AI requests per day (30 days)"
          table={
            <table className="w-full text-sm" data-testid="ai-table">
              <tbody>
                {m.aiRequestsPerDay.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className="text-right">{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <div style={{ height: 220 }} role="img" aria-label="Bar chart of AI requests per day">
            <ResponsiveContainer>
              <BarChart data={m.aiRequestsPerDay}>
                <CartesianGrid vertical={false} stroke="transparent" strokeDasharray="3 4" />
                <XAxis
                  dataKey="date"
                  tick={axis}
                  tickFormatter={(d: string) => d.slice(5)}
                  interval={6}
                  stroke="transparent"
                />
                <YAxis allowDecimals={false} tick={axis} stroke="transparent" width={32} />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ fill: 'var(--chart-grid)', opacity: 0.4 }}
                />
                <Bar
                  dataKey="count"
                  name="Requests"
                  fill="var(--series-1)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={14}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>
      <div>
        <h2 className="mb-2 text-lg font-semibold">Recent failed jobs</h2>
        {m.failedJobs.recent.length === 0 ? (
          <p className="text-sm text-gray-500">No failed jobs.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {m.failedJobs.recent.map((j) => (
              <li key={j.id} className="font-mono">
                {j.type}: {j.lastError}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
