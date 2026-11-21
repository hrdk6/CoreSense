import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  Cpu,
  FlaskConical,
  HardDrive,
  Info,
  MemoryStick,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wifi,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DiagnosticResult } from '@coresense/shared';
import { apiRequest, isTauriRuntime, runNativeTauriDiagnostic } from '../api';

const TOOL_CARDS = [
  { id: 'full_system_snapshot', label: 'Full scan', icon: Activity },
  { id: 'cpu_diagnostics', label: 'CPU & processes', icon: Cpu },
  { id: 'memory_diagnostics', label: 'RAM pressure', icon: MemoryStick },
  { id: 'storage_diagnostics', label: 'Storage & SMART', icon: HardDrive },
  { id: 'network_diagnostics', label: 'Network & DNS', icon: Wifi },
  { id: 'os_health_diagnostics', label: 'OS event logs', icon: Terminal },
  { id: 'power_and_peripherals', label: 'Battery & displays', icon: BatteryCharging },
] as const;

const SIMULATIONS = [
  { id: 'high_cpu_runaway', label: 'High CPU runaway process' },
  { id: 'high_ram_pressure', label: 'Critical RAM pressure (95.6%)' },
  { id: 'low_disk_space', label: 'Low disk space (C: 98.2%)' },
  { id: 'smart_ssd_failing', label: 'SMART predictive SSD failure' },
  { id: 'dns_failure_ip_ok', label: 'DNS failure (direct IP OK)' },
  { id: 'battery_degraded', label: 'Battery wear degradation (54%)' },
  { id: 'thermal_overheating', label: 'CPU thermal overheating (97.5°C)' },
  { id: 'windows_kernel_power_bsod', label: 'Windows Kernel-Power 41 / WHEA' },
] as const;

const TelemetryGauge: React.FC<{
  label: string;
  value: number | null;
  displayText: string;
  detail: string;
  tone?: 'accent' | 'ok' | 'warn' | 'danger';
}> = ({ label, value, displayText, detail, tone = 'accent' }) => {
  const radius = 24;
  const circumference = 2 * Math.PI * radius;
  const clamped = value == null ? 0 : Math.max(0, Math.min(100, value));
  const offset = circumference - (clamped / 100) * circumference;

  const strokeVar =
    tone === 'danger'
      ? 'var(--cs-danger)'
      : tone === 'warn'
        ? 'var(--cs-warn)'
        : tone === 'ok'
          ? 'var(--cs-ok)'
          : 'var(--cs-accent)';

  return (
    <div className="cs-panel p-4 flex items-center gap-3.5">
      <div className="relative h-14 w-14 shrink-0 flex items-center justify-center">
        <svg viewBox="0 0 60 60" className="h-14 w-14 -rotate-90" aria-hidden="true">
          <circle
            cx="30"
            cy="30"
            r={radius}
            fill="none"
            stroke="var(--cs-well)"
            strokeWidth="5"
          />
          <circle
            cx="30"
            cy="30"
            r={radius}
            fill="none"
            stroke={strokeVar}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="cs-gauge-arc"
          />
        </svg>
        <span className="absolute font-mono text-[11px] font-semibold text-[var(--cs-ink)] cs-tabular">
          {value != null ? `${Math.round(clamped)}%` : '—'}
        </span>
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-[var(--cs-ink-muted)]">{label}</div>
        <div className="font-mono text-base font-bold text-[var(--cs-ink)] cs-tabular truncate">
          {displayText}
        </div>
        <div className="text-[11px] text-[var(--cs-ink-muted)] truncate">{detail}</div>
      </div>
    </div>
  );
};

