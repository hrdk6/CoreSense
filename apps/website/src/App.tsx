import React, { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  FileSearch,
  Globe,
  Laptop,
  Moon,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sun,
  Terminal,
  TrendingUp,
} from 'lucide-react';
import { AuthCallbackCard } from './components/AuthCallbackCard';
import { BenchSpecimen } from './components/BenchSpecimen';
import {
  ANDROID_SIGNING_SHA256,
  type DownloadPlatformId,
  type LiveReleaseBundle,
  buildFallbackRelease,
  detectVisitorPlatform,
  fetchLiveReleaseBundle,
  formatBytes,
  trackPublicDownload,
} from './releases';

const THEME_STORAGE_KEY = 'coresense_site_theme';

const PLATFORM_META: Record<
  DownloadPlatformId,
  {
    name: string;
    shortName: string;
    subtitle: string;
    requirement: string;
    installHintTitle: string;
    installSteps: string[];
  }
> = {
  windows: {
    name: 'Windows',
    shortName: 'Windows',
    subtitle: 'Windows 10 / 11 (x64) native Tauri v2 desktop app with 1-click signed auto-updates.',
    requirement: 'Windows 10+ · x64 · Native Rust + CIM probes',
    installHintTitle: 'Windows SmartScreen note',
    installSteps: [
      'Download and run CoreSense_*_x64-setup.exe (or .msi for managed PCs).',
      'Because CoreSense is distributed free without a paid EV code-signing certificate, Windows SmartScreen may show "Windows protected your PC" on first launch. Click More info, then Run anyway.',
      'Future updates download and verify automatically in-app using the embedded Ed25519 signing key.',
    ],
  },
  android: {
    name: 'Android',
    shortName: 'Android APK',
    subtitle: 'Signed native Capacitor Android app with SoC thermal throttling benchmark, Wi-Fi jitter check, and PCB camera inspector.',
    requirement: 'Android 6.0+ (API 23+) · Universal APK · Signed v1/v2/v3',
    installHintTitle: 'Installing the signed APK without Google Play',
    installSteps: [
      'Tap Download Android Native App (.apk) on your phone and open the downloaded file.',
      'If Android asks once for permission, enable Install unknown apps for your browser.',
      'All future versions are signed with the same RSA-2048 keystore so updates install directly over your existing app without clearing your account or local data.',
    ],
  },
  macos: {
    name: 'macOS',
    shortName: 'macOS',
    subtitle: 'Native Apple Silicon Tauri v2 desktop app with automatic Ed25519-verified updates.',
    requirement: 'macOS 12+ · Apple Silicon (.dmg)',
    installHintTitle: 'macOS Gatekeeper first-launch note',
    installSteps: [
      'Open the .dmg and drag CoreSense.app into Applications.',
      'Since CoreSense is distributed free outside Apple Developer notarization, Control-click CoreSense.app and choose Open (or allow it once in System Settings -> Privacy & Security).',
    ],
  },
  linux: {
    name: 'Linux',
    shortName: 'Linux',
    subtitle: 'Portable AppImage or Debian/Ubuntu .deb package with native Linux hardware telemetry.',
    requirement: 'Ubuntu 22.04+ / Debian / x64 AppImage',
    installHintTitle: 'Running the AppImage or .deb',
    installSteps: [
      'For AppImage: run chmod +x CoreSense_*_amd64.AppImage && ./CoreSense_*_amd64.AppImage.',
      'For Debian/Ubuntu: run sudo apt install ./CoreSense_*_amd64.deb.',
    ],
  },
  ios: {
    name: 'iOS & Mobile Web',
    shortName: 'iOS / Web',
    subtitle: 'Installable Progressive Web App for iPhone, iPad, and any mobile or desktop browser.',
    requirement: 'iOS Safari / Chrome / Edge · Instant launch',
    installHintTitle: 'Adding CoreSense to your iPhone Home Screen',
    installSteps: [
      'Open coresense-mobile-pwa.onrender.com in Safari.',
      'Tap the Share icon and select Add to Home Screen for full-screen app behavior and instant cloud sync with your desktop.',
    ],
  },
};

