import { prisma } from './client';
import { hashPassword } from '../modules/auth/service';

export async function seedSuperAdmin(email: string, password: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) return;
  await prisma.user.create({
    data: {
      email: normalized,
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
      passwordHash: await hashPassword(password),
    },
  });
}
