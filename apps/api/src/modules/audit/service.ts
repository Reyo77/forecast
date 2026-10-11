import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/client';
import { logger } from '../../config/logger';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by Super Admin routes so audit rows land in the affected tenant's log. */
    auditTenantId?: string;
  }
}

export interface AuditActor {
  tenantId: string | null;
  actorId: string | null;
  ip?: string | null;
}

/** Records a sensitive action. Never throws: a failed audit write must not break the request. */
export async function audit(
  who: AuditActor,
  action: string,
  entityType: string,
  entityId?: string | null,
  metadata?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: who.tenantId,
        actorId: who.actorId,
        ip: who.ip ?? null,
        action,
        entityType,
        entityId: entityId ?? null,
        metadata,
      },
    });
  } catch (err) {
    logger.error({ err, action }, 'failed to write audit log');
  }
}

export function auditReq(
  req: Request,
  action: string,
  entityType: string,
  entityId?: string | null,
  metadata?: Prisma.InputJsonValue,
  /** Tenant the action concerns, when it differs from the caller's (Super Admin actions). */
  tenantId?: string | null,
) {
  return audit(
    {
      tenantId:
        tenantId !== undefined ? tenantId : (req.auditTenantId ?? req.auth?.tenantId ?? null),
      actorId: req.auth?.userId ?? null,
      ip: req.ip,
    },
    action,
    entityType,
    entityId,
    metadata,
  );
}
