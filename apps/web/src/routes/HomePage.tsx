import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

type Status = 'checking' | 'ok' | 'down';

export function HomePage() {
  const [status, setStatus] = useState<Status>('checking');
  const { user } = useAuth();

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setStatus(r.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'));
  }, []);

  if (user?.role === 'SUPER_ADMIN') return <Navigate to="/admin" replace />;

  return (
    <section>
      <h1 className="text-3xl font-bold">SupplyCast</h1>
      <p className="mt-2 text-gray-600">Demand forecasting and what-if planning.</p>
      <p className="mt-4 text-sm" data-testid="api-status">
        API: {status}
      </p>
    </section>
  );
}
