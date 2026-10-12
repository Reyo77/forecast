import type {
  AiInsightResponse,
  AssistantAnswer,
  ExplainOutput,
  RiskOutput,
  ScenarioProposal,
} from '@supplycast/shared';
import { api } from '../../api/client';

export const aiApi = {
  explain: (b: { runId: string; productId: string; locationId?: string }) =>
    api<AiInsightResponse<ExplainOutput>>('/ai/explain-forecast', 'POST', b),
  scenarioFromText: (b: { text: string; baseForecastRunId?: string }) =>
    api<ScenarioProposal>('/ai/scenario-from-text', 'POST', b),
  riskSummary: (scenarioRunId: string) =>
    api<AiInsightResponse<RiskOutput>>('/ai/risk-summary', 'POST', { scenarioRunId }),
  ask: (question: string, history: { role: 'user' | 'assistant'; text: string }[]) =>
    api<AssistantAnswer>('/ai/assistant', 'POST', { question, history }),
};
