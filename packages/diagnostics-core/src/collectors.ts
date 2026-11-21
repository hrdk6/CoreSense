import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  type DiagnosticResult,
  type DiagnosticWarning,
  type Platform,
  type ToolParameters,
  ToolParametersSchema,
  getToolDefinition,
} from '@coresense/shared';

const execFileAsync = promisify(execFile);

export function detectCurrentPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

async function runPowershellJson<T>(script: string, timeoutMs = 8000): Promise<T | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

async function runFixedCommand(
  bin: string,
  args: string[],
  timeoutMs = 6000,
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const res = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return { stdout: res.stdout.trim(), stderr: res.stderr.trim() };
  } catch {
    return null;
  }
}

function normalizeArray<T>(val: T | T[] | null | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

// Measure live CPU load over a short sampling window using Node's native os.cpus()
async function sampleCpuLoadPercent(sampleMs = 250): Promise<{
  totalPercent: number;
  perCorePercent: number[];
}> {
  const start = os.cpus();
  await new Promise((r) => setTimeout(r, sampleMs));
  const end = os.cpus();

  const perCorePercent: number[] = [];
  let totalIdleDelta = 0;
  let totalTickDelta = 0;

  for (let i = 0; i < Math.min(start.length, end.length); i++) {
    const s = start[i].times;
    const e = end[i].times;
    const idleDelta = e.idle - s.idle;
    const totalDelta =
      e.user - s.user + (e.nice - s.nice) + (e.sys - s.sys) + (e.irq - s.irq) + idleDelta;
    totalIdleDelta += idleDelta;
    totalTickDelta += totalDelta;
    const usage = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10 : 0;
    perCorePercent.push(Math.max(0, Math.min(100, usage)));
  }

  const totalPercent =
    totalTickDelta > 0
      ? Math.round(((totalTickDelta - totalIdleDelta) / totalTickDelta) * 1000) / 10
      : 0;

  return { totalPercent: Math.max(0, Math.min(100, totalPercent)), perCorePercent };
}

export async function collectCpuDiagnostics(params: ToolParameters = {}): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const topN = params.topProcessCount ?? 8;
  const cpus = os.cpus();
  const cpuSample = await sampleCpuLoadPercent(250);
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];

  let topProcesses: Array<{ name: string; pid: number; cpuSeconds?: number; workingSetMb?: number }> = [];
  let temperatureCelsius: number | null = null;
  let physicalCores: number | null = null;
  let maxClockMhz: number | null = cpus[0]?.speed ?? null;
  let source = `Node OS API (${platform})`;

  if (platform === 'windows') {
    source = 'Windows CIM/WMI + Node OS API (Read-Only)';
    const winData = await runPowershellJson<{
      cpu?: { Name?: string; NumberOfCores?: number; NumberOfLogicalProcessors?: number; MaxClockSpeed?: number; LoadPercentage?: number };
      procs?: Array<{ ProcessName: string; Id: number; CPU: number | null; WorkingSet64: number }>;
      thermalKelvin?: number | null;
    }>(`
      $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, LoadPercentage
      $procs = Get-Process | Sort-Object CPU -Descending | Select-Object -First ${topN} ProcessName, Id, CPU, WorkingSet64
      $therm = $null
      try {
        $tz = Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1
        if ($tz -and $tz.CurrentTemperature) { $therm = [math]::Round(($tz.CurrentTemperature / 10) - 273.15, 1) }
      } catch { $therm = $null }
      [PSCustomObject]@{ cpu = $cpu; procs = $procs; thermalKelvin = $therm } | ConvertTo-Json -Depth 3 -Compress
    `);

    if (winData) {
      physicalCores = winData.cpu?.NumberOfCores ?? null;
      maxClockMhz = winData.cpu?.MaxClockSpeed ?? maxClockMhz;
      if (typeof winData.thermalKelvin === 'number' && winData.thermalKelvin > 0 && winData.thermalKelvin < 130) {
        temperatureCelsius = winData.thermalKelvin;
      } else {
        limitations.push(
          'CPU package temperature requires kernel/ACPI thermal zone exposure or administrator privileges on this Windows machine.',
        );
      }
      topProcesses = normalizeArray(winData.procs).map((p) => ({
        name: p.ProcessName,
        pid: p.Id,
        cpuSeconds: typeof p.CPU === 'number' ? Math.round(p.CPU * 10) / 10 : 0,
        workingSetMb: Math.round((p.WorkingSet64 || 0) / (1024 * 1024)),
      }));
    } else {
      limitations.push('Windows CIM query timed out or was restricted; falling back to Node OS CPU sampling.');
    }
  } else {
    const psCmd =
      platform === 'macos'
        ? await runFixedCommand('ps', ['-Arcwwwxo', 'pid,pcpu,pmem,comm'])
        : await runFixedCommand('ps', ['-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu']);
    if (psCmd?.stdout) {
      topProcesses = psCmd.stdout
        .split('\n')
        .slice(1, topN + 1)
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return {
            pid: Number(parts[0]) || 0,
            cpuSeconds: Number(parts[1]) || 0,
            name: parts.slice(3).join(' ') || 'unknown',
          };
        });
    }
    limitations.push('Direct CPU die temperature requires platform hardware sensor permissions.');
  }

  if (cpuSample.totalPercent >= 85) {
    warnings.push({
      code: 'HIGH_CPU_LOAD',
      severity: 'critical',
      component: 'cpu',
      title: 'Sustained High CPU Utilization',
      detail: `Measured CPU utilization is ${cpuSample.totalPercent}%, which can cause system freezes, audio stutter, and elevated fan noise.`,
    });
  } else if (cpuSample.totalPercent >= 65) {
    warnings.push({
      code: 'ELEVATED_CPU_LOAD',
      severity: 'warning',
      component: 'cpu',
      title: 'Elevated CPU Utilization',
      detail: `Measured CPU utilization is ${cpuSample.totalPercent}%. Inspect active background workloads.`,
    });
  }

  if (temperatureCelsius !== null && temperatureCelsius >= 88) {
    warnings.push({
      code: 'HIGH_CPU_TEMP',
      severity: 'critical',
      component: 'thermal',
      title: 'High CPU Thermal Reading',
      detail: `Thermal zone reported ${temperatureCelsius}°C. Thermal throttling or dust/paste degradation may be occurring.`,
    });
  }

  const model = cpus[0]?.model?.trim() || 'Unknown Processor';
  return {
    id: crypto.randomUUID(),
    toolId: 'cpu_diagnostics',
    measurementType: 'measured',
    source,
    platform,
    osVersion: `${os.type()} ${os.release()} (${os.arch()})`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `${model} — ${cpuSample.totalPercent}% live load across ${cpus.length} logical threads${temperatureCelsius !== null ? `, ${temperatureCelsius}°C` : ''}.`,
    limitations,
    warnings,
    data: {
      model,
      architecture: os.arch(),
      physicalCores,
      logicalThreads: cpus.length,
      maxClockMhz,
      utilizationPercent: cpuSample.totalPercent,
      perCorePercent: cpuSample.perCorePercent,
      loadAverage: os.loadavg(),
      temperatureCelsius,
      topProcesses,
    },
  };
}

