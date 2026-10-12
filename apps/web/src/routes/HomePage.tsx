import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { METRIC_LABELS, MODEL_LABELS, type UsageLine } from '@supplycast/shared';
import { api } from '../api/client';
import { formatDate, formatMoney } from '../lib';
import { useAuth } from '../features/auth/AuthContext';
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
}: {
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="rounded-lg border border-gray-200 p-4" data-testid={testId}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      {children}
    </section>
  );
}

export function HomePage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/dashboard'),
    enabled: user?.role !== 'SUPER_ADMIN',
  });

  if (user?.role === 'SUPER_ADMIN') return <Navigate to="/admin" replace />;

  const empty = data && data.sales.records === 0;
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="mt-1 text-gray-600">Demand forecasting and what-if planning.</p>
      </div>
      <DemoDataCard />
      {isLoading && <p>Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {(error as Error).message}
        </p>
      )}
      {empty && (
        <section
          className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm"
          data-testid="getting-started"
        >
          <h2 className="font-semibold">Getting started</h2>
          <ol className="mt-1 list-decimal pl-5">
            <li>Add products, locations and suppliers (or load the demo data above).</li>
            <li>
              <Link to="/import" className="underline">
                Import your sales history
              </Link>
              .
            </li>
            <li>
              Run a{' '}
              <Link to="/forecasts" className="underline">
                forecast
              </Link>
              , then try a{' '}
              <Link to="/scenarios" className="underline">
                what-if scenario
              </Link>
              .
            </li>
          </ol>
        </section>
      )}
      {data && !empty && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Forecast accuracy" testId="card-accuracy">
            {data.accuracy ? (
              <>
                <p className="text-3xl font-bold" data-testid="wape">
                  {data.accuracy.wape === null
                    ? '—'
                    : `${((1 - Math.min(1, data.accuracy.wape)) * 100).toFixed(1)}%`}
                </p>
                <p className="text-xs text-gray-500">
                  accurate (1 − WAPE) · {data.accuracy.backtested} of {data.accuracy.seriesCount}{' '}
                  series backtested · run of {formatDate(data.accuracy.date)}
                </p>
                <ul className="mt-2 text-sm">
                  {data.accuracy.models.map((m) => (
                    <li key={m.model}>
                      {MODEL_LABELS[m.model as keyof typeof MODEL_LABELS] ?? m.model}: {m.count}
                    </li>
                  ))}
                </ul>
                <Link
                  to={`/forecasts/${data.accuracy.runId}`}
                  className="mt-2 inline-block text-sm text-blue-600 underline"
                >
                  Open the run
                </Link>
              </>
            ) : (
              <p className="text-sm text-gray-500">
                No finished forecast yet.{' '}
                <Link to="/forecasts" className="underline">
                  Run one.
                </Link>
              </p>
            )}
          </Card>

          <Card title="Upcoming stockouts (baseline plan)" testId="card-stockouts">
            {data.upcomingStockouts === null ? (
              <p className="text-sm text-gray-500">Run a forecast to see projected stockouts.</p>
            ) : data.upcomingStockouts.length === 0 ? (
              <p className="text-sm text-green-700">No stockouts projected.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-gray-500">
                  <tr>
                    <th>Product</th>
                    <th>Location</th>
                    <th>First stockout</th>
                    <th>Revenue at risk</th>
                  </tr>
                </thead>
                <tbody>
                  {data.upcomingStockouts.map((s) => (
                    <tr key={`${s.sku}|${s.location}`} data-testid={`stockout-${s.sku}`}>
                      <td>{s.sku}</td>
                      <td>{s.location}</td>
                      <td>{s.firstStockoutDate}</td>
                      <td>{formatMoney(s.revenueAtRiskCents)}</td>
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
              <ul className="text-sm">
                {data.latestRuns.map((r) => (
                  <li key={r.id} className="py-0.5">
                    <Link to={`/forecasts/${r.id}`} className="text-blue-600 underline">
                      {formatDate(r.createdAt)}
                    </Link>{' '}
                    · {r.status} · {r.seriesDone}/{r.seriesTotal} series · {r.horizonWeeks} wk
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Usage vs plan" testId="card-usage">
            <ul className="space-y-2 text-sm">
              {data.usage.map((u) => {
                const pct = u.limit ? Math.min(100, Math.round((u.current / u.limit) * 100)) : 100;
                return (
                  <li key={u.metric}>
                    <div className="flex justify-between">
                      <span>{METRIC_LABELS[u.metric]}</span>
                      <span data-testid={`dash-usage-${u.metric}`}>
                        {u.current.toLocaleString()} / {u.limit.toLocaleString()}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={METRIC_LABELS[u.metric]}
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="mt-1 h-1.5 rounded bg-gray-100"
                    >
                      <div
                        className="h-1.5 rounded"
                        style={{ width: `${pct}%`, background: 'var(--series-1)' }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Your data" testId="card-data">
            <p className="text-sm">
              {data.counts.products} active products · {data.counts.locations} locations ·{' '}
              {data.counts.suppliers} suppliers
            </p>
            <p className="text-sm">
              Sales history: {data.sales.records.toLocaleString()} weekly records, {data.sales.from}{' '}
              → {data.sales.to}
            </p>
            {data.counts.lateOrders > 0 && (
              <p className="mt-1 text-sm font-medium text-red-700" data-testid="late-orders">
                {data.counts.lateOrders} open order(s) are late — see{' '}
                <Link to="/inventory" className="underline">
                  Inventory
                </Link>
                .
              </p>
            )}
          </Card>
        </div>
      )}
    </section>
  );
}
