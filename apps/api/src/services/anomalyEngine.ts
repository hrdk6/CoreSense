import crypto from 'node:crypto';
import type {
  DegradationForecast,
  DiagnosticResult,
  HealthSubsystem,
  SubsystemHealthScore,
  SystemHealthAnalysis,
  TelemetryAnomaly,
} from '@coresense/shared';

interface TimePoint {
  tsMs: number;
  iso: string;
  value: number;
}

interface ExtractedSeries {
  cpuLoad: TimePoint[];
  cpuTemp: TimePoint[];
  ramUsedPct: TimePoint[];
  diskUsedPct: TimePoint[];
  ssdWearPct: TimePoint[];
  batteryWearPct: TimePoint[];
  gpuTemp: TimePoint[];
  gpuLoad: TimePoint[];
  dnsLatencyMs: TimePoint[];
  networkJitterMs: TimePoint[];
  throttleDropPct: TimePoint[];
}

function asObj(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
}

function asNum(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Iglewicz & Hoaglin Modified Z-Score (robust MAD-based outlier detection),
 * with sample standard-deviation fallback when MAD == 0 and real variance exists.
 */
function detectLatestAnomaly(params: {
  series: TimePoint[];
  metric: string;
  subsystem: HealthSubsystem;
  unit: string;
  minFloorDelta: number;
  direction: 'high_is_bad' | 'both';
}): TelemetryAnomaly | null {
  const { series, metric, subsystem, unit, minFloorDelta, direction } = params;
  // Require at least 4 chronological points (3 baseline + 1 latest) for statistically meaningful baseline
  if (series.length < 4) return null;

  const latest = series[series.length - 1];
  const baseline = series.slice(0, -1).map((p) => p.value);
  const med = median(baseline);
  const absDevs = baseline.map((v) => Math.abs(v - med));
  const mad = median(absDevs);
  const delta = latest.value - med;

  if (direction === 'high_is_bad' && delta <= 0) return null;
  if (Math.abs(delta) < minFloorDelta) return null;

  let zScore = 0;
  let method: 'modified_z_mad' | 'standard_z' = 'modified_z_mad';
  let spread = mad;

  if (mad > 1e-6) {
    zScore = (0.6745 * delta) / mad;
  } else {
    const sd = sampleStdDev(baseline);
    method = 'standard_z';
    if (sd > 1e-6) {
      spread = sd;
      zScore = delta / sd;
    } else {
      // Baseline was perfectly constant; use minimum meaningful noise floor to avoid division by zero
      spread = minFloorDelta / 2.5;
      zScore = delta / spread;
    }
  }

  const absZ = Math.abs(zScore);
  if (absZ < 2.5) return null;

  const severity: TelemetryAnomaly['severity'] = absZ >= 3.5 ? 'critical' : 'warning';
  const roundedZ = round(zScore, 2);
  const roundedLatest = round(latest.value, 1);
  const roundedMed = round(med, 1);
  const roundedSpread = round(spread, 2);

  return {
    id: crypto.randomUUID(),
    metric,
    subsystem,
    severity,
    latestValue: roundedLatest,
    unit,
    baselineMedian: roundedMed,
    baselineSpread: roundedSpread,
    zScore: roundedZ,
    method,
    sampleCount: series.length,
    explanation: `${metric} spiked to ${roundedLatest}${unit} versus your ${baseline.length}-scan baseline median of ${roundedMed}${unit} (${method === 'modified_z_mad' ? 'Modified Z' : 'Z'} = ${roundedZ > 0 ? '+' : ''}${roundedZ}).`,
    detectedAt: latest.iso,
  };
}

/**
 * Ordinary Least Squares (OLS) linear regression over time (days) to project
 * degradation slope, R^2 fit, and estimated days until threshold.
 */
function computeOlsDegradationForecast(params: {
  series: TimePoint[];
  metric: string;
  subsystem: 'battery' | 'storage' | 'thermal';
  unit: string;
  thresholdValue: number;
  thresholdLabel: string;
  urgentDays: number;
}): DegradationForecast | null {
  const { series, metric, subsystem, unit, thresholdValue, thresholdLabel, urgentDays } = params;
  if (series.length === 0) return null;

  const latest = series[series.length - 1];
  const first = series[0];
  const spanDays = Math.max(0, (latest.tsMs - first.tsMs) / (1000 * 60 * 60 * 24));

  if (series.length < 3) {
    return {
      metric,
      subsystem,
      currentValue: round(latest.value, 1),
      unit,
      slopePerDay: 0,
      rSquared: 0,
      thresholdValue,
      thresholdLabel,
      estimatedDaysToThreshold: null,
      status: 'insufficient_history',
      sampleCount: series.length,
      spanDays: round(spanDays, 3),
      explanation: `Currently ${round(latest.value, 1)}${unit}. Need at least 3 historical scans across time (currently ${series.length}) to fit an OLS linear degradation trend.`,
    };
  }

  // Require at least ~1 minute span to avoid extrapolating millisecond bursts into days
  if (spanDays < 0.0007) {
    return {
      metric,
      subsystem,
      currentValue: round(latest.value, 1),
      unit,
      slopePerDay: 0,
      rSquared: 0,
      thresholdValue,
      thresholdLabel,
      estimatedDaysToThreshold: null,
      status: 'insufficient_history',
      sampleCount: series.length,
      spanDays: round(spanDays, 4),
      explanation: `Currently ${round(latest.value, 1)}${unit} across ${series.length} scans taken within a single minute. Collect scans over multiple sessions/days for reliable RUL projection.`,
    };
  }

  const xs = series.map((p) => (p.tsMs - first.tsMs) / (1000 * 60 * 60 * 24));
  const ys = series.map((p) => p.value);
  const xBar = mean(xs);
  const yBar = mean(ys);

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - xBar;
    const dy = ys[i] - yBar;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = yBar - slope * xBar;

  let ssRes = 0;
  for (let i = 0; i < xs.length; i++) {
    const pred = intercept + slope * xs[i];
    ssRes += (ys[i] - pred) ** 2;
  }
  const rSquared = syy > 1e-12 ? Math.max(0, Math.min(1, 1 - ssRes / syy)) : 1;

  const currentValue = round(latest.value, 1);
  const roundedSlope = round(slope, 3);
  const roundedR2 = round(rSquared, 3);

  if (currentValue >= thresholdValue) {
    return {
      metric,
      subsystem,
      currentValue,
      unit,
      slopePerDay: roundedSlope,
      rSquared: roundedR2,
      thresholdValue,
      thresholdLabel,
      estimatedDaysToThreshold: 0,
      status: 'urgent',
      sampleCount: series.length,
      spanDays: round(spanDays, 2),
      explanation: `${metric} is already at ${currentValue}${unit}, exceeding the ${thresholdLabel} threshold (${thresholdValue}${unit}).`,
    };
  }

  // Only project remaining useful life if trend is meaningfully increasing (> 0.01/day)
  if (slope <= 0.01) {
    return {
      metric,
      subsystem,
      currentValue,
      unit,
      slopePerDay: roundedSlope,
      rSquared: roundedR2,
      thresholdValue,
      thresholdLabel,
      estimatedDaysToThreshold: null,
      status: 'stable',
      sampleCount: series.length,
      spanDays: round(spanDays, 2),
      explanation: `${metric} is stable at ${currentValue}${unit} (slope ${roundedSlope}${unit}/day across ${series.length} scans over ${round(spanDays, 2)}d).`,
    };
  }

  const remaining = thresholdValue - currentValue;
  const estDays = Math.min(3650, Math.max(1, Math.round(remaining / slope)));
  const status: DegradationForecast['status'] = estDays <= urgentDays ? 'urgent' : 'degrading';

  return {
    metric,
    subsystem,
    currentValue,
    unit,
    slopePerDay: roundedSlope,
    rSquared: roundedR2,
    thresholdValue,
    thresholdLabel,
    estimatedDaysToThreshold: estDays,
    status,
    sampleCount: series.length,
    spanDays: round(spanDays, 2),
    explanation: `${metric} is rising at +${roundedSlope}${unit}/day (R²=${roundedR2}, n=${series.length}); at this rate it reaches ${thresholdLabel} (${thresholdValue}${unit}) in ~${estDays} day(s).`,
  };
}

function extractSeries(snapshots: DiagnosticResult[]): ExtractedSeries {
  const series: ExtractedSeries = {
    cpuLoad: [],
    cpuTemp: [],
    ramUsedPct: [],
    diskUsedPct: [],
    ssdWearPct: [],
    batteryWearPct: [],
    gpuTemp: [],
    gpuLoad: [],
    dnsLatencyMs: [],
    networkJitterMs: [],
    throttleDropPct: [],
  };

  for (const snap of snapshots) {
    const tsMs = Date.parse(snap.collectedAt);
    if (!Number.isFinite(tsMs)) continue;
    const d = asObj(snap.data);
    if (!d) continue;

    const cpu = asObj(d.cpu) || (snap.toolId === 'cpu_diagnostics' ? d : null);
    if (cpu) {
      const load = asNum(cpu.utilizationPercent);
      if (load !== null) series.cpuLoad.push({ tsMs, iso: snap.collectedAt, value: load });
      const temp = asNum(cpu.temperatureCelsius);
      if (temp !== null) series.cpuTemp.push({ tsMs, iso: snap.collectedAt, value: temp });
    }

    const mem = asObj(d.memory) || (snap.toolId === 'memory_diagnostics' ? d : null);
    if (mem) {
      const pct = asNum(mem.utilizationPercent);
      if (pct !== null) series.ramUsedPct.push({ tsMs, iso: snap.collectedAt, value: pct });
    }

    const storage = asObj(d.storage) || (snap.toolId === 'storage_diagnostics' ? d : null);
    if (storage) {
      const vols = Array.isArray(storage.volumes) ? storage.volumes : [];
      const maxUsed = vols
        .map((v) => asNum(asObj(v)?.usedPercent))
        .filter((v): v is number => v !== null);
      if (maxUsed.length > 0) {
        series.diskUsedPct.push({ tsMs, iso: snap.collectedAt, value: Math.max(...maxUsed) });
      }
      const disks = Array.isArray(storage.physicalDisks) ? storage.physicalDisks : [];
      const maxWear = disks
        .map((dk) => asNum(asObj(dk)?.wearPercent))
        .filter((v): v is number => v !== null);
      if (maxWear.length > 0) {
        series.ssdWearPct.push({ tsMs, iso: snap.collectedAt, value: Math.max(...maxWear) });
      }
    }

    const power = asObj(d.power) || (snap.toolId === 'power_and_peripherals' ? d : null);
    if (power) {
      const batt = asObj(power.battery);
      const wear = asNum(batt?.wearPercent);
      if (wear !== null) series.batteryWearPct.push({ tsMs, iso: snap.collectedAt, value: wear });
    }

    const gpu = asObj(d.gpu) || (snap.toolId === 'gpu_diagnostics' ? d : null);
    if (gpu && Array.isArray(gpu.adapters)) {
      const temps = gpu.adapters
        .map((a) => asNum(asObj(a)?.temperatureCelsius))
        .filter((v): v is number => v !== null);
      if (temps.length > 0) {
        series.gpuTemp.push({ tsMs, iso: snap.collectedAt, value: Math.max(...temps) });
      }
      const utils = gpu.adapters
        .map((a) => asNum(asObj(a)?.utilizationPercent))
        .filter((v): v is number => v !== null);
      if (utils.length > 0) {
        series.gpuLoad.push({ tsMs, iso: snap.collectedAt, value: Math.max(...utils) });
      }
    }

    const net = asObj(d.network) || (snap.toolId === 'network_diagnostics' ? d : null);
    if (net) {
      const conn = asObj(net.connectivity);
      const dnsMs = asNum(conn?.dnsLatencyMs);
      if (dnsMs !== null) series.dnsLatencyMs.push({ tsMs, iso: snap.collectedAt, value: dnsMs });
      const apiMs = asNum(net.apiLatencyMs);
      if (apiMs !== null && dnsMs === null) series.dnsLatencyMs.push({ tsMs, iso: snap.collectedAt, value: apiMs });
    }

    // Mobile expanded network probe + SoC stress benchmark
    const netProbe = asObj(d.networkProbe);
    if (netProbe) {
      const avgMs = asNum(netProbe.avgLatencyMs);
      if (avgMs !== null) series.dnsLatencyMs.push({ tsMs, iso: snap.collectedAt, value: avgMs });
      const jitter = asNum(netProbe.jitterMs);
      if (jitter !== null) series.networkJitterMs.push({ tsMs, iso: snap.collectedAt, value: jitter });
    }

    const cpuBench = asObj(d.cpuBenchmark);
    const socBench = asObj(d.socBenchmark);
    const drop = asNum(cpuBench?.throttleDropPercent) ?? asNum(socBench?.throttleDropPercent);
    if (drop !== null) {
      series.throttleDropPct.push({ tsMs, iso: snap.collectedAt, value: drop });
    }
  }

  return series;
}

function statusFromScore(score: number | null): SubsystemHealthScore['status'] {
  if (score === null) return 'insufficient_data';
  if (score >= 85) return 'healthy';
  if (score >= 70) return 'attention';
  if (score >= 50) return 'degraded';
  return 'critical';
}

export function analyzeTelemetryHealth(
  rawSnapshots: DiagnosticResult[],
  options: { deviceId?: string | null; includeSimulated?: boolean } = {},
): SystemHealthAnalysis {
  const { deviceId = null, includeSimulated = false } = options;
  const analyzedAt = new Date().toISOString();

  // Sort chronologically (oldest -> newest)
  const realSnapshots = rawSnapshots
    .filter((s) => (includeSimulated ? true : s.measurementType !== 'simulated'))
    .sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));

  const series = extractSeries(realSnapshots);
  const anomalies: TelemetryAnomaly[] = [];

  const anomalySpecs: Array<{
    series: TimePoint[];
    metric: string;
    subsystem: HealthSubsystem;
    unit: string;
    minFloorDelta: number;
    direction: 'high_is_bad' | 'both';
  }> = [
    { series: series.cpuLoad, metric: 'CPU Utilization', subsystem: 'cpu', unit: '%', minFloorDelta: 15, direction: 'high_is_bad' },
    { series: series.cpuTemp, metric: 'CPU Temperature', subsystem: 'thermal', unit: '°C', minFloorDelta: 8, direction: 'high_is_bad' },
    { series: series.ramUsedPct, metric: 'RAM Utilization', subsystem: 'memory', unit: '%', minFloorDelta: 10, direction: 'high_is_bad' },
    { series: series.gpuTemp, metric: 'GPU Temperature', subsystem: 'gpu', unit: '°C', minFloorDelta: 8, direction: 'high_is_bad' },
    { series: series.dnsLatencyMs, metric: 'Network / DNS Latency', subsystem: 'network', unit: 'ms', minFloorDelta: 35, direction: 'high_is_bad' },
    { series: series.networkJitterMs, metric: 'Wi-Fi / Network Jitter', subsystem: 'network', unit: 'ms', minFloorDelta: 15, direction: 'high_is_bad' },
    { series: series.throttleDropPct, metric: 'Thermal Throttling Drop', subsystem: 'thermal', unit: '%', minFloorDelta: 10, direction: 'high_is_bad' },
  ];

  for (const spec of anomalySpecs) {
    const a = detectLatestAnomaly(spec);
    if (a) anomalies.push(a);
  }

  // Predictive OLS Linear Regression Degradation Forecasts
  const forecasts: DegradationForecast[] = [];
  const battForecast = computeOlsDegradationForecast({
    series: series.batteryWearPct,
    metric: 'Battery Capacity Wear',
    subsystem: 'battery',
    unit: '%',
    thresholdValue: 30,
    thresholdLabel: 'OEM battery service threshold (70% remaining)',
    urgentDays: 45,
  });
  if (battForecast) forecasts.push(battForecast);

  const ssdForecast = computeOlsDegradationForecast({
    series: series.ssdWearPct,
    metric: 'SSD SMART Wear Level',
    subsystem: 'storage',
    unit: '%',
    thresholdValue: 90,
    thresholdLabel: 'Critical SSD endurance limit (90% wear)',
    urgentDays: 60,
  });
  if (ssdForecast) forecasts.push(ssdForecast);

  const diskForecast = computeOlsDegradationForecast({
    series: series.diskUsedPct,
    metric: 'Primary Storage Fill Rate',
    subsystem: 'storage',
    unit: '%',
    thresholdValue: 95,
    thresholdLabel: 'Critical low-space threshold (95% full)',
    urgentDays: 14,
  });
  if (diskForecast) forecasts.push(diskForecast);

  // Latest snapshot per subsystem for transparent composite scoring
  const latestBySubsystem = (matchFn: (s: DiagnosticResult) => boolean) => {
    for (let i = realSnapshots.length - 1; i >= 0; i--) {
      if (matchFn(realSnapshots[i])) return realSnapshots[i];
    }
    return null;
  };

  const subsystemScores: SubsystemHealthScore[] = [];

  const scoreSubsystem = (
    subsystem: HealthSubsystem,
    latestSnap: DiagnosticResult | null,
    sampleCount: number,
    warningComponents: string[],
    latestSummary: string,
    extraDeductions: Array<{ points: number; reason: string }> = [],
  ) => {
    if (!latestSnap) {
      subsystemScores.push({
        subsystem,
        score: null,
        status: 'insufficient_data',
        sampleCount: 0,
        latestSummary: 'No measured scan yet',
        factors: ['Run a diagnostic scan covering this subsystem to compute a measured health score.'],
      });
      return;
    }

    let score = 100;
    const factors: string[] = [];

    for (const w of latestSnap.warnings) {
      if (warningComponents.includes(w.component)) {
        const penalty = w.severity === 'critical' ? 30 : w.severity === 'warning' ? 15 : 5;
        score -= penalty;
        factors.push(`-${penalty}: ${w.title}`);
      }
    }

    for (const anom of anomalies.filter((a) => a.subsystem === subsystem)) {
      const penalty = anom.severity === 'critical' ? 18 : 10;
      score -= penalty;
      factors.push(`-${penalty}: ${anom.metric} anomaly (Z=${anom.zScore})`);
    }

    for (const ex of extraDeductions) {
      if (ex.points > 0) {
        score -= ex.points;
        factors.push(`-${ex.points}: ${ex.reason}`);
      }
    }

    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    if (factors.length === 0) factors.push('All latest measured telemetry within normal operating bounds.');

    subsystemScores.push({
      subsystem,
      score: clamped,
      status: statusFromScore(clamped),
      sampleCount,
      latestSummary,
      factors,
    });
  };

  // 1. CPU
  const latestCpuSnap = latestBySubsystem(
    (s) => s.toolId === 'cpu_diagnostics' || s.toolId === 'full_system_snapshot' || s.toolId === 'hardware_stress_probe' || (s.toolId === 'mobile_device_check' && Boolean(asObj(s.data)?.socBenchmark)),
  );
  const latestCpuLoad = series.cpuLoad[series.cpuLoad.length - 1]?.value;
  scoreSubsystem(
    'cpu',
    latestCpuSnap,
    series.cpuLoad.length || (latestCpuSnap ? 1 : 0),
    ['cpu', 'soc', 'benchmark'],
    latestCpuLoad !== undefined ? `Latest load ${round(latestCpuLoad, 1)}%` : 'Measured via benchmark/profile',
    latestCpuLoad !== undefined && latestCpuLoad >= 80 && latestCpuLoad < 85
      ? [{ points: 8, reason: `Elevated CPU utilization (${round(latestCpuLoad, 1)}%)` }]
      : [],
  );

  // 2. Memory
  const latestMemSnap = latestBySubsystem((s) => s.toolId === 'memory_diagnostics' || s.toolId === 'full_system_snapshot');
  const latestRam = series.ramUsedPct[series.ramUsedPct.length - 1]?.value;
  scoreSubsystem(
    'memory',
    latestMemSnap,
    series.ramUsedPct.length,
    ['memory'],
    latestRam !== undefined ? `${round(latestRam, 1)}% RAM utilized` : 'No RAM reading',
    latestRam !== undefined && latestRam >= 80 && latestRam < 88
      ? [{ points: 10, reason: `High RAM utilization (${round(latestRam, 1)}%)` }]
      : [],
  );

  // 3. Storage
  const latestStorageSnap = latestBySubsystem((s) => s.toolId === 'storage_diagnostics' || s.toolId === 'full_system_snapshot');
  const latestDisk = series.diskUsedPct[series.diskUsedPct.length - 1]?.value;
  const latestSsdWear = series.ssdWearPct[series.ssdWearPct.length - 1]?.value;
  const storageExtras: Array<{ points: number; reason: string }> = [];
  if (latestSsdWear !== undefined && latestSsdWear >= 50) {
    storageExtras.push({ points: Math.min(35, Math.round((latestSsdWear - 40) * 0.6)), reason: `SSD wear at ${latestSsdWear}%` });
  }
  scoreSubsystem(
    'storage',
    latestStorageSnap,
    series.diskUsedPct.length || (latestStorageSnap ? 1 : 0),
    ['storage'],
    latestDisk !== undefined
      ? `Max volume ${round(latestDisk, 1)}% used${latestSsdWear !== undefined ? `, SSD wear ${latestSsdWear}%` : ''}`
      : 'Storage inspected',
    storageExtras,
  );

  // 4. GPU
  const latestGpuSnap = latestBySubsystem((s) => s.toolId === 'gpu_diagnostics' || (s.toolId === 'full_system_snapshot' && Boolean(asObj(s.data)?.gpu)));
  const gpuObj = latestGpuSnap ? asObj(asObj(latestGpuSnap.data)?.gpu) || asObj(latestGpuSnap.data) : null;
  const gpuAdapters = Array.isArray(gpuObj?.adapters) ? gpuObj.adapters : [];
  const latestGpuTemp = series.gpuTemp[series.gpuTemp.length - 1]?.value;
  scoreSubsystem(
    'gpu',
    latestGpuSnap,
    realSnapshots.filter((s) => s.toolId === 'gpu_diagnostics' || Boolean(asObj(s.data)?.gpu)).length,
    ['gpu'],
    gpuAdapters.length > 0
      ? `${gpuAdapters.length} adapter(s)${latestGpuTemp !== undefined ? `, ${latestGpuTemp}°C` : ''}`
      : 'No discrete/integrated GPU details exposed',
  );

  // 5. Battery
  const latestBattSnap = latestBySubsystem((s) => {
    const d = asObj(s.data);
    const pwr = asObj(d?.power) || (s.toolId === 'power_and_peripherals' ? d : null);
    const batt = asObj(pwr?.battery) || asObj(d?.battery);
    return Boolean(batt && (batt.present === true || asNum(batt.levelPercent) !== null || asNum(batt.wearPercent) !== null));
  });
  const latestBattWear = series.batteryWearPct[series.batteryWearPct.length - 1]?.value;
  const battExtras: Array<{ points: number; reason: string }> = [];
  if (latestBattWear !== undefined && latestBattWear >= 15) {
    battExtras.push({ points: Math.min(40, Math.round(latestBattWear * 0.9)), reason: `Measured battery wear ${latestBattWear}%` });
  }
  scoreSubsystem(
    'battery',
    latestBattSnap,
    series.batteryWearPct.length || (latestBattSnap ? 1 : 0),
    ['battery'],
    latestBattWear !== undefined ? `${latestBattWear}% capacity wear` : 'Battery state measured (wear counter OS-dependent)',
    battExtras,
  );

  // 6. Network
  const latestNetSnap = latestBySubsystem(
    (s) => s.toolId === 'network_diagnostics' || s.toolId === 'full_system_snapshot' || s.toolId === 'mobile_device_check',
  );
  const latestDns = series.dnsLatencyMs[series.dnsLatencyMs.length - 1]?.value;
  scoreSubsystem(
    'network',
    latestNetSnap,
    series.dnsLatencyMs.length || (latestNetSnap ? 1 : 0),
    ['network'],
    latestDns !== undefined ? `Latest latency ${round(latestDns, 0)} ms` : 'Network connectivity inspected',
  );

  // 7. Thermal
  const latestThermSnap = latestBySubsystem(
    (s) =>
      s.toolId === 'hardware_stress_probe' ||
      s.toolId === 'cpu_diagnostics' ||
      s.toolId === 'gpu_diagnostics' ||
      s.toolId === 'full_system_snapshot' ||
      (s.toolId === 'mobile_device_check' && Boolean(asObj(s.data)?.socBenchmark)),
  );
  const latestCpuT = series.cpuTemp[series.cpuTemp.length - 1]?.value;
  const latestDrop = series.throttleDropPct[series.throttleDropPct.length - 1]?.value;
  const thermParts: string[] = [];
  if (latestCpuT !== undefined) thermParts.push(`CPU ${latestCpuT}°C`);
  if (latestGpuTemp !== undefined) thermParts.push(`GPU ${latestGpuTemp}°C`);
  if (latestDrop !== undefined) thermParts.push(`Throttle drop ${latestDrop}%`);
  const thermExtras: Array<{ points: number; reason: string }> = [];
  if (latestDrop !== undefined && latestDrop >= 15 && latestDrop < 22) {
    thermExtras.push({ points: 10, reason: `Mild compute throttling drop (${latestDrop}%)` });
  }
  scoreSubsystem(
    'thermal',
    thermParts.length > 0 ? latestThermSnap : null,
    series.cpuTemp.length + series.gpuTemp.length + series.throttleDropPct.length,
    ['thermal'],
    thermParts.join(' • ') || 'No thermal sensor exposed',
    thermExtras,
  );

  // 8. Peripherals
  const latestPeripSnap = latestBySubsystem(
    (s) => s.toolId === 'peripherals_diagnostics' || (s.toolId === 'full_system_snapshot' && Boolean(asObj(s.data)?.peripherals)),
  );
  const peripObj = latestPeripSnap ? asObj(asObj(latestPeripSnap.data)?.peripherals) || asObj(latestPeripSnap.data) : null;
  const peripCounts = asObj(peripObj?.counts);
  const faultCount = asNum(peripCounts?.faultedDevices) ?? 0;
  scoreSubsystem(
    'peripherals',
    latestPeripSnap,
    realSnapshots.filter((s) => s.toolId === 'peripherals_diagnostics' || Boolean(asObj(s.data)?.peripherals)).length,
    ['usb', 'bluetooth', 'audio', 'display', 'camera', 'sensor', 'peripherals'],
    faultCount > 0 ? `${faultCount} PnP device fault(s)` : `${asNum(peripCounts?.usb) ?? 0} USB • ${asNum(peripCounts?.bluetooth) ?? 0} BT • ${asNum(peripCounts?.audio) ?? 0} Audio`,
  );

  // Compute overall health score strictly from subsystems with measured data
  const scored = subsystemScores.filter((s): s is SubsystemHealthScore & { score: number } => s.score !== null);
  const overallHealthScore =
    scored.length > 0 ? Math.round(scored.reduce((acc, s) => acc + s.score, 0) / scored.length) : null;
  const overallStatus = statusFromScore(overallHealthScore);
  const baselineReady = realSnapshots.length >= 4;

  const summaryBullets: string[] = [];
  if (realSnapshots.length === 0) {
    summaryBullets.push('No real measured snapshots recorded yet. Run a Full Scan to establish your hardware health baseline.');
  } else {
    summaryBullets.push(
      `Analyzed ${realSnapshots.length} real measured snapshot(s)${rawSnapshots.length > realSnapshots.length ? ` (${rawSnapshots.length - realSnapshots.length} synthetic fixture(s) excluded from baseline)` : ''}.`,
    );
    if (!baselineReady) {
      summaryBullets.push(
        `Collecting statistical baseline (${realSnapshots.length}/4 scans). Run ${4 - realSnapshots.length} more scan(s) over time to activate MAD Z-score anomaly detection and OLS degradation forecasting.`,
      );
    }
    for (const a of anomalies) summaryBullets.push(`Anomaly [${a.severity.toUpperCase()}]: ${a.explanation}`);
    for (const f of forecasts.filter((fc) => fc.status === 'degrading' || fc.status === 'urgent')) {
      summaryBullets.push(`Forecast [${f.status.toUpperCase()}]: ${f.explanation}`);
    }
    if (anomalies.length === 0 && baselineReady) {
      summaryBullets.push('No statistical telemetry spikes detected relative to your historical baseline.');
    }
  }

  return {
    analyzedAt,
    deviceId,
    totalSnapshotsAnalyzed: rawSnapshots.length,
    realSnapshotsAnalyzed: realSnapshots.length,
    baselineReady,
    overallHealthScore,
    overallStatus,
    methodology:
      'Iglewicz-Hoaglin Modified Z-Score (MAD) anomaly detection (threshold |Z| >= 2.5 warning, >= 3.5 critical) + Ordinary Least Squares (OLS) linear regression RUL forecasting + deterministic subsystem health scoring over real measured snapshots.',
    subsystemScores,
    anomalies,
    forecasts,
    summaryBullets,
  };
}

