import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
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

const WINDOWS_PNP_ERROR_DESCRIPTIONS: Record<number, string> = {
  1: 'Code 1: Device is not configured correctly (driver install or update needed).',
  10: 'Code 10: Device cannot start (driver/firmware initialization failure or hardware fault).',
  12: 'Code 12: Cannot find enough free system resources (IRQ/PCIe/BIOS allocation conflict).',
  18: 'Code 18: Reinstall the drivers for this device.',
  19: 'Code 19: Registry configuration is incomplete or damaged.',
  22: 'Code 22: Device is manually disabled in Device Manager.',
  28: 'Code 28: Drivers for this device are not installed.',
  31: 'Code 31: Device is not working properly because Windows cannot load required drivers.',
  37: 'Code 37: Driver failed to initialize its hardware driver entry point.',
  39: 'Code 39: Driver may be corrupted or missing.',
  43: 'Code 43: Windows stopped this device because it reported hardware/driver problems (common on GPU VRAM/driver faults or failing USB controllers).',
  45: 'Code 45: Device is currently not connected to the computer.',
  47: 'Code 47: Device has been prepared for safe removal.',
  56: 'Code 56: Windows is still configuring class settings for this device (often seen on VPN/virtual WAN miniport drivers).',
};

function parsePsDate(val: unknown): string | null {
  if (!val) return null;
  const s = String(val);
  const m = s.match(/\/Date\((\d+)\)\//);
  if (m) {
    const dt = new Date(Number(m[1]));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  const dt = new Date(s);
  return !Number.isNaN(dt.getTime()) ? dt.toISOString().slice(0, 10) : null;
}

function describePnpError(code: number | null | undefined): string {
  if (!code || code === 0) return 'OK';
  return WINDOWS_PNP_ERROR_DESCRIPTIONS[code] ?? `Code ${code}: OS reported a Plug-and-Play device error.`;
}

function normalizePnpDeviceId(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

export async function collectGpuDiagnostics(): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];
  let source = `OS Graphics Collector (${platform})`;

  const adapters: Array<{
    name: string;
    vendor: string;
    driverVersion: string | null;
    driverDate: string | null;
    vramMb: number | null;
    vramUsedMb: number | null;
    utilizationPercent: number | null;
    temperatureCelsius: number | null;
    powerDrawWatts: number | null;
    clockMhz: number | null;
    resolution: string | null;
    refreshHz: number | null;
    status: string;
    errorCode: number | null;
    errorDescription: string | null;
    telemetrySource: string;
  }> = [];

  // Live NVIDIA telemetry via nvidia-smi when installed (strictly read-only fixed args)
  const nvidiaMetrics = new Map<
    string,
    {
      name: string;
      tempC: number | null;
      utilPct: number | null;
      memUsedMb: number | null;
      memTotalMb: number | null;
      powerW: number | null;
      clockMhz: number | null;
      driver: string | null;
    }
  >();

  const smi = await runFixedCommand(
    'nvidia-smi',
    [
      '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.current.graphics,driver_version',
      '--format=csv,noheader,nounits',
    ],
    4500,
  );
  if (smi?.stdout) {
    for (const line of smi.stdout.split(/\r?\n/).filter(Boolean)) {
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length >= 8) {
        const toNum = (v: string): number | null => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
        };
        const name = parts[0];
        nvidiaMetrics.set(name.toLowerCase(), {
          name,
          tempC: toNum(parts[1]),
          utilPct: toNum(parts[2]),
          memUsedMb: toNum(parts[3]),
          memTotalMb: toNum(parts[4]),
          powerW: toNum(parts[5]),
          clockMhz: toNum(parts[6]),
          driver: parts[7] || null,
        });
      }
    }
  }

  if (platform === 'windows') {
    source = nvidiaMetrics.size > 0 ? 'Windows CIM Win32_VideoController + nvidia-smi (Read-Only)' : 'Windows CIM Win32_VideoController (Read-Only)';
    const winGpuPayload = await runPowershellJson<{
      gpus?: Array<{
        Name?: string;
        AdapterCompatibility?: string;
        DriverVersion?: string;
        DriverDate?: string;
        AdapterRAM?: number;
        Status?: string;
        ConfigManagerErrorCode?: number;
        CurrentHorizontalResolution?: number;
        CurrentVerticalResolution?: number;
        CurrentRefreshRate?: number;
      }>;
      regVram?: Array<{ Desc?: string; QwMem?: number }>;
    }>(`
      $gpus = Get-CimInstance Win32_VideoController | Select-Object Name, AdapterCompatibility, DriverVersion, DriverDate, AdapterRAM, Status, ConfigManagerErrorCode, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate
      $regVram = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Where-Object { $_.'HardwareInformation.qwMemorySize' -gt 0 } | ForEach-Object { @{ Desc = $_.DriverDesc; QwMem = $_.'HardwareInformation.qwMemorySize' } }
      @{ gpus = $gpus; regVram = $regVram } | ConvertTo-Json -Depth 4
    `);

    const regVramList = normalizeArray(winGpuPayload?.regVram);
    for (const g of normalizeArray(winGpuPayload?.gpus)) {
      const name = String(g.Name || 'Graphics Adapter');
      const nv =
        nvidiaMetrics.get(name.toLowerCase()) ||
        Array.from(nvidiaMetrics.values()).find((m) => name.toLowerCase().includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(name.toLowerCase()));
      const regMatch = regVramList.find((r) => r.Desc && (name.toLowerCase().includes(r.Desc.toLowerCase()) || r.Desc.toLowerCase().includes(name.toLowerCase())));
      const errCode = typeof g.ConfigManagerErrorCode === 'number' ? g.ConfigManagerErrorCode : 0;
      // Prefer nvidia-smi -> 64-bit Registry qwMemorySize -> legacy 32-bit WMI AdapterRAM
      const regVramMb = regMatch?.QwMem && regMatch.QwMem > 0 ? Math.round(regMatch.QwMem / (1024 * 1024)) : null;
      const wmiVramMb = g.AdapterRAM && g.AdapterRAM > 0 ? Math.round(g.AdapterRAM / (1024 * 1024)) : null;
      const vramMb = nv?.memTotalMb ?? regVramMb ?? wmiVramMb;
      const resolution =
        g.CurrentHorizontalResolution && g.CurrentVerticalResolution
          ? `${g.CurrentHorizontalResolution}x${g.CurrentVerticalResolution}`
          : null;

      adapters.push({
        name,
        vendor: String(g.AdapterCompatibility || (nv ? 'NVIDIA' : 'Unknown')),
        driverVersion: nv?.driver ?? g.DriverVersion ?? null,
        driverDate: parsePsDate(g.DriverDate),
        vramMb,
        vramUsedMb: nv?.memUsedMb ?? null,
        utilizationPercent: nv?.utilPct ?? null,
        temperatureCelsius: nv?.tempC ?? null,
        powerDrawWatts: nv?.powerW ?? null,
        clockMhz: nv?.clockMhz ?? null,
        resolution,
        refreshHz: g.CurrentRefreshRate ?? null,
        status: errCode === 0 ? String(g.Status || 'OK') : 'Error',
        errorCode: errCode !== 0 ? errCode : null,
        errorDescription: errCode !== 0 ? describePnpError(errCode) : null,
        telemetrySource: nv ? 'Win32_VideoController + nvidia-smi' : 'Win32_VideoController',
      });
    }
  } else if (platform === 'macos') {
    source = 'macOS system_profiler SPDisplaysDataType (Read-Only)';
    const res = await runFixedCommand('system_profiler', ['SPDisplaysDataType', '-json'], 6000);
    if (res?.stdout) {
      try {
        const parsed = JSON.parse(res.stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
        for (const g of parsed.SPDisplaysDataType ?? []) {
          const vramRaw = String(g.spdisplays_vram ?? g.spdisplays_vram_shared ?? '');
          const vramMatch = vramRaw.match(/(\d+)\s*(GB|MB)/i);
          const vramMb = vramMatch
            ? Number(vramMatch[1]) * (vramMatch[2].toUpperCase() === 'GB' ? 1024 : 1)
            : null;
          const displays = Array.isArray(g.spdisplays_ndrvs) ? (g.spdisplays_ndrvs as Array<Record<string, unknown>>) : [];
          const firstDisp = displays[0];
          adapters.push({
            name: String(g.sppci_model ?? g._name ?? 'Apple / Mac GPU'),
            vendor: String(g.spdisplays_vendor ?? 'Apple'),
            driverVersion: String(g.spdisplays_mtlgpufamilysupport ?? g.spdisplays_metal ?? 'Metal'),
            driverDate: null,
            vramMb,
            vramUsedMb: null,
            utilizationPercent: null,
            temperatureCelsius: null,
            powerDrawWatts: null,
            clockMhz: null,
            resolution: firstDisp?._spdisplays_resolution ? String(firstDisp._spdisplays_resolution) : null,
            refreshHz: null,
            status: 'OK',
            errorCode: null,
            errorDescription: null,
            telemetrySource: 'system_profiler',
          });
        }
      } catch {
        limitations.push('Unable to parse macOS SPDisplaysDataType output.');
      }
    }
  } else {
    source = nvidiaMetrics.size > 0 ? 'Linux lspci + nvidia-smi + sysfs DRM (Read-Only)' : 'Linux lspci + sysfs DRM (Read-Only)';
    // Check sysfs DRM GPU thermal sensors (AMD / Intel / Nouveau)
    let drmTempC: number | null = null;
    try {
      const drmDir = '/sys/class/drm';
      if (fs.existsSync(drmDir)) {
        for (const card of fs.readdirSync(drmDir).filter((c) => /^card\d+$/.test(c))) {
          const hwmonBase = path.join(drmDir, card, 'device', 'hwmon');
          if (fs.existsSync(hwmonBase)) {
            for (const hm of fs.readdirSync(hwmonBase)) {
              const tFile = path.join(hwmonBase, hm, 'temp1_input');
              if (fs.existsSync(tFile)) {
                const raw = Number(fs.readFileSync(tFile, 'utf8').trim());
                if (Number.isFinite(raw) && raw > 1000) {
                  drmTempC = Math.round((raw / 1000) * 10) / 10;
                  break;
                }
              }
            }
          }
          if (drmTempC !== null) break;
        }
      }
    } catch {
      // ignore sysfs permission error
    }

    const lspci = await runFixedCommand('lspci', ['-nn'], 4000);
    if (lspci?.stdout) {
      for (const line of lspci.stdout.split('\n')) {
        if (/\b(VGA compatible controller|3D controller|Display controller)\b/i.test(line)) {
          const desc = line.replace(/^[^:]+:\s*/, '').trim();
          const nv = Array.from(nvidiaMetrics.values()).find((m) =>
            desc.toLowerCase().includes('nvidia') || desc.toLowerCase().includes(m.name.toLowerCase()),
          );
          adapters.push({
            name: nv?.name ?? desc,
            vendor: /nvidia/i.test(desc) ? 'NVIDIA' : /amd|ati|radeon/i.test(desc) ? 'AMD' : /intel/i.test(desc) ? 'Intel' : 'Unknown',
            driverVersion: nv?.driver ?? null,
            driverDate: null,
            vramMb: nv?.memTotalMb ?? null,
            vramUsedMb: nv?.memUsedMb ?? null,
            utilizationPercent: nv?.utilPct ?? null,
            temperatureCelsius: nv?.tempC ?? drmTempC,
            powerDrawWatts: nv?.powerW ?? null,
            clockMhz: nv?.clockMhz ?? null,
            resolution: null,
            refreshHz: null,
            status: 'OK',
            errorCode: null,
            errorDescription: null,
            telemetrySource: nv ? 'lspci + nvidia-smi' : drmTempC !== null ? 'lspci + sysfs DRM' : 'lspci',
          });
        }
      }
    }
  }

  // If nvidia-smi found GPUs not matched by WMI/lspci, add them directly
  if (adapters.length === 0 && nvidiaMetrics.size > 0) {
    for (const nv of nvidiaMetrics.values()) {
      adapters.push({
        name: nv.name,
        vendor: 'NVIDIA',
        driverVersion: nv.driver,
        driverDate: null,
        vramMb: nv.memTotalMb,
        vramUsedMb: nv.memUsedMb,
        utilizationPercent: nv.utilPct,
        temperatureCelsius: nv.tempC,
        powerDrawWatts: nv.powerW,
        clockMhz: nv.clockMhz,
        resolution: null,
        refreshHz: null,
        status: 'OK',
        errorCode: null,
        errorDescription: null,
        telemetrySource: 'nvidia-smi',
      });
    }
  }

  // Generate honest hardware warnings
  for (const gpu of adapters) {
    if (gpu.errorCode && gpu.errorCode !== 0) {
      warnings.push({
        code: gpu.errorCode === 43 ? 'GPU_CODE_43' : 'GPU_DRIVER_ERROR',
        severity: gpu.errorCode === 43 || gpu.errorCode === 10 ? 'critical' : 'warning',
        component: 'gpu',
        title: `GPU Device Fault (${gpu.name})`,
        detail: `${gpu.errorDescription ?? `Error code ${gpu.errorCode}`}`,
      });
    }
    if (gpu.temperatureCelsius !== null && gpu.temperatureCelsius >= 84) {
      warnings.push({
        code: 'GPU_HIGH_TEMP',
        severity: gpu.temperatureCelsius >= 92 ? 'critical' : 'warning',
        component: 'thermal',
        title: `Elevated GPU Temperature (${gpu.temperatureCelsius}°C)`,
        detail: `${gpu.name} core sensor is reading ${gpu.temperatureCelsius}°C. Inspect GPU cooling fans, heatsink dust, and case airflow.`,
      });
    }
    if (gpu.vramMb && gpu.vramUsedMb && gpu.vramUsedMb / gpu.vramMb >= 0.92) {
      warnings.push({
        code: 'GPU_VRAM_PRESSURE',
        severity: 'warning',
        component: 'gpu',
        title: `High GPU VRAM Usage (${gpu.name})`,
        detail: `${gpu.vramUsedMb} MB / ${gpu.vramMb} MB VRAM allocated (${Math.round((gpu.vramUsedMb / gpu.vramMb) * 100)}%).`,
      });
    }
  }

  if (adapters.length === 0) {
    limitations.push('No discrete or integrated graphics adapter details were exposed in this host environment (headless container or restricted WMI/lspci).');
  } else if (adapters.every((a) => a.temperatureCelsius === null)) {
    limitations.push('Live GPU core temperature and clock sensors require vendor telemetry (such as NVIDIA NVML / nvidia-smi or Linux DRM hwmon); integrated GPUs often do not expose thermal counters to unprivileged user-mode queries.');
  }

  const primary = adapters[0];
  const summary = primary
    ? `Detected ${adapters.length} GPU adapter(s): ${primary.name}${primary.vramMb ? ` (${primary.vramMb} MB VRAM)` : ''}${primary.temperatureCelsius !== null ? `, ${primary.temperatureCelsius}°C` : ''}${primary.utilizationPercent !== null ? `, ${primary.utilizationPercent}% load` : ''}${primary.errorCode ? ` [ERROR CODE ${primary.errorCode}]` : ''}.`
    : 'No GPU adapter telemetry was returned by the host OS.';

  return {
    id: crypto.randomUUID(),
    toolId: 'gpu_diagnostics',
    measurementType: 'measured',
    source,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary,
    limitations,
    warnings,
    data: {
      adapterCount: adapters.length,
      adapters,
      hasLiveNvidiaSmi: nvidiaMetrics.size > 0,
    },
  };
}

