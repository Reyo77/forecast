import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Bar,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartCard, ChartTooltip, axisProps, compact, gridProps } from '../../components/charts';
import { EmptyState, Notice, PageHeader, StatTile, errText } from '../../components/ui';
import { formatMoney } from '../../lib';
import { insightsApi } from './api';

const CLASS_COLOR = { A: 'var(--series-1)', B: 'var(--series-2)', C: 'var(--series-3)' } as const;
const CLASS_HELP = {
  A: 'Your stars: protect their stock first.',
  B: 'Solid middle: review regularly.',
  C: 'Long tail: keep lean, automate.',
} as const;

/** Pareto view of revenue: which few products carry the business. */
export function AbcPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['abc'], queryFn: insightsApi.abc });
  const top = (data?.rows ?? []).slice(0, 15);
  return (
    <section className="space-y-5">
      <PageHeader
        title="ABC analysis"
        subtitle={
          data?.from
            ? `Products ranked by revenue, ${data.from} → ${data.to}.`
            : 'Products ranked by revenue over the last 52 weeks.'
        }
      />
      {error && <Notice kind="error">{errText(error)}</Notice>}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && data.rows.length === 0 && (
        <EmptyState title="No sales yet" testId="abc-empty">
          <Link to="/import" className="font-medium text-blue-600 underline">
            Import sales
          </Link>{' '}
          to see which products matter most.
        </EmptyState>
      )}
      {data && data.rows.length > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {data.summary.map((s) => (
              <StatTile
                key={s.class}
                testId={`abc-${s.class}`}
                label={`Class ${s.class}`}
                value={`${s.sharePct}%`}
                hint={`${s.products} product${s.products === 1 ? '' : 's'} · ${CLASS_HELP[s.class]}`}
                icon={<span className="text-lg font-bold">{s.class}</span>}
                tone={s.class === 'A' ? 'indigo' : s.class === 'B' ? 'amber' : 'green'}
              />
            ))}
          </div>
          <ChartCard
            title="Revenue by product"
            subtitle="Bars: revenue · line: cumulative share of total"
          >
            <div style={{ height: 320 }} role="img" aria-label="Pareto chart of revenue by product">
              <ResponsiveContainer>
                <ComposedChart data={top} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis
                    dataKey="sku"
                    {...axisProps}
                    interval={0}
                    angle={-30}
                    textAnchor="end"
                    height={56}
                  />
                  <YAxis
                    yAxisId="l"
                    {...axisProps}
                    tickFormatter={(v: number) => `$${compact(v / 100)}`}
                    width={56}
                  />
                  <YAxis
                    yAxisId="r"
                    orientation="right"
                    domain={[0, 100]}
                    {...axisProps}
                    tickFormatter={(v: number) => `${v}%`}
                    width={44}
                  />
                  <Tooltip
                    content={
                      <ChartTooltip
                        format={(v, name) =>
                          name === 'Cumulative share' ? `${v}%` : formatMoney(v)
                        }
                      />
                    }
                  />
                  <Bar
                    yAxisId="l"
                    dataKey="revenueCents"
                    name="Revenue"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={36}
                  >
                    {top.map((r) => (
                      <Cell key={r.productId} fill={CLASS_COLOR[r.class]} />
                    ))}
                  </Bar>
                  <Line
                    yAxisId="r"
                    dataKey="cumulativePct"
                    name="Cumulative share"
                    type="monotone"
                    stroke="var(--chart-ink-2)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 flex gap-4 text-xs text-gray-500">
              {(['A', 'B', 'C'] as const).map((c) => (
                <span key={c} className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: CLASS_COLOR[c] }}
                  />{' '}
                  Class {c}
                </span>
              ))}
            </p>
          </ChartCard>
          <div className="card overflow-x-auto p-4">
            <table className="w-full text-left text-sm" data-testid="abc-table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Product</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Share</th>
                  <th className="text-right">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.productId}>
                    <td>
                      <span
                        className="badge text-white"
                        style={{ background: CLASS_COLOR[r.class] }}
                      >
                        {r.class}
                      </span>
                    </td>
                    <td>
                      <span className="font-medium text-gray-900">{r.sku}</span>{' '}
                      <span className="text-gray-500">{r.name}</span>
                    </td>
                    <td className="text-right tabular-nums">{r.units.toLocaleString()}</td>
                    <td className="text-right tabular-nums">{formatMoney(r.revenueCents)}</td>
                    <td className="text-right tabular-nums">{r.sharePct}%</td>
                    <td className="text-right tabular-nums">{r.cumulativePct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
