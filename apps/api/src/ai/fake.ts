import type { AiClient, AiGenerateRequest, AiGenerateResponse } from './types';

type Scripted =
  | Partial<AiGenerateResponse>
  | Error
  | ((
      req: AiGenerateRequest,
    ) => Partial<AiGenerateResponse> | Promise<Partial<AiGenerateResponse>>);

/**
 * Test double: replies come from a queue you fill up front and every request is recorded.
 * Tests must always use this (never the real Gemini client).
 */
export class FakeAiClient implements AiClient {
  readonly requests: AiGenerateRequest[] = [];
  private queue: Scripted[] = [];
  delayMs = 0;

  enqueue(...replies: Scripted[]): this {
    this.queue.push(...replies);
    return this;
  }
  /** Convenience: queue a JSON object as the model's text. */
  enqueueJson(...objects: unknown[]): this {
    return this.enqueue(
      ...objects.map((o) => ({ text: JSON.stringify(o), inputTokens: 100, outputTokens: 50 })),
    );
  }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResponse> {
    this.requests.push(req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeAiClient: no reply queued');
    if (next instanceof Error) throw next;
    const r = typeof next === 'function' ? await next(req) : next;
    return {
      text: r.text ?? '',
      functionCalls: r.functionCalls ?? [],
      inputTokens: r.inputTokens ?? 10,
      outputTokens: r.outputTokens ?? 10,
    };
  }
}

const num = (s: string) => Number(s.replace(/[^\d.]/g, ''));

/**
 * Deterministic stand-in for Gemini used by the end-to-end tests (AI_PROVIDER=fake). It understands a
 * handful of phrasings so the full UI flow can be exercised without any network access.
 */
export class DemoAiClient implements AiClient {
  async generate(req: AiGenerateRequest): Promise<AiGenerateResponse> {
    const prompt = req.messages
      .flatMap((m) => m.parts)
      .map((p) => ('text' in p ? p.text : ''))
      .join('\n');
    const reply = (obj: unknown): AiGenerateResponse => ({
      text: JSON.stringify(obj),
      functionCalls: [],
      inputTokens: 120,
      outputTokens: 60,
    });

    if (prompt.includes('[feature:explain_forecast]')) {
      return reply({
        explanation:
          'Demand has been trending up with a clear yearly pattern, and the model follows both. The forecast stays close to recent weeks with room for the usual week-to-week swings.',
        drivers: ['Upward trend over the last months', 'Yearly seasonality', 'Recent promotions'],
        confidence: 'MEDIUM',
        caveats: [
          'Forecast accuracy is measured on only the last 12 weeks',
          'Unplanned promotions are not modelled',
        ],
      });
    }
    if (prompt.includes('[feature:risk_summary]')) {
      return reply({
        summary:
          'The scenario lowers the fill rate and creates additional stockouts compared with the baseline. Revenue is most exposed on the products listed as at risk.',
        severity: 'HIGH',
        actions: [
          'Expedite open orders from the affected supplier',
          'Raise safety stock for the top at-risk products',
          'Line up an alternate supplier for critical components',
        ],
      });
    }
    if (prompt.includes('[feature:scenario_builder]')) {
      const request = /Request: (.*)/.exec(prompt)?.[1] ?? '';
      const lists = (label: string) =>
        JSON.parse(new RegExp(`${label}: (\\[.*\\])`).exec(prompt)?.[1] ?? '[]') as string[];
      const suppliers = lists('Suppliers');
      const categories = lists('Categories');
      const levers: Record<string, unknown>[] = [];
      const unresolved: string[] = [];
      const late = /(.+?) is (\d+(?:\.\d+)?) (weeks?|days?) late/i.exec(request);
      if (late) {
        const name = late[1]!.replace(/^what if\s+/i, '').trim();
        const supplier = suppliers.find((s) => s.toLowerCase() === name.toLowerCase());
        const days = Math.round(num(late[2]!) * (/week/i.test(late[3]!) ? 7 : 1));
        if (supplier)
          levers.push({ type: 'SUPPLIER_DELAY', supplierName: supplier, extraDays: days });
        else unresolved.push(`supplier "${name}"`);
      }
      const rise =
        /demand for (.+?) (rises|goes up|increases|drops|falls) (?:by )?(\d+(?:\.\d+)?)%/i.exec(
          request,
        );
      if (rise) {
        const cat = categories.find((c) => c.toLowerCase() === rise[1]!.trim().toLowerCase());
        const pct = num(rise[3]!) * (/drop|fall/i.test(rise[2]!) ? -1 : 1);
        if (cat)
          levers.push({ type: 'DEMAND_CHANGE', scope: 'CATEGORY', targetName: cat, percent: pct });
        else unresolved.push(`category "${rise[1]!.trim()}"`);
      }
      return reply({ summary: `Interpreted as ${levers.length} lever(s).`, levers, unresolved });
    }
    return {
      text: 'I looked at your data. Nothing unusual stands out.',
      functionCalls: [],
      inputTokens: 80,
      outputTokens: 20,
    };
  }
}
