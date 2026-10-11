import bcrypt from 'bcryptjs';
import type { Prisma, User } from '@prisma/client';
import type { AuthUser, ChangePasswordInput, LoginInput, SignupInput } from '@supplycast/shared';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import { generateOpaqueToken, hashToken, REFRESH_TTL_MS, signAccessToken } from './tokens';

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;
// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-1', BCRYPT_COST);

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function toAuthUser(u: Pick<User, 'id' | 'email' | 'name' | 'role' | 'tenantId'>): AuthUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, tenantId: u.tenantId };
}

type Db = Prisma.TransactionClient | typeof prisma;

export async function issueSession(user: User, secret: string, db: Db = prisma): Promise<Session> {
  const refreshToken = generateOpaqueToken();
  await db.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  const accessToken = signAccessToken(
    { sub: user.id, tenantId: user.tenantId, role: user.role },
    secret,
  );
  return { accessToken, refreshToken, user: toAuthUser(user) };
}

async function uniqueSlug(name: string, tx: Prisma.TransactionClient): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'company';
  let slug = base;
  for (let i = 2; await tx.tenant.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
  return slug;
}

export async function signup(input: SignupInput, secret: string): Promise<Session> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing)
    throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: input.companyName, slug: await uniqueSlug(input.companyName, tx) },
      });
      const user = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          role: 'OWNER',
          tenantId: tenant.id,
        },
      });
      return issueSession(user, secret, tx);
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err;
  }
}

export async function login(input: LoginInput, secret: string): Promise<Session> {
  const invalid = new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    throw invalid;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new HttpError(
      423,
      'ACCOUNT_LOCKED',
      'Too many failed attempts. Try again in 15 minutes.',
    );
  }
  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    // After a lock expires the counter starts over.
    const prior = user.lockedUntil ? 0 : user.failedLogins;
    const failed = prior + 1;
    await prisma.user.update({
      where: { id: user.id },
      data:
        failed >= MAX_FAILED_LOGINS
          ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
          : { failedLogins: failed, lockedUntil: null },
    });
    throw invalid;
  }
  if (!user.isActive) throw invalid;
  const fresh = await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null },
  });
  return issueSession(fresh, secret);
}

export async function refresh(token: string, secret: string): Promise<Session> {
  const invalid = new HttpError(
    401,
    'INVALID_REFRESH_TOKEN',
    'Session expired, please log in again',
  );
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!record) throw invalid;
  if (record.revokedAt) {
    // A rotated-out token was presented again: assume theft and kill every session.
    await prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw invalid;
  }
  if (record.expiresAt <= new Date() || !record.user.isActive) throw invalid;
  // Atomic claim: only one concurrent request can rotate this token.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (claimed.count !== 1) throw invalid;
  return issueSession(record.user, secret);
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  secret: string,
): Promise<Session> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
  }
  const passwordHash = await hashPassword(input.newPassword);
  const [updated] = await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
  return issueSession(updated, secret);
}
