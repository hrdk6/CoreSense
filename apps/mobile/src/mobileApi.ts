import { Device } from '@capacitor/device';
import { Network } from '@capacitor/network';
import { CORESENSE_VERSION, type Platform } from '@coresense/shared';

const TOKEN_KEY = 'coresense_mobile_token';
const INSTALL_ID_KEY = 'coresense_mobile_install_id';
const API_URL_KEY = 'coresense_mobile_api_url';
const SYNC_SEQ_KEY = 'coresense_mobile_sync_seq';

export function getApiBaseUrl(): string {
  const host =
    typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '127.0.0.1';
  return localStorage.getItem(API_URL_KEY) || import.meta.env.VITE_API_URL || `http://${host}:4000`;
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

export interface MobileSocProfile {
  gpuVendor: string;
  gpuRenderer: string;
  inferredSocFamily: string;
  logicalCores: number | null;
  approxRamGb: number | null;
  displayResolution: string;
  pixelRatio: number;
  measuredRefreshHz: number | null;
}

export interface MobileNetworkProbeResult {
  connected: boolean;
  connectionType: string;
  effectiveType: string | null;
  downlinkMbps: number | null;
  browserRttMs: number | null;
  saveData: boolean;
  samplesMs: number[];
  minLatencyMs: number | null;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
  jitterMs: number | null;
  packetLossPercent: number;
  externalInternetReachable: boolean;
  externalProbeMs: number | null;
  qualityVerdict: 'excellent' | 'good' | 'fair' | 'poor' | 'offline';
  measuredAt: string;
}

export interface MobileSocBenchmarkWindow {
  windowIndex: number;
  durationMs: number;
  kOpsPerSec: number;
}

export interface MobileSocBenchmarkResult {
  totalDurationMs: number;
  peakKOpsPerSec: number;
  sustainedKOpsPerSec: number;
  averageKOpsPerSec: number;
  throttleDropPercent: number;
  stabilityPercent: number;
  throttlingLevel: 'none' | 'mild' | 'moderate' | 'heavy';
  windows: MobileSocBenchmarkWindow[];
  completedAt: string;
}

function inferSocFamilyFromRenderer(vendor: string, renderer: string): string {
  const combined = `${vendor} ${renderer}`.toLowerCase();
  if (combined.includes('adreno')) return 'Qualcomm Snapdragon (Adreno GPU)';
  if (combined.includes('apple')) return 'Apple Silicon / A-Series (Apple GPU)';
  if (combined.includes('immortalis') || combined.includes('mali')) return 'ARM Mali / Immortalis (MediaTek Dimensity / Exynos / Tensor)';
  if (combined.includes('xclipse')) return 'Samsung Exynos (AMD RDNA Xclipse GPU)';
  if (combined.includes('powervr')) return 'Imagination PowerVR SoC';
  if (combined.includes('nvidia')) return 'NVIDIA Graphics';
  if (combined.includes('radeon') || combined.includes('amd')) return 'AMD Radeon Graphics';
  if (combined.includes('intel')) return 'Intel Graphics';
  return 'Unidentified GPU / Browser Masked Renderer';
}

export async function measureDisplayRefreshHz(): Promise<number | null> {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return null;
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = 0;
    let frames = 0;
    const step = (ts: number) => {
      if (last > 0) {
        const dt = ts - last;
        if (dt > 2 && dt < 50) deltas.push(dt);
      }
      last = ts;
      frames += 1;
      if (frames < 22) {
        requestAnimationFrame(step);
      } else if (deltas.length >= 6) {
        deltas.sort((a, b) => a - b);
        const medianDt = deltas[Math.floor(deltas.length / 2)];
        const rawHz = 1000 / medianDt;
        // Snap lightly only for display clarity? No — report real rounded Hz!
        resolve(Math.round(rawHz));
      } else {
        resolve(null);
      }
    };
    requestAnimationFrame(step);
  });
}