export async function collectMemoryDiagnostics(params: ToolParameters = {}): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const topN = params.topProcessCount ?? 8;
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const utilizationPercent = Math.round((usedBytes / totalBytes) * 1000) / 10;
  const totalGb = Math.round((totalBytes / 1024 ** 3) * 100) / 100;
  const availableGb = Math.round((freeBytes / 1024 ** 3) * 100) / 100;
  const usedGb = Math.round((usedBytes / 1024 ** 3) * 100) / 100;

  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];
  let topProcesses: Array<{ name: string; pid: number; memoryMb: number }> = [];
  let pagefileUsedMb: number | null = null;
  let pagefileTotalMb: number | null = null;
  let source = `Node OS API (${platform})`;

  if (platform === 'windows') {
    source = 'Windows CIM/WMI + Node OS API (Read-Only)';
    const winMem = await runPowershellJson<{
      procs?: Array<{ ProcessName: string; Id: number; WorkingSet64: number }>;
      pagefile?: { CurrentUsage?: number; AllocatedBaseSize?: number };
    }>(`
      $procs = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${topN} ProcessName, Id, WorkingSet64
      $pf = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | Select-Object -First 1 CurrentUsage, AllocatedBaseSize
      [PSCustomObject]@{ procs = $procs; pagefile = $pf } | ConvertTo-Json -Depth 3 -Compress
    `);
    if (winMem) {
      topProcesses = normalizeArray(winMem.procs).map((p) => ({
        name: p.ProcessName,
        pid: p.Id,
        memoryMb: Math.round((p.WorkingSet64 || 0) / (1024 * 1024)),
      }));
      pagefileUsedMb = winMem.pagefile?.CurrentUsage ?? null;
      pagefileTotalMb = winMem.pagefile?.AllocatedBaseSize ?? null;
    }
  } else {
    const psCmd =
      platform === 'macos'
        ? await runFixedCommand('ps', ['-Amcwwwxo', 'pid,rss,comm'])
        : await runFixedCommand('ps', ['-eo', 'pid,rss,comm', '--sort=-rss']);
    if (psCmd?.stdout) {
      topProcesses = psCmd.stdout
        .split('\n')
        .slice(1, topN + 1)
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return {
            pid: Number(parts[0]) || 0,
            memoryMb: Math.round((Number(parts[1]) || 0) / 1024),
            name: parts.slice(2).join(' ') || 'unknown',
          };
        });
    }
  }

  let pressure: 'normal' | 'elevated' | 'high' | 'critical' = 'normal';
  if (utilizationPercent >= 90) {
    pressure = 'critical';
    warnings.push({
      code: 'CRITICAL_MEMORY_PRESSURE',
      severity: 'critical',
      component: 'memory',
      title: 'Critical RAM Pressure',
      detail: `${utilizationPercent}% of RAM (${usedGb} GB / ${totalGb} GB) is in use. Heavy disk paging can make the system feel frozen.`,
    });
  } else if (utilizationPercent >= 80) {
    pressure = 'high';
    warnings.push({
      code: 'HIGH_MEMORY_USAGE',
      severity: 'warning',
      component: 'memory',
      title: 'High RAM Utilization',
      detail: `${utilizationPercent}% of RAM (${usedGb} GB / ${totalGb} GB) is currently allocated.`,
    });
  } else if (utilizationPercent >= 70) {
    pressure = 'elevated';
  }

  return {
    id: crypto.randomUUID(),
    toolId: 'memory_diagnostics',
    measurementType: 'measured',
    source,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `${usedGb} GB / ${totalGb} GB RAM used (${utilizationPercent}%, pressure: ${pressure}).`,
    limitations,
    warnings,
    data: {
      totalGb,
      usedGb,
      availableGb,
      utilizationPercent,
      pressure,
      pagefileUsedMb,
      pagefileTotalMb,
      topProcesses,
    },
  };
}

