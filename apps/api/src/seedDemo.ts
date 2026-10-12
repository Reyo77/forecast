import path from 'node:path';
import dotenv from 'dotenv';
import { prisma } from './db/client';
import { hashPassword } from './modules/auth/service';
import { ensureDefaultPlans } from './modules/billing/plans';
import { loadDemoData } from './modules/sales/demoLoader';
import { addMonths } from './lib/time';

dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(__dirname, '../../../.env') });

const EMAIL = process.env.DEMO_EMAIL ?? 'demo@supplycast.local';

/** Creates a ready-to-explore demo company (Pro plan, demo data loaded). Safe to re-run. */
async function main() {
  await ensureDefaultPlans();
  if (await prisma.user.findUnique({ where: { email: EMAIL } })) {
    console.log(`Demo tenant already exists (${EMAIL}).`);
    return;
  }
  const password = process.env.DEMO_PASSWORD ?? 'DemoPass12345';
  const pro = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } });
  const now = new Date();
  const tenant = await prisma.tenant.create({
    data: { name: 'Demo Foods Co', slug: `demo-foods-${now.getTime()}` },
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: pro.id,
      status: 'ACTIVE',
      periodStart: now,
      periodEnd: addMonths(now, 1),
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: EMAIL,
      name: 'Demo Owner',
      role: 'OWNER',
      passwordHash: await hashPassword(password),
    },
  });
  const summary = await loadDemoData(tenant.id, now);
  console.log(`Demo tenant ready: ${EMAIL} / ${password}`, summary);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
