import path from 'node:path';
import dotenv from 'dotenv';
import { loadEnv } from './config/env';
import { logger } from './config/logger';
import { createApp } from './app';
import { DemoAiClient } from './ai/fake';
import { GeminiClient, UnconfiguredAiClient } from './ai/gemini';
import type { AiClient } from './ai/types';
import { registerCoreJobHandlers, scheduleRecurringJobs } from './jobs/handlers';
import { startWorker } from './jobs/runner';
import { LogMailer, SmtpMailer } from './email/mailers';
import { ensureDefaultPlans } from './modules/billing/plans';

dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(__dirname, '../../../.env') });

try {
  const env = loadEnv();
  let aiClient: AiClient;
  if (env.AI_PROVIDER === 'fake') {
    if (env.NODE_ENV === 'production')
      throw new Error('AI_PROVIDER=fake is not allowed in production');
    aiClient = new DemoAiClient();
  } else if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY === 'your-key-here') {
    logger.warn('GEMINI_API_KEY is not set; AI features are disabled');
    aiClient = new UnconfiguredAiClient();
  } else {
    aiClient = new GeminiClient(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  }
  const mailer =
    env.EMAIL_PROVIDER === 'smtp'
      ? new SmtpMailer({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
          from: env.EMAIL_FROM,
        })
      : new LogMailer();
  createApp(env, { aiClient, mailer, loginRateLimitMax: env.AUTH_RATE_LIMIT_MAX }).listen(
    env.PORT,
    () => logger.info(`API listening on :${env.PORT}`),
  );
  registerCoreJobHandlers();
  void ensureDefaultPlans()
    .then(scheduleRecurringJobs)
    .then(() => startWorker())
    .catch((err) => logger.error({ err }, 'failed to start background worker'));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