export async function collectStorageDiagnostics(): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];
  let volumes: Array<{
    mount: string;
    label: string;
    fileSystem: string;
    totalGb: number;
    freeGb: number;
    usedPercent: number;
  }> = [];
  let physicalDisks: Array<{
    model: string;
    mediaType: string;
    busType: string;
    sizeGb: number;
    healthStatus: string;
    operationalStatus: string;
    wearPercent?: number | null;
    temperatureC?: number | null;
  }> = [];
  let source = `OS Storage API (${platform})`;

  if (platform === 'windows') {
    source = 'Windows Storage CIM / MSFT_PhysicalDisk (Read-Only)';
    const winStorage = await runPowershellJson<{
      vols?: Array<{
        DeviceID: string;
        VolumeName: string | null;
        FileSystem: string | null;
        Size: number | null;
        FreeSpace: number | null;
      }>;
      disks?: Array<{
        FriendlyName: string;
        MediaType: string;
        BusType: string;
        Size: number;
        HealthStatus: string;
        OperationalStatus: string;
        Wear?: number | null;
        Temperature?: number | null;
      }>;
    }>(`
      $vols = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace
      $disks = @()
      try {
        $pds = Get-PhysicalDisk -ErrorAction Stop
        foreach ($d in $pds) {
          $rel = $null
          try { $rel = Get-StorageReliabilityCounter -PhysicalDisk $d -ErrorAction SilentlyContinue } catch {}
          $disks += [PSCustomObject]@{
            FriendlyName = $d.FriendlyName
            MediaType = [string]$d.MediaType
            BusType = [string]$d.BusType
            Size = $d.Size
            HealthStatus = [string]$d.HealthStatus
            OperationalStatus = [string]$d.OperationalStatus
            Wear = if ($rel) { $rel.Wear } else { $null }
            Temperature = if ($rel) { $rel.Temperature } else { $null }
          }
        }
      } catch {
        $wmiDisks = Get-CimInstance Win32_DiskDrive | Select-Object Model, MediaType, InterfaceType, Size, Status
        foreach ($d in $wmiDisks) {
          $disks += [PSCustomObject]@{
            FriendlyName = $d.Model
            MediaType = [string]$d.MediaType
            BusType = [string]$d.InterfaceType
            Size = $d.Size
            HealthStatus = [string]$d.Status
            OperationalStatus = [string]$d.Status
            Wear = $null
            Temperature = $null
          }
        }
      }
      [PSCustomObject]@{ vols = $vols; disks = $disks } | ConvertTo-Json -Depth 4 -Compress
    `, 10000);

    if (winStorage) {
      volumes = normalizeArray(winStorage.vols)
        .filter((v) => (v.Size ?? 0) > 0)
        .map((v) => {
          const totalGb = Math.round(((v.Size || 0) / 1024 ** 3) * 10) / 10;
          const freeGb = Math.round(((v.FreeSpace || 0) / 1024 ** 3) * 10) / 10;
          const usedPercent = totalGb > 0 ? Math.round(((totalGb - freeGb) / totalGb) * 1000) / 10 : 0;
          return {
            mount: v.DeviceID,
            label: v.VolumeName || 'Local Disk',
            fileSystem: v.FileSystem || 'Unknown',
            totalGb,
            freeGb,
            usedPercent,
          };
        });
      physicalDisks = normalizeArray(winStorage.disks).map((d) => ({
        model: d.FriendlyName || 'Unknown Drive',
        mediaType: d.MediaType || 'Unknown',
        busType: d.BusType || 'Unknown',
        sizeGb: Math.round(((d.Size || 0) / 1024 ** 3) * 10) / 10,
        healthStatus: d.HealthStatus || 'Unknown',
        operationalStatus: d.OperationalStatus || 'Unknown',
        wearPercent: typeof d.Wear === 'number' ? d.Wear : null,
        temperatureC: typeof d.Temperature === 'number' && d.Temperature > 0 ? d.Temperature : null,
      }));
      if (physicalDisks.every((d) => d.wearPercent === null)) {
        limitations.push(
          'Detailed NVMe/SMART wear & thermal counters require Administrator privileges on Windows; basic drive health status was still collected.',
        );
      }
    }
  } else {
    const dfRes = await runFixedCommand('df', ['-Pk']);
    if (dfRes?.stdout) {
      volumes = dfRes.stdout
        .split('\n')
        .slice(1)
        .filter((l) => l.startsWith('/'))
        .map((line) => {
          const p = line.trim().split(/\s+/);
          const totalGb = Math.round(((Number(p[1]) || 0) / (1024 * 1024)) * 10) / 10;
          const freeGb = Math.round(((Number(p[3]) || 0) / (1024 * 1024)) * 10) / 10;
          const usedPercent = totalGb > 0 ? Math.round(((totalGb - freeGb) / totalGb) * 1000) / 10 : 0;
          return {
            mount: p[5] || p[0],
            label: p[0],
            fileSystem: 'POSIX',
            totalGb,
            freeGb,
            usedPercent,
          };
        });
    }
    limitations.push('Full SMART attribute inspection requires smartctl / elevated disk permissions.');
  }

  for (const v of volumes) {
    if (v.usedPercent >= 92 || v.freeGb < 10) {
      warnings.push({
        code: 'LOW_DISK_SPACE',
        severity: v.usedPercent >= 96 || v.freeGb < 5 ? 'critical' : 'warning',
        component: 'storage',
        title: `Low Free Space on ${v.mount}`,
        detail: `${v.mount} (${v.label}) is ${v.usedPercent}% full with only ${v.freeGb} GB free. Low free space degrades SSD wear leveling, virtual memory paging, and OS updates.`,
      });
    }
  }

  for (const d of physicalDisks) {
    const h = d.healthStatus.toLowerCase();
    if (h !== 'healthy' && h !== 'ok' && h !== 'unknown') {
      warnings.push({
        code: 'SMART_HEALTH_WARNING',
        severity: 'critical',
        component: 'storage',
        title: `Drive Health Alert: ${d.model}`,
        detail: `OS reported storage health status "${d.healthStatus}". Back up critical files immediately before running intensive disk scans.`,
      });
    }
    if (d.wearPercent !== null && d.wearPercent !== undefined && d.wearPercent >= 85) {
      warnings.push({
        code: 'SSD_HIGH_WEAR',
        severity: 'warning',
        component: 'storage',
        title: `High SSD Wear Level on ${d.model}`,
        detail: `Drive wear indicator is at ${d.wearPercent}%. Plan backup and proactive replacement.`,
      });
    }
  }

  return {
    id: crypto.randomUUID(),
    toolId: 'storage_diagnostics',
    measurementType: 'measured',
    source,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `Detected ${volumes.length} volume(s) and ${physicalDisks.length} physical disk(s). ${warnings.length ? `${warnings.length} storage alert(s) found.` : 'All checked volumes within healthy thresholds.'}`,
    limitations,
    warnings,
    data: { volumes, physicalDisks },
  };
}

