import { Router, type CookieOptions, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  changePasswordSchema,
  loginSchema,
  signupSchema,
  type AuthResponse,
} from '@supplycast/shared';
import { prisma } from '../../db/client';
import { requireAuth } from '../../middleware/auth';
import { HttpError } from '../../middleware/errors';
import * as service from './service';
import { REFRESH_TTL_MS } from './tokens';

const COOKIE_NAME = 'refresh_token';

export interface AuthRouterOptions {
  accessSecret: string;
  production: boolean;
  loginRateLimitMax: number;
}

export function authRouter(opts: AuthRouterOptions): Router {
  const router = Router();
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
      send(res, 201, await service.signup(signupSchema.parse(req.body), opts.accessSecret));
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
    requireAuth(opts.accessSecret),
    wrap(async (req, res) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
      res.json({ user: service.toAuthUser(user) });
    }),
  );

  router.post(
    '/change-password',
    requireAuth(opts.accessSecret),
    wrap(async (req, res) => {
      const input = changePasswordSchema.parse(req.body);
      send(res, 200, await service.changePassword(req.auth!.userId, input, opts.accessSecret));
    }),
  );

  return router;
}
