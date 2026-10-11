import type { Role } from './auth';

export const TENANT_ROLES = ['OWNER', 'ADMIN', 'PLANNER', 'VIEWER'] as const;
const ALL_TENANT: Role[] = ['OWNER', 'ADMIN', 'PLANNER', 'VIEWER'];
const WRITERS: Role[] = ['OWNER', 'ADMIN', 'PLANNER'];
const MANAGERS: Role[] = ['OWNER', 'ADMIN'];

/** Single source of truth for who may do what. Used by the API guards and the UI. */
export const PERMISSIONS = {
  'dashboard:read': ALL_TENANT,
  'notifications:read': ALL_TENANT,
  'team:read': MANAGERS,
  'team:manage': MANAGERS,
  'tenant:transfer-ownership': ['OWNER'],
  'audit:read': [...MANAGERS, 'SUPER_ADMIN'],
  'billing:read': MANAGERS,
  'billing:manage': ['OWNER'],
  'masterdata:read': ALL_TENANT,
  'masterdata:write': MANAGERS,
  'inventory:write': WRITERS,
  'import:sales': WRITERS,
  'demo:load': MANAGERS,
  'sales:read': ALL_TENANT,
  'forecast:read': ALL_TENANT,
  'forecast:run': WRITERS,
  'forecast:override': WRITERS,
  'scenario:read': ALL_TENANT,
  'scenario:write': WRITERS,
  'ai:use': WRITERS,
  'admin:access': ['SUPER_ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
