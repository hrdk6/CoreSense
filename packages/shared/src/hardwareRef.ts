// ============================================================================
// CoreSense Verified Hardware & Electronics Technical Reference Engine
// Provides deterministic, factually accurate decoding for:
//   - Windows BSOD / BugCheck hex stop codes & critical Event IDs
//   - Motherboard / PCB silkscreen designators & SMD component functions
//   - USB-C Power Delivery (PD) voltage negotiation diagnostics
// Never invents part numbers or schematic values not explicitly known.
// ============================================================================

export interface ErrorCodeReference {
  code: string;
  aliases: string[];
  title: string;
  subsystem: 'hardware_cpu_bus' | 'gpu_driver' | 'memory' | 'storage' | 'power_os' | 'driver_kernel';
  plainExplanation: string;
  technicianExplanation: string;
  firstChecks: string[];
}

export const ERROR_CODE_CATALOG: readonly ErrorCodeReference[] = [
  {
    code: '0x00000124',
    aliases: ['0x124', 'whea_uncorrectable_error', 'whea'],
    title: 'WHEA_UNCORRECTABLE_ERROR (0x00000124)',
    subsystem: 'hardware_cpu_bus',
    plainExplanation:
      'Windows stopped because the processor or motherboard hardware reported a fatal hardware error — often caused by overheating, unstable power delivery, an aggressive BIOS overclock/undervolt, or a failing NVMe/PCIe device.',
    technicianExplanation:
      'Machine Check Exception (MCE) or PCIe AER fatal error reported through Windows Hardware Error Architecture. Inspect WHEA-Logger Event ID 1/17/18/19 in System log to identify whether Arg1 points to Machine Check (0x0), PCI Express (0x4), or Memory (0x1).',
    firstChecks: [
      'Reset BIOS/UEFI voltage/overclock/XMP settings to stock defaults.',
      'Check CPU package temperatures under load and verify VRM/heatsink cooling.',
      'Inspect Event Viewer → System for WHEA-Logger Event ID 17/18/19 naming a PCIe root port or CPU APIC ID.',
      'Update BIOS and chipset/NVMe firmware.',
    ],
  },
  {
    code: '0x00000116',
    aliases: ['0x116', 'video_tdr_failure', 'nvlddmkm', 'amdkmdag', 'igdkmd'],
    title: 'VIDEO_TDR_FAILURE (0x00000116)',
    subsystem: 'gpu_driver',
    plainExplanation:
      'The graphics chip stopped responding and Windows failed to reset the graphics driver in time. This is commonly caused by a corrupt GPU driver, GPU overheating, or unstable power to the graphics card.',
    technicianExplanation:
      'GPU Timeout Detection and Recovery (TDR) reset failed after >2s hang in display miniport (nvlddmkm.sys / amdkmdag.sys / igdkmd64.sys). Isolate between corrupt shader cache/driver, PCIe slot power/contact issue, thermal VRAM/die throttling, or failing GPU BGA/VRAM.',
    firstChecks: [
      'Perform a clean GPU driver reinstall (removing residual driver files before installing WHQL release).',
      'Monitor GPU core and hotspot temperatures under load.',
      'On desktops, reseat the GPU and verify dedicated PCIe power cables (avoid daisy-chained single cables on high-TDP GPUs).',
    ],
  },
  {
    code: '0x0000001A',
    aliases: ['0x1a', 'memory_management'],
    title: 'MEMORY_MANAGEMENT (0x0000001A)',
    subsystem: 'memory',
    plainExplanation:
      'Windows detected severe corruption in system memory (RAM) or the pagefile. Common causes are a loose or failing RAM stick, unstable XMP/EXPO memory speed, or bad storage blocks in the pagefile.',
    technicianExplanation:
      'Severe memory manager violation (check Arg1: 0x41792 corrupted PTE, 0x61941 paging hardware bit flip, 0x403 page table mismatch). Run multi-pass MemTest86 / Windows Memory Diagnostic and isolate individual DIMMs.',
    firstChecks: [
      'Disable RAM XMP/EXPO overclock temporarily in BIOS to test at JEDEC base frequency.',
      'Run Windows Memory Diagnostic or MemTest86 (minimum 2–4 full passes).',
      'If multi-DIMM, test one RAM module at a time across slots (with power unplugged & ESD precautions).',
    ],
  },
  {
    code: '0x0000007A',
    aliases: ['0x7a', 'kernel_data_inpage_error'],
    title: 'KERNEL_DATA_INPAGE_ERROR (0x0000007A)',
    subsystem: 'storage',
    plainExplanation:
      'Windows could not read critical operating system data back from the SSD or hard drive. This frequently indicates a loose drive cable/M.2 seating, storage controller drop, or failing drive sectors.',
    technicianExplanation:
      'Kernel page fault could not be satisfied from pagefile on disk (check NTSTATUS Arg2: 0xC000009C STATUS_DEVICE_DATA_ERROR = bad sectors; 0xC000000E STATUS_NO_SUCH_DEVICE = drive dropped off NVMe/SATA bus).',
    firstChecks: [
      'Back up critical files immediately before running heavy disk checks.',
      'Run CoreSense Storage & SMART Health Analyzer to inspect wear and predictive failure flags.',
      'Inspect Event Viewer for Disk Event ID 7, 51, or stornvme Event ID 129 controller resets.',
    ],
  },
  {
    code: '0x0000009F',
    aliases: ['0x9f', 'driver_power_state_failure'],
    title: 'DRIVER_POWER_STATE_FAILURE (0x0000009F)',
    subsystem: 'power_os',
    plainExplanation:
      'A device driver failed to respond while your computer was entering sleep, waking up, or changing power states — often linked to Wi-Fi, Thunderbolt/USB-C dock, or GPU power drivers.',
    technicianExplanation:
      'IRP power transition timed out (typically Arg1=0x3 DEVICE_OBJECT blocked in D-state transition). Identify blocked PDO/driver stack via minidump `!analyze -v` and test with external USB docks unplugged.',
    firstChecks: [
      'Disconnect external USB hubs/docks and test sleep/wake cycles.',
      'Update chipset, Wi-Fi/Bluetooth, and GPU drivers from the laptop OEM.',
      'Disable Fast Startup temporarily to test if hibernation resume state is corrupted.',
    ],
  },
  {
    code: '0x00000133',
    aliases: ['0x133', 'dpc_watchdog_violation'],
    title: 'DPC_WATCHDOG_VIOLATION (0x00000133)',
    subsystem: 'driver_kernel',
    plainExplanation:
      'A hardware driver monopolized the CPU for too long without yielding — frequently triggered by outdated SSD firmware, Wi-Fi drivers, or audio/RGB kernel utilities.',
    technicianExplanation:
      'Deferred Procedure Call ran past watchdog threshold (Arg1=0x0 single DPC stall; Arg1=0x1 cumulative ISR/DPC storm). Common culprits: outdated NVMe firmware, Realtek/Intel NIC drivers, or kernel anti-cheat/RGB drivers.',
    firstChecks: [
      'Update SSD/NVMe firmware and network/Wi-Fi drivers.',
      'Inspect recent driver installations or Windows Updates preceding the crashes.',
    ],
  },
  {
    code: 'EVENT_ID_41',
    aliases: ['event id 41', 'kernel-power 41', 'event 41'],
    title: 'Windows Kernel-Power Event ID 41',
    subsystem: 'power_os',
    plainExplanation:
      'Event ID 41 does NOT identify a single broken part by itself — it simply logs that Windows rebooted without a clean shutdown (such as a sudden power cut, thermal shutdown, battery drop, or hard crash).',
    technicianExplanation:
      'Inspect BugcheckCode inside Event 41 XML details: BugcheckCode=0 indicates abrupt power loss, VRM/PSU OCP/UVP trip, or thermal PROCHOT shutdown; non-zero BugcheckCode points to a preceding BSOD stop code.',
    firstChecks: [
      'Check if BugcheckCode in Event 41 details is 0 (power/thermal cutoff) vs non-zero (driver/BSOD).',
      'Check CPU/GPU peak temperatures and whether shutdowns happen under sudden load spikes or on battery.',
    ],
  },
];

