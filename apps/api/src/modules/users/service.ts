import type { AcceptInviteInput } from '@supplycast/shared';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import { generateOpaqueToken, hashToken } from '../auth/tokens';
import { hashPassword, issueSession, type Session } from '../auth/service';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

export function newToken() {
  const token = generateOpaqueToken();
  return { token, tokenHash: hashToken(token) };
}

export async function acceptInvite(input: AcceptInviteInput, secret: string): Promise<Session> {
  const invalid = new HttpError(
    400,
    'INVALID_INVITE',
    'This invite link is invalid or has expired',
  );
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(input.token) },
    include: { tenant: true },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt <= new Date()) throw invalid;
  if (invite.tenant.status !== 'ACTIVE') throw invalid;
  if (await prisma.user.findUnique({ where: { email: invite.email } })) {
    throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
  }
  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    // Atomic claim so a link cannot be accepted twice concurrently.
    const claimed = await tx.invite.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count !== 1) throw invalid;
    const user = await tx.user.create({
      data: {
        email: invite.email,
        name: input.name,
        passwordHash,
        role: invite.role,
        tenantId: invite.tenantId,
      },
    });
    return issueSession(user, secret, tx);
  });
}

export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<{ userId: string; tenantId: string | null }> {
  const invalid = new HttpError(
    400,
    'INVALID_RESET_TOKEN',
    'This reset link is invalid or has expired',
  );
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!record || record.usedAt || record.expiresAt <= new Date() || !record.user.isActive)
    throw invalid;
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw invalid;
    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash, failedLogins: 0, lockedUntil: null },
    });
    await tx.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
  return { userId: record.userId, tenantId: record.user.tenantId };
}
