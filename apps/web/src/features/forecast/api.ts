import type {
  AccuracyRow,
  ForecastRunDto,
  OverrideDto,
  Paged,
  SeriesResponse,
} from '@supplycast/shared';
import { api } from '../../api/client';

export const forecastApi = {
  runs: () => api<Paged<ForecastRunDto>>('/forecasts/runs?pageSize=50'),
  run: (id: string) => api<{ run: ForecastRunDto }>(`/forecasts/runs/${id}`),
  createRun: (b: { horizonWeeks: number; method: string; filters: Record<string, string> }) =>
    api<{ run: ForecastRunDto }>('/forecasts/runs', 'POST', b),
  accuracy: (id: string, sort: string, order: string) =>
    api<Paged<AccuracyRow>>(
      `/forecasts/runs/${id}/accuracy?pageSize=100&sort=${sort}&order=${order}`,
    ),
  series: (id: string, productId: string, locationId: string) =>
    api<SeriesResponse>(
      `/forecasts/runs/${id}/series?productId=${productId}${locationId ? `&locationId=${locationId}` : ''}`,
    ),
  overrides: (productId: string, locationId: string) =>
    api<Paged<OverrideDto>>(
      `/forecasts/overrides?pageSize=100&productId=${productId}${locationId ? `&locationId=${locationId}` : ''}`,
    ),
  setOverride: (b: {
    productId: string;
    locationId: string;
    weekStart: string;
    quantity: number;
    reason: string;
  }) => api<{ override: OverrideDto }>('/forecasts/overrides', 'PUT', b),
  deleteOverride: (id: string) => api<void>(`/forecasts/overrides/${id}`, 'DELETE'),
};
