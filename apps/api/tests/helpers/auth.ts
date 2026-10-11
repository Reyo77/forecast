import request from 'supertest';
import type { Express } from 'express';
import type { Role } from '@supplycast/shared';
import { signAccessToken } from '../../src/modules/auth/tokens';
import { TEST_PASSWORD } from '../factories';

export async function loginAs(app: Express, email: string, password = TEST_PASSWORD) {
  const res = await request(app).post('/auth/login').send({ email, password });
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return {
    token: res.body.accessToken as string,
    cookie: cookies.find((c) => c.startsWith('refresh_token=')),
    res,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Signs an access token directly (no login round-trip), for apps that don't mount /auth. */
export function tokenFor(user: { id: string; tenantId: string | null; role: Role }): string {
  return signAccessToken(
    { sub: user.id, tenantId: user.tenantId, role: user.role },
    process.env.JWT_ACCESS_SECRET!,
  );
}
