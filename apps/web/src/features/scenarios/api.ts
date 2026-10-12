import type {
  LeverDto,
  Paged,
  PlanKpisDto,
  ScenarioDto,
  ScenarioRunDto,
  AtRiskDto,
  WeekTotal,
} from '@supplycast/shared';
import { api } from '../../api/client';

export interface CompareResponse {
  baseline: { kpis: PlanKpisDto; atRisk: AtRiskDto[]; totals: WeekTotal[] };
  scenarios: {
    id: string;
    name: string;
    runId: string;
    kpis: PlanKpisDto;
    atRisk: AtRiskDto[];
    totals: WeekTotal[];
    levers: LeverDto[];
  }[];
}
export interface SeriesWeek {
  weekStart: string;
  baseline: { demand: number; receipts: number; onHand: number; shortage: number };
  scenario: { demand: number; receipts: number; onHand: number; shortage: number };
}

export const scenarioApi = {
  list: () => api<Paged<ScenarioDto>>('/scenarios?pageSize=100'),
  create: (b: { name: string; description?: string; baseForecastRunId: string }) =>
    api<{ scenario: ScenarioDto }>('/scenarios', 'POST', b),
  get: (id: string) =>
    api<{ scenario: ScenarioDto; levers: LeverDto[]; latestRun: ScenarioRunDto | null }>(
      `/scenarios/${id}`,
    ),
  remove: (id: string) => api<void>(`/scenarios/${id}`, 'DELETE'),
  addLever: (id: string, lever: unknown) =>
    api<{ lever: LeverDto }>(`/scenarios/${id}/levers`, 'POST', lever),
  removeLever: (id: string, leverId: string) =>
    api<void>(`/scenarios/${id}/levers/${leverId}`, 'DELETE'),
  run: (id: string) => api<{ run: ScenarioRunDto }>(`/scenarios/${id}/run`, 'POST'),
  runDetail: (id: string) => api<{ run: ScenarioRunDto }>(`/scenario-runs/${id}`),
  series: (runId: string, productId: string) =>
    api<{ product: { sku: string; name: string }; weeks: SeriesWeek[] }>(
      `/scenario-runs/${runId}/series?productId=${productId}`,
    ),
  compare: (ids: string[]) => api<CompareResponse>(`/scenarios/compare?ids=${ids.join(',')}`),
};
