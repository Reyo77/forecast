import path from 'node:path';
import dotenv from 'dotenv';
import { loadEnv } from './config/env';
import { logger } from './config/logger';
import { createApp } from './app';

dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(__dirname, '../../../.env') });

try {
  const env = loadEnv();
  createApp(env).listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
