import { CORESENSE_VERSION } from '@coresense/shared';

export type DownloadPlatformId = 'windows' | 'android' | 'macos' | 'linux' | 'ios';

export interface ReleaseBinary {
  label: string;
  filename: string;
  url: string;
  sizeBytes?: number;
  architecture: string;
  recommended?: boolean;
  signatureLabel: string;
}

export interface LiveReleaseBundle {
  version: string;
  tag: string;
  publishedAt: string;
  releasePageUrl: string;
  checksumsUrl: string;
  updaterManifestUrl: string;
  pwaUrl: string;
  source: 'github_live' | 'api_live' | 'embedded_fallback';
  platforms: Record<DownloadPlatformId, ReleaseBinary[]>;
}

const API_BASE = 'https://coresense-api.onrender.com';
const REPO_URL = 'https://github.com/hrdk6/CoreSense';
const PWA_URL = 'https://coresense-mobile-pwa.onrender.com';

export const ANDROID_SIGNING_SHA256 =
  '7E:4D:D0:D3:75:8F:25:F7:C7:BD:CF:82:31:C7:10:F7:75:07:15:47:46:EB:6B:57:9F:97:AD:EA:26:49:F0:AD';

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(2)} MB`;
}

export function detectVisitorPlatform(): DownloadPlatformId {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  const navPlatform = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    '').toLowerCase();

  if (ua.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(ua) || (navPlatform.includes('mac') && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (navPlatform.includes('mac') || ua.includes('mac os x')) return 'macos';
  if (navPlatform.includes('linux') || ua.includes('linux')) return 'linux';
  return 'windows';
}

export function buildFallbackRelease(version = CORESENSE_VERSION): LiveReleaseBundle {
  const v = version.replace(/^v/i, '');
  const dlBase = `${REPO_URL}/releases/latest/download`;
  return {
    version: v,
    tag: `v${v}`,
    publishedAt: '2026-11-23',
    releasePageUrl: `${REPO_URL}/releases/latest`,
    checksumsUrl: `${dlBase}/SHA256SUMS.txt`,
    updaterManifestUrl: `${dlBase}/latest.json`,
    pwaUrl: PWA_URL,
    source: 'embedded_fallback',
    platforms: {
      windows: [
        {
          label: 'Windows Installer (.exe)',
          filename: `CoreSense_${v}_x64-setup.exe`,
          url: `${dlBase}/CoreSense_${v}_x64-setup.exe`,
          architecture: 'x64',
          recommended: true,
          signatureLabel: 'Ed25519 auto-update signed',
        },
        {
          label: 'Windows MSI Package (.msi)',
          filename: `CoreSense_${v}_x64_en-US.msi`,
          url: `${dlBase}/CoreSense_${v}_x64_en-US.msi`,
          architecture: 'x64',
          signatureLabel: 'Ed25519 auto-update signed',
        },
      ],
      android: [
        {
          label: 'Android Native App (.apk)',
          filename: `CoreSense_${v}_android.apk`,
          url: `${dlBase}/CoreSense_${v}_android.apk`,
          architecture: 'universal',
          recommended: true,
          signatureLabel: 'APK Signature Scheme v1/v2/v3',
        },
      ],
      macos: [
        {
          label: 'macOS Disk Image (.dmg)',
          filename: `CoreSense_${v}_aarch64.dmg`,
          url: `${dlBase}/CoreSense_${v}_aarch64.dmg`,
          architecture: 'aarch64',
          recommended: true,
          signatureLabel: 'Ed25519 auto-update signed',
        },
      ],
      linux: [
        {
          label: 'Linux AppImage (.AppImage)',
          filename: `CoreSense_${v}_amd64.AppImage`,
          url: `${dlBase}/CoreSense_${v}_amd64.AppImage`,
          architecture: 'x64',
          recommended: true,
          signatureLabel: 'Ed25519 auto-update signed',
        },
        {
          label: 'Debian / Ubuntu (.deb)',
          filename: `CoreSense_${v}_amd64.deb`,
          url: `${dlBase}/CoreSense_${v}_amd64.deb`,
          architecture: 'x64',
          signatureLabel: 'Ed25519 auto-update signed',
        },
      ],
      ios: [
        {
          label: 'Launch CoreSense Mobile Web',
          filename: 'Installable Safari PWA',
          url: PWA_URL,
          architecture: 'web',
          recommended: true,
          signatureLabel: 'HTTPS Service Worker PWA',
        },
      ],
    },
  };
}

interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubReleaseResponse {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  assets?: GitHubAsset[];
}

export async function fetchLiveReleaseBundle(): Promise<LiveReleaseBundle> {
  const fallback = buildFallbackRelease();

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    const ghRes = await fetch('https://api.github.com/repos/hrdk6/CoreSense/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    window.clearTimeout(timer);

    if (ghRes.ok) {
      const data = (await ghRes.json()) as GitHubReleaseResponse;
      const tag = data.tag_name || fallback.tag;
      const version = tag.replace(/^v/i, '');
      const assets = Array.isArray(data.assets) ? data.assets : [];

      const findAsset = (re: RegExp) => assets.find((a) => re.test(a.name) && !a.name.endsWith('.sig'));
      const winExe = findAsset(/-setup\.exe$/i);
      const winMsi = findAsset(/\.msi$/i);
      const apk = findAsset(/\.apk$/i);
      const macDmg = findAsset(/\.dmg$/i);
      const linuxAppImage = findAsset(/\.AppImage$/i);
      const linuxDeb = findAsset(/\.deb$/i);
      const checksums = assets.find((a) => a.name === 'SHA256SUMS.txt');
      const latestJson = assets.find((a) => a.name === 'latest.json');

      const base = buildFallbackRelease(version);
      return {
        ...base,
        version,
        tag,
        publishedAt: data.published_at ? data.published_at.slice(0, 10) : base.publishedAt,
        releasePageUrl: data.html_url || base.releasePageUrl,
        checksumsUrl: checksums?.browser_download_url || base.checksumsUrl,
        updaterManifestUrl: latestJson?.browser_download_url || base.updaterManifestUrl,
        source: 'github_live',
        platforms: {
          windows: [
            {
              ...base.platforms.windows[0],
              filename: winExe?.name || base.platforms.windows[0].filename,
              url: winExe?.browser_download_url || base.platforms.windows[0].url,
              sizeBytes: winExe?.size,
            },
            {
              ...base.platforms.windows[1],
              filename: winMsi?.name || base.platforms.windows[1].filename,
              url: winMsi?.browser_download_url || base.platforms.windows[1].url,
              sizeBytes: winMsi?.size,
            },
          ],
          android: [
            {
              ...base.platforms.android[0],
              filename: apk?.name || base.platforms.android[0].filename,
              url: apk?.browser_download_url || base.platforms.android[0].url,
              sizeBytes: apk?.size,
            },
          ],
          macos: [
            {
              ...base.platforms.macos[0],
              filename: macDmg?.name || base.platforms.macos[0].filename,
              url: macDmg?.browser_download_url || base.platforms.macos[0].url,
              sizeBytes: macDmg?.size,
            },
          ],
          linux: [
            {
              ...base.platforms.linux[0],
              filename: linuxAppImage?.name || base.platforms.linux[0].filename,
              url: linuxAppImage?.browser_download_url || base.platforms.linux[0].url,
              sizeBytes: linuxAppImage?.size,
            },
            {
              ...base.platforms.linux[1],
              filename: linuxDeb?.name || base.platforms.linux[1].filename,
              url: linuxDeb?.browser_download_url || base.platforms.linux[1].url,
              sizeBytes: linuxDeb?.size,
            },
          ],
          ios: base.platforms.ios,
        },
      };
    }
  } catch {
    // Fall through to CoreSense API release endpoint
  }

  try {
    const apiRes = await fetch(`${API_BASE}/api/v1/releases/latest`);
    if (apiRes.ok) {
      const body = (await apiRes.json()) as {
        desktop?: { version?: string; releaseDate?: string };
        mobile?: { version?: string; apkDownloadUrl?: string; apkFilename?: string };
      };
      const v = body.desktop?.version || body.mobile?.version || fallback.version;
      const built = buildFallbackRelease(v);
      return {
        ...built,
        publishedAt: body.desktop?.releaseDate || built.publishedAt,
        source: 'api_live',
      };
    }
  } catch {
    // Keep embedded fallback
  }

  return fallback;
}

export function trackPublicDownload(
  platform: DownloadPlatformId,
  appVersion: string,
  architecture: string,
): void {
  const apiPlatform = platform === 'ios' ? 'web' : platform;
  try {
    void fetch(`${API_BASE}/api/v1/downloads/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        platform: apiPlatform,
        appVersion,
        channel: platform === 'ios' ? 'direct' : 'github',
        architecture,
      }),
    }).catch(() => {});
  } catch {
    // Never block a user's download on telemetry
  }
}
