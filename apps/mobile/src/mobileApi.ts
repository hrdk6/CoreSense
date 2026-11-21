import { Device } from '@capacitor/device';
import { Network } from '@capacitor/network';
import { CORESENSE_VERSION, type Platform } from '@coresense/shared';

const TOKEN_KEY = 'coresense_mobile_token';
const INSTALL_ID_KEY = 'coresense_mobile_install_id';
const API_URL_KEY = 'coresense_mobile_api_url';
const SYNC_SEQ_KEY = 'coresense_mobile_sync_seq';

export function getApiBaseUrl(): string {
  return localStorage.getItem(API_URL_KEY) || import.meta.env.VITE_API_URL || 'http://127.0.0.1:4000';
}

export function setMobileApiBaseUrl(url: string): void {
  localStorage.setItem(API_URL_KEY, url.replace(/\/$/, ''));
}

export function getInstallId(): string {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = `mob-${crypto.randomUUID()}`;
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

export function getMobileToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setMobileToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getMobileSyncSeq(): number {
  return Number(localStorage.getItem(SYNC_SEQ_KEY) || '0');
}

export function setMobileSyncSeq(seq: number): void {
  localStorage.setItem(SYNC_SEQ_KEY, String(seq));
}

export async function detectMobilePlatform(): Promise<{
  platform: Platform;
  osVersion: string;
  model: string;
  manufacturer: string;
}> {
  try {
    const info = await Device.getInfo();
    const plat: Platform =
      info.platform === 'ios' ? 'ios' : info.platform === 'android' ? 'android' : 'web';
    return {
      platform: plat,
      osVersion: `${info.operatingSystem} ${info.osVersion}`,
      model: info.model || navigator.platform || 'Mobile Device',
      manufacturer: info.manufacturer || 'Unknown',
    };
  } catch {
    const ua = navigator.userAgent.toLowerCase();
    const plat: Platform = ua.includes('iphone') || ua.includes('ipad') ? 'ios' : ua.includes('android') ? 'android' : 'web';
    return {
      platform: plat,
      osVersion: navigator.userAgent.slice(0, 60),
      model: 'Mobile Browser Companion',
      manufacturer: 'Web',
    };
  }
}

export async function readMobileBattery(): Promise<{
  levelPercent: number | null;
  isCharging: boolean | null;
  source: string;
}> {
  try {
    const cap = await Device.getBatteryInfo();
    if (typeof cap.batteryLevel === 'number') {
      return {
        levelPercent: Math.round(cap.batteryLevel * 100),
        isCharging: Boolean(cap.isCharging),
        source: 'Capacitor Native Device Battery API',
      };
    }
  } catch {}

  try {
    const nav = navigator as unknown as {
      getBattery?: () => Promise<{ level: number; charging: boolean }>;
    };
    if (nav.getBattery) {
      const b = await nav.getBattery();
      return {
        levelPercent: Math.round(b.level * 100),
        isCharging: b.charging,
        source: 'Web Battery Status API',
      };
    }
  } catch {}

  return {
    levelPercent: null,
    isCharging: null,
    source: 'Battery telemetry restricted by browser/OS privacy policy',
  };
}

export async function readMobileNetwork(): Promise<{
  connected: boolean;
  connectionType: string;
  apiLatencyMs: number | null;
}> {
  let connected = navigator.onLine;
  let connectionType = 'unknown';
  try {
    const status = await Network.getStatus();
    connected = status.connected;
    connectionType = status.connectionType;
  } catch {}

  let apiLatencyMs: number | null = null;
  try {
    const t0 = performance.now();
    const res = await fetch(`${getApiBaseUrl()}/api/v1/health`);
    if (res.ok) apiLatencyMs = Math.round(performance.now() - t0);
  } catch {
    apiLatencyMs = null;
  }

  return { connected, connectionType, apiLatencyMs };
}

export async function mobileApiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; skipAuth?: boolean } = {},
): Promise<T> {
  const token = getMobileToken();
  const deviceInfo = await detectMobilePlatform();
  const headers: Record<string, string> = {
    'x-coresense-platform': deviceInfo.platform,
    'x-coresense-version': CORESENSE_VERSION,
    'x-coresense-install-id': getInstallId(),
  };
  if (token && !options.skipAuth) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`);
  }
  return data as T;
}

export async function reportMobileActivation(): Promise<void> {
  try {
    const info = await detectMobilePlatform();
    await mobileApiRequest('/api/v1/telemetry/activation', {
      method: 'POST',
      skipAuth: true,
      body: {
        installId: getInstallId(),
        platform: info.platform,
        appVersion: CORESENSE_VERSION,
        channel: info.platform === 'ios' ? 'app_store' : info.platform === 'android' ? 'google_play' : 'direct',
      },
    });
  } catch {}
}
