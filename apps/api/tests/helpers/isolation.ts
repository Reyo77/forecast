import request from 'supertest';
import type { Express } from 'express';
import { PERMISSIONS, TENANT_ROLES, type Role } from '@supplycast/shared';
import { createTenant, createUser } from '../factories';
import { bearer, tokenFor } from './auth';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface IsolationOptions {
  app: Express;
  method: Method;
  /** Builds the URL for a resource id, e.g. (id) => `/users/${id}` */
  path: (id: string) => string;
  /** Creates a resource owned by the given tenant and returns its id. */
  createResource: (tenantId: string) => Promise<{ id: string }>;
  body?: Record<string, unknown>;
  /** Role used for the calling user; must be allowed to call the endpoint. Default OWNER. */
  role?: Role;
}

/**
 * Shared tenant-isolation check (plan §3.2 #4): a user from Tenant B who targets Tenant A's
 * resource id gets 404 — not 403 and no data — while Tenant A's own owner is not turned away.
 */
export async function expectTenantIsolation(opts: IsolationOptions): Promise<void> {
  const { app, method, path, createResource, body, role = 'OWNER' } = opts;
  const tenantA = await createTenant();
  const resource = await createResource(tenantA.id);
  const attackerB = await createUser({ role });
  const token = tokenFor(attackerB);

  const res = await request(app)[method](path(resource.id)).set(bearer(token)).send(body);
  expect({ status: res.status, body: res.body }).toMatchObject({ status: 404 });
  expect(JSON.stringify(res.body)).not.toContain(resource.id);

  // Sanity check: the legitimate tenant can reach it (so the 404 above is isolation, not a typo'd route).
  const ownerA = await createUser({ role: 'OWNER', tenantId: tenantA.id });
  const own = { token: tokenFor(ownerA) };
  const ownRes = await request(app)[method](path(resource.id)).set(bearer(own.token)).send(body);
  expect(ownRes.status).not.toBe(404);
}

interface AccessOptions {
  app: Express;
  method: Method;
  path: string | ((ctx: { tenantId: string }) => Promise<string>);
  body?:
    Record<string, unknown> | ((ctx: { tenantId: string }) => Promise<Record<string, unknown>>);
  allowed: readonly Role[];
  /** Roles to check; defaults to every tenant role. */
  roles?: readonly Role[];
}

/** 401 with no token; 403 for each disallowed role; allowed roles pass the guard (any status but 401/403). */
export async function expectRoleAccess(opts: AccessOptions): Promise<void> {
  const { app, method, allowed, roles = TENANT_ROLES } = opts;
  const resolve = async (tenantId: string) => ({
    path: typeof opts.path === 'function' ? await opts.path({ tenantId }) : opts.path,
    body: typeof opts.body === 'function' ? await opts.body({ tenantId }) : opts.body,
  });

  const anon = await resolve((await createTenant()).id);
  expect((await request(app)[method](anon.path).send(anon.body)).status).toBe(401);

  for (const role of roles) {
    const user = await createUser({ role });
    const token = tokenFor(user);
    const { path, body } = await resolve(user.tenantId!);
    const res = await request(app)[method](path).set(bearer(token)).send(body);
    if (allowed.includes(role)) {
      expect({ role, status: res.status }).not.toMatchObject({ status: 403 });
      expect({ role, status: res.status }).not.toMatchObject({ status: 401 });
    } else {
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
    }
  }
}

export const rolesWith = (permission: keyof typeof PERMISSIONS): readonly Role[] =>
  PERMISSIONS[permission] as readonly Role[];
