import { z } from 'zod';
import type { LeverInput } from './scenarios';

export const explainOutputSchema = z.object({
  explanation: z.string().trim().min(1).max(2000),
  drivers: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  caveats: z.array(z.string().trim().min(1).max(300)).max(4).default([]),
});
export type ExplainOutput = z.infer<typeof explainOutputSchema>;

export const riskOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1500),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  actions: z.array(z.string().trim().min(1).max(300)).min(3).max(5),
});
export type RiskOutput = z.infer<typeof riskOutputSchema>;

export interface AiInsightResponse<T> {
  result: T;
  cached: boolean;
}

export interface ProposedLever {
  lever: LeverInput;
  summary: string;
}
export interface ScenarioProposal {
  interpretation: string;
  levers: ProposedLever[];
  unresolved: string[];
  baseForecastRunId: string;
}

export interface AssistantAnswer {
  answer: string;
  toolCalls: { name: string; args: Record<string, unknown>; ok: boolean }[];
}

export const explainRequestSchema = z.object({
  runId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  locationId: z.string().min(1).max(64).optional(),
});
export const scenarioTextSchema = z.object({
  text: z.string().trim().min(3, 'Describe the scenario in a sentence').max(1000),
  baseForecastRunId: z.string().min(1).max(64).optional(),
});
export const riskRequestSchema = z.object({ scenarioRunId: z.string().min(1).max(64) });
export const assistantRequestSchema = z.object({
  question: z.string().trim().min(3, 'Ask a question').max(500),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) }))
    .max(6)
    .default([]),
});
