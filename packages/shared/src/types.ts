import { z } from 'zod';

// ============================================================================
// CoreSense Brand & Platform Constants
// ============================================================================
export const CORESENSE_VERSION = '1.3.0';
export const CORESENSE_TAGLINE = "Understand what's happening beneath the surface.";
export const CORESENSE_PUBLIC_WEBSITE_URL = 'https://hrdk6.github.io/CoreSense/';

export const PlatformSchema = z.enum(['windows', 'macos', 'linux', 'ios', 'android', 'web']);
export type Platform = z.infer<typeof PlatformSchema>;

export const DeviceCategorySchema = z.enum([
  'laptop',
  'desktop',
  'smartphone',
  'tablet',
  'monitor',
  'printer',
  'gaming_console',
  'router',
  'motherboard',
  'other',
]);
export type DeviceCategory = z.infer<typeof DeviceCategorySchema>;

// ============================================================================
// Measurement Provenance & Evidence Separation
// ============================================================================
export const MeasurementTypeSchema = z.enum([
  'measured',        // Direct local OS/hardware API measurement
  'user_reported',   // User-supplied observation or manual reading (e.g. multimeter)
  'inferred',        // AI interpretation or derived heuristic
  'unavailable',     // OS/platform restriction or missing sensor
  'simulated',       // Explicitly labeled deterministic test fixture
]);
export type MeasurementType = z.infer<typeof MeasurementTypeSchema>;

export const EvidenceKindSchema = z.enum([
  'user_symptom',
  'collected_diagnostic',
  'user_measurement',
  'image_observation',
  'manual_citation',
  'confirmed_finding',
  'limitation_or_uncertainty',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string(),
  kind: EvidenceKindSchema,
  measurementType: MeasurementTypeSchema,
  title: z.string(),
  summary: z.string(),
  source: z.string(),
  collectedAt: z.string(),
  rawPayload: z.record(z.unknown()).optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

// ============================================================================
// Structured Diagnostic Hypotheses (Explicitly NO fabricated confidence %)
// ============================================================================
export const HypothesisStatusSchema = z.enum([
  'active',
  'strengthened',
  'weakened',
  'confirmed',
  'ruled_out',
]);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

export const HypothesisSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  whyPossible: z.string(),
  supportingEvidence: z.array(z.string()),
  conflictingEvidence: z.array(z.string()),
  discriminatingTest: z.string(),
  strengthenCriteria: z.string(),
  weakenCriteria: z.string(),
  status: HypothesisStatusSchema,
  recommendedToolId: z.string().optional(),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

// ============================================================================
// Resolution Verification (5 Strict Outcomes)
// ============================================================================
export const VerificationOutcomeSchema = z.enum([
  'verified_resolved',
  'partially_resolved',
  'still_unresolved',
  'unable_to_verify',
  'requires_professional_inspection',
]);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

export const VerificationReportSchema = z.object({
  outcome: VerificationOutcomeSchema,
  summary: z.string(),
  baselineCollectedAt: z.string().optional(),
  followupCollectedAt: z.string().optional(),
  metricComparisons: z.array(
    z.object({
      metric: z.string(),
      before: z.string(),
      after: z.string(),
      deltaAssessment: z.enum(['improved', 'unchanged', 'worsened', 'not_comparable']),
    }),
  ),
  remainingRisks: z.array(z.string()),
  verifiedAt: z.string(),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

// ============================================================================
// Diagnostic Snapshot Schema
// ============================================================================
export const DiagnosticWarningSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  component: z.enum([
    'cpu',
    'memory',
    'storage',
    'gpu',
    'network',
    'os',
    'battery',
    'thermal',
    'audio',
    'display',
    'camera',
    'sensor',
    'usb',
    'bluetooth',
    'peripherals',
    'soc',
    'benchmark',
  ]),
  title: z.string(),
  detail: z.string(),
});
export type DiagnosticWarning = z.infer<typeof DiagnosticWarningSchema>;

export const DiagnosticResultSchema = z.object({
  id: z.string(),
  toolId: z.string(),
  measurementType: MeasurementTypeSchema,
  simulatedScenarioId: z.string().optional(),
  source: z.string(),
  platform: PlatformSchema,
  osVersion: z.string(),
  collectedAt: z.string(),
  durationMs: z.number(),
  summary: z.string(),
  limitations: z.array(z.string()),
  warnings: z.array(DiagnosticWarningSchema),
  data: z.record(z.unknown()),
});
export type DiagnosticResult = z.infer<typeof DiagnosticResultSchema>;

// ============================================================================
// Device & Repair Case Schemas
// ============================================================================
export const DeviceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  category: DeviceCategorySchema,
  manufacturer: z.string().max(80).default(''),
  model: z.string().max(120).default(''),
  serialOrTag: z.string().max(100).optional(),
  osName: z.string().max(80).optional(),
  osVersion: z.string().max(80).optional(),
  specs: z.record(z.string()).default({}),
  notes: z.string().max(4000).default(''),
  purchaseDate: z.string().optional(),
  purchasePrice: z.number().min(0).optional(),
  currency: z.string().max(8).default('USD'),
});
export type DeviceCreateInput = z.infer<typeof DeviceCreateSchema>;