export interface BoardDesignatorReference {
  prefix: string;
  componentType: string;
  role: string;
  commonFailureModes: string;
  safeTestMethod: string;
}

export const BOARD_DESIGNATOR_CATALOG: readonly BoardDesignatorReference[] = [
  {
    prefix: 'U',
    componentType: 'Integrated Circuit (IC / PMIC / EC / USB-PD Controller / BIOS Flash)',
    role: 'Performs active logic, voltage regulation, charging control, or firmware storage.',
    commonFailureModes: 'Thermal cratering, pin corrosion from liquid ingress, internal rail-to-ground short, or cracked BGA solder spheres.',
    safeTestMethod: 'Verify pin-1 orientation, read exact silkscreen part number under magnification, and check adjacent decoupling caps for low resistance to ground before powering.',
  },
  {
    prefix: 'Q',
    componentType: 'Transistor / Power MOSFET (High-side / Low-side Buck Switch or Load Switch)',
    role: 'Switches power rails or acts as reverse-current/inrush protection gate.',
    commonFailureModes: 'Gate-to-source or drain-to-source dead short (often causes instant PSU over-current protection or burnt package).',
    safeTestMethod: 'With power disconnected, check Drain-Source and Gate-Source resistance/diode drop; a dead short across Gate-Source typically confirms a blown MOSFET.',
  },
  {
    prefix: 'C',
    componentType: 'Capacitor (MLCC Ceramic / Polymer / Electrolytic / Tantalum)',
    role: 'Filters ripple, decouples IC power pins, or blocks DC on signal lines.',
    commonFailureModes: 'MLCC flex cracking causing dead shorts to ground; electrolytic bulging/leaking electrolyte with elevated ESR.',
    safeTestMethod: 'Visual check for hairline cracks, discoloration, or bulging tops; in-circuit continuity across a rail cap flags a shorted rail (remember parallel caps share the same rail — isolate carefully).',
  },
  {
    prefix: 'L',
    componentType: 'Inductor / Power Choke (Buck/Boost Converter Coil)',
    role: 'Stores magnetic energy for DC-DC step-down/step-up voltage rails.',
    commonFailureModes: 'Cracked ferrite body from impact, open winding, or downstream short pulling excessive current.',
    safeTestMethod: 'Measure continuity across the coil (<1 Ω normally) and resistance from each pad to ground (lifting one side isolates source vs load-side short for technicians).',
  },
  {
    prefix: 'F',
    componentType: 'Fuse / Resettable Polyfuse (PTC)',
    role: 'Sacrificial over-current protection protecting upstream power sources and PCB traces.',
    commonFailureModes: 'Blown open circuit — almost ALWAYS a symptom of a downstream short rather than a standalone failure.',
    safeTestMethod: 'Measure continuity across the fuse (open = blown). NEVER bridge a blown fuse with wire/foil; find and clear the downstream short first, then replace with the exact rated fuse.',
  },
  {
    prefix: 'D',
    componentType: 'Diode / Schottky Rectifier / TVS ESD Protection Diode',
    role: 'Enforces one-way current flow or clamps electrostatic/over-voltage surges.',
    commonFailureModes: 'TVS diodes intentionally fail shorted to protect downstream ICs during surge or wrong-charger events.',
    safeTestMethod: 'Use multimeter diode mode in both polarities (expected ~0.2–0.7V forward, OL reverse out-of-circuit; ~0.000V both ways signals a shorted TVS/diode).',
  },
  {
    prefix: 'R',
    componentType: 'Resistor / Current-Sense Shunt Resistor',
    role: 'Limits current, sets feedback voltage dividers, or measures rail amperage.',
    commonFailureModes: 'Open circuit / drifted high resistance after overcurrent or liquid corrosion on thin-film terminations.',
    safeTestMethod: 'Inspect for burn marks or corroded end caps; verify resistance against schematic value (note parallel paths may read lower in-circuit).',
  },
];

export function matchHardwareErrorCodes(input: string): ErrorCodeReference[] {
  const lower = input.toLowerCase();
  return ERROR_CODE_CATALOG.filter(
    (entry) =>
      lower.includes(entry.code.toLowerCase()) ||
      entry.aliases.some((a) => lower.includes(a.toLowerCase())),
  );
}

export function matchBoardDesignators(input: string): Array<{ token: string; ref: BoardDesignatorReference }> {
  // Match PCB silkscreen references like U12, Q301, C402, PC14, PL5, F1, D203, R104
  const matches = input.match(/\b(P?[UQLCFDR])(\d{1,4})\b/g) || [];
  const found: Array<{ token: string; ref: BoardDesignatorReference }> = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const token = raw.toUpperCase();
    if (seen.has(token)) continue;
    const letter = token.startsWith('P') && token.length >= 3 && /[UQLCFDR]/.test(token[1]) ? token[1] : token[0];
    const ref = BOARD_DESIGNATOR_CATALOG.find((b) => b.prefix === letter);
    if (ref) {
      seen.add(token);
      found.push({ token, ref });
    }
  }
  return found.slice(0, 5);
}
