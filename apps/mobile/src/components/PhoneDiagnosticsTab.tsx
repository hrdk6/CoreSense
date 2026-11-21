import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  BatteryCharging,
  Camera,
  Check,
  CheckCircle2,
  Compass,
  Cpu,
  Flame,
  Grid3x3,
  HardDrive,
  Info,
  Mic,
  Radio,
  RefreshCw,
  Save,
  Smartphone,
  Volume2,
  Wifi,
} from 'lucide-react';
import {
  type MobileNetworkProbeResult,
  type MobileSocBenchmarkResult,
  type MobileSocBenchmarkWindow,
  type MobileSocProfile,
  detectMobilePlatform,
  detectMobileSocAndDisplay,
  mobileApiRequest,
  readMobileBattery,
  readMobileNetwork,
  runMobileNetworkAndWifiProbe,
  runMobileSocStressTest,
} from '../mobileApi';

export const PhoneDiagnosticsTab: React.FC<{
  onSendPhotoToCopilot: (photo: { base64: string; mimeType: string; filename: string }) => void;
}> = ({ onSendPhotoToCopilot }) => {
  const [deviceInfo, setDeviceInfo] = useState<{
    platform: string;
    osVersion: string;
    model: string;
    manufacturer: string;
  } | null>(null);
  const [socProfile, setSocProfile] = useState<MobileSocProfile | null>(null);
  const [battery, setBattery] = useState<{ levelPercent: number | null; isCharging: boolean | null; source: string } | null>(null);
  const [network, setNetwork] = useState<{ connected: boolean; connectionType: string; apiLatencyMs: number | null } | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ usedMb: number; quotaMb: number } | null>(null);

  // Expanded Wi-Fi / Hotspot Probe state
  const [probingNet, setProbingNet] = useState(false);
  const [netProbe, setNetProbe] = useState<MobileNetworkProbeResult | null>(null);
  const [hotspotStatus, setHotspotStatus] = useState<'untested' | 'pass' | 'fail'>('untested');
  const [hotspotChecks, setHotspotChecks] = useState({
    ssidVisible: false,
    clientAssignedIp: false,
    internetRouted: false,
  });

  // Expanded SoC Thermal-Throttling Stress Test state
  const [stressRunning, setStressRunning] = useState(false);
  const [liveWindows, setLiveWindows] = useState<MobileSocBenchmarkWindow[]>([]);
  const [socBenchmark, setSocBenchmark] = useState<MobileSocBenchmarkResult | null>(null);

  // Existing interactive hardware checks
  const [speakerStatus, setSpeakerStatus] = useState<'untested' | 'pass' | 'fail'>('untested');
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micStatus, setMicStatus] = useState<'untested' | 'pass' | 'fail' | 'denied'>('untested');
  const [touchTestOpen, setTouchTestOpen] = useState(false);
  const [touchedCells, setTouchedCells] = useState<Set<number>>(new Set());
  const [displayColorIdx, setDisplayColorIdx] = useState<number | null>(null);
  const [displayStatus, setDisplayStatus] = useState<'untested' | 'pass' | 'fail'>('untested');
  const [motionReading, setMotionReading] = useState<string>('Stationary');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const refreshSystemChecks = async () => {
    const [dev, soc, batt, net] = await Promise.all([
      detectMobilePlatform(),
      detectMobileSocAndDisplay(),
      readMobileBattery(),
      readMobileNetwork(),
    ]);
    setDeviceInfo(dev);
    setSocProfile(soc);
    setBattery(batt);
    setNetwork(net);

    if (navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        setStorageInfo({
          usedMb: Math.round((est.usage || 0) / (1024 * 1024)),
          quotaMb: Math.round((est.quota || 0) / (1024 * 1024)),
        });
      } catch {}
    }
  };

  useEffect(() => {
    refreshSystemChecks();
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (a && (a.x !== null || a.y !== null || a.z !== null)) {
        setMotionReading(`X:${(a.x || 0).toFixed(1)} Y:${(a.y || 0).toFixed(1)} Z:${(a.z || 0).toFixed(1)} m/s²`);
      }
    };
    window.addEventListener('devicemotion', onMotion);
    return () => {
      window.removeEventListener('devicemotion', onMotion);
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleRunWifiProbe = async () => {
    setProbingNet(true);
    try {
      const res = await runMobileNetworkAndWifiProbe();
      setNetProbe(res);
      setNetwork({
        connected: res.connected,
        connectionType: res.connectionType,
        apiLatencyMs: res.avgLatencyMs,
      });
    } finally {
      setProbingNet(false);
    }
  };

  const handleRunSocStress = async () => {
    if (stressRunning) return;
    setStressRunning(true);
    setLiveWindows([]);
    setSocBenchmark(null);
    try {
      const res = await runMobileSocStressTest((_win, all) => {
        setLiveWindows(all);
      });
      setSocBenchmark(res);
      setLiveWindows(res.windows);
    } finally {
      setStressRunning(false);
    }
  };

  const toggleHotspotCheck = (key: keyof typeof hotspotChecks) => {
    setHotspotChecks((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (next.ssidVisible && next.clientAssignedIp && next.internetRouted) {
        setHotspotStatus('pass');
      }
      return next;
    });
  };

  const playSpeakerTone = (freqHz: number, pan = 0) => {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqHz, ctx.currentTime);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      if (panner) {
        panner.pan.setValueAtTime(pan, ctx.currentTime);
        osc.connect(panner).connect(gain).connect(ctx.destination);
      } else {
        osc.connect(gain).connect(ctx.destination);
      }
      osc.start();
      osc.stop(ctx.currentTime + 0.85);
    } catch {}
  };

  const toggleMicTest = async () => {
    if (micActive) {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setMicActive(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      setMicActive(true);
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!micStreamRef.current) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setMicLevel(Math.min(100, Math.round((avg / 128) * 100)));
        if (avg > 15) setMicStatus('pass');
        requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setMicStatus('denied');
    }
  };

  const handleSaveMobileDiagnostic = async () => {
    setSaving(true);
    setSavedNotice(null);
    try {
      const dev = deviceInfo || (await detectMobilePlatform());
      const warnings: Array<{
        code: string;
        severity: 'info' | 'warning' | 'critical';
        component: 'network' | 'audio' | 'thermal' | 'soc';
        title: string;
        detail: string;
      }> = [];

      if (network && !network.connected) {
        warnings.push({
          code: 'MOBILE_OFFLINE',
          severity: 'critical',
          component: 'network',
          title: 'Device Offline',
          detail: 'Mobile network API reports no active connectivity.',
        });
      }
      if (netProbe && (netProbe.packetLossPercent >= 20 || (netProbe.jitterMs !== null && netProbe.jitterMs >= 60))) {
        warnings.push({
          code: 'MOBILE_WIFI_INSTABILITY',
          severity: netProbe.packetLossPercent >= 40 ? 'critical' : 'warning',
          component: 'network',
          title: 'Wi-Fi / Network Instability Detected',
          detail: `5-ping probe measured ${netProbe.packetLossPercent}% packet loss and ${netProbe.jitterMs ?? '?'} ms jitter (avg ${netProbe.avgLatencyMs ?? '?'} ms).`,
        });
      }
      if (hotspotStatus === 'fail') {
        warnings.push({
          code: 'HOTSPOT_TETHER_FAIL',
          severity: 'warning',
          component: 'network',
          title: 'Hotspot / Tethering Check Failed',
          detail: 'User verified mobile hotspot broadcast or client routing failed.',
        });
      }
      if (socBenchmark && socBenchmark.throttleDropPercent >= 20) {
        warnings.push({
          code: 'MOBILE_SOC_THROTTLING',
          severity: socBenchmark.throttleDropPercent >= 32 ? 'critical' : 'warning',
          component: 'thermal',
          title: `SoC Thermal Throttling (${socBenchmark.throttleDropPercent}% Drop)`,
          detail: `Compute throughput dropped from ${socBenchmark.peakKOpsPerSec} to ${socBenchmark.sustainedKOpsPerSec} kOps/s across the 9s sustained stress test.`,
        });
      }
      if (speakerStatus === 'fail') {
        warnings.push({
          code: 'SPEAKER_TEST_FAIL',
          severity: 'warning',
          component: 'audio',
          title: 'Speaker Check Failed',
          detail: 'User marked audio speaker output test as failed.',
        });
      }

      const summaryParts = [
        `Battery ${battery?.levelPercent ?? 'N/A'}%`,
        `Network ${
          netProbe
            ? `${netProbe.connectionType} avg ${netProbe.avgLatencyMs ?? '?'}ms / jitter ${netProbe.jitterMs ?? '?'}ms (${netProbe.qualityVerdict})`
            : network?.connected
              ? `${network.connectionType} (${network.apiLatencyMs ?? '?'}ms)`
              : 'Offline'
        }`,
        ...(socProfile ? [`SoC/GPU: ${socProfile.inferredSocFamily}`] : []),
        ...(socBenchmark ? [`Stress: ${socBenchmark.stabilityPercent}% stability (${socBenchmark.throttleDropPercent}% drop)`] : []),
        ...(hotspotStatus !== 'untested' ? [`Hotspot: ${hotspotStatus}`] : []),
        `Speaker: ${speakerStatus}, Mic: ${micStatus}, Display: ${displayStatus}`,
      ];

      const snapshot = {
        id: crypto.randomUUID(),
        toolId: 'mobile_device_check',
        measurementType: 'measured' as const,
        source: `CoreSense Mobile Permitted APIs (${dev.platform})`,
        platform: dev.platform as 'ios' | 'android' | 'web',
        osVersion: dev.osVersion,
        collectedAt: new Date().toISOString(),
        durationMs: socBenchmark ? socBenchmark.totalDurationMs : 350,
        summary: `Mobile Check: ${summaryParts.join(' • ')}.`,
        limitations: [
          'iOS and Android sandboxes prohibit third-party apps from reading raw Wi-Fi/hotspot RF chip registers, internal SoC die temperature sensors, or kernel driver logs. CoreSense measures permitted network quality, WebGL GPU/SoC identity, and real sustained compute throttling directly.',
        ],
        warnings,
        data: {
          device: dev,
          socProfile,
          socBenchmark,
          battery,
          network,
          networkProbe: netProbe,
          hotspotVerification: {
            status: hotspotStatus,
            checks: hotspotChecks,
          },
          storageInfo,
          interactiveChecks: {
            speakerStatus,
            micStatus,
            displayStatus,
            touchTilesVerified: `${touchedCells.size}/16`,
            motionReading,
          },
        },
      };
      await mobileApiRequest('/api/v1/diagnostics/ingest', {
        method: 'POST',
        body: { snapshot },
      });
      setSavedNotice('Full mobile diagnostic snapshot (Wi-Fi/Hotspot + SoC benchmark + sensors) synced to your workspace.');
    } catch (err) {
      setSavedNotice(err instanceof Error ? err.message : 'Unable to save report.');
    } finally {
      setSaving(false);
    }
  };

  const handleCameraCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onSendPhotoToCopilot({
        base64: String(reader.result || ''),
        mimeType: file.type || 'image/jpeg',
        filename: file.name,
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const displayColors = ['#EF4444', '#22C55E', '#3B82F6', '#FFFFFF', '#000000'];
  const vuSegments = 12;
  const activeSegments = Math.round((micLevel / 100) * vuSegments);
  const maxBarScore = Math.max(1, ...liveWindows.map((w) => w.kOpsPerSec));

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="cs-heading text-base font-bold text-[var(--cs-ink)]">Phone hardware checks</h1>
          <p className="text-xs text-[var(--cs-ink-muted)]">SoC stress, Wi-Fi/hotspot quality & permitted sensors</p>
        </div>
        <button
          type="button"
          onClick={refreshSystemChecks}
          className="cs-btn-secondary px-3 py-1.5 text-xs font-semibold cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {/* Platform Limitation Note */}
      <div className="rounded-lg bg-[var(--cs-accent-soft)] border border-[var(--cs-accent-border)] p-3 flex gap-2.5 text-xs text-[var(--cs-accent-ink)] leading-relaxed">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          <strong>OS boundaries:</strong> iOS and Android restrict third-party apps from inspecting internal RF/PMIC chip registers or raw die temperatures. CoreSense measures real sustained SoC throughput, WebGL GPU identity, multi-ping Wi-Fi stability, and permitted hardware sensors directly.
        </span>
      </div>

      {/* Live Readouts Grid */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="cs-panel p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--cs-ok)]">
            <BatteryCharging className="h-4 w-4" />
            <span>Battery</span>
          </div>
          <div className="font-mono text-lg font-bold text-[var(--cs-ink)] cs-tabular">
            {battery?.levelPercent != null ? `${battery.levelPercent}%` : 'OS restricted'}
          </div>
          <div className="text-[11px] text-[var(--cs-ink-muted)]">
            {battery?.isCharging === true ? 'Charging' : battery?.isCharging === false ? 'Discharging' : battery?.source}
          </div>
        </div>

        <div className="cs-panel p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--cs-accent)]">
            <Wifi className="h-4 w-4" />
            <span>Network</span>
          </div>
          <div className="font-mono text-lg font-bold text-[var(--cs-ink)] cs-tabular">
            {network?.connected ? `${network.apiLatencyMs ?? '?'} ms` : 'Offline'}
          </div>
          <div className="text-[11px] text-[var(--cs-ink-muted)] capitalize">
            Type: {network?.connectionType || 'checking'}
          </div>
        </div>

        <div className="cs-panel p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--cs-ink-2)]">
            <HardDrive className="h-4 w-4" />
            <span>App storage</span>
          </div>
          <div className="font-mono text-sm font-bold text-[var(--cs-ink)] cs-tabular">
            {storageInfo ? `${storageInfo.usedMb} / ${storageInfo.quotaMb} MB` : 'Checking...'}
          </div>
          <div className="text-[11px] text-[var(--cs-ink-muted)]">Permitted quota estimate</div>
        </div>

        <div className="cs-panel p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--cs-warn)]">
            <Compass className="h-4 w-4" />
            <span>Motion sensor</span>
          </div>
          <div className="font-mono text-xs font-semibold text-[var(--cs-ink)] cs-tabular">{motionReading}</div>
          <div className="text-[11px] text-[var(--cs-ink-muted)]">Accelerometer probe</div>
        </div>
      </div>

      {/* SoC / Processor (Snapdragon / MediaTek / Apple) & Thermal Throttling Stress Test */}
      <div className="cs-panel p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--cs-ink)]">
            <Cpu className="h-4 w-4 text-[var(--cs-accent)]" />
            <span>SoC / Processor & GPU throttling test</span>
          </div>
          {socBenchmark && (
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border uppercase ${
                socBenchmark.throttlingLevel === 'heavy'
                  ? 'bg-[var(--cs-danger-soft)] border-[var(--cs-danger-border)] text-[var(--cs-danger-ink)]'
                  : socBenchmark.throttlingLevel === 'moderate'
                    ? 'bg-[var(--cs-warn-soft)] border-[var(--cs-warn-border)] text-[var(--cs-warn-ink)]'
                    : 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
              }`}
            >
              {socBenchmark.throttlingLevel === 'none' ? 'Stable' : `${socBenchmark.throttlingLevel} throttle`}
            </span>
          )}
        </div>

        {socProfile && (
          <div className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-2.5 space-y-1 text-xs">
            <div className="font-semibold text-[var(--cs-ink)]">{socProfile.inferredSocFamily}</div>
            <div className="font-mono text-[11px] text-[var(--cs-ink-2)] break-all">
              GPU: {socProfile.gpuRenderer}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono text-[var(--cs-ink-muted)] cs-tabular pt-0.5">
              <span>Cores: {socProfile.logicalCores ?? 'N/A'}</span>
              <span>RAM tier: {socProfile.approxRamGb ? `~${socProfile.approxRamGb} GB` : 'OS masked'}</span>
              <span>Display: {socProfile.displayResolution} @ {socProfile.measuredRefreshHz ? `${socProfile.measuredRefreshHz}Hz` : `${socProfile.pixelRatio}x`}</span>
            </div>
          </div>
        )}

        {/* Live 5-Window Compute Throughput Bar Chart (Zero Gradients) */}
        {(liveWindows.length > 0 || stressRunning) && (
          <div className="space-y-2">
            <div className="grid grid-cols-5 gap-1.5 items-end h-20 pt-2 px-1 rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)]">
              {[1, 2, 3, 4, 5].map((idx) => {
                const win = liveWindows.find((w) => w.windowIndex === idx);
                const heightPct = win ? Math.max(12, Math.round((win.kOpsPerSec / maxBarScore) * 100)) : 8;
                const isDrop =
                  win &&
                  liveWindows[0] &&
                  win.kOpsPerSec < liveWindows[0].kOpsPerSec * 0.8;
                return (
                  <div key={idx} className="flex flex-col items-center justify-end h-full gap-1">
                    <div className="w-full flex-1 flex items-end">
                      <div
                        className="w-full rounded-t-[2px] transition-all duration-200"
                        style={{
                          height: `${heightPct}%`,
                          backgroundColor: !win
                            ? 'var(--cs-well)'
                            : isDrop
                              ? 'var(--cs-warn)'
                              : 'var(--cs-accent)',
                        }}
                      />
                    </div>
                    <span className="font-mono text-[9px] text-[var(--cs-ink-muted)] cs-tabular pb-1">
                      {win ? `${Math.round(win.kOpsPerSec)}` : `W${idx}`}
                    </span>
                  </div>
                );
              })}
            </div>

            {socBenchmark && (
              <div className="grid grid-cols-3 gap-2 text-center font-mono cs-tabular">
                <div className="rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] py-1.5 px-1">
                  <div className="text-[10px] font-sans text-[var(--cs-ink-muted)]">Peak</div>
                  <div className="text-xs font-bold text-[var(--cs-ink)]">{socBenchmark.peakKOpsPerSec}</div>
                </div>
                <div className="rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] py-1.5 px-1">
                  <div className="text-[10px] font-sans text-[var(--cs-ink-muted)]">Stability</div>
                  <div className="text-xs font-bold text-[var(--cs-ok-ink)]">{socBenchmark.stabilityPercent}%</div>
                </div>
                <div className="rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] py-1.5 px-1">
                  <div className="text-[10px] font-sans text-[var(--cs-ink-muted)]">Drop</div>
                  <div className="text-xs font-bold text-[var(--cs-warn-ink)]">{socBenchmark.throttleDropPercent}%</div>
                </div>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          disabled={stressRunning}
          onClick={handleRunSocStress}
          className="cs-btn-accent w-full py-2 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          {stressRunning ? (
            <>
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>Benchmarking window {Math.min(5, liveWindows.length + 1)}/5...</span>
            </>
          ) : (
            <>
              <Flame className="h-3.5 w-3.5" />
              <span>Run 9s SoC thermal-throttling stress test</span>
            </>
          )}
        </button>
      </div>

      {/* Wi-Fi, Hotspot & Network Stability Diagnostics */}
      <div className="cs-panel p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--cs-ink)]">
            <Radio className="h-4 w-4 text-[var(--cs-accent)]" />
            <span>Wi-Fi, hotspot & latency diagnostics</span>
          </div>
          {netProbe && (
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border uppercase ${
                netProbe.qualityVerdict === 'offline' || netProbe.qualityVerdict === 'poor'
                  ? 'bg-[var(--cs-danger-soft)] border-[var(--cs-danger-border)] text-[var(--cs-danger-ink)]'
                  : netProbe.qualityVerdict === 'fair'
                    ? 'bg-[var(--cs-warn-soft)] border-[var(--cs-warn-border)] text-[var(--cs-warn-ink)]'
                    : 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
              }`}
            >
              {netProbe.qualityVerdict}
            </span>
          )}
        </div>

        {netProbe && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2 text-center font-mono cs-tabular">
              <div className="rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] py-1.5 px-1">
                <div className="text-[10px] font-sans text-[var(--cs-ink-muted)]">Avg RTT</div>
                <div className="text-xs font-bold text-[var(--cs-ink)]">
                  {netProbe.avgLatencyMs != null ? `${netProbe.avgLatencyMs}ms` : 'Fail'}
                </div>
              </div>
              <div className="rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] py-1.5 px-1">
                <div className="text-[10px] font-sans text-[var(--cs-ink-muted)]">Jitter</div>
                <div className="text-xs font-bold text-[var(--cs-ink)]">
                  {netProbe.jitterMs != null ? `${netProbe.jitterMs}ms` : '—'}
                </div>
              </div>
              <div className="rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] py-1.5 px-1">
                <div className="text-[10px] font-sans text-[var(--cs-ink-muted)]">Loss</div>
                <div className="text-xs font-bold text-[var(--cs-ink)]">{netProbe.packetLossPercent}%</div>
              </div>
            </div>
            <div className="rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-2.5 py-2 text-[11px] font-mono text-[var(--cs-ink-2)] flex flex-wrap justify-between gap-1.5 cs-tabular">
              <span>
                Link: {netProbe.connectionType}
                {netProbe.effectiveType ? ` (${netProbe.effectiveType})` : ''}
                {netProbe.downlinkMbps != null ? ` • ~${netProbe.downlinkMbps} Mbps` : ''}
              </span>
              <span>
                1.1.1.1: {netProbe.externalInternetReachable ? `OK (${netProbe.externalProbeMs}ms)` : 'Blocked/Offline'}
              </span>
            </div>
          </div>
        )}

        <button
          type="button"
          disabled={probingNet}
          onClick={handleRunWifiProbe}
          className="cs-btn-secondary w-full py-2 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <Activity className={`h-3.5 w-3.5 ${probingNet ? 'animate-spin text-[var(--cs-accent)]' : ''}`} />
          <span>{probingNet ? 'Running 5-ping jitter & internet probe...' : 'Run Wi-Fi latency & jitter probe'}</span>
        </button>

        {/* Guided Hotspot / Tethering Check */}
        <div className="pt-2.5 border-t border-[var(--cs-border)] space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-[var(--cs-ink)]">Hotspot tethering check (guided)</span>
            <span className="font-mono text-[11px] capitalize text-[var(--cs-ink-muted)]">{hotspotStatus}</span>
          </div>
          <p className="text-[11px] text-[var(--cs-ink-muted)] leading-relaxed">
            Turn on Personal Hotspot in phone settings and test with a second device (OS privacy blocks apps from reading hotspot client tables):
          </p>
          <div className="space-y-1.5">
            {[
              { key: 'ssidVisible' as const, label: '1. Hotspot SSID visible on secondary device' },
              { key: 'clientAssignedIp' as const, label: '2. Secondary device connects & gets IP (DHCP)' },
              { key: 'internetRouted' as const, label: '3. Secondary device loads a web page via hotspot' },
            ].map((step) => (
              <label
                key={step.key}
                className="flex items-center gap-2 rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-2.5 py-1.5 text-xs text-[var(--cs-ink-2)] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={hotspotChecks[step.key]}
                  onChange={() => toggleHotspotCheck(step.key)}
                  className="accent-[var(--cs-accent)]"
                />
                <span>{step.label}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setHotspotStatus('pass')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                hotspotStatus === 'pass'
                  ? 'bg-[var(--cs-ok)] border-[var(--cs-ok)] text-[var(--cs-accent-on)]'
                  : 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
              }`}
            >
              Hotspot OK
            </button>
            <button
              type="button"
              onClick={() => setHotspotStatus('fail')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                hotspotStatus === 'fail'
                  ? 'bg-[var(--cs-danger)] border-[var(--cs-danger)] text-[var(--cs-accent-on)]'
                  : 'bg-[var(--cs-danger-soft)] border-[var(--cs-danger-border)] text-[var(--cs-danger-ink)]'
              }`}
            >
              Hotspot failed
            </button>
          </div>
        </div>
      </div>

      {deviceInfo && (
        <div className="cs-panel p-3 flex items-center gap-2.5 text-xs">
          <Smartphone className="h-4 w-4 text-[var(--cs-accent)] shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold text-[var(--cs-ink)] truncate">
              {deviceInfo.manufacturer} {deviceInfo.model}
            </div>
            <div className="text-[11px] text-[var(--cs-ink-muted)] truncate font-mono">{deviceInfo.osVersion}</div>
          </div>
        </div>
      )}

      {/* Interactive Speaker Test */}
      <div className="cs-panel p-3.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--cs-ink)]">
            <Volume2 className="h-4 w-4 text-[var(--cs-accent)]" />
            <span>Speaker stereo tone test</span>
          </div>
          <span className="text-[11px] font-mono capitalize text-[var(--cs-ink-muted)]">{speakerStatus}</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => playSpeakerTone(440, -1)} className="cs-btn-secondary py-2 text-xs cursor-pointer">
            Left 440Hz
          </button>
          <button type="button" onClick={() => playSpeakerTone(660, 0)} className="cs-btn-secondary py-2 text-xs cursor-pointer">
            Center 660Hz
          </button>
          <button type="button" onClick={() => playSpeakerTone(880, 1)} className="cs-btn-secondary py-2 text-xs cursor-pointer">
            Right 880Hz
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSpeakerStatus('pass')}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
              speakerStatus === 'pass'
                ? 'bg-[var(--cs-ok)] border-[var(--cs-ok)] text-[var(--cs-accent-on)]'
                : 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
            }`}
          >
            Heard clearly (Pass)
          </button>
          <button
            type="button"
            onClick={() => setSpeakerStatus('fail')}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
              speakerStatus === 'fail'
                ? 'bg-[var(--cs-danger)] border-[var(--cs-danger)] text-[var(--cs-accent-on)]'
                : 'bg-[var(--cs-danger-soft)] border-[var(--cs-danger-border)] text-[var(--cs-danger-ink)]'
            }`}
          >
            Distorted / silent (Fail)
          </button>
        </div>
      </div>

      {/* Interactive Microphone Test — Solid Segmented Instrument VU Meter (Zero Gradients!) */}
      <div className="cs-panel p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--cs-ink)]">
            <Mic className="h-4 w-4 text-[var(--cs-accent)]" />
            <span>Microphone input level</span>
          </div>
          <span className="text-[11px] font-mono capitalize text-[var(--cs-ink-muted)]">{micStatus}</span>
        </div>

        <div className="grid grid-cols-12 gap-1 h-4" aria-label={`Microphone level ${micLevel}%`}>
          {Array.from({ length: vuSegments }).map((_, idx) => {
            const lit = idx < activeSegments;
            const segColor =
              idx >= 10
                ? 'var(--cs-danger)'
                : idx >= 7
                  ? 'var(--cs-warn)'
                  : 'var(--cs-ok)';
            return (
              <div
                key={idx}
                className="rounded-[2px] border transition-colors duration-75"
                style={{
                  backgroundColor: lit ? segColor : 'var(--cs-well)',
                  borderColor: lit ? segColor : 'var(--cs-border)',
                }}
              />
            );
          })}
        </div>

        <button
          type="button"
          onClick={toggleMicTest}
          className="cs-btn-secondary w-full py-2 text-xs font-semibold cursor-pointer"
        >
          {micActive ? 'Stop microphone monitor' : 'Start live microphone test'}
        </button>
      </div>

      {/* Interactive Display & Touch Test */}
      <div className="cs-panel p-3.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--cs-ink)]">
            <Grid3x3 className="h-4 w-4 text-[var(--cs-ok)]" />
            <span>Display & touch digitizer</span>
          </div>
          <span className="text-[11px] font-mono text-[var(--cs-ink-muted)] cs-tabular">
            {touchedCells.size}/16 ({displayStatus})
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDisplayColorIdx(0)}
            className="cs-btn-secondary py-2 text-xs font-semibold cursor-pointer"
          >
            Dead-pixel cycle
          </button>
          <button
            type="button"
            onClick={() => {
              setTouchedCells(new Set());
              setTouchTestOpen(true);
            }}
            className="cs-btn-secondary py-2 text-xs font-semibold cursor-pointer"
          >
            Touch grid (4×4)
          </button>
        </div>
      </div>

      {/* Camera Board Capture Shortcut */}
      <div className="rounded-lg bg-[var(--cs-accent-soft)] border border-[var(--cs-accent-border)] p-3.5 flex items-center justify-between gap-3">
        <div className="text-xs">
          <div className="font-semibold text-[var(--cs-ink)]">Structured PCB / board camera inspector</div>
          <div className="text-[11px] text-[var(--cs-ink-2)] mt-0.5">
            Capture a motherboard, chip, or port for Gemini 4 structured inspection.
          </div>
        </div>
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleCameraCapture}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => cameraInputRef.current?.click()}
          className="cs-btn-accent shrink-0 flex items-center gap-1.5 px-3.5 py-2 text-xs cursor-pointer"
        >
          <Camera className="h-3.5 w-3.5" />
          <span>Capture</span>
        </button>
      </div>

      {savedNotice && (
        <div className="rounded-lg bg-[var(--cs-ok-soft)] border border-[var(--cs-ok-border)] p-3 text-xs text-[var(--cs-ok-ink)] flex items-center gap-2 cs-animate-view">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{savedNotice}</span>
        </div>
      )}

      <button
        type="button"
        disabled={saving}
        onClick={handleSaveMobileDiagnostic}
        className="cs-btn-primary w-full flex items-center justify-center gap-2 py-3 text-xs cursor-pointer disabled:opacity-50"
      >
        <Save className="h-4 w-4" />
        <span>{saving ? 'Syncing snapshot...' : 'Save and sync phone report'}</span>
      </button>

      {/* Fullscreen Dead-Pixel Overlay */}
      {displayColorIdx !== null && (
        <div
          onClick={() => {
            if (displayColorIdx + 1 < displayColors.length) setDisplayColorIdx(displayColorIdx + 1);
            else {
              setDisplayColorIdx(null);
              setDisplayStatus('pass');
            }
          }}
          style={{ backgroundColor: displayColors[displayColorIdx] }}
          className="fixed inset-0 z-50 flex items-end justify-center pb-12 cursor-pointer"
        >
          <div className="rounded-md bg-[#111824] border border-[#2a3444] px-4 py-2 text-xs text-white font-semibold">
            Tap anywhere to cycle solid screen ({displayColorIdx + 1}/{displayColors.length})
          </div>
        </div>
      )}

      {/* Touch Digitizer Modal */}
      {touchTestOpen && (
        <div className="fixed inset-0 z-50 bg-[var(--cs-canvas)] p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="cs-heading text-sm font-bold text-[var(--cs-ink)]">
              Tap every tile ({touchedCells.size}/16)
            </span>
            <button
              type="button"
              onClick={() => {
                setTouchTestOpen(false);
                if (touchedCells.size === 16) setDisplayStatus('pass');
              }}
              className="cs-btn-primary px-3.5 py-1.5 text-xs cursor-pointer"
            >
              Done
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2 flex-1 my-4">
            {Array.from({ length: 16 }).map((_, idx) => {
              const hit = touchedCells.has(idx);
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    const next = new Set(touchedCells);
                    next.add(idx);
                    setTouchedCells(next);
                  }}
                  className={`rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${
                    hit
                      ? 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok)] text-[var(--cs-ok)] cs-animate-tile'
                      : 'bg-[var(--cs-surface)] border-[var(--cs-border)]'
                  }`}
                >
                  {hit && <Check className="h-5 w-5" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
