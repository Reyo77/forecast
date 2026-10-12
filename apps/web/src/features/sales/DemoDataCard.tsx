import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Notice, errText } from '../../components/ui';
import { Can } from '../auth/Can';
import { salesApi } from './api';

/** "Load demo data": visible only to Owner/Admin and only while the account has no sales history. */
export function DemoDataCard() {
  return (
    <Can permission="demo:load">
      <DemoInner />
    </Can>
  );
}

function DemoInner() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['demo-status'], queryFn: salesApi.demoStatus });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useMutation({
    mutationFn: salesApi.loadDemo,
    onSuccess: (r) => {
      setMsg(
        `Demo data loaded: ${r.summary.products} products, ${r.summary.locations} locations, ${r.summary.suppliers} suppliers and ${r.summary.weeksOfSales} weeks of sales.`,
      );
      setErr(null);
      void qc.invalidateQueries();
    },
    onError: (e) => {
      setErr(errText(e));
      setMsg(null);
    },
  });
  if (msg) return <Notice kind="success">{msg}</Notice>;
  if (!status.data?.canLoad) return err ? <Notice kind="error">{err}</Notice> : null;
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4" data-testid="demo-card">
      <h2 className="font-semibold">Try it with demo data</h2>
      <p className="mt-1 text-sm text-gray-700">
        Creates products, locations, suppliers, bills of materials, stock and about three years of
        weekly sales with trend, seasonality and promotions.
      </p>
      {err && <Notice kind="error">{err}</Notice>}
      <button
        onClick={() => load.mutate()}
        disabled={load.isPending}
        className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-60"
      >
        {load.isPending ? 'Loading…' : 'Load demo data'}
      </button>
    </div>
  );
}
