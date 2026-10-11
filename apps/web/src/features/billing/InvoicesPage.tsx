import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { formatDate, formatMoney } from '../../lib';
import { billingApi } from './api';

export function InvoicesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['billing', 'invoices'],
    queryFn: billingApi.invoices,
  });
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Invoices</h1>
      <p className="text-sm text-gray-600">Payments are simulated; invoices are issued as paid.</p>
      {isLoading && <p>Loading…</p>}
      {error && <p role="alert">{(error as Error).message}</p>}
      {data && data.items.length === 0 && (
        <p className="text-sm text-gray-500">
          No invoices yet. They appear when you choose a paid plan.
        </p>
      )}
      {data && data.items.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2">Number</th>
              <th>Plan</th>
              <th>Period</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id} className="border-b" data-testid="invoice-row">
                <td className="py-2">
                  <Link to={`/billing/invoices/${i.id}`} className="text-blue-600 underline">
                    {i.number}
                  </Link>
                </td>
                <td>{i.planName}</td>
                <td>
                  {formatDate(i.periodStart)} – {formatDate(i.periodEnd)}
                </td>
                <td>{formatMoney(i.amountCents)}</td>
                <td>{i.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function InvoicePage() {
  const { id } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['billing', 'invoice', id],
    queryFn: () => billingApi.invoice(id!),
  });
  if (isLoading) return <p>Loading…</p>;
  if (error || !data) return <p role="alert">{(error as Error)?.message ?? 'Invoice not found'}</p>;
  const { invoice: i, billedTo } = data;
  return (
    <section
      className="mx-auto max-w-2xl space-y-6 rounded border border-gray-200 p-8"
      data-testid="invoice"
    >
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Invoice {i.number}</h1>
          <p className="text-sm text-gray-600">Issued {formatDate(i.createdAt)}</p>
        </div>
        <span className="rounded bg-green-50 px-2 py-1 text-sm font-medium text-green-700">
          {i.status}
        </span>
      </div>
      <p className="text-sm">
        <strong>Billed to:</strong> {billedTo}
      </p>
      <table className="w-full text-left text-sm">
        <thead className="border-b text-gray-500">
          <tr>
            <th className="py-2">Description</th>
            <th>Period</th>
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="py-2">{i.description}</td>
            <td>
              {formatDate(i.periodStart)} – {formatDate(i.periodEnd)}
            </td>
            <td className="text-right">{formatMoney(i.amountCents)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-right text-lg font-bold">Total {formatMoney(i.amountCents)}</p>
      <p className="text-xs text-gray-500">
        Payment simulated — no real charge was made. Paid {formatDate(i.paidAt)}.
      </p>
      <div className="flex gap-3 print:hidden">
        <button
          onClick={() => window.print()}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white"
        >
          Print
        </button>
        <Link to="/billing/invoices" className="rounded border px-4 py-2 text-sm">
          Back to invoices
        </Link>
      </div>
    </section>
  );
}
