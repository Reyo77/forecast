import { NavLink, Outlet } from 'react-router-dom';
import type { Permission } from '@supplycast/shared';
import { useAuth } from '../features/auth/AuthContext';
import { useCan } from '../features/auth/Can';

export const NAV_ITEMS: { to: string; label: string; permission: Permission }[] = [
  { to: '/', label: 'Home', permission: 'dashboard:read' },
  { to: '/team', label: 'Team', permission: 'team:read' },
  { to: '/audit-log', label: 'Audit log', permission: 'audit:read' },
];

export function AppLayout() {
  const { user, logout } = useAuth();
  const can = useCan();
  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="text-lg font-bold">SupplyCast</span>
          <nav className="flex flex-1 items-center gap-4 text-sm" aria-label="Main">
            {NAV_ITEMS.filter((i) => can(i.permission)).map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === '/'}
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
      <main className="mx-auto max-w-6xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
