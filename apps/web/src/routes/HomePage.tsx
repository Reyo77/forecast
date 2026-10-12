import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { METRIC_LABELS, MODEL_LABELS, type UsageLine } from '@supplycast/shared';
import { api } from '../api/client';
import {
  ChartCard,
  ChartTooltip,
  GradientDef,
  SERIES,
  axisProps,
  compact,
  gridProps,
} from '../components/charts';
import { Icon } from '../components/Icon';
import { PageHeader, StatTile } from '../components/ui';
import { formatDate, formatMoney } from '../lib';
import { useAuth } from '../features/auth/AuthContext';
import { Can } from '../features/auth/Can';
import { DemoDataCard } from '../features/sales/DemoDataCard';

interface Dashboard {
  counts: { products: number; locations: number; suppliers: number; lateOrders: number };
  sales: { records: number; from: string | null; to: string | null };
  accuracy: {
    runId: string;
    date: string;
    wape: number | null;
    seriesCount: number;
    backtested: number;
    models: { model: string; count: number }[];
  } | null;
  upcomingStockouts:
    | {
        sku: string;
        location: string;
        firstStockoutDate: string;
        shortage: number;
        revenueAtRiskCents: number;
      }[]
    | null;
  latestRuns: {
    id: string;
    status: string;
    createdAt: string;
    horizonWeeks: number;
    seriesDone: number;
    seriesTotal: number;
  }[];
  usage: UsageLine[];
}

