import type { AuthResponse, ErrorBody } from '@supplycast/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;

export const tokenStore = {
  set: (t: string | null) => {
    accessToken = t;
  },
  get: () => accessToken,
  onAuthLost: (fn: (() => void) | null) => {
    onAuthLost = fn;
  },
};

async function send(path: string, method: string, body?: unknown, token = accessToken) {
  return fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? 'Request failed',
      err?.details,
    );
  }
  return data as T;
}

/**
 * Refreshes the session once; concurrent callers (e.g. React StrictMode's double effect or
 * parallel 401s) share one request. The server rotates refresh tokens, so two simultaneous
 * calls with the same cookie would look like token reuse and revoke every session.
 */
let refreshing: Promise<AuthResponse | null> | null = null;
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= send('/auth/refresh', 'POST', undefined, null)
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json()) as AuthResponse;
      accessToken = data.accessToken;
      return data;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res = await send(path, method, body);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await send(path, method, body);
    else onAuthLost?.();
  }
  return parse<T>(res);
}
