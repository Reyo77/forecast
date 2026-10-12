import { Router, type CookieOptions, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  changePasswordSchema,
  loginSchema,
  acceptInviteSchema,
  resetPasswordSchema,
  signupSchema,
  updateProfileSchema,
  type AuthResponse,
} from '@supplycast/shared';
import { prisma } from '../../db/client';
import type { Guards } from '../../middleware/guards';
import { scoped } from '../../db/scoped';
import { HttpError } from '../../middleware/errors';
import * as service from './service';
import * as usersService from '../users/service';
import { auditReq, audit } from '../audit/service';
import { REFRESH_TTL_MS } from './tokens';

const COOKIE_NAME = 'refresh_token';

export interface AuthRouterOptions {
  accessSecret: string;
  guards: Guards;
  production: boolean;
  loginRateLimitMax: number;
}

export function authRouter(opts: AuthRouterOptions): { auth: Router; invites: Router } {
  const router = Router();
  const invites = Router();
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    secure: opts.production,
    path: '/auth',
  };
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: opts.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts, try again later')),
  });

  function send(res: Response, status: number, session: service.Session) {
    res.cookie(COOKIE_NAME, session.refreshToken, { ...cookieOptions, maxAge: REFRESH_TTL_MS });
    const body: AuthResponse = { accessToken: session.accessToken, user: session.user };
    res.status(status).json(body);
  }

  const wrap =
    (fn: (req: import('express').Request, res: Response) => Promise<void>) =>
    (req: import('express').Request, res: Response, next: import('express').NextFunction) =>
      fn(req, res).catch(next);

  router.post(
    '/signup',
    authLimiter,
    wrap(async (req, res) => {
      const session = await service.signup(signupSchema.parse(req.body), opts.accessSecret);
      await audit(
        { tenantId: session.user.tenantId, actorId: session.user.id, ip: req.ip },
        'tenant.created',
        'Tenant',
        session.user.tenantId,
      );
      send(res, 201, session);
    }),
  );

  router.post(
    '/login',
    authLimiter,
    wrap(async (req, res) => {
      send(res, 200, await service.login(loginSchema.parse(req.body), opts.accessSecret));
    }),
  );

  router.post(
    '/refresh',
    wrap(async (req, res) => {
      const token = req.cookies?.[COOKIE_NAME];
      if (typeof token !== 'string' || !token) {
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Session expired, please log in again');
      }
      try {
        send(res, 200, await service.refresh(token, opts.accessSecret));
      } catch (err) {
        res.clearCookie(COOKIE_NAME, cookieOptions);
        throw err;
      }
    }),
  );

  router.post(
    '/logout',
    wrap(async (req, res) => {
      await service.logout(req.cookies?.[COOKIE_NAME]);
      res.clearCookie(COOKIE_NAME, cookieOptions);
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    ...opts.guards.authed(),
    wrap(async (req, res) => {
      // Tenant users are read through the tenant-scoped client; Super Admins have no tenant.
      const db = req.auth!.tenantId ? scoped(req.auth!.tenantId) : prisma;
      const user = await db.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
      const tenant = req.tenantId
        ? await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { name: true } })
        : null;
      res.json({
        user: service.toAuthUser(user),
        tenantName: tenant?.name ?? null,
        impersonating: req.auth!.impersonatorId ? { by: req.auth!.impersonatorId } : null,
      });
    }),
  );

  router.patch(
    '/me',
    ...opts.guards.authed(),
    wrap(async (req, res) => {
      const { name } = updateProfileSchema.parse(req.body);
      const user = await prisma.user.update({ where: { id: req.auth!.userId }, data: { name } });
      await auditReq(req, 'auth.profile_updated', 'User', user.id);
      res.json({ user: service.toAuthUser(user) });
    }),
  );

  router.post(
    '/change-password',
    ...opts.guards.authed(),
    wrap(async (req, res) => {
      const input = changePasswordSchema.parse(req.body);
      const session = await service.changePassword(req.auth!.userId, input, opts.accessSecret);
      await auditReq(req, 'auth.password_changed', 'User', req.auth!.userId);
      send(res, 200, session);
    }),
  );

  router.post(
    '/reset-password',
    authLimiter,
    wrap(async (req, res) => {
      const input = resetPasswordSchema.parse(req.body);
      const { userId, tenantId } = await usersService.resetPassword(input.token, input.newPassword);
      await audit({ tenantId, actorId: userId, ip: req.ip }, 'auth.password_reset', 'User', userId);
      res.status(204).end();
    }),
  );

  invites.post(
    '/accept',
    authLimiter,
    wrap(async (req, res) => {
      const session = await usersService.acceptInvite(
        acceptInviteSchema.parse(req.body),
        opts.accessSecret,
      );
      await audit(
        { tenantId: session.user.tenantId, actorId: session.user.id, ip: req.ip },
        'invite.accepted',
        'User',
        session.user.id,
        { role: session.user.role },
      );
      send(res, 201, session);
    }),
  );

  return { auth: router, invites };
}
