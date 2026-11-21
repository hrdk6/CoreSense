const OWNER_TOKEN_KEY = 'coresense_owner_admin_token';

export function getOwnerApiBase(): string {
  return import.meta.env.VITE_API_URL || 'http://127.0.0.1:4000';
}

export function getOwnerToken(): string | null {
  return localStorage.getItem(OWNER_TOKEN_KEY);
}

export function setOwnerToken(token: string | null): void {
  if (token) localStorage.setItem(OWNER_TOKEN_KEY, token);
  else localStorage.removeItem(OWNER_TOKEN_KEY);
}

export async function ownerApi<T>(
  path: string,
  options: { method?: string; body?: unknown; skipAuth?: boolean } = {},
): Promise<T> {
  const token = getOwnerToken();
  const headers: Record<string, string> = {};
  if (token && !options.skipAuth) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${getOwnerApiBase()}${path}`, {
    method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const err = new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`) as Error & {
      mfaRequired?: boolean;
      status?: number;
    };
    err.mfaRequired = Boolean(data.mfaRequired);
    err.status = res.status;
    throw err;
  }
  return data as T;
}