export async function collectPeripheralsDiagnostics(): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];
  let source = `OS Peripheral & PnP Inspector (${platform})`;

  const usbDevices: Array<{ name: string; status: string; instanceId?: string }> = [];
  const bluetoothDevices: Array<{ name: string; status: string }> = [];
  const audioEndpoints: Array<{ name: string; status: string }> = [];
  const cameras: Array<{ name: string; status: string }> = [];
  const monitors: Array<{ name: string; status: string }> = [];
  const faultedDevices: Array<{
    name: string;
    deviceClass: string;
    status: string;
    errorCode: number;
    errorDescription: string;
    instanceId: string;
  }> = [];

  if (platform === 'windows') {
    source = 'Windows PnP Device Manager CIM/Get-PnpDevice (Read-Only)';
    const winPnp = await runPowershellJson<{
      usb?: Array<{ FriendlyName?: string; Name?: string; Status?: string; InstanceId?: string }>;
      bluetooth?: Array<{ FriendlyName?: string; Name?: string; Status?: string }>;
      audio?: Array<{ FriendlyName?: string; Name?: string; Status?: string }>;
      camera?: Array<{ FriendlyName?: string; Name?: string; Status?: string }>;
      monitor?: Array<{ FriendlyName?: string; Name?: string; Status?: string }>;
      faults?: Array<{ Name?: string; PNPClass?: string; Status?: string; ConfigManagerErrorCode?: number; DeviceID?: string }>;
    }>(`
      $usb = Get-PnpDevice -Class USB, USBDevice -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 25 FriendlyName, Name, Status, InstanceId
      $bt = Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 20 FriendlyName, Name, Status
      $aud = Get-PnpDevice -Class AudioEndpoint, MEDIA -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 20 FriendlyName, Name, Status
      $cam = Get-PnpDevice -Class Camera, Image -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 10 FriendlyName, Name, Status
      $mon = Get-PnpDevice -Class Monitor -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 10 FriendlyName, Name, Status
      $faults = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.ConfigManagerErrorCode -ne 0 -and $_.ConfigManagerErrorCode -ne $null } | Select-Object -First 20 Name, PNPClass, Status, ConfigManagerErrorCode, DeviceID
      @{ usb = $usb; bluetooth = $bt; audio = $aud; camera = $cam; monitor = $mon; faults = $faults } | ConvertTo-Json -Depth 4
    `, 10000);

    if (winPnp) {
      for (const u of normalizeArray(winPnp.usb)) {
        usbDevices.push({
          name: String(u.FriendlyName || u.Name || 'USB Device'),
          status: String(u.Status || 'OK'),
          instanceId: normalizePnpDeviceId(u.InstanceId),
        });
      }
      for (const b of normalizeArray(winPnp.bluetooth)) {
        bluetoothDevices.push({
          name: String(b.FriendlyName || b.Name || 'Bluetooth Device'),
          status: String(b.Status || 'OK'),
        });
      }
      for (const a of normalizeArray(winPnp.audio)) {
        audioEndpoints.push({
          name: String(a.FriendlyName || a.Name || 'Audio Endpoint'),
          status: String(a.Status || 'OK'),
        });
      }
      for (const c of normalizeArray(winPnp.camera)) {
        cameras.push({
          name: String(c.FriendlyName || c.Name || 'Camera'),
          status: String(c.Status || 'OK'),
        });
      }
      for (const m of normalizeArray(winPnp.monitor)) {
        monitors.push({
          name: String(m.FriendlyName || m.Name || 'Display Monitor'),
          status: String(m.Status || 'OK'),
        });
      }
      for (const f of normalizeArray(winPnp.faults)) {
        const code = Number(f.ConfigManagerErrorCode || 0);
        if (code !== 0 && code !== 22) {
          // Code 22 is intentionally disabled by user; include it in list but don't mark critical unless other error
          faultedDevices.push({
            name: String(f.Name || 'Unknown Device'),
            deviceClass: String(f.PNPClass || 'Hardware'),
            status: String(f.Status || 'Error'),
            errorCode: code,
            errorDescription: describePnpError(code),
            instanceId: normalizePnpDeviceId(f.DeviceID),
          });
        } else if (code === 22) {
          faultedDevices.push({
            name: String(f.Name || 'Disabled Device'),
            deviceClass: String(f.PNPClass || 'Hardware'),
            status: 'Disabled',
            errorCode: code,
            errorDescription: describePnpError(code),
            instanceId: normalizePnpDeviceId(f.DeviceID),
          });
        }
      }
    } else {
      limitations.push('Windows PnP device enumeration timed out or was restricted by system policy.');
    }
  } else if (platform === 'macos') {
    source = 'macOS system_profiler (USB / Bluetooth / Audio)';
    const res = await runFixedCommand('system_profiler', ['SPUSBDataType', 'SPBluetoothDataType', 'SPAudioDataType', '-json'], 7000);
    if (res?.stdout) {
      try {
        const parsed = JSON.parse(res.stdout) as {
          SPUSBDataType?: Array<{ _name?: string; _items?: Array<{ _name?: string }> }>;
          SPBluetoothDataType?: Array<Record<string, unknown>>;
          SPAudioDataType?: Array<{ _items?: Array<{ _name?: string }> }>;
        };
        const walkUsb = (items: Array<{ _name?: string; _items?: Array<{ _name?: string }> }>) => {
          for (const item of items) {
            if (item._name) usbDevices.push({ name: item._name, status: 'OK' });
            if (Array.isArray(item._items)) walkUsb(item._items);
          }
        };
        walkUsb(parsed.SPUSBDataType ?? []);
        for (const a of parsed.SPAudioDataType ?? []) {
          for (const item of a._items ?? []) {
            if (item._name) audioEndpoints.push({ name: item._name, status: 'OK' });
          }
        }
        if (parsed.SPBluetoothDataType?.length) {
          bluetoothDevices.push({ name: 'Mac Bluetooth Controller', status: 'OK' });
        }
      } catch {
        limitations.push('Unable to parse macOS peripheral profile JSON.');
      }
    }
  } else {
    source = 'Linux lsusb / sysfs Bluetooth / ALSA (Read-Only)';
    const lsusb = await runFixedCommand('lsusb', [], 4000);
    if (lsusb?.stdout) {
      for (const line of lsusb.stdout.split('\n').filter(Boolean).slice(0, 25)) {
        const name = line.replace(/^Bus\s+\d+\s+Device\s+\d+:\s+ID\s+[0-9a-f:]+\s*/i, '').trim() || line;
        usbDevices.push({ name, status: 'OK' });
      }
    } else {
      limitations.push('lsusb is not installed or USB sysfs access is restricted in this Linux environment.');
    }
    try {
      if (fs.existsSync('/sys/class/bluetooth')) {
        for (const hci of fs.readdirSync('/sys/class/bluetooth')) {
          bluetoothDevices.push({ name: `Bluetooth Controller (${hci})`, status: 'OK' });
        }
      }
    } catch {
      // ignore
    }
    const aplay = await runFixedCommand('aplay', ['-l'], 3000);
    if (aplay?.stdout) {
      for (const line of aplay.stdout.split('\n').filter((l) => l.startsWith('card '))) {
        audioEndpoints.push({ name: line.trim(), status: 'OK' });
      }
    }
  }

  const activeFaults = faultedDevices.filter((f) => f.errorCode !== 22);
  for (const fault of activeFaults.slice(0, 6)) {
    const cls = fault.deviceClass.toLowerCase();
    const comp: DiagnosticWarning['component'] = cls.includes('usb')
      ? 'usb'
      : cls.includes('bluetooth')
        ? 'bluetooth'
        : cls.includes('audio') || cls.includes('media')
          ? 'audio'
          : cls.includes('display')
            ? 'gpu'
            : 'peripherals';
    warnings.push({
      code: `PNP_ERROR_CODE_${fault.errorCode}`,
      severity: fault.errorCode === 43 || fault.errorCode === 10 ? 'critical' : 'warning',
      component: comp,
      title: `Device Fault: ${fault.name} (Code ${fault.errorCode})`,
      detail: fault.errorDescription,
    });
  }

  return {
    id: crypto.randomUUID(),
    toolId: 'peripherals_diagnostics',
    measurementType: 'measured',
    source,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `Enumerated ${usbDevices.length} USB, ${bluetoothDevices.length} Bluetooth, ${audioEndpoints.length} audio, ${cameras.length} camera, and ${monitors.length} monitor device(s); ${activeFaults.length} active PnP fault(s).`,
    limitations,
    warnings,
    data: {
      counts: {
        usb: usbDevices.length,
        bluetooth: bluetoothDevices.length,
        audio: audioEndpoints.length,
        cameras: cameras.length,
        monitors: monitors.length,
        faultedDevices: activeFaults.length,
      },
      usbDevices: usbDevices.slice(0, 25),
      bluetoothDevices: bluetoothDevices.slice(0, 20),
      audioEndpoints: audioEndpoints.slice(0, 20),
      cameras: cameras.slice(0, 10),
      monitors: monitors.slice(0, 10),
      faultedDevices,
    },
  };
}

