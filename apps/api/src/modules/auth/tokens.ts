import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@supplycast/shared';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessPayload {
  sub: string;
  tenantId: string | null;
  role: Role;
  /** Super Admin id when this token is a read-only impersonation of `sub`. */
  imp?: string;
}

export const IMPERSONATION_TTL_SECONDS = 30 * 60;

export function signAccessToken(
  payload: AccessPayload,
  secret: string,
  ttlSeconds = ACCESS_TTL_SECONDS,
): string {
  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

export function verifyAccessToken(token: string, secret: string): AccessPayload {
  return jwt.verify(token, secret) as AccessPayload;
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
