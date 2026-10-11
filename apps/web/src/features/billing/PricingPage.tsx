import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { billingApi } from './api';
import { PlanCards } from './PlanCards';

export function PricingPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ['plans'], queryFn: billingApi.plans });
  return (
    <main className="mx-auto max-w-6xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <Link to="/" className="text-xl font-bold">
          SupplyCast
        </Link>
        <nav className="flex gap-4 text-sm">
          {user ? (
            <Link to="/billing" className="text-blue-600 underline">
              Manage billing
            </Link>
          ) : (
            <>
              <Link to="/login" className="text-blue-600 underline">
                Log in
              </Link>
              <Link to="/signup" className="rounded bg-blue-600 px-3 py-1 text-white">
                Start free trial
              </Link>
            </>
          )}
        </nav>
      </header>
      <h1 className="text-3xl font-bold">Simple, data-driven pricing</h1>
      <p className="mt-2 text-gray-600">
        Every new account gets a 14-day Starter trial. Payments are simulated in this demo —
        choosing a plan applies it instantly.
      </p>
      <div className="mt-8">
        {isLoading && <p>Loading plans…</p>}
        {error && <p role="alert">{(error as Error).message}</p>}
        {data && (
          <PlanCards
            plans={data.items}
            cta={(p) =>
              p.isCustom ? (
                <span className="text-sm text-gray-500">Contact us for custom limits</span>
              ) : user ? (
                <Link to="/billing" className="block rounded border px-4 py-2 text-center text-sm">
                  Go to billing
                </Link>
              ) : (
                <Link
                  to="/signup"
                  className="block rounded bg-blue-600 px-4 py-2 text-center text-sm text-white"
                >
                  {p.priceCents === 0 ? 'Start free' : `Try ${p.name} free`}
                </Link>
              )
            }
          />
        )}
      </div>
    </main>
  );
}
