import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../../components/Icon';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <Link to="/" className="mb-8 flex items-center gap-2.5 text-lg font-bold">
        <Logo /> SupplyCast
      </Link>
      <h1 className="text-3xl">{title}</h1>
      <p className="mt-1 text-sm text-gray-500">Last updated: January 2026</p>
      <div className="mt-6 space-y-4 text-gray-700">{children}</div>
    </main>
  );
}

export function TermsPage() {
  return (
    <Shell title="Terms of Service">
      <p>
        By creating an account you agree to use SupplyCast lawfully and keep your credentials
        secure. You own your data; we process it only to provide the service.
      </p>
      <h2>Plans and billing</h2>
      <p>
        Plans, limits and prices are listed on the pricing page. You can change plan at any time;
        changes take effect immediately.
      </p>
      <h2>Forecasts are estimates</h2>
      <p>
        Forecasts and plans are statistical estimates. Review them before placing orders; we are not
        liable for purchasing decisions.
      </p>
      <h2>Availability</h2>
      <p>
        We work hard to keep the service available but do not guarantee uninterrupted operation.
      </p>
    </Shell>
  );
}

export function PrivacyPage() {
  return (
    <Shell title="Privacy Policy">
      <p>
        We collect the account details you provide and the business data you import (products,
        sales, inventory, suppliers).
      </p>
      <h2>How we use it</h2>
      <p>
        Only to run forecasts, plans and the features you use. We do not sell your data. AI features
        send the minimum data needed to answer your request.
      </p>
      <h2>Isolation and security</h2>
      <p>
        Each company’s data is isolated from every other. Passwords are hashed and sensitive actions
        are recorded in an audit log.
      </p>
      <h2>Your choices</h2>
      <p>Owners can delete their company and all its data from the Team page at any time.</p>
    </Shell>
  );
}

export function NotFoundPage() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center"
      data-testid="not-found"
    >
      <p className="text-6xl font-bold text-blue-600">404</p>
      <h1 className="text-2xl">This page doesn’t exist</h1>
      <p className="text-gray-600">The link may be broken or the page may have moved.</p>
      <Link
        to="/"
        className="mt-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Back to home
      </Link>
    </main>
  );
}
