import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { SubscriptionDto } from '@supplycast/shared';
import { api } from '../api/client';
import { useAuth } from '../features/auth/AuthContext';
import { useCan } from '../features/auth/Can';
import { AssistantPanel } from '../features/ai/AssistantPanel';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { useThemeSafe } from '../theme';
import { CommandPalette } from './CommandPalette';
import { Icon, Logo } from './Icon';
import { NAV_ITEMS, type NavItem } from './navItems';

function ThemeToggle() {
  const theme = useThemeSafe();
  if (!theme) return null;
  const dark = theme.resolved === 'dark';
  return (
    <button
      onClick={theme.toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
    >
      <Icon name={dark ? 'sun' : 'moon'} className="h-5 w-5" />
    </button>
  );
}

export { NAV_ITEMS };
export type { NavItem };

function TrialBanner() {
  const can = useCan();
  const allowed = can('billing:read');
  const { data } = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: () => api<SubscriptionDto>('/billing/subscription'),
    enabled: allowed,
  });
  if (!allowed || !data || data.status !== 'TRIALING') return null;
  return (
    <div
      role="status"
      data-testid="trial-banner-global"
      className="flex flex-wrap items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-center text-sm text-amber-900 print:hidden"
    >
      <span aria-hidden>⏳</span>
      <span>
        {data.plan.name} trial:{' '}
        <strong>
          {data.trialDaysLeft} day{data.trialDaysLeft === 1 ? '' : 's'} left
        </strong>
        .
      </span>
      <Link
        to="/billing"
        className="rounded-full bg-amber-600 px-3 py-0.5 text-xs font-semibold text-white hover:bg-amber-700"
      >
        Choose a plan
      </Link>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const can = useCan();
  const items = NAV_ITEMS.filter((i) => can(i.permission));
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="flex h-full flex-col">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 px-5 py-5">
        <Logo />
        <span className="text-lg font-bold tracking-tight text-gray-900">SupplyCast</span>
      </Link>
      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
        {groups.map((g) => (
          <div key={g}>
            {g !== 'Overview' && (
              <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {g}
              </p>
            )}
            <ul className="space-y-0.5">
              {items
                .filter((i) => i.group === g)
                .map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      end={i.to === '/' || i.to === '/admin'}
                      onClick={onNavigate}
                      className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                    >
                      <Icon name={i.icon} className="h-[18px] w-[18px] shrink-0" />
                      {i.label}
                    </NavLink>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

export function AppLayout() {
  const { user, logout, suspended, impersonation, stopImpersonation } = useAuth();
  const can = useCan();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-gray-200 bg-white lg:block print:hidden">
        <Sidebar />
      </aside>
      {/* Mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden print:hidden" role="dialog" aria-label="Menu">
          <div className="absolute inset-0 bg-gray-900/40" onClick={() => setMenuOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 bg-white shadow-pop">
            <Sidebar onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-h-screen flex-col">
        {impersonation && (
          <div
            role="alert"
            data-testid="impersonation-banner"
            className="flex flex-wrap items-center justify-center gap-4 bg-purple-700 px-4 py-2 text-sm text-white print:hidden"
          >
            <span>
              Viewing <strong>{impersonation.tenantName}</strong> as its Owner — read-only. Every
              request is audited.
            </span>
            <button
              onClick={() => void stopImpersonation()}
              className="rounded-full bg-white px-3 py-0.5 text-purple-800"
            >
              Exit
            </button>
          </div>
        )}
        <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/85 backdrop-blur print:hidden">
          <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
            <button
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              className="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 lg:hidden"
            >
              <Icon name="menu" />
            </button>
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="hidden items-center gap-2 border border-gray-200 px-3 py-1.5 text-gray-500 sm:inline-flex"
            >
              <Icon name="search" className="h-4 w-4" />
              <span className="font-normal">Search…</span>
              <kbd className="rounded border border-gray-200 px-1.5 text-xs">Ctrl K</kbd>
            </button>
            <div className="flex-1" />
            {can('ai:use') && !impersonation && (
              <button
                onClick={() => setAssistantOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:brightness-110"
              >
                <Icon name="sparkle" className="h-4 w-4" />
                Ask AI
              </button>
            )}
            <ThemeToggle />
            {can('notifications:read') && <NotificationBell />}
            <span className="hidden items-center gap-2 border-l border-gray-200 pl-3 sm:flex">
              <span
                aria-hidden
                className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700"
              >
                {user?.name?.[0]?.toUpperCase()}
              </span>
              <span className="text-sm text-gray-700" data-testid="whoami">
                {user?.name} ({user?.role})
              </span>
            </span>
            <span className="sm:hidden" data-testid="whoami-short" hidden />
            <NavLink
              to="/settings"
              aria-label="Settings"
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            >
              <Icon name="cog" />
            </NavLink>
            <NavLink to="/change-password" className="text-sm text-blue-600 hover:underline">
              Change password
            </NavLink>
            <button
              onClick={() => void logout().then(() => navigate('/login'))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700"
            >
              <Icon name="logout" className="h-4 w-4" />
              Log out
            </button>
          </div>
        </header>
        <TrialBanner />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        {assistantOpen && <AssistantPanel onClose={() => setAssistantOpen(false)} />}
        <main className="flex-1">
          {suspended ? (
            <div className="page">
              <section
                data-testid="suspended"
                className="rounded-xl border border-red-200 bg-red-50 p-6"
              >
                <h1 className="text-xl font-bold text-red-800">Account unavailable</h1>
                <p className="mt-2 text-red-700">
                  This account is suspended or has been deleted. Contact support if you think this
                  is a mistake.
                </p>
              </section>
            </div>
          ) : (
            <div className="page">
              <Outlet />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
