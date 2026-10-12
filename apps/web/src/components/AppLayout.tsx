import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet } from 'react-router-dom';
import type { Permission, SubscriptionDto } from '@supplycast/shared';
import { api } from '../api/client';
import { useAuth } from '../features/auth/AuthContext';
import { useCan } from '../features/auth/Can';

export const NAV_ITEMS: { to: string; label: string; permission: Permission }[] = [
  { to: '/', label: 'Home', permission: 'dashboard:read' },
  { to: '/products', label: 'Products', permission: 'masterdata:read' },
  { to: '/locations', label: 'Locations', permission: 'masterdata:read' },
  { to: '/suppliers', label: 'Suppliers', permission: 'masterdata:read' },
  { to: '/inventory', label: 'Inventory', permission: 'masterdata:read' },
  { to: '/sales', label: 'Sales', permission: 'sales:read' },
  { to: '/import', label: 'Import', permission: 'import:sales' },
  { to: '/forecasts', label: 'Forecasts', permission: 'forecast:read' },
  { to: '/scenarios', label: 'Scenarios', permission: 'scenario:read' },
  { to: '/team', label: 'Team', permission: 'team:read' },
  { to: '/billing', label: 'Billing', permission: 'billing:read' },
  { to: '/audit-log', label: 'Audit log', permission: 'audit:read' },
  { to: '/admin', label: 'Overview', permission: 'admin:access' },
  { to: '/admin/tenants', label: 'Tenants', permission: 'admin:access' },
  { to: '/admin/plans', label: 'Plans', permission: 'admin:access' },
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
      className="border-b border-amber-300 bg-amber-50 px-6 py-2 text-center text-sm text-amber-900 print:hidden"
    >
      {data.plan.name} trial:{' '}
      <strong>
        {data.trialDaysLeft} day{data.trialDaysLeft === 1 ? '' : 's'} left
      </strong>
      .{' '}
      <Link to="/billing" className="underline">
        Choose a plan
      </Link>
    </div>
  );
}

export function AppLayout() {
  const { user, logout, suspended, impersonation, stopImpersonation } = useAuth();
  const can = useCan();
  return (
    <div className="min-h-screen">
      {impersonation && (
        <div
          role="alert"
          data-testid="impersonation-banner"
          className="flex items-center justify-center gap-4 bg-purple-700 px-4 py-2 text-sm text-white print:hidden"
        >
          <span>
            Viewing <strong>{impersonation.tenantName}</strong> as its Owner — read-only. Every
            request is audited.
          </span>
          <button
            onClick={() => void stopImpersonation()}
            className="rounded bg-white px-3 py-0.5 text-purple-800"
          >
            Exit
          </button>
        </div>
      )}
      <header className="border-b border-gray-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="text-lg font-bold">SupplyCast</span>
          <nav className="flex flex-1 flex-wrap items-center gap-4 text-sm" aria-label="Main">
            {NAV_ITEMS.filter((i) => can(i.permission)).map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === '/' || i.to === '/admin'}
                className={({ isActive }) =>
                  isActive ? 'font-semibold text-blue-700' : 'text-gray-600 hover:text-gray-900'
                }
              >
                {i.label}
              </NavLink>
            ))}
          </nav>
          <span className="text-sm text-gray-600" data-testid="whoami">
            {user?.name} ({user?.role})
          </span>
          <NavLink to="/change-password" className="text-sm text-blue-600 underline">
            Change password
          </NavLink>
          <button onClick={() => void logout()} className="rounded border px-3 py-1 text-sm">
            Log out
          </button>
        </div>
      </header>
      <TrialBanner />
      <main className="mx-auto max-w-6xl p-6">
        {suspended ? (
          <section data-testid="suspended" className="rounded border border-red-300 bg-red-50 p-6">
            <h1 className="text-xl font-bold text-red-800">Account suspended</h1>
            <p className="mt-2 text-red-700">
              This account has been suspended by the platform operator. Contact support to restore
              access.
            </p>
          </section>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
