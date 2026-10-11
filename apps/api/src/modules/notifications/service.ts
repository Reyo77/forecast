import { prisma } from '../../db/client';
import type { Tx } from '../../db/tx';

/** In-app notification for every active Owner/Admin of the tenant. */
export async function notifyAdmins(
  tenantId: string,
  type: string,
  title: string,
  body: string,
  db: Tx = prisma,
): Promise<void> {
  const admins = await db.user.findMany({
    where: { tenantId, isActive: true, role: { in: ['OWNER', 'ADMIN'] } },
    select: { id: true },
  });
  if (!admins.length) return;
  await db.notification.createMany({
    data: admins.map((u) => ({ tenantId, userId: u.id, type, title, body })),
  });
}
