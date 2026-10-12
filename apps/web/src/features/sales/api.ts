import type { Paged } from '@supplycast/shared';
import { api, apiText } from '../../api/client';

export interface ImportRow {
  id: string;
  fileName: string;
  status: 'PREVIEW' | 'QUEUED' | 'PROCESSING' | 'DONE' | 'FAILED';
  rowCount: number;
  validRowCount: number;
  errorCount: number;
  importedRows: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface PreviewResult {
  import: ImportRow;
  errors: { row: number; field: string; message: string }[];
  sample: {
    sku: string;
    location: string;
    weekStart: string;
    quantity: number;
    revenueCents: number;
  }[];
  totalWeeklyRows: number;
}
export interface ExplorerResult {
  series: {
    key: string;
    label: string;
    total: number;
    points: { weekStart: string; quantity: number; revenueCents: number }[];
  }[];
  omittedSeries: number;
  totals: { quantity: number; revenueCents: number; weeks: number };
}

export const salesApi = {
  preview: (fileName: string, csv: string) =>
    apiText<PreviewResult>(`/imports/sales/preview?fileName=${encodeURIComponent(fileName)}`, csv),
  commit: (id: string, skipErrors: boolean) =>
    api<{ import: ImportRow }>(`/imports/sales/${id}/commit`, 'POST', { skipErrors }),
  imports: () => api<Paged<ImportRow>>('/imports/sales?pageSize=20'),
  demoStatus: () => api<{ hasSalesData: boolean; canLoad: boolean }>('/demo-data/status'),
  loadDemo: () =>
    api<{
      summary: {
        products: number;
        locations: number;
        suppliers: number;
        weeksOfSales: number;
        salesRows: number;
      };
    }>('/demo-data', 'POST'),
  explorer: (qs: string) => api<ExplorerResult>(`/sales/explorer?${qs}`),
};
