import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

type Status = 'checking' | 'ok' | 'down';

export function HomePage() {
  const [status, setStatus] = useState<Status>('checking');
  const { user, logout } = useAuth();

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setStatus(r.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'));
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">SupplyCast</h1>
        <nav className="flex items-center gap-4 text-sm">
          <span data-testid="whoami">
            {user?.name} ({user?.role})
          </span>
          <Link to="/change-password" className="text-blue-600 underline">
            Change password
          </Link>
          <button onClick={() => void logout()} className="rounded border px-3 py-1">
            Log out
          </button>
        </nav>
      </header>
      <p className="mt-2 text-gray-600">Demand forecasting and what-if planning.</p>
      <p className="mt-4 text-sm" data-testid="api-status">
        API: {status}
      </p>
    </main>
  );
}
