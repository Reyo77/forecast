import { METRIC_LABELS, type PlanDto } from '@supplycast/shared';
import { formatMoney } from '../../lib';

const LIMIT_ROWS: [keyof PlanDto['limits'], string][] = [
  ['users', 'users'],
  ['skus', 'SKUs'],
  ['locations', 'locations'],
  ['forecastRuns', 'forecast runs / month'],
  ['scenarios', 'saved scenarios'],
  ['aiRequests', 'AI requests / month'],
  ['historyMonths', 'months of sales history'],
];

export function PlanCards({
  plans,
  currentCode,
  pendingCode,
  onChoose,
  busyCode,
  cta,
}: {
  plans: PlanDto[];
  currentCode?: string;
  pendingCode?: string;
  onChoose?: (plan: PlanDto) => void;
  busyCode?: string | null;
  cta?: (plan: PlanDto) => React.ReactNode;
}) {
  void METRIC_LABELS;
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {plans.map((p) => {
        const isCurrent = p.code === currentCode;
        return (
          <article
            key={p.id}
            data-testid={`plan-${p.code}`}
            className={`flex flex-col rounded-lg border p-5 ${isCurrent ? 'border-blue-600 ring-1 ring-blue-600' : 'border-gray-200'}`}
          >
            <h3 className="text-lg font-semibold">{p.name}</h3>
            <p className="mt-1 text-3xl font-bold">
              {p.isCustom ? 'Custom' : formatMoney(p.priceCents)}
              {!p.isCustom && <span className="text-sm font-normal text-gray-500"> / month</span>}
            </p>
            <ul className="mt-4 flex-1 space-y-1 text-sm text-gray-700">
              {LIMIT_ROWS.map(([k, label]) => (
                <li key={k}>
                  <strong>{p.limits[k].toLocaleString()}</strong> {label}
                </li>
              ))}
            </ul>
            <div className="mt-5">
              {cta ? (
                cta(p)
              ) : isCurrent ? (
                <span className="inline-block rounded bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700">
                  Current plan
                </span>
              ) : p.isCustom ? (
                <span className="text-sm text-gray-500">Contact us for custom limits</span>
              ) : pendingCode === p.code ? (
                <span className="text-sm text-amber-700">Scheduled</span>
              ) : onChoose ? (
                <button
                  onClick={() => onChoose(p)}
                  disabled={busyCode !== null && busyCode !== undefined}
                  className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {busyCode === p.code ? 'Processing…' : `Choose ${p.name}`}
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
