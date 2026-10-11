import type { ReactNode } from 'react';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto mt-16 max-w-md rounded-lg border border-gray-200 p-8 shadow-sm">
      <h1 className="mb-6 text-2xl font-bold">{title}</h1>
      {children}
    </main>
  );
}

export function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
      {message}
    </p>
  ) : null;
}
