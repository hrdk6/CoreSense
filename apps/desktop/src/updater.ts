import { CORESENSE_VERSION } from '@coresense/shared';
import { apiRequest, isTauriRuntime } from './api';

export interface AvailableUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  notes: string;
  releaseUrl: string;
  canAutoInstall: boolean;
  nativeHandle?: {
    downloadAndInstall: (
      onEvent?: (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
    ) => Promise<void>;
  };
}

export interface UpdateCheckResult {
  status: 'up_to_date' | 'update_available' | 'error';
  currentVersion: string;
  update?: AvailableUpdateInfo;
  message: string;
}

export function isNewerSemver(candidate: string, current: string): boolean {
  const c = candidate.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const cur = current.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((c[i] ?? 0) > (cur[i] ?? 0)) return true;
    if ((c[i] ?? 0) < (cur[i] ?? 0)) return false;
  }
  return false;
}

export async function checkForDesktopUpdate(): Promise<UpdateCheckResult> {
  // 1. Inside installed Tauri Desktop app: use cryptographically signed Tauri v2 Updater plugin first
  if (isTauriRuntime()) {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        return {
          status: 'update_available',
          currentVersion: update.currentVersion || CORESENSE_VERSION,
          update: {
            currentVersion: update.currentVersion || CORESENSE_VERSION,
            latestVersion: update.version,
            notes: update.body || `CoreSense v${update.version} is ready to install.`,
            releaseUrl: 'https://github.com/hrdk6/CoreSense-Releases/releases/latest',
            canAutoInstall: true,
            nativeHandle: update as unknown as AvailableUpdateInfo['nativeHandle'],
          },
          message: `Signed update v${update.version} is available.`,
        };
      }
      return {
        status: 'up_to_date',
        currentVersion: CORESENSE_VERSION,
        message: `CoreSense v${CORESENSE_VERSION} is up to date.`,
      };
    } catch {
      // Fall through cleanly to API release manifest check if GitHub latest.json is unreachable or unpublished yet
    }
  }

  // 2. Fallback / Web preview: check CoreSense API release manifest
  try {
    const res = await apiRequest<{
      desktop: { version: string; notes: string; releaseUrl: string };
    }>('/api/v1/releases/latest', { skipAuth: true });
    const latest = res.desktop?.version || CORESENSE_VERSION;
    if (isNewerSemver(latest, CORESENSE_VERSION)) {
      return {
        status: 'update_available',
        currentVersion: CORESENSE_VERSION,
        update: {
          currentVersion: CORESENSE_VERSION,
          latestVersion: latest,
          notes: res.desktop.notes || `CoreSense v${latest} is available.`,
          releaseUrl: res.desktop.releaseUrl || 'https://github.com/hrdk6/CoreSense-Releases/releases/latest',
          canAutoInstall: false,
        },
        message: `CoreSense v${latest} is available to download.`,
      };
    }
    return {
      status: 'up_to_date',
      currentVersion: CORESENSE_VERSION,
      message: `CoreSense v${CORESENSE_VERSION} is up to date.`,
    };
  } catch (err) {
    return {
      status: 'error',
      currentVersion: CORESENSE_VERSION,
      message: err instanceof Error ? err.message : 'Unable to check for updates right now.',
    };
  }
}

export async function installDesktopUpdate(
  update: AvailableUpdateInfo,
  onProgress?: (percent: number | null) => void,
): Promise<void> {
  if (update.canAutoInstall && update.nativeHandle) {
    let totalBytes = 0;
    let downloadedBytes = 0;
    await update.nativeHandle.downloadAndInstall((ev) => {
      if (ev.event === 'Started') {
        totalBytes = ev.data?.contentLength ?? 0;
        onProgress?.(0);
      } else if (ev.event === 'Progress') {
        downloadedBytes += ev.data?.chunkLength ?? 0;
        if (totalBytes > 0) {
          onProgress?.(Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
        } else {
          onProgress?.(null);
        }
      } else if (ev.event === 'Finished') {
        onProgress?.(100);
      }
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return;
  }

  window.open(update.releaseUrl, '_blank', 'noopener,noreferrer');
}
