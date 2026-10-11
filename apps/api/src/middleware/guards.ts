import type { RequestHandler } from 'express';
import type { Permission } from '@supplycast/shared';
import { requireAuth } from './auth';
import { requirePermission } from './rbac';
import { tenantContext } from './tenant';

/** Standard middleware stacks so every route gets auth + tenant + permission checks. */
export function createGuards(accessSecret: string) {
  return {
    /** Authenticated tenant user holding `permission`; req.tenantId and req.db are set. */
    tenant: (permission: Permission): RequestHandler[] => [
      requireAuth(accessSecret),
      tenantContext(),
      requirePermission(permission),
    ],
    /** Authenticated user holding `permission`, with or without a tenant (e.g. Super Admin). */
    any: (permission: Permission): RequestHandler[] => [
      requireAuth(accessSecret),
      tenantContext({ allowNoTenant: true }),
      requirePermission(permission),
    ],
    /** Any authenticated user (tenant suspension still enforced for tenant users). */
    authed: (): RequestHandler[] => [
      requireAuth(accessSecret),
      tenantContext({ allowNoTenant: true }),
    ],
  };
}

export type Guards = ReturnType<typeof createGuards>;