export const DiagnosticsView: React.FC<{ devices: Array<{ id: string; name: string }> }> = ({ devices }) => {
  const [history, setHistory] = useState<DiagnosticResult[]>([]);
  const [active, setActive] = useState<DiagnosticResult | null>(null);
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [showSimDrawer, setShowSimDrawer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = async () => {
    const res = await apiRequest<{ snapshots: DiagnosticResult[] }>('/api/v1/diagnostics/history?limit=25');
    setHistory(res.snapshots);
    if (!active && res.snapshots.length > 0) setActive(res.snapshots[0]);
  };

  useEffect(() => {
    loadHistory().catch(() => {});
  }, []);

  const runTool = async (toolId: string) => {
    setRunningTool(toolId);
    setError(null);
    try {
      if (isTauriRuntime() && ['cpu_diagnostics', 'memory_diagnostics', 'storage_diagnostics', 'full_system_snapshot'].includes(toolId)) {
        const nativeRes = await runNativeTauriDiagnostic(toolId);
        if (nativeRes) {
          const ingested = await apiRequest<{ snapshot: DiagnosticResult }>('/api/v1/diagnostics/ingest', {
            method: 'POST',
            body: { snapshot: nativeRes, deviceId: selectedDeviceId || undefined },
          });
          setActive(ingested.snapshot);
          await loadHistory();
          return;
        }
      }

      const res = await apiRequest<{ snapshot: DiagnosticResult }>('/api/v1/diagnostics/run', {
        method: 'POST',
        body: { toolId, deviceId: selectedDeviceId || undefined },
      });
      setActive(res.snapshot);
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diagnostic scan failed.');
    } finally {
      setRunningTool(null);
    }
  };

  const runSimulation = async (scenarioId: string) => {
    setRunningTool(`sim:${scenarioId}`);
    setError(null);
    try {
      const res = await apiRequest<{ snapshot: DiagnosticResult }>('/api/v1/diagnostics/simulate', {
        method: 'POST',
        body: { scenarioId, deviceId: selectedDeviceId || undefined },
      });
      setActive(res.snapshot);
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation fixture failed.');
    } finally {
      setRunningTool(null);
    }
  };

  const cpuObj = ((active?.data?.cpu as Record<string, unknown>) ||
    (active?.toolId === 'cpu_diagnostics' ? active.data : null)) as Record<string, unknown> | null;
  const memObj = ((active?.data?.memory as Record<string, unknown>) ||
    (active?.toolId === 'memory_diagnostics' ? active.data : null)) as Record<string, unknown> | null;
  const storageObj = ((active?.data?.storage as Record<string, unknown>) ||
    (active?.toolId === 'storage_diagnostics' ? active.data : null)) as Record<string, unknown> | null;
  const netObj = ((active?.data?.network as Record<string, unknown>) ||
    (active?.toolId === 'network_diagnostics' ? active.data : null)) as Record<string, unknown> | null;
  const osObj = ((active?.data?.osHealth as Record<string, unknown>) ||
    (active?.toolId === 'os_health_diagnostics' ? active.data : null)) as Record<string, unknown> | null;
  const powerObj = ((active?.data?.power as Record<string, unknown>) ||
    (active?.toolId === 'power_and_peripherals' ? active.data : null)) as Record<string, unknown> | null;

  const perCoreChartData = Array.isArray(cpuObj?.perCorePercent)
    ? (cpuObj.perCorePercent as number[]).map((v, i) => ({ core: `T${i}`, load: v }))
    : [];

  const cpuPct = cpuObj?.utilizationPercent != null ? Number(cpuObj.utilizationPercent) : null;
  const memPct = memObj?.utilizationPercent != null ? Number(memObj.utilizationPercent) : null;
  const firstVol = Array.isArray(storageObj?.volumes) ? (storageObj.volumes as Array<any>)[0] : null;
  const diskPct = firstVol?.usedPercent != null ? Number(firstVol.usedPercent) : null;
  const dnsOk = Boolean((netObj?.connectivity as any)?.dnsResolved);
  const dnsMs = (netObj?.connectivity as any)?.dnsLatencyMs;

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header Command Deck */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-[var(--cs-border)]">
        <div className="space-y-1">
          <h1 className="cs-heading text-2xl font-bold text-[var(--cs-ink)]">
            Local hardware & OS diagnostics
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--cs-ink-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--cs-ok)] cs-animate-led" />
              <span>Validated read-only collector</span>
            </span>
            <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-2)]">
              {isTauriRuntime() ? 'Native Rust Tauri' : 'Local host engine'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            aria-label="Target device for snapshot"
            className="cs-input px-3 py-2 text-xs"
          >
            <option value="">Attach to local host</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setShowSimDrawer((s) => !s)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
              showSimDrawer
                ? 'border-[var(--cs-warn)] bg-[var(--cs-warn-soft)] text-[var(--cs-warn-ink)]'
                : 'cs-btn-secondary'
            }`}
          >
            <FlaskConical className="h-3.5 w-3.5" />
            <span>Test fixtures</span>
          </button>

          <button
            type="button"
            disabled={runningTool !== null}
            onClick={() => runTool('full_system_snapshot')}
            className="cs-btn-primary flex items-center gap-1.5 px-4 py-2 text-xs cursor-pointer disabled:opacity-50"
          >
            {runningTool === 'full_system_snapshot' ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            <span>{runningTool === 'full_system_snapshot' ? 'Scanning...' : 'Run full scan'}</span>
          </button>
        </div>
      </div>

      {/* Individual Read-Only Probe Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {TOOL_CARDS.map((t) => {
          const Icon = t.icon;
          const busy = runningTool === t.id;
          const isCurrent = active?.toolId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              disabled={runningTool !== null}
              onClick={() => runTool(t.id)}
              className={`relative overflow-hidden rounded-lg p-3 text-left border transition-colors flex flex-col justify-between gap-2.5 cursor-pointer disabled:opacity-60 ${
                isCurrent
                  ? 'bg-[var(--cs-accent-soft)] border-[var(--cs-accent-border)]'
                  : 'bg-[var(--cs-surface)] border-[var(--cs-border)] hover:border-[var(--cs-border-strong)]'
              }`}
            >
              {busy && (
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-[var(--cs-well)] overflow-hidden">
                  <div className="h-full w-1/3 bg-[var(--cs-accent)] cs-animate-scan" />
                </div>
              )}
              <Icon
                className={`h-4 w-4 ${
                  busy
                    ? 'animate-spin text-[var(--cs-accent)]'
                    : isCurrent
                      ? 'text-[var(--cs-accent)]'
                      : 'text-[var(--cs-ink-muted)]'
                }`}
              />
              <div className="text-xs font-semibold text-[var(--cs-ink)]">
                {busy ? 'Scanning...' : t.label}
              </div>
            </button>
          );
        })}
      </div>

      {/* Clearly Separated Simulation Fixtures Drawer */}
      {showSimDrawer && (
        <div className="rounded-lg border border-[var(--cs-warn-border)] border-l-[4px] border-l-[var(--cs-warn)] bg-[var(--cs-warn-soft)] p-4 space-y-3 cs-animate-view">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--cs-warn-ink)]">
            <FlaskConical className="h-4 w-4 shrink-0" />
            <span>Synthetic test fixtures (deterministic training data, never real host measurements)</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {SIMULATIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={runningTool !== null}
                onClick={() => runSimulation(s.id)}
                className="rounded-md bg-[var(--cs-surface)] border border-[var(--cs-warn-border)] hover:border-[var(--cs-warn)] px-3 py-1.5 text-xs font-medium text-[var(--cs-ink)] transition-colors cursor-pointer disabled:opacity-50"
              >
                {runningTool === `sim:${s.id}` ? 'Running fixture...' : s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] px-4 py-2.5 text-xs text-[var(--cs-danger-ink)]">
          {error}
        </div>
      )}

      {/* Main Diagnostics Display + Snapshot History */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 space-y-4">
          {!active ? (
            <div className="cs-panel p-12 text-center space-y-3">
              <ShieldCheck className="h-9 w-9 text-[var(--cs-accent)] mx-auto" />
              <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                No diagnostic snapshot loaded
              </h2>
              <p className="text-xs text-[var(--cs-ink-muted)] max-w-md mx-auto leading-relaxed">
                Run a full scan above to measure live CPU threads, memory pressure, disk SMART health,
                network DNS latency, OS event logs, and battery wear on this machine.
              </p>
            </div>
          ) : (
            <div key={active.id} className="space-y-4 cs-animate-view">
              {/* Provenance Banner */}
              <div
                className={`cs-panel p-4 space-y-3 border-l-[4px] ${
                  active.measurementType === 'simulated'
                    ? 'border-l-[var(--cs-warn)] bg-[var(--cs-warn-soft)] border-[var(--cs-warn-border)]'
                    : 'border-l-[var(--cs-ok)]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                        active.measurementType === 'simulated'
                          ? 'bg-[var(--cs-surface)] text-[var(--cs-warn-ink)] border-[var(--cs-warn-border)]'
                          : 'bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)] border-[var(--cs-ok-border)]'
                      }`}
                    >
                      {active.measurementType === 'simulated' ? 'Simulated fixture' : 'Measured hardware'}
                    </span>
                    <span className="font-mono text-xs text-[var(--cs-accent-ink)]">{active.toolId}</span>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--cs-ink-muted)] cs-tabular">
                    {new Date(active.collectedAt).toLocaleString()} ({active.durationMs} ms)
                  </span>
                </div>

                <p className="text-sm font-medium text-[var(--cs-ink)] leading-snug">{active.summary}</p>
                <div className="text-xs text-[var(--cs-ink-muted)] font-mono">
                  Source: {active.source} / OS: {active.osVersion}
                </div>

                {active.warnings.length > 0 && (
                  <div className="pt-1 space-y-2">
                    {active.warnings.map((w, i) => (
                      <div
                        key={i}
                        className={`rounded-md px-3 py-2.5 text-xs flex items-start gap-2.5 border ${
                          w.severity === 'critical'
                            ? 'bg-[var(--cs-danger-soft)] border-[var(--cs-danger-border)] text-[var(--cs-danger-ink)]'
                            : 'bg-[var(--cs-warn-soft)] border-[var(--cs-warn-border)] text-[var(--cs-warn-ink)]'
                        }`}
                      >
                        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold">{w.title}</div>
                          <div className="mt-0.5 opacity-90">{w.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {active.limitations.length > 0 && (
                  <div className="pt-1 space-y-1">
                    {active.limitations.map((lim, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-[var(--cs-ink-muted)]">
                        <Info className="h-3.5 w-3.5 text-[var(--cs-accent)] shrink-0 mt-0.5" />
                        <span>{lim}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Animated Instrument Radial Gauges Strip */}
              {(cpuObj || memObj || storageObj || netObj) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {cpuObj && (
                    <TelemetryGauge
                      label="CPU utilization"
                      value={cpuPct}
                      displayText={
                        cpuObj.temperatureCelsius
                          ? `${cpuPct ?? '?'}% / ${String(cpuObj.temperatureCelsius)}°C`
                          : `${cpuPct ?? '?'}%`
                      }
                      detail={String(cpuObj.model || 'Host processor')}
                      tone={cpuPct != null && cpuPct >= 85 ? 'danger' : cpuPct != null && cpuPct >= 65 ? 'warn' : 'accent'}
                    />
                  )}
                  {memObj && (
                    <TelemetryGauge
                      label="Memory pressure"
                      value={memPct}
                      displayText={`${String(memObj.usedGb)} / ${String(memObj.totalGb)} GB`}
                      detail={`State: ${String(memObj.pressure)}`}
                      tone={memPct != null && memPct >= 88 ? 'danger' : memPct != null && memPct >= 75 ? 'warn' : 'ok'}
                    />
                  )}
                  {firstVol && (
                    <TelemetryGauge
                      label={`Volume ${firstVol.mount}`}
                      value={diskPct}
                      displayText={`${firstVol.freeGb} GB free`}
                      detail={`of ${firstVol.totalGb} GB total`}
                      tone={diskPct != null && diskPct >= 90 ? 'danger' : diskPct != null && diskPct >= 78 ? 'warn' : 'ok'}
                    />
                  )}
                  {netObj && (
                    <TelemetryGauge
                      label="DNS lookup"
                      value={dnsOk ? Math.max(8, Math.min(100, 100 - Number(dnsMs || 0) / 3)) : 0}
                      displayText={dnsOk ? `${dnsMs} ms` : 'Failed'}
                      detail={
                        (netObj.connectivity as any)?.directIpReachable
                          ? `Direct IP ${(netObj.connectivity as any)?.directIpLatencyMs} ms`
                          : 'Direct IP unreachable'
                      }
                      tone={dnsOk ? 'ok' : 'danger'}
                    />
                  )}
                </div>
              )}

              {/* CPU Telemetry & Per-Core Chart */}
              {cpuObj && (
                <div className="cs-panel p-4 space-y-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">CPU threads & load</h3>
                      <div className="text-xs text-[var(--cs-ink-muted)]">{String(cpuObj.model || '')}</div>
                    </div>
                    <span className="font-mono text-xs text-[var(--cs-accent-ink)] cs-tabular">
                      Load {String(cpuObj.utilizationPercent ?? '?')}%
                      {cpuObj.temperatureCelsius ? ` / ${String(cpuObj.temperatureCelsius)}°C` : ''}
                    </span>
                  </div>

                  {perCoreChartData.length > 0 && (
                    <div className="h-40 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={perCoreChartData} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--cs-border)" vertical={false} />
                          <XAxis dataKey="core" tick={{ fill: 'var(--cs-ink-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                          <YAxis domain={[0, 100]} tick={{ fill: 'var(--cs-ink-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                          <Tooltip
                            cursor={{ fill: 'var(--cs-well)' }}
                            contentStyle={{
                              backgroundColor: 'var(--cs-surface)',
                              borderColor: 'var(--cs-border-strong)',
                              color: 'var(--cs-ink)',
                              borderRadius: '8px',
                              fontSize: 12,
                            }}
                          />
                          <Bar dataKey="load" fill="var(--cs-accent)" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {Array.isArray(cpuObj.topProcesses) && (cpuObj.topProcesses as Array<any>).length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-[var(--cs-ink-muted)] border-b border-[var(--cs-border)]">
                            <th className="py-2 font-medium">Top CPU process</th>
                            <th className="py-2 font-medium">PID</th>
                            <th className="py-2 text-right font-medium">CPU time (s)</th>
                            <th className="py-2 text-right font-medium">RAM (MB)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--cs-border)] font-mono cs-tabular">
                          {(cpuObj.topProcesses as Array<any>).slice(0, 6).map((p, i) => (
                            <tr key={i} className="text-[var(--cs-ink-2)]">
                              <td className="py-2 font-sans font-medium text-[var(--cs-ink)]">{p.name}</td>
                              <td className="py-2 text-[var(--cs-ink-muted)]">{p.pid}</td>
                              <td className="py-2 text-right text-[var(--cs-accent-ink)]">{p.cpuSeconds ?? '-'}</td>
                              <td className="py-2 text-right">{p.workingSetMb ?? '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Memory & Storage Row */}
              {(memObj || storageObj) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {memObj && (
                    <div className="cs-panel p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Memory</h3>
                        <span className="font-mono text-xs text-[var(--cs-accent-ink)] cs-tabular">
                          {String(memObj.utilizationPercent)}% ({String(memObj.pressure)})
                        </span>
                      </div>
                      <div className="w-full h-2.5 rounded-sm bg-[var(--cs-well)] overflow-hidden">
                        <div
                          className="h-full cs-meter-fill"
                          style={{
                            width: `${Math.min(100, Number(memObj.utilizationPercent) || 0)}%`,
                            backgroundColor:
                              Number(memObj.utilizationPercent) >= 88
                                ? 'var(--cs-danger)'
                                : Number(memObj.utilizationPercent) >= 75
                                  ? 'var(--cs-warn)'
                                  : 'var(--cs-accent)',
                          }}
                        />
                      </div>
                      <div className="text-xs text-[var(--cs-ink-muted)] font-mono cs-tabular">
                        Used {String(memObj.usedGb)} GB / Total {String(memObj.totalGb)} GB (Free {String(memObj.availableGb)} GB)
                      </div>
                      {Array.isArray(memObj.topProcesses) && (
                        <div className="space-y-1.5 pt-2 border-t border-[var(--cs-border)]">
                          {(memObj.topProcesses as Array<any>).slice(0, 5).map((p, i) => (
                            <div key={i} className="flex justify-between text-xs text-[var(--cs-ink-2)]">
                              <span className="truncate pr-2">{p.name}</span>
                              <span className="font-mono text-[var(--cs-ink-muted)] cs-tabular shrink-0">
                                {p.memoryMb} MB
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {storageObj && (
                    <div className="cs-panel p-4 space-y-3">
                      <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Storage & SMART</h3>
                      {Array.isArray(storageObj.volumes) &&
                        (storageObj.volumes as Array<any>).map((v, i) => (
                          <div key={i} className="space-y-1.5">
                            <div className="flex justify-between text-xs gap-2">
                              <span className="font-semibold text-[var(--cs-ink)]">
                                {v.mount} {v.label ? `(${v.label})` : ''}
                              </span>
                              <span className="font-mono text-[var(--cs-ink-muted)] cs-tabular">
                                {v.freeGb} GB free / {v.totalGb} GB ({v.usedPercent}%)
                              </span>
                            </div>
                            <div className="w-full h-2 rounded-sm bg-[var(--cs-well)] overflow-hidden">
                              <div
                                className="h-full cs-meter-fill"
                                style={{
                                  width: `${Math.min(100, v.usedPercent)}%`,
                                  backgroundColor: v.usedPercent >= 90 ? 'var(--cs-danger)' : 'var(--cs-ok)',
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      {Array.isArray(storageObj.physicalDisks) && (
                        <div className="space-y-1.5 pt-2 border-t border-[var(--cs-border)]">
                          {(storageObj.physicalDisks as Array<any>).map((d, i) => (
                            <div
                              key={i}
                              className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-2.5 py-2 text-xs flex justify-between gap-2"
                            >
                              <span className="text-[var(--cs-ink)] font-medium truncate">{d.model}</span>
                              <span className="font-mono text-[11px] text-[var(--cs-ok-ink)] shrink-0 cs-tabular">
                                {d.healthStatus}
                                {d.wearPercent != null ? ` / Wear ${d.wearPercent}%` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Network, Power & OS Health */}
              {(netObj || osObj || powerObj) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {netObj && (
                    <div className="cs-panel p-4 space-y-2.5 text-xs">
                      <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Network & DNS</h3>
                      <div className="font-mono text-[var(--cs-ink-2)] cs-tabular">
                        DNS:{' '}
                        {(netObj.connectivity as any)?.dnsResolved
                          ? `OK (${(netObj.connectivity as any)?.dnsLatencyMs} ms)`
                          : `Failed (${(netObj.connectivity as any)?.dnsError})`}
                      </div>
                      <div className="font-mono text-[var(--cs-ink-2)] cs-tabular">
                        Direct IP (1.1.1.1):{' '}
                        {(netObj.connectivity as any)?.directIpReachable
                          ? `Reachable (${(netObj.connectivity as any)?.directIpLatencyMs} ms)`
                          : 'Unreachable'}
                      </div>
                      {Boolean(netObj.wifi) && (
                        <div className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-2.5 text-xs text-[var(--cs-ink)] font-mono">
                          Wi-Fi: {String((netObj.wifi as any).SSID || (netObj.wifi as any).State)} / Signal:{' '}
                          {String((netObj.wifi as any).Signal || 'N/A')}
                        </div>
                      )}
                    </div>
                  )}

                  {powerObj && (
                    <div className="cs-panel p-4 space-y-2.5 text-xs">
                      <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Power & displays</h3>
                      <div className="text-[var(--cs-ink-2)]">
                        Battery:{' '}
                        <span className="font-mono text-[var(--cs-ink)]">
                          {(powerObj.battery as any)?.present
                            ? `${(powerObj.battery as any).chargePercent}% (${(powerObj.battery as any).status})${
                                (powerObj.battery as any).wearPercent != null
                                  ? ` / Wear ${(powerObj.battery as any).wearPercent}%`
                                  : ''
                              }`
                            : 'AC desktop / no internal battery'}
                        </span>
                      </div>
                      {Array.isArray(powerObj.displays) &&
                        (powerObj.displays as Array<any>).map((g, i) => (
                          <div key={i} className="text-xs text-[var(--cs-ink-muted)] font-mono">
                            GPU: {g.name} ({g.resolution})
                          </div>
                        ))}
                    </div>
                  )}

                  {osObj && (
                    <div className="md:col-span-2 cs-panel p-4 space-y-3 text-xs">
                      <div className="flex items-center justify-between">
                        <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">
                          OS health & recent error events
                        </h3>
                        <span className="font-mono text-[var(--cs-ink-muted)] cs-tabular">
                          Uptime {String(osObj.uptimeHours ?? '?')} h
                        </span>
                      </div>
                      {Array.isArray(osObj.recentErrors) && (osObj.recentErrors as Array<any>).length > 0 ? (
                        <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                          {(osObj.recentErrors as Array<any>).map((ev, i) => (
                            <div
                              key={i}
                              className="rounded-md bg-[var(--cs-canvas)] p-2.5 border border-[var(--cs-border)]"
                            >
                              <div className="flex justify-between font-mono text-[11px] text-[var(--cs-warn-ink)]">
                                <span>
                                  [{ev.logName}] {ev.provider} (ID {ev.id})
                                </span>
                                <span>{ev.level}</span>
                              </div>
                              <p className="text-xs text-[var(--cs-ink-2)] mt-1 line-clamp-2">{ev.message}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[var(--cs-ink-muted)]">No recent critical or error events reported.</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chronological Snapshot History Rail */}
        <aside className="lg:col-span-4 cs-panel overflow-hidden flex flex-col max-h-[780px]">
          <div className="px-4 py-3 border-b border-[var(--cs-border)] bg-[var(--cs-chassis)] flex items-center justify-between">
            <h2 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Snapshot history</h2>
            <span className="font-mono text-[11px] cs-tabular px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-muted)]">
              {history.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[var(--cs-border)]">
            {history.length === 0 ? (
              <div className="p-6 text-xs text-[var(--cs-ink-muted)] text-center">
                Completed scans will be logged here for comparison.
              </div>
            ) : (
              history.map((snap) => {
                const selected = active?.id === snap.id;
                const isSim = snap.measurementType === 'simulated';
                return (
                  <button
                    key={snap.id}
                    type="button"
                    onClick={() => setActive(snap)}
                    className={`relative w-full text-left px-4 py-3 transition-colors cursor-pointer ${
                      selected ? 'bg-[var(--cs-accent-soft)]' : 'hover:bg-[var(--cs-canvas)]'
                    }`}
                  >
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--cs-accent)]"
                      />
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] font-medium text-[var(--cs-ink)]">
                        {snap.toolId}
                      </span>
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
                          isSim
                            ? 'bg-[var(--cs-warn-soft)] text-[var(--cs-warn-ink)] border-[var(--cs-warn-border)]'
                            : 'bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)] border-[var(--cs-ok-border)]'
                        }`}
                      >
                        {isSim ? 'Simulated' : 'Measured'}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--cs-ink-2)] mt-1 line-clamp-2 leading-snug">
                      {snap.summary}
                    </p>
                    <div className="text-[11px] text-[var(--cs-ink-muted)] mt-1.5 font-mono cs-tabular flex items-center justify-between">
                      <span>{new Date(snap.collectedAt).toLocaleString()}</span>
                      <span>{snap.warnings.length} alert(s)</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
