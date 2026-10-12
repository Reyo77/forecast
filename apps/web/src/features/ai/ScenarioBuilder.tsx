import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { LeverInput, ScenarioProposal } from '@supplycast/shared';
import { Notice, errText, inputCls } from '../../components/ui';
import { Can } from '../auth/Can';
import { scenarioApi } from '../scenarios/api';
import { aiApi } from './api';

type Editable = { id: number; lever: LeverInput; summary: string };

/** The one numeric value the planner is most likely to tweak for a proposed lever. */
function mainParam(
  l: LeverInput,
): { key: string; label: string; value: number; scale: number } | null {
  const p = l.params as Record<string, number>;
  switch (l.type) {
    case 'DEMAND_CHANGE':
    case 'PRICE_CHANGE':
      return { key: 'percent', label: 'Change %', value: p.percent!, scale: 1 };
    case 'SUPPLIER_DELAY':
      return { key: 'extraDays', label: 'Days late', value: p.extraDays!, scale: 1 };
    case 'LEAD_TIME_CHANGE':
      return { key: 'leadTimeDays', label: 'Lead time (days)', value: p.leadTimeDays!, scale: 1 };
    case 'CAPACITY_CAP':
      return { key: 'weeklyQuantity', label: 'Units / week', value: p.weeklyQuantity!, scale: 1 };
    case 'SERVICE_LEVEL':
      return {
        key: 'serviceLevel',
        label: 'Service level %',
        value: Math.round(p.serviceLevel! * 1000) / 10,
        scale: 100,
      };
  }
}

/**
 * "Describe a scenario" in plain English. The AI only PROPOSES levers: nothing is saved until the
 * planner reviews/edits them and confirms.
 */
export function ScenarioBuilder() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState<ScenarioProposal | null>(null);
  const [items, setItems] = useState<Editable[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const propose = useMutation({
    mutationFn: () => aiApi.scenarioFromText({ text }),
    onSuccess: (p) => {
      setProposal(p);
      setItems(p.levers.map((l, i) => ({ id: i, lever: l.lever, summary: l.summary })));
      setName(text.slice(0, 80));
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (e) => {
      setProposal(null);
      setErr(errText(e));
    },
  });
  const confirm = useMutation({
    mutationFn: async () => {
      const { scenario } = await scenarioApi.create({
        name,
        baseForecastRunId: proposal!.baseForecastRunId,
      });
      for (const it of items) await scenarioApi.addLever(scenario.id, it.lever);
      return scenario;
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['scenarios'] });
      navigate(`/scenarios/${s.id}`);
    },
    onError: (e) => setErr(errText(e)),
  });
  useQuery({ queryKey: ['noop-ai'], queryFn: () => null, enabled: false });

  function edit(id: number, value: number) {
    setItems((all) =>
      all.map((it) => {
        if (it.id !== id) return it;
        const mp = mainParam(it.lever);
        if (!mp) return it;
        return {
          ...it,
          lever: {
            ...it.lever,
            params: { ...(it.lever.params as object), [mp.key]: value / mp.scale },
          } as LeverInput,
        };
      }),
    );
  }

  return (
    <Can permission="ai:use">
      <section
        className="space-y-3 rounded-lg border border-purple-200 bg-purple-50/40 p-4"
        aria-label="Describe a scenario"
      >
        <h2 className="font-semibold">Describe a scenario in plain English</h2>
        <form
          className="flex flex-wrap items-end gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            setErr(null);
            propose.mutate();
          }}
        >
          <label className="min-w-72 flex-1">
            What if…
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Acme Supplies is 3 weeks late and demand for snacks rises 15%"
              className={`${inputCls} w-full`}
            />
          </label>
          <button
            type="submit"
            disabled={propose.isPending || text.trim().length < 3}
            className="rounded bg-purple-700 px-4 py-2 text-white disabled:opacity-60"
          >
            {propose.isPending ? 'Thinking…' : 'Propose levers'}
          </button>
        </form>
        {err && <Notice kind="error">{err}</Notice>}
        {proposal && (
          <div className="space-y-3" data-testid="proposal">
            {proposal.interpretation && (
              <p className="text-sm text-gray-700">{proposal.interpretation}</p>
            )}
            {items.length === 0 ? (
              <p className="text-sm text-gray-600">No levers could be built from that sentence.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {items.map((it) => {
                  const mp = mainParam(it.lever);
                  return (
                    <li
                      key={it.id}
                      className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-white px-3 py-1.5"
                      data-testid="proposed-lever"
                    >
                      <span>{it.summary}</span>
                      {mp && (
                        <label className="ml-auto text-xs">
                          {mp.label}
                          <input
                            type="number"
                            step="any"
                            aria-label={`${mp.label} for ${it.summary}`}
                            value={mp.value}
                            onChange={(e) => edit(it.id, Number(e.target.value))}
                            className="ml-1 w-20 rounded border px-1 py-0.5"
                          />
                        </label>
                      )}
                      <button
                        onClick={() => setItems((all) => all.filter((x) => x.id !== it.id))}
                        aria-label={`Discard ${it.summary}`}
                        className="text-xs text-red-700 underline"
                      >
                        discard
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {proposal.unresolved.length > 0 && (
              <div
                className="rounded border border-amber-300 bg-amber-50 p-2 text-sm"
                data-testid="unresolved"
              >
                <p className="font-medium">Could not match (nothing was guessed):</p>
                <ul className="list-disc pl-5">
                  {proposal.unresolved.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
            {items.length > 0 && (
              <form
                className="flex flex-wrap items-end gap-2 text-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  confirm.mutate();
                }}
              >
                <label>
                  Scenario name
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={`${inputCls} w-72`}
                  />
                </label>
                <button
                  type="submit"
                  disabled={confirm.isPending}
                  className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
                >
                  Confirm and create scenario ({items.length} lever{items.length === 1 ? '' : 's'})
                </button>
                <button
                  type="button"
                  onClick={() => setProposal(null)}
                  className="rounded border px-3 py-2"
                >
                  Dismiss
                </button>
              </form>
            )}
            <p className="text-xs text-gray-500">Nothing is saved until you confirm.</p>
          </div>
        )}
      </section>
    </Can>
  );
}
