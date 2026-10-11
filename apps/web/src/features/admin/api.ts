import type { InvoiceDto, Paged, PlanDto, PlanInput, SubscriptionDto } from '@supplycast/shared';
import { api } from '../../api/client';

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  createdAt: string;
  userCount: number;
  plan: { code: string; name: string } | null;
  subscriptionStatus: string | null;
  lastActivityAt: string | null;
}

export interface TenantDetail {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: TenantRow['status'];
    createdAt: string;
  };
  users: {
    id: string;
    email: string;
    name: string;
    role: string;
    isActive: boolean;
    lastLoginAt: string | null;
  }[];
  invoices: InvoiceDto[];
  subscription: SubscriptionDto | null;
  customLimits: Record<string, number> | null;
}

export interface Metrics {
  tenantsByPlan: { code: string; plan: string; count: number }[];
  tenantsByStatus: { status: string; count: number }[];
  totalTenants: number;
  totalUsers: number;
  mrrCents: number;
  trials: { started: number; converted: number; conversionRate: number };
  aiRequestsPerDay: { date: string; count: number }[];
  failedJobs: {
    count: number;
    recent: { id: string; type: string; lastError: string | null; updatedAt: string }[];
  };
}

export type AdminPlan = PlanDto & { subscriberCount: number };

export const adminApi = {
  tenants: (qs: string) => api<Paged<TenantRow>>(`/admin/tenants?${qs}`),
  tenant: (id: string) => api<TenantDetail>(`/admin/tenants/${id}`),
  suspend: (id: string) => api(`/admin/tenants/${id}/suspend`, 'POST'),
  reactivate: (id: string) => api(`/admin/tenants/${id}/reactivate`, 'POST'),
  ownerResetLink: (id: string) =>
    api<{ link: string; ownerEmail: string }>(`/admin/tenants/${id}/owner-reset-link`, 'POST'),
  setSubscription: (
    id: string,
    body: { planCode?: string; customLimits?: Record<string, number> | null; status?: string },
  ) => api<SubscriptionDto>(`/admin/tenants/${id}/subscription`, 'PATCH', body),
  setInvoice: (id: string, status: 'PAID' | 'VOID') =>
    api(`/admin/invoices/${id}`, 'PATCH', { status }),
  metrics: () => api<Metrics>('/admin/metrics'),
  plans: () => api<{ items: AdminPlan[] }>('/admin/plans'),
  createPlan: (p: PlanInput) => api('/admin/plans', 'POST', p),
  updatePlan: (id: string, p: Partial<PlanInput>) => api(`/admin/plans/${id}`, 'PATCH', p),
  deletePlan: (id: string) => api(`/admin/plans/${id}`, 'DELETE'),
};
