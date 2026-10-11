import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './config/logger';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { authRouter } from './modules/auth/routes';

export type AppConfig = Pick<Env, 'APP_URL' | 'JWT_ACCESS_SECRET'> & {
  NODE_ENV?: Env['NODE_ENV'];
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

  app.use(
    '/auth',
    authRouter({
      accessSecret: env.JWT_ACCESS_SECRET,
      production: env.NODE_ENV === 'production',
      loginRateLimitMax: options.loginRateLimitMax ?? 20,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
