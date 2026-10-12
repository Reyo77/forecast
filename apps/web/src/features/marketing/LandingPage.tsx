import { Link } from 'react-router-dom';
import { Icon, Logo } from '../../components/Icon';
import { useThemeSafe } from '../../theme';

const FEATURES = [
  {
    icon: 'trend',
    title: 'Forecasts that explain themselves',
    body: 'Six statistical models compete on every product; the best one wins by backtest. See accuracy, intervals and bias at a glance.',
  },
  {
    icon: 'flask',
    title: 'What-if scenarios',
    body: 'A supplier is two weeks late? Demand jumps 25%? Simulate it in seconds and compare against your baseline plan.',
  },
  {
    icon: 'list',
    title: 'A reorder plan you can act on',
    body: 'Get purchase orders with quantities, suppliers and dates, honouring lead times and minimum order sizes. Export to CSV.',
  },
  {
    icon: 'sparkle',
    title: 'AI planning assistant',
    body: 'Describe a scenario in plain English, ask about your data, or get an executive summary of the risks.',
  },
  {
    icon: 'chart',
    title: 'ABC analysis',
    body: 'Find the few products that carry your revenue and focus your attention where it pays off.',
  },
  {
    icon: 'shield',
    title: 'Built for teams',
    body: 'Roles, invitations, audit log and per-company data isolation. Everyone sees what they should.',
  },
];
const STEPS = [
  [
    'Import your sales',
    'Upload a CSV or load the demo data. Products, locations and suppliers are set up in minutes.',
  ],
  [
    'Run a forecast',
    'One click forecasts every product and location, with a backtest of how accurate it is.',
  ],
  [
    'Plan with confidence',
    'Spot stockouts early, test scenarios and send the reorder plan to purchasing.',
  ],
] as const;
const FAQ = [
  [
    'What data do I need?',
    'Weekly (or daily) sales per product and location as a CSV. Inventory, suppliers and open orders make the plan sharper but are optional to start.',
  ],
  [
    'Is there a free trial?',
    'Every new account starts with a 14-day trial. No card needed to explore.',
  ],
  [
    'Can my team use it?',
    'Yes. Invite owners, admins, planners and viewers, each with the right level of access.',
  ],
  [
    'Is my data private?',
    'Each company’s data is isolated and every sensitive action is written to an audit log.',
  ],
] as const;

function MiniChart() {
  // Decorative: a stylised history + forecast chart for the hero.
  const hist = 'M0 120 C40 100 60 130 100 90 S160 60 200 80 S260 40 300 55';
  const fc = 'M300 55 C330 45 350 70 380 50 S430 30 460 45';
  return (
    <svg viewBox="0 0 470 160" className="w-full" role="img" aria-label="Example forecast chart">
      <defs>
        <linearGradient id="lp-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--series-1)" stopOpacity=".35" />
          <stop offset="1" stopColor="var(--series-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[40, 80, 120].map((y) => (
        <line
          key={y}
          x1="0"
          x2="470"
          y1={y}
          y2={y}
          stroke="var(--chart-grid)"
          strokeDasharray="3 4"
        />
      ))}
      <path d={`${hist} L300 160 L0 160 Z`} fill="url(#lp-g)" />
      <path d={hist} fill="none" stroke="var(--series-1)" strokeWidth="3" strokeLinecap="round" />
      <path d="M300 55 L460 25 L460 75 Z" fill="var(--series-2)" opacity=".15" />
      <path
        d={fc}
        fill="none"
        stroke="var(--series-2)"
        strokeWidth="3"
        strokeDasharray="6 5"
        strokeLinecap="round"
      />
      <line x1="300" x2="300" y1="10" y2="150" stroke="var(--chart-ink-2)" strokeDasharray="4 4" />
    </svg>
  );
}