async function runCpuStressWindowsOffThread(windowTargetMs: number): Promise<{
  windows: Array<{ windowIndex: number; durationMs: number; kOpsPerSec: number }>;
  checksumSink: number;
}> {
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { performance } = require('node:perf_hooks');
    const targetMs = workerData.windowTargetMs;
    const windows = [];
    let checksumSink = 0;
    for (let w = 0; w < 4; w++) {
      const t0 = performance.now();
      let ops = 0;
      while (performance.now() - t0 < targetMs) {
        let acc = 0;
        for (let i = 1; i <= 400; i++) {
          const x = (i + ops) * 0.00137;
          acc += Math.sin(x) * Math.cos(x) + Math.sqrt(i + 1.5);
        }
        checksumSink += acc > 0 ? 1 : 0;
        ops += 1;
      }
      const elapsed = Math.max(1, performance.now() - t0);
      const kOpsPerSec = Math.round(((ops * 400) / elapsed) * 10) / 10;
      windows.push({ windowIndex: w + 1, durationMs: Math.round(elapsed), kOpsPerSec });
    }
    parentPort.postMessage({ windows, checksumSink });
  `;

  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { windowTargetMs },
      });
      const timer = setTimeout(() => {
        worker.terminate().catch(() => {});
        reject(new Error('CPU stress worker timed out'));
      }, 15_000);
      worker.once('message', (msg) => {
        clearTimeout(timer);
        resolve(msg as { windows: Array<{ windowIndex: number; durationMs: number; kOpsPerSec: number }>; checksumSink: number });
      });
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`CPU stress worker exited with code ${code}`));
      });
    });
  } catch {
    // Graceful non-blocking micro-sliced fallback if worker_threads is restricted
    const windows: Array<{ windowIndex: number; durationMs: number; kOpsPerSec: number }> = [];
    let checksumSink = 0;
    for (let w = 0; w < 4; w++) {
      let activeMs = 0;
      let ops = 0;
      while (activeMs < windowTargetMs) {
        const sliceStart = performance.now();
        while (performance.now() - sliceStart < 40 && activeMs + (performance.now() - sliceStart) < windowTargetMs) {
          let acc = 0;
          for (let i = 1; i <= 400; i++) {
            const x = (i + ops) * 0.00137;
            acc += Math.sin(x) * Math.cos(x) + Math.sqrt(i + 1.5);
          }
          checksumSink += acc > 0 ? 1 : 0;
          ops += 1;
        }
        activeMs += performance.now() - sliceStart;
        await new Promise((r) => setImmediate(r));
      }
      const elapsed = Math.max(1, activeMs);
      const kOpsPerSec = Math.round(((ops * 400) / elapsed) * 10) / 10;
      windows.push({ windowIndex: w + 1, durationMs: Math.round(elapsed), kOpsPerSec });
    }
    return { windows, checksumSink };
  }
}

export async function collectHardwareStressProbe(): Promise<DiagnosticResult> {
  const started = Date.now();
  const platform = detectCurrentPlatform();
  const warnings: DiagnosticWarning[] = [];
  const limitations: string[] = [];

  // 1. Bounded 4 x 650ms CPU Compute Stability Probe (executed off main event loop in a Worker thread)
  const { windows, checksumSink } = await runCpuStressWindowsOffThread(650);

  const scores = windows.map((w) => w.kOpsPerSec);
  const peakKOps = Math.max(...scores);
  const sustainedKOps = scores[scores.length - 1] ?? peakKOps;
  const avgKOps = Math.round((scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length)) * 10) / 10;
  const throttleDropPercent =
    peakKOps > 0 ? Math.max(0, Math.round(((peakKOps - sustainedKOps) / peakKOps) * 1000) / 10) : 0;
  const stabilityPercent = Math.max(0, Math.min(100, Math.round((100 - throttleDropPercent) * 10) / 10));

  if (throttleDropPercent >= 22) {
    warnings.push({
      code: 'CPU_THROTTLING_DETECTED',
      severity: throttleDropPercent >= 32 ? 'critical' : 'warning',
      component: 'thermal',
      title: `CPU Compute Throughput Dropped ${throttleDropPercent}%`,
      detail: `Single-thread compute throughput fell from ${peakKOps} kOps/s peak to ${sustainedKOps} kOps/s across the 4-window probe. This may indicate thermal throttling, power-plan capping, or heavy background contention.`,
    });
  }

  // 2. Bounded Self-Cleaning 16 MB Sequential Temp-File Disk I/O Benchmark (non-blocking async I/O)
  let diskWriteMBps: number | null = null;
  let diskReadMBps: number | null = null;
  const testBytes = 16 * 1024 * 1024;
  const tmpFile = path.join(os.tmpdir(), `coresense-io-bench-${crypto.randomUUID()}.tmp`);

  try {
    const payload = crypto.randomBytes(testBytes);
    const wStart = performance.now();
    const fh = await fsp.open(tmpFile, 'w');
    try {
      await fh.write(payload, 0, payload.length, 0);
      await fh.sync();
    } finally {
      await fh.close();
    }
    const wSec = Math.max(0.001, (performance.now() - wStart) / 1000);
    diskWriteMBps = Math.round((16 / wSec) * 10) / 10;

    const rStart = performance.now();
    const readBuf = await fsp.readFile(tmpFile);
    const rSec = Math.max(0.001, (performance.now() - rStart) / 1000);
    if (readBuf.length === testBytes) {
      diskReadMBps = Math.round((16 / rSec) * 10) / 10;
    }

    if (diskWriteMBps < 35) {
      warnings.push({
        code: 'SLOW_DISK_WRITE',
        severity: 'warning',
        component: 'storage',
        title: `Slow Sequential Disk Write (${diskWriteMBps} MB/s)`,
        detail: `16 MB flushed write to ${os.tmpdir()} measured ${diskWriteMBps} MB/s. Check drive health, full SSD SLC cache, or SATA/HDD bottleneck.`,
      });
    }
  } catch {
    limitations.push('Temp-directory sequential disk I/O test could not run due to filesystem permission or space limits.');
  } finally {
    try {
      await fsp.unlink(tmpFile);
    } catch {
      // ignore cleanup error
    }
  }

  limitations.push('This probe is strictly bounded (~3s single-thread CPU + 16 MB fsync temp file) so it remains safe and non-disruptive; OS page cache can boost sequential read speed.');

  return {
    id: crypto.randomUUID(),
    toolId: 'hardware_stress_probe',
    measurementType: 'measured',
    source: `CoreSense Bounded Hardware Benchmark (${platform})`,
    platform,
    osVersion: `${os.type()} ${os.release()}`,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: `Stress probe complete: CPU ${avgKOps} kOps/s avg (${stabilityPercent}% stability, ${throttleDropPercent}% drop); Disk ${diskWriteMBps ?? 'N/A'} MB/s write / ${diskReadMBps ?? 'N/A'} MB/s read.`,
    limitations,
    warnings,
    data: {
      checksumGuard: checksumSink > 0,
      cpuBenchmark: {
        logicalThreads: os.cpus().length,
        cpuModel: os.cpus()[0]?.model?.trim() || 'Unknown CPU',
        peakKOpsPerSec: peakKOps,
        sustainedKOpsPerSec: sustainedKOps,
        averageKOpsPerSec: avgKOps,
        throttleDropPercent,
        stabilityPercent,
        windows,
      },
      diskBenchmark: {
        sampleSizeMb: 16,
        targetDir: os.tmpdir(),
        sequentialWriteMBps: diskWriteMBps,
        sequentialReadMBps: diskReadMBps,
      },
    },
  };
}

export async function runFullSystemSnapshot(): Promise<DiagnosticResult> {
  const started = Date.now();
  const [cpu, memory, storage, gpu, network, peripherals, osHealth, power] = await Promise.all([
    collectCpuDiagnostics(),
    collectMemoryDiagnostics(),
    collectStorageDiagnostics(),
    collectGpuDiagnostics(),
    collectNetworkDiagnostics(),
    collectPeripheralsDiagnostics(),
    collectOsHealthDiagnostics(),
    collectPowerAndPeripherals(),
  ]);

  const warnings = [
    ...cpu.warnings,
    ...memory.warnings,
    ...storage.warnings,
    ...gpu.warnings,
    ...network.warnings,
    ...peripherals.warnings,
    ...osHealth.warnings,
    ...power.warnings,
  ];
  const limitations = Array.from(
    new Set([
      ...cpu.limitations,
      ...memory.limitations,
      ...storage.limitations,
      ...gpu.limitations,
      ...network.limitations,
      ...peripherals.limitations,
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
    summary: `Full system diagnostic completed: CPU ${String(cpu.data.utilizationPercent)}%, RAM ${String(memory.data.utilizationPercent)}%, ${String(gpu.data.adapterCount ?? 0)} GPU(s), ${String((peripherals.data.counts as Record<string, number> | undefined)?.faultedDevices ?? 0)} PnP fault(s), ${warnings.length} alert(s) identified.`,
    limitations,
    warnings,
    data: {
      cpu: cpu.data,
      memory: memory.data,
      storage: storage.data,
      gpu: gpu.data,
      network: network.data,
      peripherals: peripherals.data,
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
    case 'gpu_diagnostics':
      return collectGpuDiagnostics();
    case 'network_diagnostics':
      return collectNetworkDiagnostics(parsedParams);
    case 'peripherals_diagnostics':
      return collectPeripheralsDiagnostics();
    case 'hardware_stress_probe':
      return collectHardwareStressProbe();
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
