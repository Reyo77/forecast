import type { RequestHandler } from 'express';
import { prisma } from '../db/client';
import { scoped, type ScopedClient } from '../db/scoped';
import { HttpError } from './errors';

declare module 'express-serve-static-core' {
  interface Request {
    tenantId?: string;
    /** Prisma client already restricted to the caller's tenant. Use this, never `prisma`, for tenant data. */
    db?: ScopedClient;
  }
}

/**
 * Takes the tenant from the verified token's user row only (never from body/query/params),
 * blocks suspended tenants and exposes a tenant-scoped Prisma client as req.db.
 */
export function tenantContext(opts: { allowNoTenant?: boolean } = {}): RequestHandler {
  const handler: RequestHandler = async (req, _res, next) => {
    try {
      if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
      const { tenantId } = req.auth;
      if (!tenantId) {
        if (opts.allowNoTenant) return next();
        throw new HttpError(403, 'TENANT_REQUIRED', 'This action requires a tenant account');
      }
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant || tenant.status === 'DELETED') {
        throw new HttpError(403, 'TENANT_UNAVAILABLE', 'This account is no longer available');
      }
      if (tenant.status === 'SUSPENDED') {
        throw new HttpError(403, 'TENANT_SUSPENDED', 'This account has been suspended');
      }
      req.tenantId = tenantId;
      req.db = scoped(tenantId);
      next();
    } catch (err) {
      next(err);
    }
  };
  return Object.assign(handler, { guard: 'tenant' as const });
}
