/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from './client';

/**
 * Models that carry a `tenantId` column. Every tenant-owned model MUST be listed here so that
 * scoped(tenantId) filters it. (A test fails if a Prisma model with tenantId is missing.)
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'User',
  'Invite',
  'AuditLog',
  'Subscription',
  'Invoice',
  'UsageCounter',
  'Notification',
  'Job',
  'AiRequest',
]);

const WHERE_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/**
 * Returns a Prisma client whose queries on tenant-owned models are forced to `tenantId`:
 * reads/updates/deletes get it added to `where`, creates get it written into `data`, and a
 * client-supplied `tenantId` can never override or move a row to another tenant.
 */
export function scoped(tenantId: string) {
  if (!tenantId) throw new Error('scoped() requires a tenantId');
  return prisma.$extends({
    name: 'tenantScope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_SCOPED_MODELS.has(model)) return query(args);
          const a: Record<string, any> = { ...(args as any) };
          if (WHERE_OPS.has(operation)) a.where = { ...a.where, tenantId };
          switch (operation) {
            case 'create':
              a.data = { ...a.data, tenantId };
              break;
            case 'createMany':
              a.data = Array.isArray(a.data)
                ? a.data.map((d: any) => ({ ...d, tenantId }))
                : { ...a.data, tenantId };
              break;
            case 'update':
            case 'updateMany': {
              const { tenantId: _ignored, ...rest } = a.data ?? {};
              a.data = rest;
              break;
            }
            case 'upsert': {
              a.where = { ...a.where, tenantId };
              a.create = { ...a.create, tenantId };
              const { tenantId: _ignored, ...rest } = a.update ?? {};
              a.update = rest;
              break;
            }
          }
          return query(a as any);
        },
      },
    },
  });
}

export type ScopedClient = ReturnType<typeof scoped>;
