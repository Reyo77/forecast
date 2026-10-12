import type { ZodType, ZodTypeDef } from 'zod';
import type { AiMessage, AiClient, AiToolDeclaration } from '../../ai/types';
import { AiNotConfiguredError } from '../../ai/types';
import { repairHint } from '../../ai/prompts';
import { logger } from '../../config/logger';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import { reserveUsage } from '../billing/limits';

export class AiTimeoutError extends Error {
  constructor() {
    super('AI request timed out');
  }
}

export const DEFAULT_AI_TIMEOUT_MS = 30_000;

/** Pulls the JSON object out of a model reply (handles ```json fences and stray prose). */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

export interface AiContext {
  tenantId: string;
  userId: string | null;
  feature: string;
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Every AI call goes through here: plan-limit check, one structured retry, a hard timeout,
 * usage accounting that only charges successful calls, and an AiRequest audit row.
 * Prompts and API keys are never logged.
 */
export class AiService {
  constructor(
    private readonly client: AiClient,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  private get timeoutMs() {
    return this.opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  }

  private async withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiTimeoutError());
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async record(ctx: AiContext, status: string, totals: Totals, startedAt: number) {
    const latencyMs = Date.now() - startedAt;
    await prisma.aiRequest.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        feature: ctx.feature,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        status,
        latencyMs,
      },
    });
    logger.info({ feature: ctx.feature, status, latencyMs }, 'ai request'); // metadata only
  }

  private friendly(err: unknown): HttpError {
    if (err instanceof HttpError) return err;
    if (err instanceof AiTimeoutError)
      return new HttpError(
        504,
        'AI_TIMEOUT',
        'The AI service took too long to answer. Please try again.',
      );
    if (err instanceof AiNotConfiguredError)
      return new HttpError(
        503,
        'AI_NOT_CONFIGURED',
        'AI features are not configured on this server.',
      );
    return new HttpError(
      502,
      'AI_UNAVAILABLE',
      'The AI service is unavailable right now. Please try again in a moment.',
    );
  }

  /** Runs `body` under the plan limit: reserves one request, releases it if the call fails. */
  private async metered<T>(ctx: AiContext, body: (totals: Totals) => Promise<T>): Promise<T> {
    const reservation = await reserveUsage(ctx.tenantId, 'aiRequests'); // throws 402 at the limit
    const totals: Totals = { inputTokens: 0, outputTokens: 0 };
    const startedAt = Date.now();
    try {
      const out = await body(totals);
      await this.record(ctx, 'OK', totals, startedAt);
      return out;
    } catch (err) {
      await reservation.release();
      const status =
        err instanceof AiTimeoutError
          ? 'TIMEOUT'
          : err instanceof InvalidOutputError
            ? 'INVALID_OUTPUT'
            : 'ERROR';
      logger.warn(
        { feature: ctx.feature, status, errorType: (err as Error)?.constructor?.name },
        'ai request failed',
      );
      await this.record(ctx, status, totals, startedAt).catch(() => undefined);
      throw err instanceof InvalidOutputError
        ? new HttpError(
            502,
            'AI_INVALID_RESPONSE',
            'The AI returned an answer in an unexpected format. Please try again.',
          )
        : this.friendly(err);
    }
  }

  /** One structured (JSON) answer validated by `schema`; an invalid answer is retried once. */
  async structured<T>(
    ctx: AiContext,
    args: {
      system: string;
      prompt: string;
      schema: ZodType<T, ZodTypeDef, unknown>;
      maxOutputTokens?: number;
    },
  ): Promise<T> {
    return this.metered(ctx, async (totals) => {
      const messages: AiMessage[] = [{ role: 'user', parts: [{ text: args.prompt }] }];
      let lastErrors = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await this.withTimeout((signal) =>
          this.client.generate({
            system: args.system,
            messages,
            json: true,
            maxOutputTokens: args.maxOutputTokens,
            signal,
          }),
        );
        totals.inputTokens += res.inputTokens;
        totals.outputTokens += res.outputTokens;
        try {
          const parsed = args.schema.safeParse(extractJson(res.text));
          if (parsed.success) return parsed.data;
          lastErrors = parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; ');
        } catch {
          lastErrors = 'the reply was not valid JSON';
        }
        messages.push(
          { role: 'model', parts: [{ text: res.text.slice(0, 4000) }] },
          { role: 'user', parts: [{ text: repairHint(lastErrors) }] },
        );
      }
      throw new InvalidOutputError(lastErrors);
    });
  }

  /**
   * Tool-using conversation: the model may only call functions from `tools`; each call is run by
   * `execute`, which enforces the allowlist and tenant scoping. One question = one request of quota.
   */
  async converse(
    ctx: AiContext,
    args: {
      system: string;
      messages: AiMessage[];
      tools: AiToolDeclaration[];
      execute: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ ok: boolean; response: Record<string, unknown> }>;
      maxRounds?: number;
      maxCalls?: number;
    },
  ): Promise<{
    answer: string;
    toolCalls: { name: string; args: Record<string, unknown>; ok: boolean }[];
  }> {
    return this.metered(ctx, async (totals) => {
      const messages = [...args.messages];
      const toolCalls: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
      const maxRounds = args.maxRounds ?? 4;
      const maxCalls = args.maxCalls ?? 6;
      for (let round = 0; round < maxRounds; round++) {
        const res = await this.withTimeout((signal) =>
          this.client.generate({ system: args.system, messages, tools: args.tools, signal }),
        );
        totals.inputTokens += res.inputTokens;
        totals.outputTokens += res.outputTokens;
        if (res.functionCalls.length === 0) {
          return {
            answer:
              res.text.trim() || 'I could not produce an answer. Try rephrasing the question.',
            toolCalls,
          };
        }
        const modelParts = res.functionCalls.map((c) => ({
          functionCall: { name: c.name, args: c.args },
        }));
        const responseParts: AiMessage['parts'] = [];
        for (const call of res.functionCalls) {
          if (toolCalls.length >= maxCalls) {
            responseParts.push({
              functionResponse: {
                name: call.name,
                response: { error: 'Too many lookups for one question' },
              },
            });
            continue;
          }
          const out = await args.execute(call.name, call.args);
          toolCalls.push({ name: call.name, args: call.args, ok: out.ok });
          responseParts.push({ functionResponse: { name: call.name, response: out.response } });
        }
        messages.push({ role: 'model', parts: modelParts }, { role: 'user', parts: responseParts });
      }
      return {
        answer: 'I needed too many lookups to answer that. Try a more specific question.',
        toolCalls,
      };
    });
  }
}

class InvalidOutputError extends Error {}

/** Looks up a cached insight, if any. */
export async function getInsight<T>(
  tenantId: string,
  kind: string,
  refKey: string,
): Promise<T | null> {
  const row = await prisma.aiInsight.findUnique({
    where: { tenantId_kind_refKey: { tenantId, kind, refKey } },
  });
  return (row?.result as T | undefined) ?? null;
}

export async function saveInsight(
  tenantId: string,
  kind: string,
  refKey: string,
  promptVersion: string,
  result: unknown,
): Promise<void> {
  try {
    await prisma.aiInsight.create({
      data: { tenantId, kind, refKey, promptVersion, result: result as never },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err; // a concurrent request cached the same insight first
  }
}