const CAPABILITIES = [
  {
    icon: Cpu,
    title: 'Full PC & Android hardware probes',
    summary:
      'Reads real OS and device sensors instead of guessing from chat descriptions. On desktop: CPU, RAM, NVMe SMART counters, GPU VRAM/driver/live nvidia-smi thermals, USB/Bluetooth/Audio PnP error codes, and a bounded CPU/disk stress probe. On Android: 5-window SoC thermal-throttling benchmark, 5-ping Wi-Fi latency/jitter check, and guided hotspot diagnostics.',
    detail: 'Every value carries strict provenance: measured, user_reported, inferred, unavailable, or simulated.',
  },
  {
    icon: TrendingUp,
    title: 'Predictive battery, SSD & thermal ML engine',
    summary:
      'Detects silent hardware anomalies across your scan history using Iglewicz-Hoaglin Modified Z-Score (MAD) outlier math, and projects remaining useful life (RUL) via Ordinary Least Squares linear regression across 8 subsystem health scores.',
    detail: 'Refuses to invent forecasts when fewer than 3 real diagnostic snapshots exist.',
  },
  {
    icon: FileSearch,
    title: 'Hybrid technical-manual RAG & streaming Gemini 4 Copilot',
    summary:
      'Index PDF schematics, service manuals, and bench notes once. Retrieval fuses exact BM25/FTS lexical search with 768-dimensional gemini-embedding-2 semantic vectors via Reciprocal Rank Fusion (RRF), streaming grounded responses token-by-token.',
    detail: 'Runs 100% offline with the CoreSense Local Engine, or upgrades to Gemini 4, OpenAI, or local Ollama BYOK.',
  },
  {
    icon: Eye,
    title: 'Structured multimodal Vision PCB inspector',
    summary:
      'Photograph a motherboard, burnt charging IC, or bulging capacitor on desktop or Android. Vision analysis returns schema-validated silkscreen markings, component damage zones, and one-click multimeter follow-up tests.',
    detail: 'Explicitly reports low-clarity photos as unclear_macro_needed instead of hallucinating chip codes.',
  },
];

const GUARANTEES = [
  {
    icon: ShieldCheck,
    title: 'Zero invented confidence percentages',
    body: 'Hypotheses list supporting evidence, conflicting evidence, and a concrete discriminating test across five strict states rather than fabricated scores.',
  },
  {
    icon: Terminal,
    title: 'Zero arbitrary shell execution',
    body: 'AI models can never generate or run arbitrary bash or PowerShell commands. Only 9 predefined, Zod-validated diagnostic tools exist, with explicit approval for state changes.',
  },
  {
    icon: ShieldAlert,
    title: 'Mandatory hardware safety gate',
    body: 'Swollen lithium batteries, exposed mains capacitors, fuse bypassing, and powered liquid-damaged electronics trigger an immediate deterministic stop before DIY instructions.',
  },
  {
    icon: Globe,
    title: 'Physically isolated dual-database privacy',
    body: 'Customer devices, chat transcripts, manuals, and photos stay isolated from anonymous aggregate reliability telemetry with AES-256-GCM encrypted user BYOK keys.',
  },
  {
    icon: Download,
    title: 'Signed binaries & 100% free forever',
    body: 'No subscriptions, no query paywalls, no play-store gatekeeping. Every release ships with Ed25519 desktop update signatures, APK v3 signing, and published SHA-256 checksums.',
  },
];