async function probeTcpLatency(host: string, port: number, timeoutMs = 2500): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.on('connect', () => {
      const elapsed = Date.now() - start;
      socket.destroy();
      resolve(elapsed);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

export async function collectNetworkDiagnostics(params: ToolParameters = {}): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const testHost = params.testHost || 'cloudflare.com';
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];

  const rawIfaces = os.networkInterfaces();
  const interfaces: Array<{
    name: string;
    ipv4?: string;
    ipv6?: string;
    mac?: string;
    internal: boolean;
  }> = [];

  for (const [name, addrs] of Object.entries(rawIfaces)) {
    if (!addrs) continue;
    const v4 = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    const v6 = addrs.find((a) => a.family === 'IPv6' && !a.internal);
    if (v4 || v6) {
      interfaces.push({
        name,
        ipv4: v4?.address,
        ipv6: v6?.address,
        mac: v4?.mac || v6?.mac,
        internal: false,
      });
    }
  }

  let dnsResolvedIps: string[] = [];
  let dnsLatencyMs: number | null = null;
  let dnsError: string | null = null;
  try {
    const dnsStart = Date.now();
    dnsResolvedIps = await dns.resolve4(testHost);
    dnsLatencyMs = Date.now() - dnsStart;
  } catch (err) {
    dnsError = err instanceof Error ? err.message : 'DNS resolution failed';
  }

  const directIpLatencyMs = await probeTcpLatency('1.1.1.1', 443, 2500);
  const hostLatencyMs = dnsResolvedIps[0] ? await probeTcpLatency(dnsResolvedIps[0], 443, 2500) : null;

  let wifiInfo: Record<string, string> | null = null;
  let gatewayAndDns: { gateways: string[]; dnsServers: string[] } = { gateways: [], dnsServers: [] };
  let source = `Node Network/DNS API (${platform})`;

  if (platform === 'windows') {
    source = 'Windows NetIP/WLAN + Node DNS/TCP Probe (Read-Only)';
    const netWin = await runPowershellJson<{
      gateways?: string[];
      dnsServers?: string[];
    }>(`
      $gw = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty NextHop -Unique)
      $dns = (Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ServerAddresses -Unique)
      [PSCustomObject]@{ gateways = @($gw); dnsServers = @($dns) } | ConvertTo-Json -Depth 3 -Compress
    `);
    if (netWin) {
      gatewayAndDns = {
        gateways: normalizeArray(netWin.gateways).filter(Boolean),
        dnsServers: normalizeArray(netWin.dnsServers).filter(Boolean),
      };
    }

    const wlan = await runFixedCommand('netsh', ['wlan', 'show', 'interfaces']);
    if (wlan?.stdout && !wlan.stdout.includes('no wireless interface')) {
      const parsed: Record<string, string> = {};
      for (const line of wlan.stdout.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (['Name', 'State', 'SSID', 'Radio type', 'Signal', 'Receive rate (Mbps)', 'Transmit rate (Mbps)'].includes(k)) {
            parsed[k] = v;
          }
        }
      }
      if (Object.keys(parsed).length > 0) wifiInfo = parsed;
    } else {
      limitations.push('No active Wi-Fi interface reported or location/WLAN service restricted.');
    }
  }

  if (interfaces.length === 0) {
    warnings.push({
      code: 'NO_ACTIVE_INTERFACE',
      severity: 'critical',
      component: 'network',
      title: 'No Active External Network Interface',
      detail: 'No non-loopback IPv4/IPv6 network adapters are currently assigned an address.',
    });
  } else if (directIpLatencyMs !== null && dnsError) {
    warnings.push({
      code: 'DNS_RESOLUTION_FAILURE',
      severity: 'critical',
      component: 'network',
      title: 'DNS Resolution Failed While Raw IP Connectivity Works',
      detail: `Direct TCP reachability to 1.1.1.1 succeeded (${directIpLatencyMs}ms), but DNS lookup for ${testHost} failed (${dnsError}). This strongly isolates the issue to DNS configuration rather than physical link hardware.`,
    });
  } else if (directIpLatencyMs === null && dnsError) {
    warnings.push({
      code: 'INTERNET_UNREACHABLE',
      severity: 'critical',
      component: 'network',
      title: 'External Network Unreachable',
      detail: `Neither direct IP (1.1.1.1:443) nor DNS (${testHost}) could be reached.`,
    });
  } else if ((hostLatencyMs ?? directIpLatencyMs ?? 0) > 250) {
    warnings.push({
      code: 'HIGH_NETWORK_LATENCY',
      severity: 'warning',
      component: 'network',
      title: 'Elevated Network Latency',
      detail: `TCP reachability took ${hostLatencyMs ?? directIpLatencyMs}ms, which may cause slow page loads or dropped calls.`,
    });
  }

  return {
    id: crypto.randomUUID(),
    toolId: 'network_diagnostics',
    measurementType: 'measured',
    source,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `${interfaces.length} active adapter(s); DNS(${testHost}): ${dnsError ? 'FAILED' : `${dnsLatencyMs}ms`}; Direct IP(1.1.1.1): ${directIpLatencyMs !== null ? `${directIpLatencyMs}ms` : 'UNREACHABLE'}.`,
    limitations,
    warnings,
    data: {
      interfaces,
      gateways: gatewayAndDns.gateways,
      dnsServers: gatewayAndDns.dnsServers,
      wifi: wifiInfo,
      connectivity: {
        testHost,
        dnsResolved: !dnsError,
        dnsResolvedIps,
        dnsLatencyMs,
        dnsError,
        directIpReachable: directIpLatencyMs !== null,
        directIpLatencyMs,
        hostLatencyMs,
      },
    },
  };
}

