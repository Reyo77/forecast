import type { ReactNode } from 'react';

export const inputCls = 'mt-1 block';

export function Notice({ kind, children }: { kind: 'error' | 'success'; children: ReactNode }) {
  return kind === 'error' ? (
    <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
      {children}
    </p>
  ) : (
    <p role="status" className="rounded bg-green-50 p-2 text-sm text-green-800">
      {children}
    </p>
  );
}

export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded border px-3 py-1 disabled:opacity-40"
      >
        Previous
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        className="rounded border px-3 py-1 disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  indigo: 'bg-indigo-50 text-indigo-600',
  green: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  red: 'bg-rose-50 text-rose-600',
  sky: 'bg-sky-50 text-sky-600',
  violet: 'bg-violet-50 text-violet-600',
} as const;

/** Headline number with an icon chip. */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'indigo',
  testId,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: keyof typeof TONES;
  testId?: string;
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-card"
      data-testid={testId}
    >
      {icon && (
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
        <p className="mt-0.5 truncate text-2xl font-semibold tabular-nums text-gray-900">{value}</p>
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
    </div>
  );
}

/** A white panel for filters or form controls. */
export function Panel({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`rounded-xl border border-gray-200 bg-white p-4 shadow-card ${className}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  testId,
}: {
  title: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="rounded-xl border border-dashed border-gray-300 bg-white/60 px-6 py-10 text-center"
      data-testid={testId}
    >
      <p className="font-medium text-gray-700">{title}</p>
      {children && <div className="mt-1 text-sm text-gray-500">{children}</div>}
    </div>
  );
}

export const badgeTone = {
  green: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  gray: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200',
} as const;
