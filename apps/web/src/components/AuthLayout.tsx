import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from './Icon';

const PERKS = [
  'Forecasts that pick the best model for every product',
  'What-if scenarios: late suppliers, demand spikes, price moves',
  'A reorder plan you can export to your purchasing team',
];

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800 p-12 text-white lg:flex">
        <Link to="/" className="flex items-center gap-2.5 text-lg font-bold">
          <Logo className="h-8 w-8" /> SupplyCast
        </Link>
        <div>
          <p className="text-3xl font-semibold leading-tight tracking-tight">
            See stockouts coming before they cost you sales.
          </p>
          <ul className="mt-8 space-y-3 text-indigo-100">
            {PERKS.map((p) => (
              <li key={p} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs">
                  ✓
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-indigo-200">
          Demand forecasting &amp; planning for growing teams.
        </p>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 right-10 h-80 w-80 rounded-full bg-violet-400/20"
        />
      </aside>
      <main className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex items-center gap-2.5 text-lg font-bold lg:hidden">
            <Logo /> SupplyCast
          </Link>
          <h1 className="mb-6 text-2xl font-bold">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-lg bg-red-50 p-2.5 text-sm text-red-700">
      {message}
    </p>
  ) : null;
}
