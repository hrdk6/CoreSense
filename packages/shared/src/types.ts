import { z } from 'zod';

// ============================================================================
// CoreSense Brand & Platform Constants
// ============================================================================
export const CORESENSE_VERSION = '1.0.0';
export const CORESENSE_TAGLINE = "Understand what's happening beneath the surface.";

export const ExpertiseModeSchema = z.enum(['everyday', 'enthusiast', 'technician']);
export type ExpertiseMode = z.infer<typeof ExpertiseModeSchema>;

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
  component: z.enum(['cpu', 'memory', 'storage', 'network', 'os', 'battery', 'thermal', 'audio', 'display', 'camera', 'sensor']),
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
// Device, Case & Document Schemas
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
// Subscription & Entitlement Schemas (Dynamic — Never Hardcoded Pricing)
// ============================================================================
export const PlanTierSchema = z.enum(['free', 'pro', 'premium']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

export const PlanConfigSchema = z.object({
  tier: PlanTierSchema,
  displayName: z.string(),
  description: z.string(),
  monthlyPriceCents: z.number().int().min(0),
  annualPriceCents: z.number().int().min(0),
  currency: z.string().default('USD'),
  limits: z.object({
    aiMessagesPerMonth: z.number().int(),
    imageAnalysesPerMonth: z.number().int(),
    documentUploadsMax: z.number().int(),
    maxDevices: z.number().int(),
    cloudSyncEnabled: z.boolean(),
    advancedDiagnosticExport: z.boolean(),
    voiceCopilotEnabled: z.boolean(),
  }),
  active: z.boolean().default(true),
});
export type PlanConfig = z.infer<typeof PlanConfigSchema>;

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
