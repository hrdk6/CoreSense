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
  safeGuidance: string;
  blockDirect: boolean;
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
      'Damaged or swollen lithium-ion cells contain flammable electrolyte and pressurized gas. Puncturing, bending, charging, applying heat, or prying them can trigger violent thermal runaway, toxic fumes, and fire.',
    safeGuidance:
      'STOP immediately. Do NOT charge the device, compress the battery, apply heat/metal pry tools to the cell, or attempt to puncture it. Power off safely, move it away from flammable surfaces to a well-ventilated area, and bring it to an authorized repair shop or certified hazardous battery recycler.',
    blockDirect: true,
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
      'Mains-powered equipment, desktop SMPS/ATX PSUs (320V–400V DC primary bus), CRT flybacks, and microwave capacitors store lethal energy even when unplugged. Bypassing fuses removes critical fire and electrocution protection.',
    safeGuidance:
      'DO NOT open sealed power supplies or bridge blown fuses. Lethal voltage remains stored in primary bulk capacitors after unplugging. Replace sealed PSUs/adapters with UL/CE-listed units or hand off to a licensed electronics technician equipped with an isolation transformer, CAT-III probes, and bleed-resistor discharge verification.',
    blockDirect: true,
  },
  {
    code: 'LIVE_LIQUID_DAMAGE',
    title: 'Liquid-Damaged Energized Electronics Hazard',
    severity: 'high_risk',
    patterns: [
      /\b(spilled|water|liquid|coffee|soda|dropped in water|wet|submerged)\b.{0,50}\b(plug(?:ged)?[\s-]?in|turn on|charge|charging|hair dryer|rice|power on|oven|microwave|smoke|smelled smoke|spark|burning smell|energized|live)\b/i,
      /\b(charging|plug(?:ged)?[\s-]?in)\b.{0,40}\b(wet|water|liquid|spilled|coffee|soda|smoke|spark)\b/i,
    ],
    riskExplanation:
      'Applying power or charging wet electronics causes immediate electrochemical corrosion across power rails, internal short circuits, battery overheating, or electric shock.',
    safeGuidance:
      'Unplug from the wall safely, power off and disconnect the battery immediately if accessible, and do NOT charge, power-cycle to "test", or use a hair dryer/oven/rice. Inspect for corrosion under magnification, clean with 99% isopropyl alcohol (or ultrasonic cleaning by a board repair shop), and verify no rail shorts before re-energizing.',
    blockDirect: true,
  },
  {
    code: 'BOARD_LEVEL_SOLDERING_REWORK',
    title: 'Board-Level Soldering / Hot-Air Rework Caution',
    severity: 'caution',
    patterns: [
      /\b(solder|desolder|reflow|reball|hot air|bga|microsolder|micro-solder|jumper wire|replace mosfet|replace ic|replace capacitor on motherboard)\b/i,
    ],
    riskExplanation:
      'Motherboard rework involves 300–400°C tools, toxic flux/lead fumes, ESD sensitivity, and risk of lifting PCB pads or shorting adjacent power rails.',
    safeGuidance:
      'Only attempt board-level rework with ESD grounding, active fume extraction, temperature-controlled soldering/hot-air tools, Kapton shielding around nearby plastic connectors, and post-rework rail impedance verification before powering on. Never use household ovens or paint heat guns to "reflow" boards.',
    blockDirect: false,
  },
];

export function evaluateHardwareSafety(inputText: string): SafetyAssessment {
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
      if (rule.blockDirect) blockDirect = true;
      if (!highest || rank[rule.severity] > rank[highest]) {
        highest = rule.severity;
      }
      matched.push({
        code: rule.code,
        title: rule.title,
        severity: rule.severity,
        riskExplanation: rule.riskExplanation,
        safeGuidance: rule.safeGuidance,
        requiresProfessionalReferral: rule.blockDirect || rule.severity === 'critical_stop',
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
