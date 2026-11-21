import { z } from 'zod';
import { PlatformSchema } from './types.js';

// ============================================================================
// Predefined Validated Diagnostic Tool Registry
// ZERO arbitrary AI-generated shell execution is permitted anywhere in CoreSense.
// Every diagnostic tool must be registered here with strict schema, risk class,
// OS support matrix, and explicit user-approval policy.
// ============================================================================

export const ToolRiskLevelSchema = z.enum([
  'read_only',         // Safe inspection; allowed with session/tool authorization
  'user_guided',       // Interactive test requiring user participation (mic/speaker/touch/multimeter)
  'system_modifying',  // Any state change (cache cleanup, DNS flush, service restart); REQUIRES explicit per-action approval
]);
export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>;

export const DiagnosticToolDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum([
    'cpu',
    'memory',
    'storage',
    'gpu',
    'network',
    'peripherals',
    'os',
    'power',
    'benchmark',
    'mobile_hardware',
    'composite',
    'remediation',
  ]),
  description: z.string(),
  riskLevel: ToolRiskLevelSchema,
  requiresExplicitApproval: z.boolean(),
  approvalWarning: z.string().optional(),
  supportedPlatforms: z.array(PlatformSchema),
  readOnly: z.boolean(),
  estimatedDurationSec: z.number(),
  parametersDescription: z.record(z.string()).default({}),
});
export type DiagnosticToolDefinition = z.infer<typeof DiagnosticToolDefinitionSchema>;

export const DIAGNOSTIC_TOOL_REGISTRY: readonly DiagnosticToolDefinition[] = [
  {
    id: 'cpu_diagnostics',
    name: 'CPU & Process Profiler',
    category: 'cpu',
    description: 'Collects CPU model, core/thread count, live utilization, top CPU-consuming processes, and thermal sensor data where exposed by the OS.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 2,
    parametersDescription: {
      topProcessCount: 'Optional integer (1-20) limiting top processes returned. Default 8.',
    },
  },
  {
    id: 'memory_diagnostics',
    name: 'Memory & Pressure Inspector',
    category: 'memory',
    description: 'Inspects total, available, and used RAM, memory pressure state, swap/pagefile usage, and top memory-consuming processes.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 2,
    parametersDescription: {
      topProcessCount: 'Optional integer (1-20) limiting top processes returned. Default 8.',
    },
  },
  {
    id: 'storage_diagnostics',
    name: 'Storage & SMART Health Analyzer',
    category: 'storage',
    description: 'Inspects physical drives, partitions, capacity, available free space, media type (NVMe/SSD/HDD), and SMART health status where exposed.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 3,
    parametersDescription: {},
  },
  {
    id: 'network_diagnostics',
    name: 'Network, Wi-Fi & DNS Probe',
    category: 'network',
    description: 'Inspects active network interfaces, IP/gateway/DNS configuration, Wi-Fi signal status, DNS resolution tests, and internet reachability latency.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 4,
    parametersDescription: {
      testHost: 'Optional validated hostname (e.g. cloudflare.com or dns.google) for DNS and latency check.',
    },
  },
  {
    id: 'os_health_diagnostics',
    name: 'OS Health, Event Logs & Startup Inspector',
    category: 'os',
    description: 'Collects OS version, uptime, hardware vendor/BIOS details, startup items, and recent critical/error application & system events.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 3,
    parametersDescription: {
      maxEvents: 'Optional integer (1-25) limiting recent error log entries. Default 12.',
    },
  },
  {
    id: 'power_and_peripherals',
    name: 'Battery, Thermal & Peripheral Inspector',
    category: 'power',
    description: 'Inspects battery charge, design vs full-charge capacity wear, charging status, display adapters, and connected peripherals where accessible.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 3,
    parametersDescription: {},
  },
  {
    id: 'gpu_diagnostics',
    name: 'GPU, VRAM & Driver Inspector',
    category: 'gpu',
    description: 'Inspects discrete and integrated graphics adapters, VRAM capacity, driver versions, OS device error codes (such as Code 43), active display resolutions/refresh rates, and live GPU temperature, clock, power draw, and utilization where exposed.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 3,
    parametersDescription: {},
  },
  {
    id: 'peripherals_diagnostics',
    name: 'USB, Bluetooth, Audio & PnP Device Inspector',
    category: 'peripherals',
    description: 'Enumerates USB controllers and devices, Bluetooth adapters and paired peripherals, audio endpoints, cameras, monitors, and detects Plug-and-Play device faults with OS error code decoding.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 3,
    parametersDescription: {},
  },
  {
    id: 'hardware_stress_probe',
    name: 'Bounded CPU Throttling & Disk I/O Benchmark',
    category: 'benchmark',
    description: 'Runs a safe, bounded 3-second multi-window CPU compute stability probe (to detect thermal throttling drops) and a self-cleaning 16 MB sequential temp-file disk read/write MB/s throughput test.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 5,
    parametersDescription: {},
  },
  {
    id: 'full_system_snapshot',
    name: 'Full System Diagnostic Snapshot',
    category: 'composite',
    description: 'Runs a coordinated read-only diagnostic pass across CPU, Memory, Storage, GPU, Network, USB/Bluetooth/Audio Peripherals, OS Health, and Power.',
    riskLevel: 'read_only',
    requiresExplicitApproval: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: true,
    estimatedDurationSec: 10,
    parametersDescription: {},
  },
  {
    id: 'mobile_device_check',
    name: 'Mobile Permitted Health Check',
    category: 'mobile_hardware',
    description: 'Collects battery state, Wi-Fi/hotspot multi-sample latency/jitter & reachability, WebGL GPU/SoC profile, 10-second SoC thermal-throttling stress test, and user-guided speaker, mic, display, touch, camera, and motion checks.',
    riskLevel: 'user_guided',
    requiresExplicitApproval: false,
    supportedPlatforms: ['ios', 'android', 'web'],
    readOnly: true,
    estimatedDurationSec: 5,
    parametersDescription: {},
  },
  {
    id: 'flush_dns_cache',
    name: 'Flush Local DNS Resolver Cache',
    category: 'remediation',
    description: 'Clears the local operating system DNS resolver cache to resolve stale or poisoned DNS records. Does not modify files or network passwords.',
    riskLevel: 'system_modifying',
    requiresExplicitApproval: true,
    approvalWarning: 'This action clears the system DNS cache and may briefly interrupt active hostname lookups. Explicit user approval is required.',
    supportedPlatforms: ['windows', 'macos', 'linux'],
    readOnly: false,
    estimatedDurationSec: 2,
    parametersDescription: {},
  },
] as const;

export const VALID_TOOL_IDS = new Set(DIAGNOSTIC_TOOL_REGISTRY.map((t) => t.id));

export function getToolDefinition(toolId: string): DiagnosticToolDefinition | undefined {
  return DIAGNOSTIC_TOOL_REGISTRY.find((t) => t.id === toolId);
}

// Strict parameter validation for tools (blocks injection attempts)
export const ToolParametersSchema = z.object({
  topProcessCount: z.number().int().min(1).max(20).optional(),
  maxEvents: z.number().int().min(1).max(25).optional(),
  testHost: z
    .string()
    .regex(/^[a-zA-Z0-9.-]{1,120}$/, 'Invalid hostname format')
    .optional(),
}).strict();

export type ToolParameters = z.infer<typeof ToolParametersSchema>;
