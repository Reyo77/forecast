import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Notice, errText, inputCls } from '../../components/ui';
import { formatDate } from '../../lib';
import { Can } from '../auth/Can';
import { forecastApi } from '../forecast/api';
import { scenarioApi } from './api';

const STATUS_CLS: Record<string, string> = {
  READY: 'bg-green-100 text-green-800',
  RUNNING: 'bg-amber-100 text-amber-800',
  FAILED: 'bg-red-100 text-red-800',
  DRAFT: 'bg-gray-100 text-gray-700',
};

export function ScenariosPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const scenarios = useQuery({ queryKey: ['scenarios'], queryFn: scenarioApi.list });
  const runs = useQuery({ queryKey: ['forecast-runs'], queryFn: forecastApi.runs });
  const doneRuns = runs.data?.items.filter((r) => r.status === 'DONE') ?? [];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseRun, setBaseRun] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      scenarioApi.create({
        name,
        ...(description && { description }),
        baseForecastRunId: baseRun || doneRuns[0]!.id,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['scenarios'] });
      void qc.invalidateQueries({ queryKey: ['billing'] });
      navigate(`/scenarios/${r.scenario.id}`);
    },
    onError: (e) => setErr(errText(e)),
  });
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? s : [...s, id],
    );

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">What-if scenarios</h1>
        <button
          disabled={selected.length < 1}
          onClick={() => navigate(`/scenarios/compare?ids=${selected.join(',')}`)}
          className="rounded border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Compare selected ({selected.length}/3)
        </button>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      <Can permission="scenario:write">
        {doneRuns.length === 0 && !runs.isLoading ? (
          <p
            className="rounded border border-amber-300 bg-amber-50 p-3 text-sm"
            data-testid="needs-forecast"
          >
            Scenarios start from a finished forecast.{' '}
            <Link to="/forecasts" className="underline">
              Run a forecast first.
            </Link>
          </p>
        ) : (
          <form
            aria-label="New scenario"
            className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              setErr(null);
              create.mutate();
            }}
          >
            <label>
              Name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="min-w-48 flex-1">
              Description
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className={`${inputCls} w-full`}
              />
            </label>
            <label>
              Base forecast
              <select
                value={baseRun || doneRuns[0]?.id || ''}
                onChange={(e) => setBaseRun(e.target.value)}
                className={inputCls}
              >
                {doneRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {formatDate(r.createdAt)} · {r.horizonWeeks} wk · {r.seriesTotal} series
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
            >
              Create scenario
            </button>
          </form>
        )}
      </Can>

      {scenarios.data && scenarios.data.items.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="no-scenarios">
          No scenarios yet.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              <th className="py-2 w-8" />
              <th>Name</th>
              <th>Status</th>
              <th>Levers</th>
              <th>Fill rate (what-if)</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.data?.items.map((s) => (
              <tr key={s.id} className="border-b" data-testid={`scenario-${s.name}`}>
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${s.name}`}
                    checked={selected.includes(s.id)}
                    disabled={!selected.includes(s.id) && selected.length >= 3}
                    onChange={() => toggle(s.id)}
                  />
                </td>
                <td>
                  <Link to={`/scenarios/${s.id}`} className="text-blue-600 underline">
                    {s.name}
                  </Link>
                </td>
                <td>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLS[s.status]}`}
                  >
                    {s.status}
                  </span>
                </td>
                <td>{s.leverCount}</td>
                <td>
                  {s.latestKpis
                    ? `${(s.latestKpis.scenario.fillRate * 100).toFixed(1)}% (baseline ${(s.latestKpis.baseline.fillRate * 100).toFixed(1)}%)`
                    : '—'}
                </td>
                <td>{formatDate(s.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