const CoreSenseMark: React.FC = () => (
  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#000000] border border-[#262b31]">
    <svg viewBox="0 0 128 128" className="h-5 w-5" fill="none" aria-hidden="true">
      <path
        d="M16 68 H42 L53 34 L67 96 L78 52 L87 68 H112"
        stroke="#7BA7F7"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="112" cy="68" r="6" fill="#5EC6A8" />
    </svg>
  </div>
);

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    typeof window !== 'undefined' && localStorage.getItem(THEME_STORAGE_KEY) === 'light'
      ? 'light'
      : 'dark',
  );
  const [detectedOs] = useState<DownloadPlatformId>(() => detectVisitorPlatform());
  const [selectedPlatform, setSelectedPlatform] = useState<DownloadPlatformId>(() => detectVisitorPlatform());
  const [release, setRelease] = useState<LiveReleaseBundle>(() => buildFallbackRelease());
  const [showVerifyGuide, setShowVerifyGuide] = useState(false);
  const [copiedFingerprint, setCopiedFingerprint] = useState(false);
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    let mounted = true;
    fetchLiveReleaseBundle()
      .then((live) => {
        if (mounted) setRelease(live);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_STORAGE_KEY, next);
      document.documentElement.classList.add('cs-theme-switching');
      document.documentElement.classList.toggle('dark', next === 'dark');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement.classList.remove('cs-theme-switching');
        });
      });
      return next;
    });
  };

  const primaryBinary = release.platforms[detectedOs][0];
  const selectedBinaries = release.platforms[selectedPlatform];
  const selectedMeta = PLATFORM_META[selectedPlatform];

  const handleDownloadClick = (platform: DownloadPlatformId, filename: string, architecture: string) => {
    trackPublicDownload(platform, release.version, architecture);
    setDownloadedFile(filename);
  };

  const handleCopyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(ANDROID_SIGNING_SHA256);
      setCopiedFingerprint(true);
      window.setTimeout(() => setCopiedFingerprint(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div className="min-h-screen bg-[var(--cs-canvas)] text-[var(--cs-ink)] flex flex-col">
      {/* Minimal single-line instrument header */}
      <header className="sticky top-0 z-30 border-b border-[var(--cs-border)] bg-[var(--cs-canvas)]/95 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-5 h-14 flex items-center justify-between gap-4">
          <a href="#top" className="flex items-center gap-2.5 text-[var(--cs-ink)] no-underline">
            <CoreSenseMark />
            <span className="cs-heading text-base font-bold tracking-tight">CoreSense</span>
            <span className="hidden sm:inline-block rounded border border-[var(--cs-border)] bg-[var(--cs-surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--cs-ink-muted)] cs-tabular">
              v{release.version}
            </span>
          </a>

          <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-6 text-sm text-[var(--cs-ink-2)]">
            <a href="#download" className="hover:text-[var(--cs-ink)] transition-colors">
              Downloads
            </a>
            <a href="#diagnostics" className="hover:text-[var(--cs-ink)] transition-colors">
              Diagnostics &amp; AI
            </a>
            <a href="#architecture" className="hover:text-[var(--cs-ink)] transition-colors">
              Safety &amp; Privacy
            </a>
            <a
              href={release.pwaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--cs-ink)] transition-colors inline-flex items-center gap-1"
            >
              <span>Mobile Web</span>
              <ExternalLink className="h-3.5 w-3.5 text-[var(--cs-ink-muted)]" />
            </a>
          </nav>

          <div className="flex items-center gap-2">
            <a
              href="https://github.com/hrdk6/CoreSense"
              target="_blank"
              rel="noopener noreferrer"
              className="cs-btn-secondary px-3 py-1.5 text-xs hidden sm:inline-flex items-center gap-1.5"
            >
              <span>GitHub</span>
              <ExternalLink className="h-3 w-3 text-[var(--cs-ink-muted)]" />
            </a>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              className="cs-btn-secondary h-8 w-8 flex items-center justify-center cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="flex-1">
        <AuthCallbackCard />

        {/* Asymmetric Hero: Editorial thesis left · Live Interactive Bench Specimen right */}
        <section className="border-b border-[var(--cs-border)]">
          <div className="mx-auto max-w-6xl px-5 py-14 lg:py-20 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
            <div className="lg:col-span-6 space-y-6 lg:pt-2">
              <h1 className="cs-heading text-4xl sm:text-5xl font-bold leading-[1.06] text-[var(--cs-ink)] max-w-[16ch]">
                Understand what&apos;s happening beneath the surface.
              </h1>

              <p className="text-base sm:text-[17px] leading-relaxed text-[var(--cs-ink-2)] max-w-[54ch]">
                CoreSense is a free, evidence-first diagnostics and repair instrument for PCs, phones, and circuit
                boards. It reads real hardware telemetry, forecasts battery and drive wear mathematically, and pairs
                your service manuals with safety-gated multimodal AI.
              </p>

              {/* Primary auto-detected OS action */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <a
                  href={primaryBinary.url}
                  target={detectedOs === 'ios' ? '_blank' : undefined}
                  rel={detectedOs === 'ios' ? 'noopener noreferrer' : undefined}
                  onClick={() => handleDownloadClick(detectedOs, primaryBinary.filename, primaryBinary.architecture)}
                  className="cs-btn-primary px-5 py-3 text-sm inline-flex items-center gap-2.5"
                >
                  {detectedOs === 'android' ? (
                    <Smartphone className="h-4 w-4" />
                  ) : detectedOs === 'ios' ? (
                    <Globe className="h-4 w-4" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  <span>
                    {detectedOs === 'ios'
                      ? 'Open CoreSense Mobile Web'
                      : `Download for ${PLATFORM_META[detectedOs].name} (v${release.version})`}
                  </span>
                </a>

                <a
                  href="#download"
                  className="cs-btn-secondary px-4 py-3 text-sm inline-flex items-center gap-2"
                >
                  <span>All platforms</span>
                </a>
              </div>

              <div className="text-xs text-[var(--cs-ink-muted)] space-y-1">
                <div className="font-mono cs-tabular">
                  {primaryBinary.filename}
                  {primaryBinary.sizeBytes ? ` · ${formatBytes(primaryBinary.sizeBytes)}` : ''} ·{' '}
                  {primaryBinary.signatureLabel}
                </div>
                <div>
                  Free and unlimited on Windows, Android, macOS, Linux, and Mobile Web. Works offline out of the box.
                </div>
              </div>

              {downloadedFile && (
                <div className="rounded-lg border border-[var(--cs-ok-border)] bg-[var(--cs-ok-soft)] px-3.5 py-2.5 text-xs text-[var(--cs-ok-ink)] max-w-[54ch]">
                  Download started for <span className="font-mono font-semibold">{downloadedFile}</span>. Need
                  first-launch install help or SHA-256 verification?{' '}
                  <a
                    href="#download"
                    onClick={() => setShowVerifyGuide(true)}
                    className="underline font-semibold"
                  >
                    Open install guide
                  </a>
                  .
                </div>
              )}
            </div>

            <div className="lg:col-span-6">
              <BenchSpecimen />
            </div>
          </div>
        </section>

        {/* Mechanical Download Selector Matrix */}
        <section id="download" className="border-b border-[var(--cs-border)] bg-[var(--cs-well)]/45">
          <div className="mx-auto max-w-6xl px-5 py-14 lg:py-16 space-y-7">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="space-y-1.5">
                <h2 className="cs-heading text-2xl sm:text-3xl font-bold text-[var(--cs-ink)]">
                  Download CoreSense v{release.version}
                </h2>
                <p className="text-sm text-[var(--cs-ink-2)] max-w-[62ch]">
                  Every build is compiled automatically in GitHub Actions from public source and synced with your
                  account across desktop and mobile.
                </p>
              </div>
              <a
                href={release.releasePageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-[var(--cs-accent)] hover:underline inline-flex items-center gap-1"
              >
                <span>GitHub Release {release.tag} ({release.publishedAt})</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            {/* Platform selector bar */}
            <div className="cs-panel overflow-hidden">
              <div
                role="tablist"
                aria-label="Choose your operating system"
                className="grid grid-cols-2 sm:grid-cols-5 border-b border-[var(--cs-border)] bg-[var(--cs-well)]"
              >
                {(['windows', 'android', 'macos', 'linux', 'ios'] as DownloadPlatformId[]).map((pid) => {
                  const active = selectedPlatform === pid;
                  const isDetected = detectedOs === pid;
                  return (
                    <button
                      key={pid}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      onClick={() => setSelectedPlatform(pid)}
                      className={`px-4 py-3 text-left border-b-2 transition-colors cursor-pointer ${
                        active
                          ? 'border-[var(--cs-accent)] bg-[var(--cs-surface)] text-[var(--cs-ink)]'
                          : 'border-transparent text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] hover:bg-[var(--cs-well-hover)]/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-xs font-semibold flex items-center gap-1.5">
                          {pid === 'android' ? (
                            <Smartphone className="h-3.5 w-3.5" />
                          ) : pid === 'ios' ? (
                            <Globe className="h-3.5 w-3.5" />
                          ) : (
                            <Laptop className="h-3.5 w-3.5" />
                          )}
                          <span>{PLATFORM_META[pid].shortName}</span>
                        </span>
                        {isDetected && (
                          <span className="rounded border border-[var(--cs-ok-border)] bg-[var(--cs-ok-soft)] px-1 py-0.2 text-[9px] font-mono text-[var(--cs-ok-ink)]">
                            This device
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Selected platform binaries */}
              <div className="p-5 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-5 space-y-2">
                  <h3 className="cs-heading text-lg font-bold text-[var(--cs-ink)]">{selectedMeta.name}</h3>
                  <p className="text-sm text-[var(--cs-ink-2)] leading-relaxed">{selectedMeta.subtitle}</p>
                  <div className="pt-1 text-xs font-mono text-[var(--cs-ink-muted)]">{selectedMeta.requirement}</div>
                </div>

                <div className="lg:col-span-7 space-y-2.5">
                  {selectedBinaries.map((bin) => (
                    <div
                      key={bin.filename}
                      className="rounded-lg border border-[var(--cs-border)] bg-[var(--cs-canvas)] px-4 py-3 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-[var(--cs-ink)]">{bin.label}</span>
                          {bin.recommended && (
                            <span className="rounded border border-[var(--cs-accent-border)] bg-[var(--cs-accent-soft)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--cs-accent-ink)]">
                              Recommended
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-mono text-[var(--cs-ink-muted)] cs-tabular truncate">
                          {bin.filename}
                          {bin.sizeBytes ? ` · ${formatBytes(bin.sizeBytes)}` : ''} · {bin.signatureLabel}
                        </div>
                      </div>

                      <a
                        href={bin.url}
                        target={selectedPlatform === 'ios' ? '_blank' : undefined}
                        rel={selectedPlatform === 'ios' ? 'noopener noreferrer' : undefined}
                        onClick={() => handleDownloadClick(selectedPlatform, bin.filename, bin.architecture)}
                        className={`${
                          bin.recommended ? 'cs-btn-primary' : 'cs-btn-secondary'
                        } px-3.5 py-2 text-xs inline-flex items-center gap-1.5 shrink-0`}
                      >
                        {selectedPlatform === 'ios' ? (
                          <ExternalLink className="h-3.5 w-3.5" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        <span>{selectedPlatform === 'ios' ? 'Open app' : 'Download'}</span>
                      </a>
                    </div>
                  ))}
                </div>
              </div>

              {/* Collapsible First-Install & Cryptographic Verification Drawer */}
              <div className="border-t border-[var(--cs-border)] bg-[var(--cs-well)]/60">
                <button
                  type="button"
                  onClick={() => setShowVerifyGuide((v) => !v)}
                  aria-expanded={showVerifyGuide}
                  className="w-full px-5 sm:px-6 py-3 flex items-center justify-between text-xs font-medium text-[var(--cs-ink-2)] hover:text-[var(--cs-ink)] cursor-pointer"
                >
                  <span>First-install steps ({selectedMeta.installHintTitle}) &amp; SHA-256 verification</span>
                  <ChevronDown
                    className={`h-4 w-4 text-[var(--cs-ink-muted)] transition-transform ${
                      showVerifyGuide ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {showVerifyGuide && (
                  <div className="px-5 sm:px-6 pb-5 pt-1 grid grid-cols-1 lg:grid-cols-12 gap-6 border-t border-[var(--cs-border)]/70">
                    <ol className="lg:col-span-6 space-y-2 text-xs text-[var(--cs-ink-2)] list-decimal list-inside pt-3 leading-relaxed">
                      {selectedMeta.installSteps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>

                    <div className="lg:col-span-6 pt-3 space-y-2.5">
                      <div className="text-xs font-semibold text-[var(--cs-ink)]">
                        Cryptographic integrity &amp; signing certificate
                      </div>
                      <div className="rounded-md border border-[var(--cs-border)] bg-[var(--cs-surface)] p-3 space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--cs-ink-muted)]">
                          <span>Android APK v3 Signer SHA-256</span>
                          <button
                            type="button"
                            onClick={handleCopyFingerprint}
                            className="inline-flex items-center gap-1 text-[var(--cs-accent)] hover:underline cursor-pointer"
                          >
                            {copiedFingerprint ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            <span>{copiedFingerprint ? 'Copied' : 'Copy'}</span>
                          </button>
                        </div>
                        <code className="block font-mono text-[11px] text-[var(--cs-ink)] break-all leading-relaxed">
                          {ANDROID_SIGNING_SHA256}
                        </code>
                      </div>
                      <div className="flex flex-wrap gap-4 text-xs">
                        <a
                          href={release.checksumsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--cs-accent)] hover:underline inline-flex items-center gap-1 font-mono"
                        >
                          <span>SHA256SUMS.txt</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        <a
                          href={release.updaterManifestUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--cs-accent)] hover:underline inline-flex items-center gap-1 font-mono"
                        >
                          <span>latest.json (Ed25519 manifest)</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Asymmetric Editorial Capability Ledger */}
        <section id="diagnostics" className="border-b border-[var(--cs-border)]">
          <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20 grid grid-cols-1 lg:grid-cols-12 gap-10">
            <div className="lg:col-span-4 lg:sticky lg:top-24 self-start space-y-3">
              <h2 className="cs-heading text-2xl sm:text-3xl font-bold text-[var(--cs-ink)] leading-tight">
                Built like a bench instrument, not a generic chat wrapper.
              </h2>
              <p className="text-sm text-[var(--cs-ink-2)] leading-relaxed">
                Every subsystem separates direct hardware measurements from AI reasoning so both everyday device owners
                and board-level repair technicians see the same grounded proof.
              </p>
            </div>

            <div className="lg:col-span-8 divide-y divide-[var(--cs-border)] border-t border-b border-[var(--cs-border)]">
              {CAPABILITIES.map((cap) => {
                const Icon = cap.icon;
                return (
                  <article key={cap.title} className="py-6 first:pt-6 last:pb-6 flex gap-4 items-start">
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface)] text-[var(--cs-accent)]">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="space-y-1.5 min-w-0">
                      <h3 className="cs-heading text-base font-bold text-[var(--cs-ink)]">{cap.title}</h3>
                      <p className="text-sm text-[var(--cs-ink-2)] leading-relaxed max-w-[66ch]">{cap.summary}</p>
                      <p className="text-xs font-mono text-[var(--cs-ink-muted)] pt-0.5">{cap.detail}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* Architectural Safety & Privacy Guarantees */}
        <section id="architecture" className="bg-[var(--cs-well)]/35">
          <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20 space-y-8">
            <div className="max-w-2xl space-y-2">
              <h2 className="cs-heading text-2xl sm:text-3xl font-bold text-[var(--cs-ink)]">
                Five hard engineering guarantees
              </h2>
              <p className="text-sm text-[var(--cs-ink-2)] leading-relaxed">
                Enforced in shared TypeScript schemas, Rust OS collectors, and database boundaries — verified on every
                release by an automated 28-test end-to-end and AI evaluation suite.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {GUARANTEES.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="cs-panel p-5 space-y-2.5">
                    <div className="flex items-center gap-2 text-[var(--cs-ink)]">
                      <Icon className="h-4 w-4 text-[var(--cs-ok)] shrink-0" />
                      <h3 className="cs-heading text-sm font-bold">{item.title}</h3>
                    </div>
                    <p className="text-xs sm:text-[13px] text-[var(--cs-ink-2)] leading-relaxed">{item.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      {/* Clean Technical Footer */}
      <footer className="border-t border-[var(--cs-border)] bg-[var(--cs-surface)]">
        <div className="mx-auto max-w-6xl px-5 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-[var(--cs-ink-muted)]">
          <div className="flex items-center gap-2.5">
            <CoreSenseMark />
            <div>
              <div className="font-semibold text-[var(--cs-ink)]">CoreSense v{release.version}</div>
              <div>Free, unlimited electronics diagnostics and repair intelligence.</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <a
              href="https://github.com/hrdk6/CoreSense"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--cs-ink)]"
            >
              Source on GitHub
            </a>
            <a
              href={release.releasePageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--cs-ink)]"
            >
              All Releases
            </a>
            <a
              href={release.pwaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--cs-ink)]"
            >
              Mobile Web PWA
            </a>
            <a
              href={release.checksumsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--cs-ink)] font-mono"
            >
              SHA-256
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};
