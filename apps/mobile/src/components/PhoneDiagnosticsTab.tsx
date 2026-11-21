import React, { useEffect, useRef, useState } from 'react';
import {
  BatteryCharging,
  Camera,
  Check,
  CheckCircle2,
  Compass,
  Grid3x3,
  HardDrive,
  Info,
  Mic,
  Save,
  Smartphone,
  Volume2,
  Wifi,
} from 'lucide-react';
import {
  detectMobilePlatform,
  mobileApiRequest,
  readMobileBattery,
  readMobileNetwork,
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
  const [battery, setBattery] = useState<{ levelPercent: number | null; isCharging: boolean | null; source: string } | null>(null);
  const [network, setNetwork] = useState<{ connected: boolean; connectionType: string; apiLatencyMs: number | null } | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ usedMb: number; quotaMb: number } | null>(null);

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
    const [dev, batt, net] = await Promise.all([
      detectMobilePlatform(),
      readMobileBattery(),
      readMobileNetwork(),
    ]);
    setDeviceInfo(dev);
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
      const snapshot = {
        id: crypto.randomUUID(),
        toolId: 'mobile_device_check',
        measurementType: 'measured' as const,
        source: `CoreSense Mobile Permitted APIs (${dev.platform})`,
        platform: dev.platform as 'ios' | 'android' | 'web',
        osVersion: dev.osVersion,
        collectedAt: new Date().toISOString(),
        durationMs: 250,
        summary: `Mobile Check: Battery ${battery?.levelPercent ?? 'N/A'}%, Network ${network?.connected ? `${network.connectionType} (${network.apiLatencyMs ?? '?'}ms)` : 'Offline'}, Speaker: ${speakerStatus}, Mic: ${micStatus}, Display/Touch: ${displayStatus}.`,
        limitations: [
          'Third-party mobile apps on iOS and Android cannot inspect internal motherboard Wi-Fi/PMIC chips, private app memory, or unrestricted OS kernel logs.',
        ],
        warnings: [
          ...(network && !network.connected
            ? [{ code: 'MOBILE_OFFLINE', severity: 'critical' as const, component: 'network' as const, title: 'Device Offline', detail: 'Mobile network API reports no active connectivity.' }]
            : []),
          ...(speakerStatus === 'fail'
            ? [{ code: 'SPEAKER_TEST_FAIL', severity: 'warning' as const, component: 'audio' as const, title: 'Speaker Check Failed', detail: 'User marked audio speaker output test as failed.' }]
            : []),
        ],
        data: {
          device: dev,
          battery,
          network,
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
      setSavedNotice('Phone diagnostic snapshot saved and synced to your workspace.');
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

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="cs-heading text-base font-bold text-[var(--cs-ink)]">Phone hardware checks</h1>
          <p className="text-xs text-[var(--cs-ink-muted)]">Permitted native sensors and interactive tests</p>
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
          <strong>OS boundaries:</strong> iOS and Android prevent third-party apps from inspecting internal board chips or raw kernel logs. CoreSense runs every permitted sensor check directly.
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
                ? 'bg-[var(--cs-ok)] border-[var(--cs-ok)] text-white'
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
                ? 'bg-[var(--cs-danger)] border-[var(--cs-danger)] text-white'
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
                className="rounded-[2px] transition-colors duration-75"
                style={{
                  backgroundColor: lit ? segColor : 'var(--cs-well)',
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

      {/* Camera Board Capture Shortcut (Solid Flat Accent Surface — Zero Gradient) */}
      <div className="rounded-lg bg-[var(--cs-accent-soft)] border border-[var(--cs-accent-border)] p-3.5 flex items-center justify-between gap-3">
        <div className="text-xs">
          <div className="font-semibold text-[var(--cs-ink)]">Inspect another device via camera</div>
          <div className="text-[11px] text-[var(--cs-ink-2)] mt-0.5">
            Capture a board, port, or error code for the copilot.
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