export function LandingPage() {
  const theme = useThemeSafe();
  return (
    <div className="min-h-screen bg-white text-gray-800" data-testid="landing">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 text-lg font-bold text-gray-900">
            <Logo /> SupplyCast
          </Link>
          <nav
            aria-label="Site"
            className="ml-4 hidden gap-6 text-sm font-medium text-gray-600 sm:flex"
          >
            <a href="#features" className="hover:text-gray-900">
              Features
            </a>
            <a href="#how" className="hover:text-gray-900">
              How it works
            </a>
            <Link to="/pricing" className="hover:text-gray-900">
              Pricing
            </Link>
            <a href="#faq" className="hover:text-gray-900">
              FAQ
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {theme && (
              <button
                onClick={theme.toggle}
                aria-label={
                  theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
                }
                className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100"
              >
                <Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} />
              </button>
            )}
            <Link
              to="/login"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              Log in
            </Link>
            <Link
              to="/signup"
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Start free trial
            </Link>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 -z-0 h-[28rem] bg-gradient-to-b from-indigo-100/70 to-transparent dark:from-indigo-500/10"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
          <div>
            <p className="badge bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200">
              Demand forecasting &amp; supply planning
            </p>
            <h1 className="mt-4 text-4xl font-bold leading-tight tracking-tight text-gray-900 sm:text-5xl">
              Know what to buy <span className="text-blue-600">before you run out.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-gray-600">
              SupplyCast turns your sales history into accurate forecasts, stockout alerts and a
              ready-to-send reorder plan, so you stop guessing and start planning.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/signup"
                className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white shadow-sm hover:bg-blue-700"
              >
                Start your free trial
              </Link>
              <Link
                to="/pricing"
                className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 font-medium text-gray-800 hover:bg-gray-50"
              >
                See pricing
              </Link>
            </div>
            <p className="mt-4 text-sm text-gray-500">
              14-day trial · no credit card · set up in minutes
            </p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-pop">
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="font-semibold text-gray-900">Weekly demand · Green Tea 20 bags</span>
              <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                87% accurate
              </span>
            </div>
            <MiniChart />
            <div className="mt-3 grid grid-cols-3 gap-3 text-center text-xs">
              {[
                ['Stockouts ahead', '2'],
                ['Order now', '4 POs'],
                ['Revenue at risk', '$6.1k'],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-gray-50 p-2.5">
                  <p className="text-gray-500">{k}</p>
                  <p className="mt-0.5 text-base font-semibold text-gray-900">{v}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          Everything you need to plan supply
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-gray-600">
          From the first CSV to the purchase order, in one place.
        </p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                <Icon name={f.icon} />
              </span>
              <h3 className="mt-4 font-semibold text-gray-900">{f.title}</h3>
              <p className="mt-1.5 text-sm text-gray-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="border-y border-gray-200 bg-gray-50 py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight">
            Up and running in three steps
          </h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map(([t, b], i) => (
              <li key={t} className="card p-6">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 font-semibold text-white">
                  {i + 1}
                </span>
                <h3 className="mt-4 font-semibold text-gray-900">{t}</h3>
                <p className="mt-1.5 text-sm text-gray-600">{b}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h2 className="text-center text-3xl font-bold tracking-tight">Questions, answered</h2>
        <div className="mt-8 space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="card group p-4">
              <summary className="flex cursor-pointer items-center justify-between font-medium text-gray-900">
                {q}
                <span aria-hidden className="text-gray-400 transition group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-2 text-sm text-gray-600">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700 px-6 py-12 text-center text-white">
          <h2 className="text-3xl font-bold tracking-tight">Ready to stop guessing?</h2>
          <p className="mx-auto mt-3 max-w-xl text-indigo-100">
            Load the demo data and see your first forecast in under five minutes.
          </p>
          <Link
            to="/signup"
            className="mt-6 inline-block rounded-lg bg-white px-6 py-2.5 font-medium text-indigo-700 hover:bg-indigo-50"
          >
            Start free trial
          </Link>
        </div>
      </section>

      <footer className="border-t border-gray-200 py-8 text-sm text-gray-500">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 sm:px-6">
          <span className="flex items-center gap-2">
            <Logo className="h-5 w-5" /> © {new Date().getFullYear()} SupplyCast
          </span>
          <nav aria-label="Legal" className="flex gap-5">
            <Link to="/pricing" className="hover:text-gray-900">
              Pricing
            </Link>
            <Link to="/terms" className="hover:text-gray-900">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-gray-900">
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
