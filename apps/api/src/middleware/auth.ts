import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@supplycast/shared';
import { prisma } from '../db/client';
import { HttpError } from './errors';
import { verifyAccessToken } from '../modules/auth/tokens';

export interface AuthContext {
  userId: string;
  tenantId: string | null;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function requireAuth(secret: string): RequestHandler {
  return async (req, _res, next) => {
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
      next();
    } catch (err) {
      next(err);
    }
  };
}
