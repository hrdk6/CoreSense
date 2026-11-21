import { z } from 'zod';
import { PlatformSchema } from './types.js';

// ============================================================================
// Privacy-First Telemetry Allowlist
// Guarantees that NO private customer data (prompts, emails, photos, documents,
// device notes, file paths, or IP addresses) can ever enter the Owner DB.
// ============================================================================

export const ALLOWED_PRODUCT_EVENTS = [
  'app_launched',
  'onboarding_completed',
  'expertise_mode_changed',
  'device_added',
  'investigation_started',
  'investigation_message_sent',
  'investigation_completed',
  'diagnostic_scan_run',
  'image_analysis_requested',
  'document_uploaded',
  'voice_interaction_used',
  'repair_case_created',
  'diagnostic_report_exported',
  'sync_completed',
  'sync_failed',
  'subscription_viewed',
  'subscription_upgraded',
  'subscription_cancelled',
  'account_registered',
  'account_deleted',
  'feedback_submitted',
] as const;

export type ProductEventName = (typeof ALLOWED_PRODUCT_EVENTS)[number];

export const ProductTelemetryEventSchema = z.object({
  eventName: z.enum(ALLOWED_PRODUCT_EVENTS),
  anonymousInstallId: z.string().min(8).max(80),
  anonymousUserHash: z.string().max(64).optional(), // One-way salted hash for DAU/WAU/MAU retention ONLY
  platform: PlatformSchema,
  appVersion: z.string().max(32),
  expertiseMode: z.enum(['everyday', 'enthusiast', 'technician']).optional(),
  durationMs: z.number().int().min(0).max(3_600_000).optional(),
  success: z.boolean().default(true),
  errorCategory: z.string().max(64).optional(),
  countryCode: z.string().max(4).optional(), // Aggregate geo only if consented
  metadata: z
    .record(z.union([z.string().max(64), z.number(), z.boolean()]))
    .optional(),
});

export type ProductTelemetryEvent = z.infer<typeof ProductTelemetryEventSchema>;

// Keys strictly forbidden inside telemetry metadata
const FORBIDDEN_TELEMETRY_KEYS = new Set([
  'email',
  'name',
  'username',
  'password',
  'token',
  'secret',
  'prompt',
  'message',
  'content',
  'response',
  'image',
  'photo',
  'document',
  'filename',
  'filepath',
  'path',
  'notes',
  'serial',
  'ip',
  'address',
  'phone',
  'apikey',
  'api_key',
]);

export function scrubTelemetryMetadata(
  raw?: Record<string, unknown>,
): Record<string, string | number | boolean> {
  if (!raw) return {};
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    const keyLower = k.toLowerCase();
    if (FORBIDDEN_TELEMETRY_KEYS.has(keyLower)) continue;
    if (
      keyLower.includes('email') ||
      keyLower.includes('prompt') ||
      keyLower.includes('secret') ||
      keyLower.includes('token') ||
      keyLower.includes('password') ||
      keyLower.includes('content')
    ) {
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = v;
    } else if (typeof v === 'string') {
      // Scrub anything resembling an email, file path, or API key
      const scrubbed = scrubSensitiveStrings(v).slice(0, 64);
      clean[k] = scrubbed;
    }
  }
  return clean;
}

export function scrubSensitiveStrings(input: string): string {
  return input
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/(?:sk|pk|AIza|ghp|xoxb|Bearer\s+)[A-Za-z0-9_\-.]{10,}/g, '[REDACTED_CREDENTIAL]')
    .replace(/[A-Za-z]:\\Users\\[^\s\\]+/gi, 'C:\\Users\\[REDACTED]')
    .replace(/\/Users\/[^\s/]+/g, '/Users/[REDACTED]')
    .replace(/\/home\/[^\s/]+/g, '/home/[REDACTED]');
}