export const RepairCaseCreateSchema = z.object({
  deviceId: z.string().optional(),
  investigationId: z.string().optional(),
  title: z.string().min(2).max(160),
  symptomSummary: z.string().max(3000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  status: z.enum(['open', 'investigating', 'waiting_parts', 'resolved', 'referred_pro', 'closed']).default('open'),
});
export type RepairCaseCreateInput = z.infer<typeof RepairCaseCreateSchema>;

export const RepairExpenseSchema = z.object({
  itemName: z.string().min(1).max(140),
  category: z.enum(['part', 'tool', 'service', 'shipping', 'other']).default('part'),
  amount: z.number().min(0),
  currency: z.string().max(8).default('USD'),
  vendor: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
});

// ============================================================================
// Cross-Device Synchronization Schemas
// ============================================================================
export const SyncEntityTypeSchema = z.enum([
  'device',
  'investigation',
  'repair_case',
  'document',
  'diagnostic_snapshot',
]);
export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;

export const SyncMutationSchema = z.object({
  clientMutationId: z.string(),
  entityType: SyncEntityTypeSchema,
  entityId: z.string(),
  operation: z.enum(['upsert', 'delete']),
  baseRevision: z.number().int().min(0),
  payload: z.record(z.unknown()),
  clientTimestamp: z.string(),
});
export type SyncMutation = z.infer<typeof SyncMutationSchema>;

// ============================================================================
// Predictive ML Telemetry Anomaly & Degradation Engine Schemas
// ============================================================================
export const HealthSubsystemSchema = z.enum([
  'cpu',
  'memory',
  'storage',
  'gpu',
  'battery',
  'network',
  'thermal',
  'peripherals',
]);
export type HealthSubsystem = z.infer<typeof HealthSubsystemSchema>;

export const SubsystemHealthScoreSchema = z.object({
  subsystem: HealthSubsystemSchema,
  score: z.number().min(0).max(100).nullable(),
  status: z.enum(['healthy', 'attention', 'degraded', 'critical', 'insufficient_data']),
  sampleCount: z.number().int().min(0),
  latestSummary: z.string(),
  factors: z.array(z.string()),
});
export type SubsystemHealthScore = z.infer<typeof SubsystemHealthScoreSchema>;

export const TelemetryAnomalySchema = z.object({
  id: z.string(),
  metric: z.string(),
  subsystem: HealthSubsystemSchema,
  severity: z.enum(['info', 'warning', 'critical']),
  latestValue: z.number(),
  unit: z.string(),
  baselineMedian: z.number(),
  baselineSpread: z.number(),
  zScore: z.number(),
  method: z.enum(['modified_z_mad', 'standard_z']),
  sampleCount: z.number().int().min(1),
  explanation: z.string(),
  detectedAt: z.string(),
});
export type TelemetryAnomaly = z.infer<typeof TelemetryAnomalySchema>;

export const DegradationForecastSchema = z.object({
  metric: z.string(),
  subsystem: z.enum(['battery', 'storage', 'thermal']),
  currentValue: z.number(),
  unit: z.string(),
  slopePerDay: z.number(),
  rSquared: z.number().min(0).max(1),
  thresholdValue: z.number(),
  thresholdLabel: z.string(),
  estimatedDaysToThreshold: z.number().nullable(),
  status: z.enum(['stable', 'degrading', 'urgent', 'insufficient_history']),
  sampleCount: z.number().int().min(0),
  spanDays: z.number().min(0),
  explanation: z.string(),
});
export type DegradationForecast = z.infer<typeof DegradationForecastSchema>;

export const SystemHealthAnalysisSchema = z.object({
  analyzedAt: z.string(),
  deviceId: z.string().nullable(),
  totalSnapshotsAnalyzed: z.number().int().min(0),
  realSnapshotsAnalyzed: z.number().int().min(0),
  baselineReady: z.boolean(),
  overallHealthScore: z.number().min(0).max(100).nullable(),
  overallStatus: z.enum(['healthy', 'attention', 'degraded', 'critical', 'insufficient_data']),
  methodology: z.string(),
  subsystemScores: z.array(SubsystemHealthScoreSchema),
  anomalies: z.array(TelemetryAnomalySchema),
  forecasts: z.array(DegradationForecastSchema),
  summaryBullets: z.array(z.string()),
});
export type SystemHealthAnalysis = z.infer<typeof SystemHealthAnalysisSchema>;

// ============================================================================
// Structured Multimodal Vision PCB / Hardware Inspector Schemas
// ============================================================================
export const PcbComponentConditionSchema = z.enum([
  'normal',
  'suspect_burn',
  'suspect_corrosion',
  'suspect_cracked',
  'suspect_bulged',
  'missing_or_lifted',
  'loose_or_bent',
  'unreadable',
]);
export type PcbComponentCondition = z.infer<typeof PcbComponentConditionSchema>;

export const PcbComponentFindingSchema = z.object({
  designator: z.string(),
  componentType: z.string(),
  functionSummary: z.string(),
  visualCondition: PcbComponentConditionSchema,
  region: z.string(),
  visualEvidence: z.string(),
  boundingBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});
export type PcbComponentFinding = z.infer<typeof PcbComponentFindingSchema>;

export const ElectricalTestRequirementSchema = z.object({
  target: z.string(),
  testMethod: z.string(),
  expectedBaseline: z.string(),
  safetyNote: z.string(),
});
export type ElectricalTestRequirement = z.infer<typeof ElectricalTestRequirementSchema>;

export const StructuredPcbInspectionSchema = z.object({
  analysisMode: z.enum([
    'gemini_vision_structured',
    'openai_vision_structured',
    'local_metadata_fallback',
  ]),
  boardOrDeviceType: z.string(),
  imageClarity: z.enum(['clear', 'moderate', 'unclear_macro_needed']),
  clarityNotes: z.string(),
  identifiedComponents: z.array(PcbComponentFindingSchema),
  visualAnomalies: z.array(z.string()),
  electricalTestsRequired: z.array(ElectricalTestRequirementSchema),
  safetyWarnings: z.array(z.string()),
  disclaimer: z.string(),
});
export type StructuredPcbInspection = z.infer<typeof StructuredPcbInspectionSchema>;
