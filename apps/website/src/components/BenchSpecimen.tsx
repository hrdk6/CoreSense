import React, { useState } from 'react';

type SpecimenMode = 'pc' | 'android' | 'pcb';

interface ReadingRow {
  label: string;
  value: string;
  provenance: 'measured' | 'inferred' | 'image_observation' | 'safety_gate';
  tone: 'ok' | 'warn' | 'danger' | 'accent';
}

interface SpecimenSpec {
  id: SpecimenMode;
  tabLabel: string;
  instrumentTitle: string;
  channelMeta: string;
  traceLabel: string;
  traceUnit: string;
  tracePoints: string;
  baselineY: number;
  anomalyDot?: { cx: number; cy: number; label: string };
  readings: ReadingRow[];
  hypothesisTitle: string;
  discriminatingTest: string;
}

const SPECIMENS: Record<SpecimenMode, SpecimenSpec> = {
  pc: {
    id: 'pc',
    tabLabel: 'PC Hardware',
    instrumentTitle: 'Thermal & Wear Telemetry Probe',
    channelMeta: 'Windows x64 · Native Rust + CIM',
    traceLabel: 'CPU package temperature (6-scan baseline)',
    traceUnit: '88 °C peak',
    tracePoints: '18,98 76,94 134,96 192,92 250,95 312,26',
    baselineY: 95,
    anomalyDot: { cx: 312, cy: 26, label: 'z = +4.12' },
    readings: [
      { label: 'CPU thermal outlier (MAD)', value: '88 °C vs 51 °C median (z = +4.12)', provenance: 'measured', tone: 'danger' },
      { label: 'Battery RUL slope (OLS)', value: '+0.50 %/day · 20d to 30% wear', provenance: 'measured', tone: 'warn' },
      { label: 'GPU / NVMe / USB PnP', value: 'RTX 4060 62 °C · 0 PnP errors', provenance: 'measured', tone: 'ok' },
    ],
    hypothesisTitle: 'Dried thermal interface paste or blocked exhaust fin stack',
    discriminatingTest: 'Run the bounded 4-window CPU stress probe while checking exhaust airflow delta.',
  },
  android: {
    id: 'android',
    tabLabel: 'Android SoC & Wi-Fi',
    instrumentTitle: 'SoC Throttling & Link Jitter Check',
    channelMeta: 'Android APK · Capacitor Native',
    traceLabel: '5-window sustained compute throughput',
    traceUnit: '18.4% drop',
    tracePoints: '18,28 92,33 166,42 240,56 312,62',
    baselineY: 30,
    anomalyDot: { cx: 312, cy: 62, label: 'Mild throttle' },
    readings: [
      { label: 'SoC stability (5 windows)', value: '81.6% sustained · 18.4% thermal drop', provenance: 'measured', tone: 'warn' },
      { label: 'Wi-Fi latency & jitter', value: '14.2 ms avg · ±2.1 ms · 0% loss', provenance: 'measured', tone: 'ok' },
      { label: 'WAN / Hotspot probe', value: '1.1.1.1 reachable · 120 Hz panel', provenance: 'measured', tone: 'accent' },
    ],
    hypothesisTitle: 'Thermal ceiling reached under sustained load; Wi-Fi radio healthy',
    discriminatingTest: 'Repeat SoC stress check without case after 5 min cool-down and compare drop %.',
  },
  pcb: {
    id: 'pcb',
    tabLabel: 'PCB Vision',
    instrumentTitle: 'Structured Board Vision Inspector',
    channelMeta: 'Gemini 4 Vision · Strict JSON Schema',
    traceLabel: 'USB-C PD rail drop vs nominal 20 V negotiation',
    traceUnit: '5.04 V stuck',
    tracePoints: '18,86 78,86 138,85 198,86 258,84 312,86',
    baselineY: 34,
    anomalyDot: { cx: 198, cy: 86, label: 'No 20 V PD' },
    readings: [
      { label: 'Silkscreen / zone', value: 'U7000 USB-C PD controller · pins 14–16', provenance: 'image_observation', tone: 'accent' },
      { label: 'Safety gate status', value: 'Disconnect battery before probing rails', provenance: 'safety_gate', tone: 'danger' },
      { label: 'Suggested next proof', value: 'Diode-mode check on PPBUS_G3H to GND', provenance: 'inferred', tone: 'ok' },
    ],
    hypothesisTitle: 'USB-C PD controller failing 20 V contract negotiation (stuck at 5 V)',
    discriminatingTest: 'Measure CC1/CC2 diode drops and PP3V3_G3H before replacing U7000.',
  },
};

const TONE_CLASSES: Record<ReadingRow['tone'], string> = {
  ok: 'text-[var(--cs-ok-ink)] bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)]',
  warn: 'text-[var(--cs-warn-ink)] bg-[var(--cs-warn-soft)] border-[var(--cs-warn-border)]',
  danger: 'text-[var(--cs-danger-ink)] bg-[var(--cs-danger-soft)] border-[var(--cs-danger-border)]',
  accent: 'text-[var(--cs-accent-ink)] bg-[var(--cs-accent-soft)] border-[var(--cs-accent-border)]',
};

