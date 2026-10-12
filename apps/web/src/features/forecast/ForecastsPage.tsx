import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FORECAST_MODELS, MODEL_LABELS } from '@supplycast/shared';
import { Notice, errText, inputCls } from '../../components/ui';
import { formatDate } from '../../lib';
import { Can } from '../auth/Can';
import { mdApi } from '../masterdata/api';
import { forecastApi } from './api';

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'DONE'
      ? 'bg-green-100 text-green-800'
      : status === 'FAILED'
        ? 'bg-red-100 text-red-800'
        : 'bg-amber-100 text-amber-800';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Progress"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-32 rounded bg-gray-100"
    >
      <div className="h-2 rounded" style={{ width: `${value}%`, background: 'var(--series-1)' }} />
    </div>
  );
}

export function ForecastsPage() {
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ['forecast-runs'],
    queryFn: forecastApi.runs,
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.status === 'PENDING' || r.status === 'RUNNING')
        ? 1500
        : false,
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: mdApi.categories });
  const locations = useQuery({ queryKey: ['locations'], queryFn: mdApi.locations });
  const products = useQuery({
    queryKey: ['products', 'all'],
    queryFn: () => mdApi.products('pageSize=100'),
  });
  const [horizon, setHorizon] = useState('26');
  const [method, setMethod] = useState('AUTO');
  const [categoryId, setCategoryId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [productId, setProductId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      forecastApi.createRun({
        horizonWeeks: Number(horizon),
        method,
        filters: {
          ...(categoryId && { categoryId }),
          ...(locationId && { locationId }),
          ...(productId && { productId }),
        },
      }),
    onSuccess: () => {
      setErr(null);
      setMsg('Forecast run started. It runs in the background.');
      void qc.invalidateQueries({ queryKey: ['forecast-runs'] });
      void qc.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (e) => {
      setErr(errText(e));
      setMsg(null);
    },
  });

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-bold">Forecasts</h1>
      <Can permission="forecast:run">
        <form
          aria-label="New forecast run"
          className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <label>
            Horizon (weeks)
            <input
              type="number"
              min={4}
              max={52}
              required
              value={horizon}
              onChange={(e) => setHorizon(e.target.value)}
              className={`${inputCls} w-24`}
            />
          </label>
          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
              <option value="AUTO">Automatic (best model per series)</option>
              {FORECAST_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select
              aria-label="Category filter"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={inputCls}
            >
              <option value="">All</option>
              {categories.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parentId ? '— ' : ''}
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Location
            <select
              aria-label="Location filter"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className={inputCls}
            >
              <option value="">All</option>
              {locations.data?.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Product
            <select
              aria-label="Product filter"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className={inputCls}
            >
              <option value="">All</option>
              {products.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={start.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
          >
            Run forecast
          </button>
        </form>
      </Can>
      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice kind="success">{msg}</Notice>}

      <div>
        <h2 className="mb-2 text-lg font-semibold">Runs</h2>
        {runs.data && runs.data.items.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="no-runs">
            No forecast runs yet.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b text-gray-500">
              <tr>
                <th className="py-2">Started</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Series</th>
                <th>Horizon</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {runs.data?.items.map((r) => (
                <tr key={r.id} className="border-b" data-testid={`run-${r.id}`}>
                  <td className="py-2">
                    <Link to={`/forecasts/${r.id}`} className="text-blue-600 underline">
                      {formatDate(r.createdAt)}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>
                    <ProgressBar value={r.progress} />
                  </td>
                  <td>
                    {r.seriesDone}/{r.seriesTotal}
                    {r.seriesFailed > 0 && (
                      <span className="ml-1 text-red-700">({r.seriesFailed} failed)</span>
                    )}
                  </td>
                  <td>{r.horizonWeeks} wk</td>
                  <td>
                    {r.method === 'AUTO'
                      ? 'Automatic'
                      : (MODEL_LABELS[r.method as keyof typeof MODEL_LABELS] ?? r.method)}
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
