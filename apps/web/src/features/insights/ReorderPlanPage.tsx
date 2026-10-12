import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { downloadFile } from '../../api/client';
import { Icon } from '../../components/Icon';
import { EmptyState, Notice, PageHeader, StatTile, errText } from '../../components/ui';
import { formatDate, formatMoney } from '../../lib';
import { insightsApi } from './api';

type Filter = 'all' | 'urgent';

/** What to buy, from whom and by when: the baseline plan's purchase orders. */
export function ReorderPlanPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['reorder-plan'],
    queryFn: insightsApi.reorderPlan,
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (i) =>
        (filter === 'all' || i.urgent) &&
        (!needle ||
          `${i.sku} ${i.productName} ${i.supplierName ?? ''} ${i.locationCode}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [data, filter, q]);

  return (
    <section className="space-y-5">
      <PageHeader
        title="Reorder plan"
        subtitle="What to buy, from whom and by when, based on your latest forecast and current stock."
        actions={
          data?.run && (
            <button
              onClick={() =>
                void downloadFile('/insights/reorder-plan/export.csv', 'reorder-plan.csv').catch(
                  (e) => setErr(errText(e)),
                )
              }
              className="inline-flex items-center gap-1.5 border px-3.5 py-2"
            >
              <Icon name="upload" className="h-4 w-4 rotate-180" /> Export CSV
            </button>
          )
        }
      />
      {err && <Notice kind="error">{err}</Notice>}
      {error && <Notice kind="error">{errText(error)}</Notice>}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && !data.run && (
        <EmptyState title="No reorder plan yet" testId="no-plan">
          Run a{' '}
          <Link to="/forecasts" className="font-medium text-blue-600 underline">
            forecast
          </Link>{' '}
          first. Your plan appears here as soon as it finishes.
        </EmptyState>
      )}
      {data?.run && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              testId="plan-orders"
              label="Purchase orders"
              value={data.totals.orders}
              hint={`next ${data.run.horizonWeeks} weeks`}
              icon={<Icon name="list" />}
              tone="indigo"
            />
            <StatTile
              testId="plan-urgent"
              label="Order this week"
              value={data.totals.urgent}
              hint={data.totals.urgent ? 'urgent' : 'nothing urgent'}
              icon={<Icon name="truck" />}
              tone={data.totals.urgent ? 'red' : 'green'}
            />
            <StatTile
              testId="plan-units"
              label="Units to buy"
              value={data.totals.units.toLocaleString()}
              icon={<Icon name="box" />}
              tone="sky"
            />
            <StatTile
              testId="plan-cost"
              label="Estimated spend"
              value={formatMoney(data.totals.costCents)}
              hint={`forecast of ${formatDate(data.run.asOf)}`}
              icon={<Icon name="card" />}
              tone="green"
            />
          </div>
          <div className="card space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <div
                role="group"
                aria-label="Filter"
                className="inline-flex rounded-lg border border-gray-200 p-0.5"
              >
                {(['all', 'urgent'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                    className={`rounded-md px-3 py-1 ${filter === f ? 'bg-blue-50 text-blue-700' : 'text-gray-600'}`}
                  >
                    {f === 'all' ? 'All orders' : 'Urgent only'}
                  </button>
                ))}
              </div>
              <input
                aria-label="Search orders"
                placeholder="Search product, supplier, location…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-72 max-w-full"
              />
              <span className="ml-auto text-gray-500">{items.length} shown</span>
            </div>
            {items.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500" data-testid="plan-empty">
                {data.items.length === 0
                  ? 'Stock covers all forecast demand: nothing to order.'
                  : 'No orders match.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="plan-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Location</th>
                      <th>Supplier</th>
                      <th>Order by</th>
                      <th>Arrives</th>
                      <th className="text-right">Quantity</th>
                      <th className="text-right">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i, n) => (
                      <tr
                        key={`${i.sku}|${i.locationCode}|${i.orderDate}|${n}`}
                        data-testid={`plan-row-${i.sku}`}
                      >
                        <td>
                          <span className="font-medium text-gray-900">{i.sku}</span>{' '}
                          <span className="text-gray-500">{i.productName}</span>
                        </td>
                        <td>{i.locationCode}</td>
                        <td>{i.supplierName ?? <span className="text-gray-400">—</span>}</td>
                        <td>
                          {i.orderDate}{' '}
                          {i.urgent && (
                            <span className="badge bg-rose-50 text-rose-700 ring-1 ring-rose-200">
                              Now
                            </span>
                          )}
                        </td>
                        <td>{i.arrivalDate}</td>
                        <td className="text-right tabular-nums">{i.quantity.toLocaleString()}</td>
                        <td className="text-right tabular-nums">{formatMoney(i.estCostCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
