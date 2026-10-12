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
let onSuspended: (() => void) | null = null;

export const tokenStore = {
  set: (t: string | null) => {
    accessToken = t;
  },
  get: () => accessToken,
  onAuthLost: (fn: (() => void) | null) => {
    onAuthLost = fn;
  },
  onSuspended: (fn: (() => void) | null) => {
    onSuspended = fn;
  },
};

async function send(
  path: string,
  method: string,
  body?: unknown,
  token = accessToken,
  contentType?: string,
) {
  return fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined && { 'Content-Type': contentType ?? 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : contentType ? (body as string) : JSON.stringify(body),
  });
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ErrorBody | null)?.error;
    if (res.status === 403 && err?.code === 'TENANT_SUSPENDED') onSuspended?.();
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

/** POST a raw text body (e.g. CSV). */
export async function apiText<T>(path: string, text: string, contentType = 'text/csv'): Promise<T> {
  let res = await send(path, 'POST', text, accessToken, contentType);
  if (res.status === 401 && (await refreshSession()))
    res = await send(path, 'POST', text, accessToken, contentType);
  return parse<T>(res);
}

/** Download a file with the auth header and hand it to the browser. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let res = await send(path, 'GET');
  if (res.status === 401 && (await refreshSession())) res = await send(path, 'GET');
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
