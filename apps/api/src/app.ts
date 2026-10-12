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
import { catalogRouter } from './modules/masterdata/catalog';
import { supplyRouter } from './modules/masterdata/supply';
import { salesRouter } from './modules/sales/routes';
import { forecastRouter } from './modules/forecast/routes';
import { scenarioRouter } from './modules/scenarios/routes';
import { aiRouter } from './modules/ai/routes';
import { AiService } from './modules/ai/service';
import { UnconfiguredAiClient } from './ai/gemini';
import type { AiClient } from './ai/types';
import { notificationsRouter } from './modules/notifications/routes';
import { dashboardRouter } from './modules/dashboard/routes';
import { insightsRouter } from './modules/insights/routes';
import { auditRouter } from './modules/audit/routes';
import { LogMailer } from './email/mailers';
import type { Mailer } from './email/types';

export type AppConfig = Pick<Env, 'APP_URL' | 'JWT_ACCESS_SECRET'> & {
  NODE_ENV?: Env['NODE_ENV'];
  SIMULATED_PAYMENTS?: boolean;
};

export interface AppOptions {
  loginRateLimitMax?: number;
  /** The AI backend (Gemini in production, a fake in tests). Defaults to "not configured". */
  aiClient?: AiClient;
  aiTimeoutMs?: number;
  /** Where transactional email goes. Defaults to the log driver (nothing is delivered). */
  mailer?: Mailer;
}

export function createApp(env: AppConfig, options: AppOptions = {}) {
  const mailer = options.mailer ?? new LogMailer();
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
    mailer,
    appUrl: env.APP_URL,
  });
  app.use('/auth', authRouters.auth);
  app.use('/invites', authRouters.invites);

  app.use(usersRouter({ guards, appUrl: env.APP_URL, mailer }));
  app.use('/audit-logs', auditRouter(guards));
  app.use(catalogRouter(guards));
  app.use(supplyRouter(guards));
  app.use(salesRouter(guards));
  app.use(forecastRouter(guards));
  app.use(scenarioRouter(guards));
  app.use(notificationsRouter(guards));
  app.use(dashboardRouter(guards));
  app.use(insightsRouter(guards));
  app.use(
    aiRouter({
      guards,
      ai: new AiService(options.aiClient ?? new UnconfiguredAiClient(), {
        timeoutMs: options.aiTimeoutMs,
      }),
    }),
  );
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
