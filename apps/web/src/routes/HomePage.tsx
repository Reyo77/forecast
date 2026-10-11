import { useEffect, useState } from 'react';

type Status = 'checking' | 'ok' | 'down';

export function HomePage() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setStatus(r.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'));
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">SupplyCast</h1>
      <p className="mt-2 text-gray-600">Demand forecasting and what-if planning.</p>
      <p className="mt-4 text-sm" data-testid="api-status">
        API: {status}
      </p>
    </main>
  );
}
