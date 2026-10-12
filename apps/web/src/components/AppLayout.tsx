import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { Permission, SubscriptionDto } from '@supplycast/shared';
import { api } from '../api/client';
import { useAuth } from '../features/auth/AuthContext';
import { useCan } from '../features/auth/Can';
import { AssistantPanel } from '../features/ai/AssistantPanel';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { Icon, Logo } from './Icon';

export interface NavItem {
  to: string;
  label: string;
  permission: Permission;
  group: string;
  icon: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', permission: 'dashboard:read', group: 'Overview', icon: 'home' },
  { to: '/products', label: 'Products', permission: 'masterdata:read', group: 'Data', icon: 'box' },
  {
    to: '/locations',
    label: 'Locations',
    permission: 'masterdata:read',
    group: 'Data',
    icon: 'pin',
  },
  {
    to: '/suppliers',
    label: 'Suppliers',
    permission: 'masterdata:read',
    group: 'Data',
    icon: 'truck',
  },
  {
    to: '/inventory',
    label: 'Inventory',
    permission: 'masterdata:read',
    group: 'Data',
    icon: 'stack',
  },
  { to: '/sales', label: 'Sales', permission: 'sales:read', group: 'Demand', icon: 'chart' },
  { to: '/import', label: 'Import', permission: 'import:sales', group: 'Demand', icon: 'upload' },
  {
    to: '/forecasts',
    label: 'Forecasts',
    permission: 'forecast:read',
    group: 'Planning',
    icon: 'trend',
  },
  {
    to: '/scenarios',
    label: 'Scenarios',
    permission: 'scenario:read',
    group: 'Planning',
    icon: 'flask',
  },
  { to: '/team', label: 'Team', permission: 'team:read', group: 'Workspace', icon: 'users' },
  {
    to: '/billing',
    label: 'Billing',
    permission: 'billing:read',
    group: 'Workspace',
    icon: 'card',
  },
  {
    to: '/audit-log',
    label: 'Audit log',
    permission: 'audit:read',
    group: 'Workspace',
    icon: 'shield',
  },
  { to: '/admin', label: 'Overview', permission: 'admin:access', group: 'Platform', icon: 'home' },
  {
    to: '/admin/tenants',
    label: 'Tenants',
    permission: 'admin:access',
    group: 'Platform',
    icon: 'building',
  },
  {
    to: '/admin/plans',
    label: 'Plans',
    permission: 'admin:access',
    group: 'Platform',
    icon: 'card',
  },
];

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
      className="flex flex-wrap items-center justify-center gap-2 border-b border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 px-6 py-2 text-center text-sm text-amber-900 print:hidden"
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
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);

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
            <NavLink to="/change-password" className="text-sm text-blue-600 hover:underline">
              Change password
            </NavLink>
            <button
              onClick={() => void logout()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700"
            >
              <Icon name="logout" className="h-4 w-4" />
              Log out
            </button>
          </div>
        </header>
        <TrialBanner />
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
