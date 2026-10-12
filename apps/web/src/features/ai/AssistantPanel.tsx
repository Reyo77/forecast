import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errText } from '../../components/ui';
import { aiApi } from './api';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  tools?: { name: string; ok: boolean }[];
  error?: boolean;
}

/** Side panel: ask questions about your data; the AI answers from a fixed set of safe lookups. */
export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const ask = useMutation({
    mutationFn: (v: { q: string; history: { role: 'user' | 'assistant'; text: string }[] }) =>
      aiApi.ask(v.q, v.history),
    onSuccess: (r) =>
      setTurns((t) => [
        ...t,
        {
          role: 'assistant',
          text: r.answer,
          tools: r.toolCalls.map((c) => ({ name: c.name, ok: c.ok })),
        },
      ]),
    onError: (e) => setTurns((t) => [...t, { role: 'assistant', text: errText(e), error: true }]),
  });
  return (
    <aside
      aria-label="AI assistant"
      data-testid="assistant"
      className="fixed bottom-4 right-4 z-30 flex h-[28rem] w-96 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-gray-300 bg-white shadow-xl print:hidden"
    >
      <header className="flex items-center justify-between border-b px-3 py-2">
        <strong className="text-sm">Ask about your data</strong>
        <button onClick={onClose} aria-label="Close assistant" className="text-gray-500">
          ✕
        </button>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm" aria-live="polite">
        {turns.length === 0 && (
          <p className="text-gray-500">
            Try: "Which products have the worst forecast accuracy?" or "Which products make the most
            revenue?"
          </p>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={t.role === 'user' ? 'text-right' : ''}
            data-testid={`turn-${t.role}`}
          >
            <div
              className={`inline-block max-w-full rounded-lg px-3 py-1.5 text-left ${t.role === 'user' ? 'bg-blue-600 text-white' : t.error ? 'bg-red-50 text-red-800' : 'bg-gray-100'}`}
            >
              {t.text}
            </div>
            {t.tools && t.tools.length > 0 && (
              <p className="mt-0.5 text-xs text-gray-500" data-testid="tools-used">
                Looked up: {t.tools.map((x) => `${x.name}${x.ok ? '' : ' (failed)'}`).join(', ')}
              </p>
            )}
          </div>
        ))}
        {ask.isPending && <p className="text-gray-500">Thinking…</p>}
      </div>
      <form
        className="flex gap-2 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          const q = question.trim();
          if (q.length < 3) return;
          // History is everything said BEFORE this question (the question itself is sent separately).
          const history = turns
            .filter((t) => !t.error)
            .slice(-6)
            .map((t) => ({ role: t.role, text: t.text }));
          setTurns((t) => [...t, { role: 'user', text: q }]);
          setQuestion('');
          ask.mutate({ q, history });
        }}
      >
        <input
          aria-label="Your question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question…"
          maxLength={500}
          className="min-w-0 flex-1 rounded border px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={ask.isPending}
          className="rounded bg-purple-700 px-3 py-1 text-sm text-white disabled:opacity-60"
        >
          Ask
        </button>
      </form>
    </aside>
  );
}
