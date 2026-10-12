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

/** In-app notification for one user (e.g. the person who started a long job). */
export async function notifyUser(
  tenantId: string,
  userId: string | null | undefined,
  type: string,
  title: string,
  body: string,
): Promise<void> {
  if (!userId) return;
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, isActive: true },
    select: { id: true },
  });
  if (!user) return;
  await prisma.notification.create({ data: { tenantId, userId, type, title, body } });
}