export async function collectOsHealthDiagnostics(params: ToolParameters = {}): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const maxEvents = params.maxEvents ?? 12;
  const uptimeHours = Math.round((os.uptime() / 3600) * 10) / 10;
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];

  let hardware: Record<string, string | null> = {
    hostname: os.hostname(),
    manufacturer: null,
    model: null,
    biosVersion: null,
    osCaption: `${os.type()} ${os.release()}`,
  };
  let recentErrors: Array<{ logName: string; provider: string; id: number; level: string; time: string; message: string }> = [];
  let startupCount: number | null = null;
  let source = `Node OS API (${platform})`;

  if (platform === 'windows') {
    source = 'Windows CIM + Event Log Reader (Read-Only)';
    const winOs = await runPowershellJson<{
      cs?: { Manufacturer?: string; Model?: string };
      bios?: { SMBIOSBIOSVersion?: string };
      osInfo?: { Caption?: string; Version?: string; BuildNumber?: string };
      events?: Array<{ LogName: string; ProviderName: string; Id: number; LevelDisplayName: string; TimeCreated: string; Message: string }>;
      startupCount?: number;
    }>(`
      $cs = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model
      $bios = Get-CimInstance Win32_BIOS | Select-Object SMBIOSBIOSVersion
      $osInfo = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
      $startup = @(Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue).Count
      $ev = @()
      try {
        $rawEv = Get-WinEvent -FilterHashtable @{ LogName='Application','System'; Level=1,2 } -MaxEvents ${maxEvents} -ErrorAction SilentlyContinue
        foreach ($e in $rawEv) {
          $msg = if ($e.Message) { ($e.Message -replace '\r?\n', ' ').Substring(0, [Math]::Min(220, ($e.Message -replace '\r?\n', ' ').Length)) } else { '' }
          $ev += [PSCustomObject]@{
            LogName = $e.LogName
            ProviderName = $e.ProviderName
            Id = $e.Id
            LevelDisplayName = $e.LevelDisplayName
            TimeCreated = $e.TimeCreated.ToString('o')
            Message = $msg
          }
        }
      } catch {}
      [PSCustomObject]@{ cs = $cs; bios = $bios; osInfo = $osInfo; events = $ev; startupCount = $startup } | ConvertTo-Json -Depth 4 -Compress
    `, 10000);

    if (winOs) {
      hardware = {
        hostname: os.hostname(),
        manufacturer: winOs.cs?.Manufacturer ?? null,
        model: winOs.cs?.Model ?? null,
        biosVersion: winOs.bios?.SMBIOSBIOSVersion ?? null,
        osCaption: winOs.osInfo?.Caption
          ? `${winOs.osInfo.Caption} (Build ${winOs.osInfo.BuildNumber || ''})`
          : hardware.osCaption,
      };
      startupCount = typeof winOs.startupCount === 'number' ? winOs.startupCount : null;
      recentErrors = normalizeArray(winOs.events).map((e) => ({
        logName: e.LogName,
        provider: e.ProviderName,
        id: e.Id,
        level: e.LevelDisplayName || 'Error',
        time: e.TimeCreated,
        message: e.Message,
      }));
    }
  } else {
    limitations.push('System error log inspection on macOS/Linux may require elevated log-read permissions.');
  }

  const criticalCount = recentErrors.filter((e) => e.level.toLowerCase().includes('critical') || e.id === 41).length;
  if (criticalCount > 0) {
    warnings.push({
      code: 'CRITICAL_OS_EVENTS',
      severity: 'critical',
      component: 'os',
      title: `${criticalCount} Critical System Event(s) Detected`,
      detail: 'Recent critical system events (such as unexpected Kernel-Power shutdowns or crash stops) were found in the OS event log.',
    });
  }
  if (uptimeHours > 240) {
    warnings.push({
      code: 'LONG_UPTIME',
      severity: 'info',
      component: 'os',
      title: 'Extended System Uptime',
      detail: `System has been running for ${uptimeHours} hours without a full reboot, which can accumulate driver or memory fragmentation.`,
    });
  }

  return {
    id: crypto.randomUUID(),
    toolId: 'os_health_diagnostics',
    measurementType: 'measured',
    source,
    platform,
    osVersion: hardware.osCaption || `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `${hardware.osCaption || os.type()} — Uptime ${uptimeHours}h, ${recentErrors.length} recent error/critical event(s)${startupCount !== null ? `, ${startupCount} startup items` : ''}.`,
    limitations,
    warnings,
    data: {
      hardware,
      uptimeHours,
      startupCount,
      recentErrors,
    },
  };
}

export async function collectPowerAndPeripherals(): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];

  let battery: {
    present: boolean;
    chargePercent: number | null;
    status: string;
    designCapacityMwh: number | null;
    fullChargeCapacityMwh: number | null;
    wearPercent: number | null;
    cycleCount: number | null;
  } = {
    present: false,
    chargePercent: null,
    status: 'Not detected (Desktop or unsupported)',
    designCapacityMwh: null,
    fullChargeCapacityMwh: null,
    wearPercent: null,
    cycleCount: null,
  };
  let displays: Array<{ name: string; resolution: string; refreshHz?: number | null }> = [];
  let audioDevices: string[] = [];
  let source = `OS Power/Peripheral API (${platform})`;

  if (platform === 'windows') {
    source = 'Windows CIM Battery/Display/Audio (Read-Only)';
    const winPwr = await runPowershellJson<{
      batt?: { EstimatedChargeRemaining?: number; BatteryStatus?: number; Name?: string };
      battStatic?: { DesignedCapacity?: number };
      battFull?: { FullChargedCapacity?: number };
      battCycle?: { CycleCount?: number };
      gpus?: Array<{ Name: string; CurrentHorizontalResolution: number | null; CurrentVerticalResolution: number | null; CurrentRefreshRate: number | null }>;
      audio?: Array<{ Name: string; Status: string }>;
    }>(`
      $batt = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1 EstimatedChargeRemaining, BatteryStatus, Name
      $bStatic = $null; $bFull = $null; $bCycle = $null
      try { $bStatic = Get-CimInstance -Namespace root/WMI -ClassName BatteryStaticData -ErrorAction Stop | Select-Object -First 1 DesignedCapacity } catch {}
      try { $bFull = Get-CimInstance -Namespace root/WMI -ClassName BatteryFullChargedCapacity -ErrorAction Stop | Select-Object -First 1 FullChargedCapacity } catch {}
      try { $bCycle = Get-CimInstance -Namespace root/WMI -ClassName BatteryCycleCount -ErrorAction Stop | Select-Object -First 1 CycleCount } catch {}
      $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object Name, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate
      $audio = Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Select-Object Name, Status
      [PSCustomObject]@{ batt = $batt; battStatic = $bStatic; battFull = $bFull; battCycle = $bCycle; gpus = $gpus; audio = $audio } | ConvertTo-Json -Depth 4 -Compress
    `, 9000);

    if (winPwr) {
      if (winPwr.batt) {
        const statusMap: Record<number, string> = {
          1: 'Discharging',
          2: 'AC Connected / Charging',
          3: 'Fully Charged',
          4: 'Low',
          5: 'Critical',
          6: 'Charging',
          7: 'Charging & High',
          8: 'Charging & Low',
          9: 'Charging & Critical',
        };
        const design = winPwr.battStatic?.DesignedCapacity ?? null;
        const full = winPwr.battFull?.FullChargedCapacity ?? null;
        const wear =
          design && full && design > 0
            ? Math.max(0, Math.min(100, Math.round((1 - full / design) * 1000) / 10))
            : null;
        battery = {
          present: true,
          chargePercent: winPwr.batt.EstimatedChargeRemaining ?? null,
          status: statusMap[winPwr.batt.BatteryStatus ?? 0] || 'Present',
          designCapacityMwh: design,
          fullChargeCapacityMwh: full,
          wearPercent: wear,
          cycleCount: winPwr.battCycle?.CycleCount ?? null,
        };
        if (wear === null) {
          limitations.push('Battery design vs full-charge capacity (wear %) requires ACPI WMI battery telemetry support.');
        }
        if (wear !== null && wear >= 30) {
          warnings.push({
            code: 'BATTERY_DEGRADATION',
            severity: wear >= 45 ? 'critical' : 'warning',
            component: 'battery',
            title: 'Battery Capacity Degradation Detected',
            detail: `Battery has lost approximately ${wear}% of its original design capacity (${full} vs ${design} mWh).`,
          });
        }
      }
      displays = normalizeArray(winPwr.gpus).map((g) => ({
        name: g.Name,
        resolution:
          g.CurrentHorizontalResolution && g.CurrentVerticalResolution
            ? `${g.CurrentHorizontalResolution}x${g.CurrentVerticalResolution}`
            : 'Inactive / Secondary',
        refreshHz: g.CurrentRefreshRate ?? null,
      }));
      audioDevices = normalizeArray(winPwr.audio).map((a) => `${a.Name} (${a.Status})`);
    }
  } else {
    limitations.push('Hardware battery wear & GPU peripheral enumeration varies by OS permission policy.');
  }

  return {
    id: crypto.randomUUID(),
    toolId: 'power_and_peripherals',
    measurementType: 'measured',
    source,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: battery.present
      ? `Battery ${battery.chargePercent ?? '?'}% (${battery.status})${battery.wearPercent !== null ? `, ${battery.wearPercent}% wear` : ''}; ${displays.length} display adapter(s).`
      : `AC/Desktop system (no internal battery detected); ${displays.length} display adapter(s), ${audioDevices.length} audio device(s).`,
    limitations,
    warnings,
    data: { battery, displays, audioDevices },
  };
}

export async function runFullSystemSnapshot(): Promise<DiagnosticResult> {
  const started = Date.now();
  const [cpu, memory, storage, network, osHealth, power] = await Promise.all([
    collectCpuDiagnostics(),
    collectMemoryDiagnostics(),
    collectStorageDiagnostics(),
    collectNetworkDiagnostics(),
    collectOsHealthDiagnostics(),
    collectPowerAndPeripherals(),
  ]);

  const warnings = [
    ...cpu.warnings,
    ...memory.warnings,
    ...storage.warnings,
    ...network.warnings,
    ...osHealth.warnings,
    ...power.warnings,
  ];
  const limitations = Array.from(
    new Set([
      ...cpu.limitations,
      ...memory.limitations,
      ...storage.limitations,
      ...network.limitations,
      ...osHealth.limitations,
      ...power.limitations,
    ]),
  );

  return {
    id: crypto.randomUUID(),
    toolId: 'full_system_snapshot',
    measurementType: 'measured',
    source: `CoreSense Composite Host Collector (${detectCurrentPlatform()})`,
    platform: detectCurrentPlatform(),
    osVersion: osHealth.osVersion,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `Full system diagnostic completed: CPU ${String(cpu.data.utilizationPercent)}%, RAM ${String(memory.data.utilizationPercent)}%, ${warnings.length} alert(s) identified.`,
    limitations,
    warnings,
    data: {
      cpu: cpu.data,
      memory: memory.data,
      storage: storage.data,
      network: network.data,
      osHealth: osHealth.data,
      power: power.data,
    },
  };
}

async function executeFlushDnsCache(): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  let output = '';
  let ok = false;

  if (platform === 'windows') {
    const res = await runFixedCommand('ipconfig', ['/flushdns']);
    ok = Boolean(res);
    output = res?.stdout || 'DNS flush failed or lacked permission.';
  } else if (platform === 'macos') {
    const res = await runFixedCommand('dscacheutil', ['-flushcache']);
    ok = Boolean(res);
    output = res?.stdout || 'Flushed macOS directory service cache.';
  } else {
    const res = await runFixedCommand('resolvectl', ['flush-caches']);
    ok = Boolean(res);
    output = res?.stdout || 'Attempted systemd-resolved cache flush.';
  }

  return {
    id: crypto.randomUUID(),
    toolId: 'flush_dns_cache',
    measurementType: 'measured',
    source: `Validated Remediation Tool (${platform})`,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: ok ? 'Local DNS resolver cache flushed successfully.' : 'DNS cache flush could not complete on this host.',
    limitations: ok ? [] : ['Elevated system privileges may be required to clear the system DNS cache.'],
    warnings: [],
    data: { success: ok, output },
  };
}

// ============================================================================
// Validated Diagnostic Tool Dispatcher (ONLY entry point for tool execution)
// ============================================================================
export async function executeValidatedDiagnosticTool(
  toolId: string,
  rawParams: Record<string, unknown> = {},
  options: { explicitUserApproval?: boolean } = {},
): Promise<DiagnosticResult> {
  const def = getToolDefinition(toolId);
  if (!def) {
    throw new Error(`SECURITY_BLOCK: Tool "${toolId}" is not registered in the CoreSense Diagnostic Tool Registry.`);
  }

  const parsedParams = ToolParametersSchema.parse(rawParams);

  if (def.requiresExplicitApproval && !options.explicitUserApproval) {
    throw new Error(
      `APPROVAL_REQUIRED: Tool "${toolId}" (${def.riskLevel}) modifies system state and requires explicit user approval before execution.`,
    );
  }

  switch (toolId) {
    case 'cpu_diagnostics':
      return collectCpuDiagnostics(parsedParams);
    case 'memory_diagnostics':
      return collectMemoryDiagnostics(parsedParams);
    case 'storage_diagnostics':
      return collectStorageDiagnostics();
    case 'network_diagnostics':
      return collectNetworkDiagnostics(parsedParams);
    case 'os_health_diagnostics':
      return collectOsHealthDiagnostics(parsedParams);
    case 'power_and_peripherals':
      return collectPowerAndPeripherals();
    case 'full_system_snapshot':
      return runFullSystemSnapshot();
    case 'flush_dns_cache':
      return executeFlushDnsCache();
    default:
      throw new Error(`UNSUPPORTED_HOST_TOOL: Tool "${toolId}" must run on its target client platform.`);
  }
}
