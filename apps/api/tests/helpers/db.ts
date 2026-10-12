import { prisma } from '../../src/db/client';

/**
 * Truncates every table (keeps the schema). Call from beforeEach in integration tests.
 * Runs on a single connection: FOREIGN_KEY_CHECKS is per-session, so the pool must not hand
 * the TRUNCATEs to a different connection than the one where checks were disabled.
 */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<{ TABLE_NAME: string }[]>`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations'`;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
      try {
        for (const t of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t.TABLE_NAME}\``);
      } finally {
        await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
      }
    },
    { timeout: 60_000 },
  );
}
