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

export const NATIVE_TAURI_TOOL_IDS: readonly string[] = [
  'cpu_diagnostics',
  'memory_diagnostics',
  'storage_diagnostics',
  'gpu_diagnostics',
  'network_diagnostics',
  'peripherals_diagnostics',
  'hardware_stress_probe',
  'os_health_diagnostics',
  'power_and_peripherals',
  'full_system_snapshot',
];

// Invoke native Rust diagnostic command when running inside Tauri Desktop
export async function runNativeTauriDiagnostic(toolId: string): Promise<DiagnosticResult | null> {
  if (!isTauriRuntime() || !NATIVE_TAURI_TOOL_IDS.includes(toolId)) return null;
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

export async function streamSsePost(
  path: string,
  body: unknown,
  handlers: {
    onMeta?: (data: Record<string, unknown>) => void;
    onDelta?: (text: string) => void;
    onVision?: (inspection: unknown) => void;
    onDone?: (data: Record<string, unknown>) => void;
  },
): Promise<void> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'x-coresense-platform': detectClientPlatform(),
    'x-coresense-version': CORESENSE_VERSION,
    'x-coresense-install-id': getInstallId(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(typeof errPayload.error === 'string' ? errPayload.error : `Stream failed (${res.status})`);
  }

  if (!res.body) throw new Error('Streaming response body is unavailable.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (eventName === 'meta') handlers.onMeta?.(payload);
    else if (eventName === 'delta' && typeof payload.text === 'string') handlers.onDelta?.(payload.text);
    else if (eventName === 'vision') handlers.onVision?.(payload.structuredInspection);
    else if (eventName === 'done') handlers.onDone?.(payload);
    else if (eventName === 'error') {
      throw new Error(typeof payload.error === 'string' ? payload.error : 'Stream encountered an error.');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) dispatchFrame(frame);
    }
  }
  if (buffer.trim()) dispatchFrame(buffer);
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
        channel: isTauriRuntime() ? 'desktop_native' : 'web_preview',
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