export function formatHealthAnalysisForCopilot(analysis: SystemHealthAnalysis): string {
  if (analysis.realSnapshotsAnalyzed === 0) return '';
  const lines: string[] = [
    `Predictive Telemetry ML Analysis (${analysis.realSnapshotsAnalyzed} measured snapshots, Overall Health: ${analysis.overallHealthScore ?? 'N/A'}/100 [${analysis.overallStatus}]):`,
  ];
  const activeScores = analysis.subsystemScores.filter((s) => s.score !== null);
  if (activeScores.length > 0) {
    lines.push(
      `- Subsystem Scores: ${activeScores.map((s) => `${s.subsystem}=${s.score}/100 (${s.latestSummary})`).join(', ')}`,
    );
  }
  if (analysis.anomalies.length > 0) {
    lines.push(
      `- Statistical Anomalies Detected:\n${analysis.anomalies.map((a) => `  * [${a.severity.toUpperCase()}] ${a.explanation}`).join('\n')}`,
    );
  }
  const activeForecasts = analysis.forecasts.filter((f) => f.status !== 'insufficient_history');
  if (activeForecasts.length > 0) {
    lines.push(
      `- OLS Degradation Forecasts:\n${activeForecasts.map((f) => `  * [${f.status.toUpperCase()}] ${f.explanation}`).join('\n')}`,
    );
  }
  return lines.join('\n');
}
