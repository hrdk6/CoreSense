import type { ExpertiseMode } from './types.js';

// ============================================================================
// Hardware Repair Safety Policy & Hazard Classifier
// CoreSense takes physical electronics safety seriously: high-voltage mains,
// charged PSU/CRT/microwave capacitors, swollen or punctured Li-ion batteries,
// liquid-damaged live electronics, and hazardous board-level soldering.
// ============================================================================

export type HazardSeverity = 'caution' | 'high_risk' | 'critical_stop';

export interface SafetyAssessment {
  triggered: boolean;
  highestSeverity: HazardSeverity | null;
  hazards: Array<{
    code: string;
    title: string;
    severity: HazardSeverity;
    riskExplanation: string;
    safeGuidance: string;
    requiresProfessionalReferral: boolean;
  }>;
  blockDirectRepairInstructions: boolean;
}

interface HazardRule {
  code: string;
  title: string;
  severity: HazardSeverity;
  patterns: RegExp[];
  riskExplanation: string;
  everydayGuidance: string;
  technicianGuidance: string;
  blockForEveryday: boolean;
  blockForAll: boolean;
}

const HAZARD_RULES: HazardRule[] = [
  {
    code: 'SWOLLEN_OR_DAMAGED_LITHIUM_BATTERY',
    title: 'Swollen, Punctured, or Thermal-Runaway Lithium Battery Hazard',
    severity: 'critical_stop',
    patterns: [
      /\b(swollen|bloated|puffy|bulging|expanding|punctured|pierced|hissing|smoking|venting|leaking)\b.{0,40}\b(battery|cell|lithium|li-ion|lipo|pack)\b/i,
      /\b(battery|cell|lithium|li-ion|lipo)\b.{0,40}\b(swollen|bloated|puffy|bulging|punctured|pierced|hissing|smoking|venting|hot to touch|burning|fire|poke|pry|flatten)\b/i,
      /\b(poke|puncture|stab|squeeze|flatten|drain with needle)\b.{0,30}\b(battery|cell)\b/i,
    ],
    riskExplanation:
      'Damaged or swollen lithium-ion cells contain flammable electrolyte and pressurized gas. Puncturing, bending, charging, or prying them can trigger violent thermal runaway, toxic fumes, and fire.',
    everydayGuidance:
      'STOP immediately. Do NOT charge the device, press down on the battery, or attempt to puncture or pry it out. Power the device down safely if possible, move it away from flammable materials to a well-ventilated area, and take it to an authorized repair center or certified battery recycling facility.',
    technicianGuidance:
      'Treat as an active thermal-runaway hazard. Isolate power immediately, do not apply heat or metal pry tools directly to the pouch cell, keep a Class D/sand containment tray available, discharge safely only if undamaged, and transfer immediately to hazardous e-waste containment. Never puncture or compress a swollen cell.',
    blockForEveryday: true,
    blockForAll: true,
  },
  {
    code: 'HIGH_VOLTAGE_PSU_CAPACITOR',
    title: 'High-Voltage Power Supply / Mains Capacitor Shock Hazard',
    severity: 'critical_stop',
    patterns: [
      /\b(open|disassemble|touch|probe|bypass|short|fix|repair|solder)\b.{0,40}\b(power supply|psu|smps|crt|microwave|transformer|mains|240v|220v|120v|ac line|high voltage|hv capacitor|primary capacitor|inverter board)\b/i,
      /\b(power supply|psu|crt|microwave|mains|high voltage|primary capacitor|bulk capacitor)\b.{0,40}\b(open|inside|capacitor|discharge|shock|bypass fuse|bridge fuse|wire directly)\b/i,
      /\b(bypass|bridge|foil|jumper)\b.{0,25}\b(fuse|breaker|thermal cutoff)\b/i,
    ],
    riskExplanation:
      'Mains-powered equipment, desktop PSUs, CRT flybacks, and microwave capacitors store lethal DC voltages (300V–25,000V+) even after being unplugged from the wall. Bypassing fuses removes critical fire and electrocution protection.',
    everydayGuidance:
      'DO NOT open the power supply enclosure or probe internal components. Lethal voltage can remain stored inside capacitors even when unplugged. Replace sealed power supplies as complete UL/CE-listed units or consult a licensed electronics technician.',
    technicianGuidance:
      'Lethal primary-side energy hazard (320V–400V DC bus on PFC/SMPS primaries; >2kV in microwaves/CRTs). Never bypass safety fuses or work without an isolation transformer, CAT-III rated probes, verified discharge through an appropriate high-wattage bleed resistor, and zero-voltage verification with a calibrated multimeter. For sealed consumer ATX/laptop PSUs, full unit replacement is strongly advised over live internal repair.',
    blockForEveryday: true,
    blockForAll: false,
  },
  {
    code: 'LIVE_LIQUID_DAMAGE',
    title: 'Liquid-Damaged Energized Electronics Hazard',
    severity: 'high_risk',
    patterns: [
      /\b(spilled|water|liquid|coffee|soda|dropped in water|wet|submerged)\b.{0,40}\b(plug in|turn on|charge|hair dryer|rice|power on|oven|microwave)\b/i,
      /\b(charging|plugged in)\b.{0,30}\b(wet|water|liquid|spilled)\b/i,
    ],
    riskExplanation:
      'Applying power or charging a wet device causes rapid electrochemical corrosion, internal short circuits, and potential battery overheating or electric shock.',
    everydayGuidance:
      'Unplug the charger safely (from the wall first if the cable is wet), power off the device immediately, and do NOT try to charge it or dry it with a hot hair dryer/oven (and avoid rice, which introduces dust and starch). Have the board inspected and cleaned professionally before re-energizing.',
    technicianGuidance:
      'Keep power and battery disconnected immediately. Do not power-cycle to "test". Disassemble, inspect under magnification for corrosion around power rails/PMICs, clean with high-purity isopropyl alcohol (99%) or ultrasonic bath where appropriate, verify no dead shorts on main rails before applying current-limited bench power.',
    blockForEveryday: true,
    blockForAll: false,
  },
  {
    code: 'BOARD_LEVEL_SOLDERING_REWORK',
    title: 'Board-Level Soldering / Hot-Air Rework Risk',
    severity: 'caution',
    patterns: [
      /\b(solder|desolder|reflow|reball|hot air|bga|microsolder|micro-solder|jumper wire|replace mosfet|replace ic|replace capacitor on motherboard)\b/i,
    ],
    riskExplanation:
      'Motherboard rework involves 300–400°C tools, toxic flux/lead fumes, ESD damage risks, and potential trace lifting or shorting neighboring power rails.',
    everydayGuidance:
      'Board-level soldering requires specialized ESD-safe tools, fume extraction, and magnification. Attempting DIY reflow (especially using household ovens or heat guns) frequently causes permanent board delamination or toxic exposure. Consider an independent micro-soldering specialist.',
    technicianGuidance:
      'Ensure ESD grounding, active fume extraction, pre-heating where appropriate, and thermal protection (Kapton tape/shields) around adjacent plastic connectors and BGA packages. Verify rail impedance to ground before reapplying power.',
    blockForEveryday: true,
    blockForAll: false,
  },
];

