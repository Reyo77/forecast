import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { METRIC_LABELS, type PlanDto } from '@supplycast/shared';
import { ApiError } from '../../api/client';
import { formatDate, formatMoney } from '../../lib';
import { Can, useCan } from '../auth/Can';
import { billingApi, type ChangePlanResponse } from './api';
import { PlanCards } from './PlanCards';

interface Overage {
  metric: string;
  label: string;
  limit: number;
  current: number;
  reduceBy: number;
}

export function BillingPage() {
  const qc = useQueryClient();
  const canManage = useCan()('billing:manage');
  const sub = useQuery({ queryKey: ['billing', 'subscription'], queryFn: billingApi.subscription });
  const plans = useQuery({ queryKey: ['plans'], queryFn: billingApi.plans });
  const [result, setResult] = useState<ChangePlanResponse | null>(null);
  const [error, setError] = useState<{ message: string; overages?: Overage[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const done = (r: ChangePlanResponse) => {
    setResult(r);
    setError(null);
    setBusy(null);
    qc.setQueryData(['billing', 'subscription'], r.subscription);
    void qc.invalidateQueries({ queryKey: ['billing'] });
  };
  const fail = (e: unknown) => {
    setBusy(null);
    setResult(null);
    const ae = e as ApiError;
    setError({
      message: ae.message,
      overages: (ae.details as { overages?: Overage[] } | undefined)?.overages,
    });
  };
  const change = useMutation({
    mutationFn: (p: PlanDto) => billingApi.changePlan(p.code),
    onMutate: (p) => setBusy(p.code),
    onSuccess: done,
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: billingApi.cancel,
    onMutate: () => setBusy('cancel'),
    onSuccess: done,
    onError: fail,
  });

  if (sub.isLoading || plans.isLoading) return <p>Loading…</p>;
  if (sub.error) return <p role="alert">{(sub.error as Error).message}</p>;
  const s = sub.data!;

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-bold">Billing</h1>

      <p
        className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-800"
        data-testid="simulated-notice"
      >
        Payments are simulated. Choosing a plan applies it instantly — no card is charged.
      </p>

      {s.status === 'TRIALING' && (
        <p
          role="status"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="trial-banner"
        >
          Free trial of {s.plan.name}:{' '}
          <strong>
            {s.trialDaysLeft} day{s.trialDaysLeft === 1 ? '' : 's'} left
          </strong>{' '}
          (ends {formatDate(s.trialEndsAt)}). After that you move to Free unless you choose a plan.
        </p>
      )}

      {result && (
        <div
          role="status"
          className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900"
          data-testid="change-result"
        >
          <p className="font-semibold">
            {result.paymentStatus === 'SUCCEEDED' ? 'Payment successful' : 'Plan updated'}
          </p>
          <p>{result.message}</p>
          {result.invoice && (
            <p className="mt-1">
              Invoice{' '}
              <Link to={`/billing/invoices/${result.invoice.id}`} className="underline">
                {result.invoice.number}
              </Link>{' '}
              ({formatMoney(result.invoice.amountCents)}, paid)
            </p>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          data-testid="change-error"
        >
          <p>{error.message}</p>
          {error.overages && (
            <ul className="mt-1 list-disc pl-5">
              {error.overages.map((o) => (
                <li key={o.metric}>
                  {o.label}: you have {o.current}, the new plan allows {o.limit} — reduce by{' '}
                  {o.reduceBy}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 p-5" data-testid="current-plan">
          <h2 className="text-sm font-medium text-gray-500">Current plan</h2>
          <p className="mt-1 text-2xl font-bold">
            {s.plan.name}{' '}
            <span className="text-base font-normal text-gray-500">
              {s.plan.isCustom ? 'custom pricing' : `${formatMoney(s.plan.priceCents)} / month`}
            </span>
          </p>
          <p className="mt-1 text-sm text-gray-600">
            Status: {s.status.toLowerCase()} · current period ends {formatDate(s.periodEnd)}
          </p>
          {s.pendingPlan && (
            <p className="mt-2 text-sm text-amber-800" data-testid="pending-plan">
              Scheduled: you will move to {s.pendingPlan.name} on {formatDate(s.periodEnd)}.
            </p>
          )}
          <Can permission="billing:manage">
            <div className="mt-4 flex gap-2">
              {s.pendingPlan && (
                <button
                  onClick={() => change.mutate(s.plan)}
                  className="rounded border px-3 py-1 text-sm"
                >
                  Keep {s.plan.name}
                </button>
              )}
              {s.plan.priceCents > 0 && s.status !== 'CANCELED' && (
                <button
                  onClick={() => cancel.mutate()}
                  disabled={busy === 'cancel'}
                  className="rounded border border-red-300 px-3 py-1 text-sm text-red-700"
                >
                  Cancel plan
                </button>
              )}
            </div>
          </Can>
        </div>

        <div className="rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-500">Usage</h2>
          <ul className="mt-2 space-y-3" data-testid="usage">
            {s.usage.map((u) => {
              const pct = u.limit ? Math.min(100, Math.round((u.current / u.limit) * 100)) : 100;
              return (
                <li key={u.metric}>
                  <div className="flex justify-between text-sm">
                    <span>{METRIC_LABELS[u.metric]}</span>
                    <span data-testid={`usage-${u.metric}`}>
                      {u.current.toLocaleString()} / {u.limit.toLocaleString()}
                      {pct >= 100 ? ' · limit reached' : pct >= 80 ? ' · almost full' : ''}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={METRIC_LABELS[u.metric]}
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="mt-1 h-2 rounded bg-gray-100"
                  >
                    <div
                      className="h-2 rounded"
                      style={{ width: `${pct}%`, background: 'var(--series-1)' }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Plans</h2>
          <Link to="/billing/invoices" className="text-sm text-blue-600 underline">
            View invoices
          </Link>
        </div>
        <PlanCards
          plans={plans.data?.items ?? []}
          currentCode={s.plan.code}
          pendingCode={s.pendingPlan?.code}
          busyCode={busy && busy !== 'cancel' ? busy : null}
          onChoose={canManage ? (p) => change.mutate(p) : undefined}
          cta={undefined}
        />
        {!(plans.data?.items ?? []).length && (
          <p className="text-sm text-gray-500">No plans available.</p>
        )}
      </div>
    </section>
  );
}
