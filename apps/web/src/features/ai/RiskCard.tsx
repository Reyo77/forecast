import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Can } from '../auth/Can';
import { Notice, errText } from '../../components/ui';
import { aiApi } from './api';

const SEV_CLS = {
  LOW: 'bg-green-100 text-green-800',
  MEDIUM: 'bg-amber-100 text-amber-800',
  HIGH: 'bg-red-100 text-red-800',
} as const;

export function RiskCard({ scenarioRunId }: { scenarioRunId: string }) {
  const [shown, setShown] = useState<{
    id: string;
    data: Awaited<ReturnType<typeof aiApi.riskSummary>>;
  } | null>(null);
  const summarise = useMutation({
    mutationFn: () => aiApi.riskSummary(scenarioRunId),
    onSuccess: (data) => setShown({ id: scenarioRunId, data }),
  });
  const current = shown?.id === scenarioRunId ? shown.data : null;
  return (
    <Can permission="ai:use">
      <div className="space-y-2">
        <button
          onClick={() => summarise.mutate()}
          disabled={summarise.isPending}
          className="rounded border border-purple-300 bg-purple-50 px-3 py-1.5 text-sm text-purple-900 disabled:opacity-60"
        >
          {summarise.isPending ? 'Summarising…' : 'Summarise risks'}
        </button>
        {summarise.isError && <Notice kind="error">{errText(summarise.error)}</Notice>}
        {current && (
          <div
            className="rounded-lg border border-purple-200 bg-purple-50/40 p-3 text-sm"
            data-testid="risk-summary"
          >
            <div className="mb-1 flex items-center gap-2">
              <strong>Executive summary</strong>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${SEV_CLS[current.result.severity]}`}
                data-testid="severity"
              >
                Risk: {current.result.severity}
              </span>
              {current.cached && (
                <span className="text-xs text-gray-500">saved — no quota used</span>
              )}
            </div>
            <p>{current.result.summary}</p>
            <p className="mt-2 font-medium">Suggested actions</p>
            <ol className="list-decimal pl-5" data-testid="risk-actions">
              {current.result.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Can>
  );
}