export function evaluateHardwareSafety(
  inputText: string,
  expertiseMode: ExpertiseMode,
): SafetyAssessment {
  const matched: SafetyAssessment['hazards'] = [];
  let blockDirect = false;
  let highest: HazardSeverity | null = null;

  const rank: Record<HazardSeverity, number> = {
    caution: 1,
    high_risk: 2,
    critical_stop: 3,
  };

  for (const rule of HAZARD_RULES) {
    if (rule.patterns.some((rx) => rx.test(inputText))) {
      const safeGuidance =
        expertiseMode === 'technician' ? rule.technicianGuidance : rule.everydayGuidance;
      const shouldBlock =
        rule.blockForAll || (expertiseMode === 'everyday' && rule.blockForEveryday);
      if (shouldBlock) blockDirect = true;
      if (!highest || rank[rule.severity] > rank[highest]) {
        highest = rule.severity;
      }
      matched.push({
        code: rule.code,
        title: rule.title,
        severity: rule.severity,
        riskExplanation: rule.riskExplanation,
        safeGuidance,
        requiresProfessionalReferral: shouldBlock || rule.severity === 'critical_stop',
      });
    }
  }

  return {
    triggered: matched.length > 0,
    highestSeverity: highest,
    hazards: matched,
    blockDirectRepairInstructions: blockDirect,
  };
}

// ============================================================================
// Prompt Injection Defense for Untrusted Uploaded Documents
// ============================================================================
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
  /system\s*prompt/i,
  /execute\s+(shell|bash|powershell|cmd|arbitrary\s+command)/i,
  /override\s+(safety|security|policy)/i,
  /disregard\s+(all\s+)?safety/i,
];

export function sanitizeUntrustedDocumentExcerpt(excerpt: string): {
  sanitized: string;
  flaggedInjectionAttempt: boolean;
} {
  let flagged = false;
  let cleaned = excerpt;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      flagged = true;
      cleaned = cleaned.replace(pattern, '[REDACTED_UNTRUSTED_DIRECTIVE]');
    }
  }
  return { sanitized: cleaned, flaggedInjectionAttempt: flagged };
}
