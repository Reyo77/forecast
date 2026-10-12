import type { ReactNode } from 'react';

export const inputCls = 'mt-1 block rounded border border-gray-300 px-2 py-1 text-sm';

export function Notice({ kind, children }: { kind: 'error' | 'success'; children: ReactNode }) {
  return kind === 'error' ? (
    <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
      {children}
    </p>
  ) : (
    <p role="status" className="rounded bg-green-50 p-2 text-sm text-green-800">
      {children}
    </p>
  );
}

export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded border px-3 py-1 disabled:opacity-40"
      >
        Previous
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        className="rounded border px-3 py-1 disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