function Card({
  title,
  children,
  testId,
  action,
}: {
  title: string;
  children: React.ReactNode;
  testId: string;
  action?: React.ReactNode;
}) {
  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-5 shadow-card"
      data-testid={testId}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const RUN_TONE: Record<string, string> = {
  DONE: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-rose-50 text-rose-700',
  RUNNING: 'bg-amber-50 text-amber-700',
  PENDING: 'bg-amber-50 text-amber-700',
};

/** Half-circle gauge showing forecast accuracy. */
function AccuracyGauge({ pct }: { pct: number }) {
  const data = [{ v: pct }, { v: 100 - pct }];
  const color = pct >= 75 ? '#10b981' : pct >= 55 ? '#f59e0b' : '#ef4444';
  return (
    <div className="relative mx-auto h-28 w-52">
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="v"
            startAngle={180}
            endAngle={0}
            cx="50%"
            cy="100%"
            innerRadius={62}
            outerRadius={84}
            stroke="none"
            isAnimationActive={false}
          >
            <Cell fill={color} />
            <Cell fill="#eef1f6" />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <p
        className="absolute inset-x-0 bottom-0 text-center text-3xl font-bold tabular-nums text-gray-900"
        data-testid="wape"
      >
        {pct.toFixed(1)}%
      </p>
    </div>
  );
}

export function HomePage() {
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/dashboard'),
    enabled: !isSuper,
  });
  // Sales trend for the chart; a failure here simply hides the chart.
  const trend = useQuery({
    queryKey: ['dashboard-trend'],
    queryFn: () =>
      api<{ series: { points: { weekStart: string; quantity: number }[] }[] }>('/sales/explorer'),
    enabled: !isSuper && !!data && data.sales.records > 0,
    retry: false,
  });

  if (isSuper) return <Navigate to="/admin" replace />;

  const empty = data && data.sales.records === 0;
  const points = (trend.data?.series[0]?.points ?? []).slice(-52);
  const accuracyPct =
    data?.accuracy?.wape != null ? Math.max(0, (1 - Math.min(1, data.accuracy.wape)) * 100) : null;
  const atRiskTotal = data?.upcomingStockouts?.reduce((s, x) => s + x.revenueAtRiskCents, 0) ?? 0;

  return (
    <section className="space-y-6">
      <PageHeader
        title={`Welcome back${user?.name ? `, ${user.name.split(' ')[0]}` : ''}`}
        subtitle="Here is where your supply chain stands today."
        actions={
          <>
            <Can permission="forecast:run">
              <Link
                to="/forecasts"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              >
                <Icon name="trend" className="h-4 w-4" /> New forecast
              </Link>
            </Can>
            <Can permission="scenario:write">
              <Link
                to="/scenarios"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
              >
                <Icon name="flask" className="h-4 w-4" /> What-if scenario
              </Link>
            </Can>
          </>
        }
      />
      <DemoDataCard />
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {(error as Error).message}
        </p>
      )}

      {empty && (
        <section
          className="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-6"
          data-testid="getting-started"
        >
          <h2 className="text-lg font-semibold">Getting started</h2>
          <p className="mt-1 text-sm text-gray-600">Three steps to your first forecast:</p>
          <ol className="mt-3 space-y-2 text-sm">
            {[
              <>Add products, locations and suppliers (or load the demo data above).</>,
              <>
                <Link to="/import" className="font-medium text-blue-600 underline">
                  Import your sales history
                </Link>{' '}
                as a CSV.
              </>,
              <>
                Run a{' '}
                <Link to="/forecasts" className="font-medium text-blue-600 underline">
                  forecast
                </Link>
                , then try a{' '}
                <Link to="/scenarios" className="font-medium text-blue-600 underline">
                  what-if scenario
                </Link>
                .
              </>,
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
                  {i + 1}
                </span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {data && !empty && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Forecast accuracy"
              value={accuracyPct === null ? '—' : `${accuracyPct.toFixed(0)}%`}
              hint="1 − WAPE, latest run"
              icon={<Icon name="trend" />}
              tone="indigo"
            />
            <StatTile
              label="Stockouts ahead"
              value={data.upcomingStockouts?.length ?? '—'}
              hint={
                data.upcomingStockouts?.length
                  ? `${formatMoney(atRiskTotal)} revenue at risk (top 5)`
                  : 'baseline plan'
              }
              icon={<Icon name="shield" />}
              tone={data.upcomingStockouts?.length ? 'red' : 'green'}
            />
            <StatTile
              label="Active products"
              value={data.counts.products}
              hint={`${data.counts.locations} locations · ${data.counts.suppliers} suppliers`}
              icon={<Icon name="box" />}
              tone="sky"
            />
            <StatTile
              label="Late open orders"
              value={data.counts.lateOrders}
              hint={data.counts.lateOrders ? 'need attention' : 'all on time'}
              icon={<Icon name="truck" />}
              tone={data.counts.lateOrders ? 'amber' : 'green'}
            />
          </div>

          {points.length > 1 && (
            <ChartCard
              title="Sales, last 52 weeks"
              subtitle="Units sold per week across all products"
            >
              <div style={{ height: 230 }} role="img" aria-label="Weekly sales trend">
                <ResponsiveContainer>
                  <AreaChart data={points} margin={{ left: 0, right: 8, top: 4 }}>
                    <GradientDef id="dash-fill" color="var(--series-1)" />
                    <CartesianGrid {...gridProps} />
                    <XAxis
                      dataKey="weekStart"
                      {...axisProps}
                      tickFormatter={(d: string) => d.slice(5)}
                      minTickGap={36}
                    />
                    <YAxis {...axisProps} tickFormatter={compact} width={44} />
                    <Tooltip content={<ChartTooltip title={(l) => `Week of ${l}`} />} />
                    <Area
                      type="monotone"
                      dataKey="quantity"
                      name="Units"
                      stroke="var(--series-1)"
                      strokeWidth={2.5}
                      fill="url(#dash-fill)"
                      animationDuration={600}
                      activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="Forecast accuracy"
              testId="card-accuracy"
              action={
                data.accuracy && (
                  <Link
                    to={`/forecasts/${data.accuracy.runId}`}
                    className="text-xs font-medium text-blue-600 hover:underline"
                  >
                    Open the run →
                  </Link>
                )
              }
            >
              {data.accuracy ? (
                <>
                  {data.accuracy.wape === null ? (
                    <p className="text-3xl font-bold" data-testid="wape">
                      —
                    </p>
                  ) : (
                    <AccuracyGauge pct={Math.max(0, (1 - Math.min(1, data.accuracy.wape)) * 100)} />
                  )}
                  <p className="mt-2 text-center text-xs text-gray-500">
                    accurate (1 − WAPE) · {data.accuracy.backtested} of {data.accuracy.seriesCount}{' '}
                    series backtested · run of {formatDate(data.accuracy.date)}
                  </p>
                  <ul className="mt-3 space-y-1 text-sm">
                    {data.accuracy.models.map((m, i) => (
                      <li key={m.model} className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ background: SERIES[i % SERIES.length] }}
                        />
                        {MODEL_LABELS[m.model as keyof typeof MODEL_LABELS] ?? m.model}: {m.count}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-gray-500">
                  No finished forecast yet.{' '}
                  <Link to="/forecasts" className="font-medium text-blue-600 underline">
                    Run one.
                  </Link>
                </p>
              )}
            </Card>

            <Card
              title="Upcoming stockouts (baseline plan)"
              testId="card-stockouts"
              action={
                <Link to="/scenarios" className="text-xs font-medium text-blue-600 hover:underline">
                  Try a what-if →
                </Link>
              }
            >
              {data.upcomingStockouts === null ? (
                <p className="text-sm text-gray-500">Run a forecast to see projected stockouts.</p>
              ) : data.upcomingStockouts.length === 0 ? (
                <p className="text-sm text-emerald-700">No stockouts projected.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Location</th>
                      <th>First stockout</th>
                      <th className="text-right">Revenue at risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.upcomingStockouts.map((s) => (
                      <tr key={`${s.sku}|${s.location}`} data-testid={`stockout-${s.sku}`}>
                        <td className="font-medium text-gray-900">{s.sku}</td>
                        <td>{s.location}</td>
                        <td>{s.firstStockoutDate}</td>
                        <td className="text-right font-medium text-rose-700">
                          {formatMoney(s.revenueAtRiskCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Latest forecast runs" testId="card-runs">
              {data.latestRuns.length === 0 ? (
                <p className="text-sm text-gray-500">No runs yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100 text-sm">
                  {data.latestRuns.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2">
                      <span>
                        <Link
                          to={`/forecasts/${r.id}`}
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {formatDate(r.createdAt)}
                        </Link>
                        <span className="text-gray-500">
                          {' '}
                          · {r.status} · {r.seriesDone}/{r.seriesTotal} series · {r.horizonWeeks} wk
                        </span>
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${RUN_TONE[r.status] ?? 'bg-gray-100'}`}
                        aria-hidden
                      >
                        {r.status === 'DONE' ? '✓' : r.status === 'FAILED' ? '✕' : '…'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Usage vs plan"
              testId="card-usage"
              action={
                <Link to="/billing" className="text-xs font-medium text-blue-600 hover:underline">
                  Plans →
                </Link>
              }
            >
              <ul className="space-y-3 text-sm">
                {data.usage.map((u) => {
                  const pct = u.limit
                    ? Math.min(100, Math.round((u.current / u.limit) * 100))
                    : 100;
                  const tone = pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : 'var(--series-1)';
                  return (
                    <li key={u.metric}>
                      <div className="flex justify-between text-gray-700">
                        <span>{METRIC_LABELS[u.metric]}</span>
                        <span
                          className="tabular-nums text-gray-500"
                          data-testid={`dash-usage-${u.metric}`}
                        >
                          {u.current.toLocaleString()} / {u.limit.toLocaleString()}
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={METRIC_LABELS[u.metric]}
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100"
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, background: tone }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>

          <Card title="Your data" testId="card-data">
            <p className="text-sm">
              {data.counts.products} active products · {data.counts.locations} locations ·{' '}
              {data.counts.suppliers} suppliers
            </p>
            <p className="text-sm text-gray-600">
              Sales history: {data.sales.records.toLocaleString()} weekly records, {data.sales.from}{' '}
              → {data.sales.to}
            </p>
            {data.counts.lateOrders > 0 && (
              <p
                className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800"
                data-testid="late-orders"
              >
                {data.counts.lateOrders} open order(s) are late — see{' '}
                <Link to="/inventory" className="underline">
                  Inventory
                </Link>
                .
              </p>
            )}
          </Card>
        </>
      )}
    </section>
  );
}