const TRACE_STROKE: Record<SpecimenMode, string> = {
  pc: 'var(--cs-danger)',
  android: 'var(--cs-warn)',
  pcb: 'var(--cs-accent)',
};

export const BenchSpecimen: React.FC = () => {
  const [mode, setMode] = useState<SpecimenMode>('pc');
  const spec = SPECIMENS[mode];

  return (
    <div className="cs-panel overflow-hidden" aria-label="Interactive CoreSense diagnostic bench specimen">
      {/* Instrument header & mechanical mode tabs */}
      <div className="px-4 py-3 border-b border-[var(--cs-border)] bg-[var(--cs-well)] flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[var(--cs-ink)] truncate">{spec.instrumentTitle}</div>
          <div className="text-[11px] font-mono text-[var(--cs-ink-muted)] truncate">{spec.channelMeta}</div>
        </div>
        <div
          role="tablist"
          aria-label="Diagnostic mode preview"
          className="inline-flex rounded-md border border-[var(--cs-border)] bg-[var(--cs-surface)] p-0.5"
        >
          {(['pc', 'android', 'pcb'] as SpecimenMode[]).map((id) => {
            const active = mode === id;
            return (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setMode(id)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-[5px] cursor-pointer transition-colors ${
                  active
                    ? 'bg-[var(--cs-action)] text-[var(--cs-action-ink)] font-semibold'
                    : 'text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)]'
                }`}
              >
                {SPECIMENS[id].tabLabel}
              </button>
            );
          })}
        </div>
      </div>

      {/* Live oscilloscope readout pane */}
      <div className="p-4 space-y-4">
        <div className="rounded-lg border border-[var(--cs-border)] bg-[var(--cs-canvas)] cs-bench-grid p-3">
          <div className="flex items-center justify-between text-[11px] mb-2">
            <span className="text-[var(--cs-ink-muted)]">{spec.traceLabel}</span>
            <span className="font-mono font-semibold text-[var(--cs-ink)] cs-tabular">{spec.traceUnit}</span>
          </div>
          <svg
            key={mode}
            viewBox="0 0 340 116"
            className="w-full h-28 block"
            role="img"
            aria-label={`${spec.traceLabel}: ${spec.traceUnit}`}
          >
            {/* Reference baseline */}
            <line
              x1="12"
              y1={spec.baselineY}
              x2="328"
              y2={spec.baselineY}
              stroke="var(--cs-border-strong)"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            {/* Measured signal trace */}
            <polyline
              fill="none"
              stroke={TRACE_STROKE[mode]}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={spec.tracePoints}
              className="cs-trace-line"
            />
            {spec.anomalyDot && (
              <g>
                <circle
                  cx={spec.anomalyDot.cx}
                  cy={spec.anomalyDot.cy}
                  r="4.5"
                  fill={TRACE_STROKE[mode]}
                />
                <circle
                  cx={spec.anomalyDot.cx}
                  cy={spec.anomalyDot.cy}
                  r="9"
                  fill="none"
                  stroke={TRACE_STROKE[mode]}
                  strokeOpacity="0.45"
                  strokeWidth="1.5"
                />
                <text
                  x={spec.anomalyDot.cx - 8}
                  y={spec.anomalyDot.cy < 45 ? spec.anomalyDot.cy + 19 : spec.anomalyDot.cy - 12}
                  textAnchor="end"
                  fill="var(--cs-ink)"
                  fontSize="10.5"
                  fontFamily="IBM Plex Mono, monospace"
                  fontWeight="600"
                >
                  {spec.anomalyDot.label}
                </text>
              </g>
            )}
          </svg>
        </div>

        {/* Strict provenance-tagged measurements */}
        <div className="space-y-2">
          {spec.readings.map((row) => (
            <div
              key={row.label}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--cs-border)] bg-[var(--cs-well)] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-[11px] text-[var(--cs-ink-muted)]">{row.label}</div>
                <div className="text-xs font-mono font-medium text-[var(--cs-ink)] cs-tabular">
                  {row.value}
                </div>
              </div>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-mono font-medium ${TONE_CLASSES[row.tone]}`}
              >
                {row.provenance}
              </span>
            </div>
          ))}
        </div>

        {/* Evidence-linked hypothesis (explicitly zero fake confidence %) */}
        <div className="rounded-md border border-[var(--cs-border)] bg-[var(--cs-canvas)] px-3 py-2.5 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-[var(--cs-ink)]">Active hypothesis</span>
            <span className="text-[10px] font-mono text-[var(--cs-ink-muted)]">No invented % scores</span>
          </div>
          <p className="text-xs text-[var(--cs-ink-2)] leading-snug">{spec.hypothesisTitle}</p>
          <p className="text-[11px] text-[var(--cs-ink-muted)] leading-snug pt-0.5">
            <span className="text-[var(--cs-ink)] font-medium">Next discriminating test:</span>{' '}
            {spec.discriminatingTest}
          </p>
        </div>
      </div>
    </div>
  );
};
