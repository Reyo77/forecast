import path from 'node:path';
import dotenv from 'dotenv';
import { loadEnv } from './config/env';
import { prisma } from './db/client';
import { seedSuperAdmin } from './db/seed';
import { ensureDefaultPlans } from './modules/billing/plans';

dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(__dirname, '../../../.env') });

/** Idempotent: default plans + the Super Admin from env. Run at every start-up of the container. */
async function main() {
  const env = loadEnv();
  await ensureDefaultPlans();
  await seedSuperAdmin(env.SUPER_ADMIN_EMAIL, env.SUPER_ADMIN_PASSWORD);
  console.log(`Plans and Super Admin ready (${env.SUPER_ADMIN_EMAIL})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
