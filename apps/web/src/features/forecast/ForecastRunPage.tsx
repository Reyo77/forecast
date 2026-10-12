import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { MODEL_LABELS } from '@supplycast/shared';
import { downloadFile } from '../../api/client';
import { Notice, errText, inputCls } from '../../components/ui';
import { formatDate } from '../../lib';
import { Can } from '../auth/Can';
import { mdApi } from '../masterdata/api';
import { ExplainCard } from '../ai/ExplainCard';
import { forecastApi } from './api';
import { ProgressBar, StatusBadge } from './ForecastsPage';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const modelLabel = (m: string) => MODEL_LABELS[m as keyof typeof MODEL_LABELS] ?? m;

export function ForecastRunPage() {
  const { id } = useParams() as { id: string };
  const qc = useQueryClient();
  const run = useQuery({
    queryKey: ['forecast-run', id],
    queryFn: () => forecastApi.run(id),
    refetchInterval: (q) =>
      q.state.data?.run.status === 'PENDING' || q.state.data?.run.status === 'RUNNING'
        ? 1500
        : false,
  });
  const status = run.data?.run.status;
  const [sort, setSort] = useState('wape');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const accuracy = useQuery({
    queryKey: ['forecast-accuracy', id, sort, order, status],
    queryFn: () => forecastApi.accuracy(id, sort, order),
    enabled: status === 'DONE',
  });
  const locations = useQuery({ queryKey: ['locations'], queryFn: mdApi.locations });

  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const rows = accuracy.data?.items ?? [];
  // Default to the first accuracy row so something is on screen as soon as the run finishes.
  useEffect(() => {
    if (!productId && rows[0]) {
      setProductId(rows[0].productId);
      setLocationId(rows[0].locationId);
    }
  }, [rows, productId]);

  const series = useQuery({
    queryKey: ['forecast-series', id, productId, locationId],
    queryFn: () => forecastApi.series(id, productId, locationId),
    enabled: !!productId && status === 'DONE',
  });
  const overrides = useQuery({
    queryKey: ['forecast-overrides', productId, locationId],
    queryFn: () => forecastApi.overrides(productId, locationId),
    enabled: !!productId,
  });
  const [asTable, setAsTable] = useState(false);
  const [week, setWeek] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['forecast-series'] });
    void qc.invalidateQueries({ queryKey: ['forecast-overrides'] });
  };
  const setOv = useMutation({
    mutationFn: () =>
      forecastApi.setOverride({
        productId,
        locationId,
        weekStart: week,
        quantity: Number(qty),
        reason,
      }),
    onSuccess: () => {
      setMsg('Override saved.');
      setErr(null);
      setQty('');
      setReason('');
      refresh();
    },
    onError: (e) => {
      setErr(errText(e));
      setMsg(null);
    },
  });
  const delOv = useMutation({
    mutationFn: forecastApi.deleteOverride,
    onSuccess: () => {
      setMsg('Override removed.');
      refresh();
    },
    onError: (e) => setErr(errText(e)),
  });

  const chartData = useMemo(() => {
    const s = series.data;
    if (!s) return [];
    const hist = s.history.map((p) => ({ weekStart: p.weekStart, history: p.quantity }));
    const fc = s.forecast.map((p) => ({
      weekStart: p.weekStart,
      forecast: p.quantity,
      band: [p.lower, p.upper] as [number, number],
      override: p.override,
    }));
    return [...hist, ...fc];
  }, [series.data]);

  if (run.isLoading) return <p>Loading…</p>;
  if (run.error || !run.data) return <p role="alert">{errText(run.error)}</p>;
  const r = run.data.run;
  const axis = { fontSize: 12, fill: 'var(--chart-ink-2)' };
  const sortBtn = (key: string, label: string) => (
    <button
      onClick={() => {
        if (sort === key) setOrder(order === 'asc' ? 'desc' : 'asc');
        else {
          setSort(key);
          setOrder('desc');
        }
      }}
      aria-label={`Sort by ${label}`}
      className="font-semibold underline-offset-2 hover:underline"
    >
      {label}
      {sort === key ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  );
  const selectedLocationCode = locations.data?.items.find((l) => l.id === locationId)?.code;

  return (
    <section className="space-y-6">
      <div>
        <Link to="/forecasts" className="text-sm text-blue-600 underline">
          ← Forecasts
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">Forecast run</h1>
          <StatusBadge status={r.status} />
          {(r.status === 'PENDING' || r.status === 'RUNNING') && <ProgressBar value={r.progress} />}
          {r.status === 'DONE' && (
            <button
              onClick={() =>
                void downloadFile(`/forecasts/runs/${id}/export.csv`, `forecast-${id}.csv`).catch(
                  (e) => setErr(errText(e)),
                )
              }
              className="ml-auto rounded border px-3 py-1 text-sm"
            >
              Export CSV
            </button>
          )}
        </div>
        <p className="text-sm text-gray-600" data-testid="run-summary">
          {r.horizonWeeks} weeks ·{' '}
          {r.method === 'AUTO' ? 'automatic model selection' : modelLabel(r.method)} ·{' '}
          {r.seriesDone}/{r.seriesTotal} series · history through {formatDate(r.asOfWeek)}
        </p>
      </div>
      {r.error && <Notice kind="error">{r.error}</Notice>}
      {r.seriesFailed > 0 && (
        <div
          role="alert"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm"
          data-testid="failures"
        >
          <p className="font-semibold">
            {r.seriesFailed} series could not be forecast; the rest are complete.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {r.failures?.map((f, i) => (
              <li key={i}>{f.error}</li>
            ))}
          </ul>
        </div>
      )}
      {msg && <Notice kind="success">{msg}</Notice>}
      {err && <Notice kind="error">{err}</Notice>}

      {r.status === 'DONE' && (
        <>
          <div className="space-y-3 rounded-lg border border-gray-200 p-4">
            <div className="flex flex-wrap items-end gap-3 text-sm">
              <label>
                Product
                <select
                  aria-label="Chart product"
                  value={`${productId}|${locationId}`}
                  onChange={(e) => {
                    const [p, l] = e.target.value.split('|');
                    setProductId(p!);
                    setLocationId(l!);
                  }}
                  className={inputCls}
                >
                  {rows.map((a) => (
                    <option
                      key={`${a.productId}|${a.locationId}`}
                      value={`${a.productId}|${a.locationId}`}
                    >
                      {a.productSku} @ {a.locationCode}
                    </option>
                  ))}
                </select>
              </label>
              <button className="text-xs text-blue-600 underline" onClick={() => setLocationId('')}>
                Sum all locations
              </button>
            </div>
            {series.data && (
              <>
                <p className="text-sm" data-testid="series-summary">
                  <strong>{series.data.product.sku}</strong> {series.data.product.name} ·{' '}
                  {series.data.location ? series.data.location.code : 'all locations'} · model:{' '}
                  <strong>
                    {series.data.modelUsed === 'mixed'
                      ? 'mixed'
                      : modelLabel(series.data.modelUsed)}
                  </strong>
                  {series.data.accuracy && (
                    <>
                      {' '}
                      · WAPE {pct(series.data.accuracy.wape)} · MAPE{' '}
                      {pct(series.data.accuracy.mape)} · bias {pct(series.data.accuracy.bias)}
                    </>
                  )}
                </p>
                <figure>
                  <figcaption className="mb-1 flex justify-end">
                    <button
                      onClick={() => setAsTable((v) => !v)}
                      className="text-xs text-blue-600 underline"
                    >
                      {asTable ? 'Show chart' : 'View as table'}
                    </button>
                  </figcaption>
                  {asTable ? (
                    <div className="max-h-80 overflow-auto">
                      <table className="w-full text-left text-sm" data-testid="series-table">
                        <thead className="sticky top-0 bg-white text-gray-500">
                          <tr>
                            <th className="py-1">Week</th>
                            <th>Forecast</th>
                            <th>Low (80%)</th>
                            <th>High (80%)</th>
                            <th>Override</th>
                            <th>Final</th>
                          </tr>
                        </thead>
                        <tbody>
                          {series.data.forecast.map((p) => (
                            <tr
                              key={p.weekStart}
                              className="border-t"
                              data-testid={`fc-${p.weekStart}`}
                            >
                              <td className="py-1">{p.weekStart}</td>
                              <td>{p.quantity.toFixed(1)}</td>
                              <td>{p.lower.toFixed(1)}</td>
                              <td>{p.upper.toFixed(1)}</td>
                              <td
                                className={
                                  p.override !== null ? 'font-semibold text-green-700' : ''
                                }
                              >
                                {p.override === null ? '—' : p.override}
                              </td>
                              <td>{p.final.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div
                      style={{ height: 340 }}
                      role="img"
                      aria-label="History, forecast and prediction interval chart"
                    >
                      <ResponsiveContainer>
                        <ComposedChart data={chartData}>
                          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                          <XAxis
                            dataKey="weekStart"
                            tick={axis}
                            tickFormatter={(d: string) => d.slice(2, 7)}
                            minTickGap={40}
                            stroke="var(--chart-grid)"
                          />
                          <YAxis tick={axis} width={56} stroke="var(--chart-grid)" />
                          <Tooltip />
                          <Legend />
                          <Area
                            dataKey="band"
                            name="80% interval"
                            stroke="none"
                            fill="var(--series-2)"
                            fillOpacity={0.18}
                          />
                          <Line
                            dataKey="history"
                            name="History"
                            stroke="var(--series-1)"
                            strokeWidth={2}
                            dot={false}
                            connectNulls={false}
                          />
                          <Line
                            dataKey="forecast"
                            name="Forecast"
                            stroke="var(--series-2)"
                            strokeWidth={2}
                            strokeDasharray="6 4"
                            dot={false}
                          />
                          <Line
                            dataKey="override"
                            name="Override"
                            stroke="var(--series-3)"
                            strokeWidth={0}
                            dot={{
                              r: 5,
                              fill: 'var(--series-3)',
                              stroke: 'var(--chart-surface)',
                              strokeWidth: 2,
                            }}
                            activeDot={{ r: 6 }}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </figure>

                <ExplainCard runId={id} productId={productId} locationId={locationId} />
                <Can permission="forecast:override">
                  {locationId ? (
                    <form
                      aria-label="Add override"
                      className="flex flex-wrap items-end gap-3 border-t pt-3 text-sm"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setOv.mutate();
                      }}
                    >
                      <label>
                        Week
                        <select
                          required
                          value={week}
                          onChange={(e) => setWeek(e.target.value)}
                          className={inputCls}
                        >
                          <option value="">Select…</option>
                          {series.data.forecast.map((p) => (
                            <option key={p.weekStart} value={p.weekStart}>
                              {p.weekStart}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Quantity
                        <input
                          type="number"
                          min={0}
                          step="any"
                          required
                          value={qty}
                          onChange={(e) => setQty(e.target.value)}
                          className={`${inputCls} w-24`}
                        />
                      </label>
                      <label className="min-w-64 flex-1">
                        Reason (required)
                        <input
                          required
                          minLength={3}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          className={`${inputCls} w-full`}
                        />
                      </label>
                      <button type="submit" className="rounded bg-green-700 px-3 py-1.5 text-white">
                        Override
                      </button>
                    </form>
                  ) : (
                    <p className="border-t pt-3 text-xs text-gray-500">
                      Pick a single location to override a week.
                    </p>
                  )}
                </Can>
                {overrides.data && overrides.data.items.length > 0 && (
                  <div data-testid="overrides">
                    <h3 className="text-sm font-semibold">
                      Overrides{selectedLocationCode ? ` (${selectedLocationCode})` : ''}
                    </h3>
                    <ul className="text-sm">
                      {overrides.data.items.map((o) => (
                        <li
                          key={o.id}
                          className="flex items-center gap-2 py-0.5"
                          data-testid={`override-${o.weekStart}`}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: 'var(--series-3)' }}
                          />
                          {o.locationCode} · {o.weekStart}: <strong>{o.quantity}</strong> —{' '}
                          {o.reason}
                          <Can permission="forecast:override">
                            <button
                              onClick={() => delOv.mutate(o.id)}
                              className="text-xs text-red-700 underline"
                              aria-label={`Remove override ${o.weekStart}`}
                            >
                              remove
                            </button>
                          </Can>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-lg font-semibold">Accuracy (backtest on the last weeks)</h2>
            <table className="w-full text-left text-sm" data-testid="accuracy-table">
              <thead className="border-b text-gray-500">
                <tr>
                  <th className="py-2">{sortBtn('sku', 'SKU')}</th>
                  <th>Location</th>
                  <th>{sortBtn('model', 'Model')}</th>
                  <th>{sortBtn('wape', 'WAPE')}</th>
                  <th>{sortBtn('mape', 'MAPE')}</th>
                  <th>{sortBtn('bias', 'Bias')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr
                    key={`${a.productId}|${a.locationId}`}
                    className="cursor-pointer border-b hover:bg-gray-50"
                    onClick={() => {
                      setProductId(a.productId);
                      setLocationId(a.locationId);
                    }}
                    data-testid={`acc-${a.productSku}-${a.locationCode}`}
                  >
                    <td className="py-1">{a.productSku}</td>
                    <td>{a.locationCode}</td>
                    <td>{modelLabel(a.modelUsed)}</td>
                    <td>{pct(a.wape)}</td>
                    <td>{pct(a.mape)}</td>
                    <td>{pct(a.bias)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-gray-500">
              Bias above 0 means the model over-forecasts. "—" means there was too little history to
              backtest.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
