import type { RequestHandler } from 'express';
import { PERMISSIONS, type Permission, type Role } from '@supplycast/shared';
import { HttpError } from './errors';

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
    if (!roles.includes(req.auth.role)) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have permission to do this'));
    }
    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return requireRole(...(PERMISSIONS[permission] as readonly Role[]));
}
