import crypto from 'node:crypto';
import type { DiagnosticResult } from '@coresense/shared';

// ============================================================================
// Clearly Labeled Simulation Fixtures (For Deterministic Evaluation & Testing)
// Every fixture strictly carries `measurementType: 'simulated'` and an explicit
// `simulatedScenarioId` so it can NEVER be presented as real hardware telemetry.
// ============================================================================

export type SimulationScenarioId =
  | 'high_cpu_runaway'
  | 'high_ram_pressure'
  | 'low_disk_space'
  | 'smart_ssd_failing'
  | 'wifi_disabled_or_down'
  | 'dns_failure_ip_ok'
  | 'battery_degraded'
  | 'thermal_overheating'
  | 'app_crash_loop'
  | 'windows_kernel_power_bsod'
  | 'healthy_baseline_after_fix';

export function buildSimulatedDiagnostic(scenario: SimulationScenarioId): DiagnosticResult {
  const base = {
    id: crypto.randomUUID(),
    measurementType: 'simulated' as const,
    simulatedScenarioId: scenario,
    source: `SIMULATED TEST FIXTURE (${scenario}) — NOT REAL HARDWARE`,
    platform: 'windows' as const,
    osVersion: 'Windows 11 Pro 24H2 (Simulated Fixture)',
    collectedAt: new Date().toISOString(),
    durationMs: 12,
    limitations: [
      'SIMULATED FIXTURE: Values are synthetic test data generated for verification and evaluation, not measured from live hardware.',
    ],
  };

  switch (scenario) {
    case 'high_cpu_runaway':
      return {
        ...base,
        toolId: 'cpu_diagnostics',
        summary: '[SIMULATED] Intel Core i7-1260P — 96.4% CPU load caused by runaway indexer process.',
        warnings: [
          {
            code: 'HIGH_CPU_LOAD',
            severity: 'critical',
            component: 'cpu',
            title: 'Sustained High CPU Utilization (Simulated)',
            detail: 'CPU utilization is 96.4% with SearchIndexer.exe consuming sustained CPU time.',
          },
        ],
        data: {
          model: 'Intel(R) Core(TM) i7-1260P',
          physicalCores: 12,
          logicalThreads: 16,
          utilizationPercent: 96.4,
          temperatureCelsius: 84,
          topProcesses: [
            { name: 'SearchIndexer', pid: 4412, cpuSeconds: 1842.5, workingSetMb: 410 },
            { name: 'Antimalware Service', pid: 2104, cpuSeconds: 412.1, workingSetMb: 295 },
            { name: 'chrome', pid: 8820, cpuSeconds: 190.4, workingSetMb: 1240 },
          ],
        },
      };

    case 'high_ram_pressure':
      return {
        ...base,
        toolId: 'memory_diagnostics',
        summary: '[SIMULATED] 15.3 GB / 16.0 GB RAM used (95.6%, critical memory pressure).',
        warnings: [
          {
            code: 'CRITICAL_MEMORY_PRESSURE',
            severity: 'critical',
            component: 'memory',
            title: 'Critical RAM Pressure (Simulated)',
            detail: '95.6% RAM allocated with heavy pagefile thrashing (7,400 MB paged).',
          },
        ],
        data: {
          totalGb: 16,
          usedGb: 15.3,
          availableGb: 0.7,
          utilizationPercent: 95.6,
          pressure: 'critical',
          pagefileUsedMb: 7400,
          pagefileTotalMb: 8192,
          topProcesses: [
            { name: 'chrome', pid: 1024, memoryMb: 6820 },
            { name: 'node', pid: 5520, memoryMb: 3110 },
            { name: 'Teams', pid: 3340, memoryMb: 1890 },
          ],
        },
      };

    case 'low_disk_space':
      return {
        ...base,
        toolId: 'storage_diagnostics',
        summary: '[SIMULATED] System drive C: is 98.2% full (4.3 GB free of 238 GB).',
        warnings: [
          {
            code: 'LOW_DISK_SPACE',
            severity: 'critical',
            component: 'storage',
            title: 'Critical Low Free Space on C: (Simulated)',
            detail: 'Only 4.3 GB free on OS NVMe drive; virtual memory and OS updates are constrained.',
          },
        ],
        data: {
          volumes: [{ mount: 'C:', label: 'Windows', fileSystem: 'NTFS', totalGb: 238, freeGb: 4.3, usedPercent: 98.2 }],
          physicalDisks: [{ model: 'Samsung PM9A1 NVMe', mediaType: 'SSD', busType: 'NVMe', sizeGb: 256, healthStatus: 'Healthy', operationalStatus: 'OK', wearPercent: 18 }],
        },
      };

    case 'smart_ssd_failing':
      return {
        ...base,
        toolId: 'storage_diagnostics',
        summary: '[SIMULATED] CRITICAL SMART warning on NVMe SSD — media wear 96%, predictive failure flagged.',
        warnings: [
          {
            code: 'SMART_HEALTH_WARNING',
            severity: 'critical',
            component: 'storage',
            title: 'Drive Health Alert: Crucial P3 NVMe (Simulated)',
            detail: 'HealthStatus reported "Warning / Predictive Failure" with 96% wear and media errors.',
          },
        ],
        data: {
          volumes: [{ mount: 'C:', label: 'OS', fileSystem: 'NTFS', totalGb: 476, freeGb: 184, usedPercent: 61.3 }],
          physicalDisks: [
            {
              model: 'Crucial P3 500GB NVMe',
              mediaType: 'SSD',
              busType: 'NVMe',
              sizeGb: 500,
              healthStatus: 'Warning',
              operationalStatus: 'Predictive Failure',
              wearPercent: 96,
              temperatureC: 69,
            },
          ],
        },
      };

    case 'wifi_disabled_or_down':
      return {
        ...base,
        toolId: 'network_diagnostics',
        summary: '[SIMULATED] No active Wi-Fi or external network interface connected.',
        warnings: [
          {
            code: 'NO_ACTIVE_INTERFACE',
            severity: 'critical',
            component: 'network',
            title: 'No Active External Network Interface (Simulated)',
            detail: 'Wi-Fi adapter reports Disconnected state and no IPv4 lease is present.',
          },
        ],
        data: {
          interfaces: [],
          wifi: { Name: 'Wi-Fi', State: 'disconnected' },
          connectivity: {
            testHost: 'cloudflare.com',
            dnsResolved: false,
            dnsError: 'ENOTFOUND',
            directIpReachable: false,
            directIpLatencyMs: null,
          },
        },
      };

    case 'dns_failure_ip_ok':
      return {
        ...base,
        toolId: 'network_diagnostics',
        summary: '[SIMULATED] Direct IP (1.1.1.1) reachable in 19ms, but DNS resolution failed (ETIMEOUT).',
        warnings: [
          {
            code: 'DNS_RESOLUTION_FAILURE',
            severity: 'critical',
            component: 'network',
            title: 'DNS Resolution Failed While IP Works (Simulated)',
            detail: 'Direct TCP to 1.1.1.1 succeeded in 19ms; DNS lookup failed on configured resolver 192.168.1.1.',
          },
        ],
        data: {
          interfaces: [{ name: 'Wi-Fi', ipv4: '192.168.1.42', internal: false }],
          gateways: ['192.168.1.1'],
          dnsServers: ['192.168.1.1'],
          connectivity: {
            testHost: 'cloudflare.com',
            dnsResolved: false,
            dnsError: 'queryA ETIMEOUT cloudflare.com',
            directIpReachable: true,
            directIpLatencyMs: 19,
          },
        },
      };

    case 'battery_degraded':
      return {
        ...base,
        toolId: 'power_and_peripherals',
        summary: '[SIMULATED] Battery wear 54% (Full charge 26,200 mWh vs Design 57,000 mWh, 890 cycles).',
        warnings: [
          {
            code: 'BATTERY_DEGRADATION',
            severity: 'critical',
            component: 'battery',
            title: 'Severe Battery Degradation (Simulated)',
            detail: 'Battery retains only 46% of original design capacity after 890 cycles.',
          },
        ],
        data: {
          battery: {
            present: true,
            chargePercent: 34,
            status: 'Discharging',
            designCapacityMwh: 57000,
            fullChargeCapacityMwh: 26200,
            wearPercent: 54,
            cycleCount: 890,
          },
        },
      };

    case 'thermal_overheating':
      return {
        ...base,
        toolId: 'cpu_diagnostics',
        summary: '[SIMULATED] CPU thermal sensor at 97.5°C under moderate load (38%), severe thermal throttling.',
        warnings: [
          {
            code: 'HIGH_CPU_TEMP',
            severity: 'critical',
            component: 'thermal',
            title: 'Critical CPU Overheating (Simulated)',
            detail: 'CPU package temperature reached 97.5°C at only 38% load, strongly indicating blocked airflow, stalled fan, or dried thermal paste.',
          },
        ],
        data: {
          model: 'AMD Ryzen 7 6800U',
          utilizationPercent: 38.2,
          temperatureCelsius: 97.5,
          topProcesses: [{ name: 'System', pid: 4, cpuSeconds: 80.1, workingSetMb: 42 }],
        },
      };

    case 'app_crash_loop':
      return {
        ...base,
        toolId: 'os_health_diagnostics',
        summary: '[SIMULATED] Repeated Application Error (Event ID 1000) crashing GPU driver / app module.',
        warnings: [
          {
            code: 'REPEATED_APP_CRASH',
            severity: 'warning',
            component: 'os',
            title: 'Repeated Application Faults (Simulated)',
            detail: 'Multiple Event ID 1000 crashes referencing nvlddmkm.sys / d3d11.dll within 24 hours.',
          },
        ],
        data: {
          uptimeHours: 14.2,
          recentErrors: [
            {
              logName: 'Application',
              provider: 'Application Error',
              id: 1000,
              level: 'Error',
              time: new Date().toISOString(),
              message: 'Faulting application name: blender.exe, faulting module name: nvoglv64.dll, exception code: 0xc0000005',
            },
            {
              logName: 'System',
              provider: 'Display',
              id: 4101,
              level: 'Warning',
              time: new Date().toISOString(),
              message: 'Display driver nvlddmkm stopped responding and has successfully recovered.',
            },
          ],
        },
      };

    case 'windows_kernel_power_bsod':
      return {
        ...base,
        toolId: 'os_health_diagnostics',
        summary: '[SIMULATED] Critical Event ID 41 (Kernel-Power) & BugCheck 1001 (WHEA_UNCORRECTABLE_ERROR).',
        warnings: [
          {
            code: 'CRITICAL_OS_EVENTS',
            severity: 'critical',
            component: 'os',
            title: 'Unexpected Shutdown / Kernel-Power 41 (Simulated)',
            detail: 'Detected Kernel-Power Event 41 paired with BugCheck 0x00000124 (WHEA_UNCORRECTABLE_ERROR).',
          },
        ],
        data: {
          uptimeHours: 0.4,
          recentErrors: [
            {
              logName: 'System',
              provider: 'Microsoft-Windows-Kernel-Power',
              id: 41,
              level: 'Critical',
              time: new Date().toISOString(),
              message: 'The system has rebooted without cleanly shutting down first (Event ID 41).',
            },
            {
              logName: 'System',
              provider: 'Microsoft-Windows-WER-SystemErrorReporting',
              id: 1001,
              level: 'Error',
              time: new Date().toISOString(),
              message: 'The computer has rebooted from a bugcheck: 0x00000124 (WHEA_UNCORRECTABLE_ERROR).',
            },
          ],
        },
      };

    case 'healthy_baseline_after_fix':
      return {
        ...base,
        toolId: 'full_system_snapshot',
        summary: '[SIMULATED] Post-remediation check: CPU 14.2%, RAM 44.0%, C: 58% full, DNS 14ms, 0 warnings.',
        warnings: [],
        data: {
          cpu: { utilizationPercent: 14.2, temperatureCelsius: 52 },
          memory: { totalGb: 16, usedGb: 7.0, availableGb: 9.0, utilizationPercent: 44.0, pressure: 'normal' },
          storage: { volumes: [{ mount: 'C:', freeGb: 98.4, usedPercent: 58.6 }] },
          network: { connectivity: { dnsResolved: true, dnsLatencyMs: 14, directIpReachable: true, directIpLatencyMs: 12 } },
        },
      };
  }
}
