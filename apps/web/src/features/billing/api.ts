import type { InvoiceDto, Paged, PlanDto, SubscriptionDto } from '@supplycast/shared';
import { api } from '../../api/client';

export interface ChangePlanResponse {
  result: 'APPLIED' | 'SCHEDULED' | 'UNCHANGED' | 'CHECKOUT_REQUIRED';
  /** Where to pay (only with CHECKOUT_REQUIRED). */
  checkoutUrl?: string;
  paymentStatus?: 'SUCCEEDED';
  message: string;
  invoice?: InvoiceDto;
  subscription: SubscriptionDto;
}

export const billingApi = {
  plans: () => api<{ items: PlanDto[] }>('/plans'),
  subscription: () => api<SubscriptionDto>('/billing/subscription'),
  changePlan: (planCode: string) =>
    api<ChangePlanResponse>('/billing/change-plan', 'POST', { planCode }),
  cancel: () => api<ChangePlanResponse>('/billing/cancel', 'POST'),
  invoices: () => api<Paged<InvoiceDto>>('/billing/invoices?pageSize=100'),
  invoice: (id: string) =>
    api<{ invoice: InvoiceDto; billedTo: string }>(`/billing/invoices/${id}`),
};
