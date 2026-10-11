import type { ReactNode } from 'react';
import { can, type Permission } from '@supplycast/shared';
import { useAuth } from './AuthContext';

export function useCan() {
  const { user } = useAuth();
  return (permission: Permission) => can(user?.role, permission);
}

/** Renders children only when the current user's role holds the permission (same map as the API). */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const allowed = useCan()(permission);
  return <>{allowed ? children : fallback}</>;
}
