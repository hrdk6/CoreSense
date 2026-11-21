import { CORESENSE_VERSION, type DiagnosticResult } from '@coresense/shared';

const TOKEN_KEY = 'coresense_desktop_token';
const INSTALL_ID_KEY = 'coresense_desktop_install_id';
const API_URL_KEY = 'coresense_api_url';
const SYNC_SEQ_KEY = 'coresense_sync_seq';
const OFFLINE_CACHE_KEY = 'coresense_offline_cache';

export function getApiBaseUrl(): string {
  return localStorage.getItem(API_URL_KEY) || import.meta.env.VITE_API_URL || 'http://127.0.0.1:4000';
}

export function setApiBaseUrl(url: string): void {
  localStorage.setItem(API_URL_KEY, url.replace(/\/$/, ''));
}

export function getInstallId(): string {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = `desk-${crypto.randomUUID()}`;
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getSyncSeq(): number {
  return Number(localStorage.getItem(SYNC_SEQ_KEY) || '0');
}

export function setSyncSeq(seq: number): void {
  localStorage.setItem(SYNC_SEQ_KEY, String(seq));
}

export function detectClientPlatform(): 'windows' | 'macos' | 'linux' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'windows';
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Invoke native Rust diagnostic command when running inside Tauri Desktop
export async function runNativeTauriDiagnostic(toolId: string): Promise<DiagnosticResult | null> {
  if (!isTauriRuntime()) return null;
  try {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (!tauri?.invoke) return null;
    const result = await tauri.invoke('run_native_diagnostic', { toolId });
    return result as DiagnosticResult;
  } catch {
    return null;
  }
}

export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; isFormData?: boolean; skipAuth?: boolean } = {},
): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'x-coresense-platform': detectClientPlatform(),
    'x-coresense-version': CORESENSE_VERSION,
    'x-coresense-install-id': getInstallId(),
  };
  if (token && !options.skipAuth) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (!options.isFormData && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.isFormData
      ? (options.body as FormData)
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined,
  });

  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const errMsg =
      typeof data.error === 'string'
        ? data.error
        : data.error?.formErrors?.[0] || JSON.stringify(data.error) || `Request failed (${res.status})`;
    const err = new Error(errMsg) as Error & { status?: number; payload?: unknown };
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data as T;
}

export function saveOfflineCache(key: string, value: unknown): void {
  try {
    const existing = JSON.parse(localStorage.getItem(OFFLINE_CACHE_KEY) || '{}') as Record<string, unknown>;
    existing[key] = { updatedAt: new Date().toISOString(), value };
    localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(existing));
  } catch {}
}

export function loadOfflineCache<T>(key: string): T | null {
  try {
    const existing = JSON.parse(localStorage.getItem(OFFLINE_CACHE_KEY) || '{}') as Record<
      string,
      { value: T }
    >;
    return existing[key]?.value ?? null;
  } catch {
    return null;
  }
}

export async function reportDesktopActivation(): Promise<void> {
  try {
    await apiRequest('/api/v1/telemetry/activation', {
      method: 'POST',
      skipAuth: true,
      body: {
        installId: getInstallId(),
        platform: detectClientPlatform(),
        appVersion: CORESENSE_VERSION,
        channel: isTauriRuntime() ? 'direct' : 'direct',
      },
    });
  } catch {
    // Offline-safe
  }
}

export async function reportClientCrash(component: string, error: unknown): Promise<void> {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    await apiRequest('/api/v1/telemetry/crash', {
      method: 'POST',
      skipAuth: true,
      body: {
        anonymousInstallId: getInstallId(),
        platform: detectClientPlatform(),
        appVersion: CORESENSE_VERSION,
        component,
        errorName: err.name || 'Error',
        message: err.message || 'Unhandled desktop UI error',
        stack: err.stack?.slice(0, 1800),
      },
    });
  } catch {}
}
