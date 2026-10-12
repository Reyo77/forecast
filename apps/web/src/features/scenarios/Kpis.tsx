import { kpiDelta, type PlanKpisDto } from '@supplycast/shared';
import { formatMoney } from '../../lib';

export const KPI_LABELS: { key: keyof PlanKpisDto; label: string }[] = [
  { key: 'fillRate', label: 'Fill rate' },
  { key: 'stockoutWeeks', label: 'Stockout weeks' },
  { key: 'revenueAtRiskCents', label: 'Revenue at risk' },
  { key: 'avgInventoryValueCents', label: 'Avg inventory value' },
  { key: 'plannedOrders', label: 'Planned orders' },
  { key: 'totalShortage', label: 'Units short' },
];

export function formatKpi(key: keyof PlanKpisDto, v: number): string {
  if (key === 'fillRate') return `${(v * 100).toFixed(1)}%`;
  if (key === 'revenueAtRiskCents' || key === 'avgInventoryValueCents') return formatMoney(v);
  return Math.round(v).toLocaleString();
}

export function DeltaBadge({
  k,
  baseline,
  value,
}: {
  k: keyof PlanKpisDto;
  baseline: number;
  value: number;
}) {
  const d = kpiDelta(k, baseline, value);
  if (d.verdict === 'same' && d.absolute === 0)
    return <span className="text-xs text-gray-500">no change</span>;
  const arrow = d.absolute > 0 ? '▲' : '▼';
  const cls =
    d.verdict === 'worse'
      ? 'text-red-700'
      : d.verdict === 'better'
        ? 'text-green-700'
        : 'text-gray-600';
  const pct = d.percent === null ? '' : ` (${d.percent > 0 ? '+' : ''}${d.percent.toFixed(1)}%)`;
  const diff =
    k === 'fillRate' ? `${(d.absolute * 100).toFixed(1)} pts` : formatKpi(k, Math.abs(d.absolute));
  return (
    <span className={`text-xs font-medium ${cls}`} data-testid={`delta-${k}`}>
      {arrow} {d.absolute < 0 && k !== 'fillRate' ? '−' : d.absolute > 0 ? '+' : ''}
      {k === 'fillRate' ? diff : diff}
      {pct} · {d.verdict}
    </span>
  );
}

export function KpiCards({ baseline, scenario }: { baseline: PlanKpisDto; scenario: PlanKpisDto }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="kpi-cards">
      {KPI_LABELS.map(({ key, label }) => (
        <div key={key} className="rounded-lg border border-gray-200 p-3" data-testid={`kpi-${key}`}>
          <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
          <p className="mt-1 text-xl font-bold">{formatKpi(key, scenario[key])}</p>
          <p className="text-xs text-gray-500">Baseline {formatKpi(key, baseline[key])}</p>
          <DeltaBadge k={key} baseline={baseline[key]} value={scenario[key]} />
        </div>
      ))}
    </div>
  );
}
