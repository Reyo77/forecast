import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@supplycast/shared';
import { prisma } from '../db/client';
import { HttpError } from './errors';
import { audit } from '../modules/audit/service';
import { verifyAccessToken } from '../modules/auth/tokens';

export interface AuthContext {
  userId: string;
  tenantId: string | null;
  role: Role;
  /** Set when a Super Admin is read-only impersonating this user. */
  impersonatorId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function requireAuth(secret: string): RequestHandler {
  const handler: RequestHandler = async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
      }
      let payload;
      try {
        payload = verifyAccessToken(header.slice(7), secret);
      } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
          throw new HttpError(401, 'TOKEN_EXPIRED', 'Access token expired');
        }
        throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid access token');
      }
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.isActive) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid access token');
      }
      // Identity comes from the database row, never from client-supplied data.
      req.auth = { userId: user.id, tenantId: user.tenantId, role: user.role };
      if (payload.imp) {
        const admin = await prisma.user.findUnique({ where: { id: payload.imp } });
        if (!admin || !admin.isActive || admin.role !== 'SUPER_ADMIN') {
          throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid access token');
        }
        req.auth.impersonatorId = admin.id;
        res.setHeader('X-Impersonated-By', admin.id);
        // Every impersonated request is audited and anything that is not a read is refused.
        await audit(
          { tenantId: user.tenantId, actorId: admin.id, ip: req.ip },
          'impersonation.request',
          'Request',
          null,
          { method: req.method, path: req.originalUrl.split('?')[0] ?? '', asUser: user.id },
        );
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          throw new HttpError(
            403,
            'IMPERSONATION_READ_ONLY',
            'Read-only impersonation: changes are not allowed',
          );
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
  return Object.assign(handler, { guard: 'auth' as const });
}
