import type { ReactNode } from 'react';

/** Shared chart styling so every graph looks like it belongs to the same product. */
export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
];

export const axisProps = {
  tick: { fontSize: 11, fill: 'var(--chart-ink-2)' },
  axisLine: false,
  tickLine: false,
} as const;

export const gridProps = {
  vertical: false,
  stroke: 'var(--chart-grid)',
  strokeDasharray: '3 4',
} as const;

export const compact = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : Math.abs(v) >= 1000
      ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`
      : String(Math.round(v * 10) / 10);

/** Smooth gradient used under area charts. */
export function GradientDef({
  id,
  color,
  from = 0.35,
  to = 0.02,
}: {
  id: string;
  color: string;
  from?: number;
  to?: number;
}) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={from} />
        <stop offset="100%" stopColor={color} stopOpacity={to} />
      </linearGradient>
    </defs>
  );
}

interface TooltipEntry {
  name?: string;
  value?: number | string | [number, number];
  color?: string;
  dataKey?: string;
}

/** Rounded white tooltip with colour swatches and formatted values. */
export function ChartTooltip({
  active,
  payload,
  label,
  format = (v: number) => v.toLocaleString(),
  title = (l: string) => l,
  hide = [],
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  format?: (v: number, name?: string) => string;
  title?: (l: string) => string;
  hide?: string[];
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(
    (p) => p.value !== undefined && p.value !== null && !hide.includes(String(p.dataKey)),
  );
  if (!rows.length) return null;
  return (
    <div className="min-w-36 rounded-xl border border-gray-100 bg-white px-3 py-2 text-xs shadow-pop">
      <p className="mb-1 font-semibold text-gray-900">{title(String(label))}</p>
      <ul className="space-y-0.5">
        {rows.map((p, i) => {
          const v = Array.isArray(p.value)
            ? `${format(p.value[0]!)} – ${format(p.value[1]!)}`
            : typeof p.value === 'number'
              ? format(p.value, p.name)
              : String(p.value);
          return (
            <li key={`${p.dataKey}-${i}`} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-gray-600">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: p.color }}
                />
                {p.name}
              </span>
              <span className="font-medium tabular-nums text-gray-900">{v}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Card wrapper for a chart with a title, optional subtitle and a right-hand action (e.g. view as table). */
export function ChartCard({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`rounded-xl border border-gray-200 bg-white p-5 shadow-card ${className}`}>
      <figcaption className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-900">{title}</p>
          {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
        </div>
        {action}
      </figcaption>
      {children}
    </figure>
  );
}

export const linkButton = 'rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50';
