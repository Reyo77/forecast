import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@supplycast/shared';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessPayload {
  sub: string;
  tenantId: string | null;
  role: Role;
}

export function signAccessToken(payload: AccessPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: ACCESS_TTL_SECONDS });
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