export async function detectMobileSocAndDisplay(): Promise<MobileSocProfile> {
  let gpuVendor = 'Restricted by browser';
  let gpuRenderer = 'WebGL unavailable';
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ||
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        gpuVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || gpuVendor);
        gpuRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || gpuRenderer);
      } else {
        gpuVendor = String(gl.getParameter(gl.VENDOR) || gpuVendor);
        gpuRenderer = String(gl.getParameter(gl.RENDERER) || gpuRenderer);
      }
    }
  } catch {
    // WebGL blocked
  }

  const nav = navigator as unknown as { hardwareConcurrency?: number; deviceMemory?: number };
  const measuredRefreshHz = await measureDisplayRefreshHz();

  return {
    gpuVendor,
    gpuRenderer,
    inferredSocFamily: inferSocFamilyFromRenderer(gpuVendor, gpuRenderer),
    logicalCores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    approxRamGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    displayResolution: `${window.screen.width}×${window.screen.height}`,
    pixelRatio: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    measuredRefreshHz,
  };
}

export async function runMobileNetworkAndWifiProbe(): Promise<MobileNetworkProbeResult> {
  let connected = navigator.onLine;
  let connectionType = 'unknown';
  try {
    const status = await Network.getStatus();
    connected = status.connected;
    connectionType = status.connectionType;
  } catch {}

  const conn = (navigator as unknown as {
    connection?: {
      effectiveType?: string;
      type?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
  }).connection;

  if (connectionType === 'unknown' && conn?.type) {
    connectionType = conn.type;
  }

  const samplesMs: number[] = [];
  let failed = 0;
  const totalPings = 5;

  for (let i = 0; i < totalPings; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const t0 = performance.now();
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/v1/health?probe=${i}&t=${Date.now()}`, {
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (res.ok) {
        samplesMs.push(Math.round(performance.now() - t0));
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
    if (i < totalPings - 1) {
      await new Promise((r) => setTimeout(r, 140));
    }
  }

  // Independent public endpoint reachability check (separates API issue vs local Wi-Fi/ISP outage)
  let externalInternetReachable = false;
  let externalProbeMs: number | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const t0 = performance.now();
    try {
      await fetch(`https://1.1.1.1/cdn-cgi/trace?t=${Date.now()}`, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      externalInternetReachable = true;
      externalProbeMs = Math.round(performance.now() - t0);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    externalInternetReachable = false;
  }

  const packetLossPercent = Math.round((failed / totalPings) * 100);
  const minLatencyMs = samplesMs.length ? Math.min(...samplesMs) : null;
  const maxLatencyMs = samplesMs.length ? Math.max(...samplesMs) : null;
  const avgLatencyMs = samplesMs.length
    ? Math.round(samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length)
    : null;

  let jitterMs: number | null = null;
  if (samplesMs.length >= 2) {
    let diffSum = 0;
    for (let i = 1; i < samplesMs.length; i++) {
      diffSum += Math.abs(samplesMs[i] - samplesMs[i - 1]);
    }
    jitterMs = Math.round((diffSum / (samplesMs.length - 1)) * 10) / 10;
  }

  let qualityVerdict: MobileNetworkProbeResult['qualityVerdict'] = 'offline';
  if (!connected || (samplesMs.length === 0 && !externalInternetReachable)) {
    qualityVerdict = 'offline';
  } else if (packetLossPercent >= 20 || (avgLatencyMs !== null && avgLatencyMs > 400) || (jitterMs !== null && jitterMs > 90)) {
    qualityVerdict = 'poor';
  } else if ((avgLatencyMs !== null && avgLatencyMs > 180) || (jitterMs !== null && jitterMs > 40)) {
    qualityVerdict = 'fair';
  } else if ((avgLatencyMs !== null && avgLatencyMs > 80) || (jitterMs !== null && jitterMs > 18)) {
    qualityVerdict = 'good';
  } else {
    qualityVerdict = 'excellent';
  }

  return {
    connected: connected && (samplesMs.length > 0 || externalInternetReachable),
    connectionType,
    effectiveType: conn?.effectiveType ?? null,
    downlinkMbps: typeof conn?.downlink === 'number' ? conn.downlink : null,
    browserRttMs: typeof conn?.rtt === 'number' ? conn.rtt : null,
    saveData: Boolean(conn?.saveData),
    samplesMs,
    minLatencyMs,
    avgLatencyMs,
    maxLatencyMs,
    jitterMs,
    packetLossPercent,
    externalInternetReachable,
    externalProbeMs,
    qualityVerdict,
    measuredAt: new Date().toISOString(),
  };
}

export async function runMobileSocStressTest(
  onWindow?: (win: MobileSocBenchmarkWindow, all: MobileSocBenchmarkWindow[]) => void,
): Promise<MobileSocBenchmarkResult> {
  const totalStart = performance.now();
  const windows: MobileSocBenchmarkWindow[] = [];
  const totalWindows = 5;
  const windowDurationMs = 1800; // 5 x 1.8s = ~9 seconds real sustained compute
  const vecA = new Float64Array(256);
  const vecB = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    vecA[i] = (i + 1) * 0.371;
    vecB[i] = (256 - i) * 0.193;
  }
  let sink = 0;

  for (let w = 0; w < totalWindows; w++) {
    const winStart = performance.now();
    let batches = 0;
    while (performance.now() - winStart < windowDurationMs) {
      const sliceStart = performance.now();
      // Run ~45ms compute micro-slice then yield to UI thread so bars animate cleanly
      while (performance.now() - sliceStart < 45 && performance.now() - winStart < windowDurationMs) {
        let dot = 0;
        for (let i = 0; i < 256; i++) {
          dot += vecA[i] * vecB[i] + Math.sin(vecA[i] + batches * 0.001);
        }
        // Small integer primality workload mixed in
        let primes = 0;
        for (let n = 101; n <= 199; n += 2) {
          let isPrime = true;
          for (let d = 3; d * d <= n; d += 2) {
            if (n % d === 0) {
              isPrime = false;
              break;
            }
          }
          if (isPrime) primes += 1;
        }
        sink += dot > 0 ? primes : 0;
        batches += 1;
      }
      await new Promise((r) => setTimeout(r, 8));
    }

    const elapsed = Math.max(1, performance.now() - winStart);
    const kOpsPerSec = Math.round(((batches * 300) / elapsed) * 10) / 10;
    const win: MobileSocBenchmarkWindow = {
      windowIndex: w + 1,
      durationMs: Math.round(elapsed),
      kOpsPerSec,
    };
    windows.push(win);
    onWindow?.(win, [...windows]);
  }

  // Keep sink observable so JIT never eliminates math loop
  if (sink < 0) console.debug(sink);

  const scores = windows.map((w) => w.kOpsPerSec);
  const peakKOpsPerSec = Math.max(...scores);
  const sustainedKOpsPerSec = scores[scores.length - 1] ?? peakKOpsPerSec;
  const averageKOpsPerSec =
    Math.round((scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length)) * 10) / 10;
  const throttleDropPercent =
    peakKOpsPerSec > 0
      ? Math.max(0, Math.round(((peakKOpsPerSec - sustainedKOpsPerSec) / peakKOpsPerSec) * 1000) / 10)
      : 0;
  const stabilityPercent = Math.max(0, Math.min(100, Math.round((100 - throttleDropPercent) * 10) / 10));

  const throttlingLevel: MobileSocBenchmarkResult['throttlingLevel'] =
    throttleDropPercent >= 32
      ? 'heavy'
      : throttleDropPercent >= 20
        ? 'moderate'
        : throttleDropPercent >= 10
          ? 'mild'
          : 'none';

  return {
    totalDurationMs: Math.round(performance.now() - totalStart),
    peakKOpsPerSec,
    sustainedKOpsPerSec,
    averageKOpsPerSec,
    throttleDropPercent,
    stabilityPercent,
    throttlingLevel,
    windows,
    completedAt: new Date().toISOString(),
  };
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
