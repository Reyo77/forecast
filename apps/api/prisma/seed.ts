import path from 'node:path';
import dotenv from 'dotenv';
import { loadEnv } from '../src/config/env';
import { prisma } from '../src/db/client';
import { seedSuperAdmin } from '../src/db/seed';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function main() {
  const env = loadEnv();
  await seedSuperAdmin(env.SUPER_ADMIN_EMAIL, env.SUPER_ADMIN_PASSWORD);
  console.log(`Super Admin ready: ${env.SUPER_ADMIN_EMAIL}`);
}

main().finally(() => prisma.$disconnect());
