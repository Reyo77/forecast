import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './config/logger';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { createGuards } from './middleware/guards';
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { adminRouter } from './modules/admin/routes';
import { billingRouter } from './modules/billing/routes';
import { auditRouter } from './modules/audit/routes';

export type AppConfig = Pick<Env, 'APP_URL' | 'JWT_ACCESS_SECRET'> & {
  NODE_ENV?: Env['NODE_ENV'];
  SIMULATED_PAYMENTS?: boolean;
};

export interface AppOptions {
  loginRateLimitMax?: number;
}

export function createApp(env: AppConfig, options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(cors({ origin: [env.APP_URL], credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const guards = createGuards(env.JWT_ACCESS_SECRET);

  const authRouters = authRouter({
    accessSecret: env.JWT_ACCESS_SECRET,
    guards,
    production: env.NODE_ENV === 'production',
    loginRateLimitMax: options.loginRateLimitMax ?? 20,
  });
  app.use('/auth', authRouters.auth);
  app.use('/invites', authRouters.invites);

  app.use(usersRouter({ guards, appUrl: env.APP_URL }));
  app.use('/audit-logs', auditRouter(guards));
  app.use(
    '/admin',
    adminRouter({
      guards,
      accessSecret: env.JWT_ACCESS_SECRET,
      appUrl: env.APP_URL,
      simulatedPayments: env.SIMULATED_PAYMENTS ?? true,
    }),
  );
  app.use(billingRouter({ guards, simulatedPayments: env.SIMULATED_PAYMENTS ?? true }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
