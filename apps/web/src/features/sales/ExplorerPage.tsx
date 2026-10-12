import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMoney } from '../../lib';
import { EmptyState, PageHeader, Panel, StatTile, inputCls } from '../../components/ui';
import {
  ChartCard,
  ChartTooltip,
  GradientDef,
  axisProps,
  compact,
  gridProps,
  linkButton,
} from '../../components/charts';
import { Icon } from '../../components/Icon';
import { mdApi } from '../masterdata/api';
import { salesApi } from './api';

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`);

export function ExplorerPage() {
  const [groupBy, setGroupBy] = useState('none');
  const [productId, setProductId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [asTable, setAsTable] = useState(false);
  const [metric, setMetric] = useState<'quantity' | 'revenueCents'>('quantity');

  const products = useQuery({
    queryKey: ['products', 'all'],
    queryFn: () => mdApi.products('pageSize=100'),
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: mdApi.categories });
  const locations = useQuery({ queryKey: ['locations'], queryFn: mdApi.locations });

  const qs = new URLSearchParams({ groupBy });
  if (productId) qs.set('productId', productId);
  if (categoryId) qs.set('categoryId', categoryId);
  if (locationId) qs.set('locationId', locationId);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const { data, isLoading, error } = useQuery({
    queryKey: ['explorer', qs.toString()],
    queryFn: () => salesApi.explorer(qs.toString()),
  });

  const { rows, keys } = useMemo(() => {
    const weeks = new Map<string, Record<string, number | string>>();
    for (const s of data?.series ?? []) {
      for (const p of s.points) {
        const row = weeks.get(p.weekStart) ?? { weekStart: p.weekStart };
        row[s.key] = p[metric];
        weeks.set(p.weekStart, row);
      }
    }
    return {
      rows: [...weeks.values()].sort((a, b) =>
        String(a.weekStart).localeCompare(String(b.weekStart)),
      ),
      keys: (data?.series ?? []).map((s) => s.key),
    };
  }, [data, metric]);

  // Colour by series identity (alphabetical order of key) so a series keeps its colour when totals shift.
  const colorOf = (key: string) => SLOTS[[...keys].sort().indexOf(key) % SLOTS.length]!;
  const fmt = (v: number) => (metric === 'revenueCents' ? formatMoney(v) : v.toLocaleString());

  const label = metric === 'quantity' ? 'units' : 'revenue';
  const single = data && data.series.length === 1;
  const yFmt = (v: number) => (metric === 'revenueCents' ? `$${compact(v / 100)}` : compact(v));

  return (
    <section className="space-y-5">
      <PageHeader
        title="Sales explorer"
        subtitle="See how much you sold, week by week. Slice by product, category or location."
      />
      <Panel className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          Group by
          <select
            aria-label="Group by"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            className={inputCls}
          >
            <option value="none">Total</option>
            <option value="product">Product</option>
            <option value="category">Category</option>
            <option value="location">Location</option>
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
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputCls}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputCls}
          />
        </label>
        <label>
          Measure
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as typeof metric)}
            className={inputCls}
          >
            <option value="quantity">Units</option>
            <option value="revenueCents">Revenue</option>
          </select>
        </label>
      </Panel>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {(error as Error).message}
        </p>
      )}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile
              testId="total-units"
              label="Units"
              value={data.totals.quantity.toLocaleString()}
              icon={<Icon name="box" />}
              tone="indigo"
            />
            <StatTile
              testId="total-revenue"
              label="Revenue"
              value={formatMoney(data.totals.revenueCents)}
              icon={<Icon name="card" />}
              tone="green"
            />
            <StatTile
              testId="total-weeks"
              label="Weeks with sales"
              value={data.totals.weeks}
              icon={<Icon name="chart" />}
              tone="sky"
            />
          </div>
          {data.series.length === 0 ? (
            <EmptyState title="No sales for this selection" testId="explorer-empty">
              Import a CSV or load demo data.
            </EmptyState>
          ) : (
            <ChartCard
              title={`Weekly ${label}`}
              subtitle={
                data.omittedSeries > 0
                  ? `top 10 of ${data.series.length + data.omittedSeries} groups`
                  : data.series.length > 1
                    ? 'one line per group'
                    : 'all selected sales'
              }
              action={
                <button onClick={() => setAsTable((v) => !v)} className={linkButton}>
                  {asTable ? 'Show chart' : 'View as table'}
                </button>
              }
            >
              {asTable ? (
                <div className="max-h-96 overflow-auto">
                  <table className="w-full text-left text-sm" data-testid="explorer-table">
                    <thead className="sticky top-0 bg-white text-gray-500">
                      <tr>
                        <th className="py-1">Week</th>
                        {data.series.map((s) => (
                          <th key={s.key}>{s.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={String(r.weekStart)} className="border-t">
                          <td className="py-1">{String(r.weekStart)}</td>
                          {keys.map((k) => (
                            <td key={k}>{r[k] === undefined ? '—' : fmt(Number(r[k]))}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ height: 340 }} role="img" aria-label="Line chart of weekly sales">
                  <ResponsiveContainer>
                    {single ? (
                      <AreaChart data={rows} margin={{ left: 4, right: 8, top: 4 }}>
                        <GradientDef id="sales-fill" color="var(--series-1)" />
                        <CartesianGrid {...gridProps} />
                        <XAxis
                          dataKey="weekStart"
                          {...axisProps}
                          tickFormatter={(d: string) => d.slice(2, 7)}
                          minTickGap={48}
                        />
                        <YAxis {...axisProps} tickFormatter={yFmt} width={52} />
                        <Tooltip
                          content={<ChartTooltip format={fmt} title={(l) => `Week of ${l}`} />}
                        />
                        <Area
                          type="monotone"
                          dataKey={keys[0]!}
                          name={data.series[0]!.label}
                          stroke="var(--series-1)"
                          strokeWidth={2.5}
                          fill="url(#sales-fill)"
                          activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }}
                        />
                      </AreaChart>
                    ) : (
                      <LineChart data={rows} margin={{ left: 4, right: 8, top: 4 }}>
                        <CartesianGrid {...gridProps} />
                        <XAxis
                          dataKey="weekStart"
                          {...axisProps}
                          tickFormatter={(d: string) => d.slice(2, 7)}
                          minTickGap={48}
                        />
                        <YAxis {...axisProps} tickFormatter={yFmt} width={52} />
                        <Tooltip
                          content={<ChartTooltip format={fmt} title={(l) => `Week of ${l}`} />}
                        />
                        <Legend
                          iconType="circle"
                          iconSize={8}
                          formatter={(key) => data.series.find((s) => s.key === key)?.label ?? key}
                        />
                        {data.series.map((s) => (
                          <Line
                            key={s.key}
                            type="monotone"
                            dataKey={s.key}
                            name={s.label}
                            stroke={colorOf(s.key)}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                            connectNulls
                          />
                        ))}
                      </LineChart>
                    )}
                  </ResponsiveContainer>
                </div>
              )}
            </ChartCard>
          )}
        </>
      )}
    </section>
  );
}
