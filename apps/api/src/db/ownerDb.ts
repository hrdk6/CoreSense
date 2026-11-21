import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  type PlanConfig,
  type ProductTelemetryEvent,
  scrubSensitiveStrings,
  scrubTelemetryMetadata,
} from '@coresense/shared';
import { hashPassword } from '../security/crypto.js';

// ============================================================================
// Physically Separate Owner Observability & Business Operations Database
// STRICT PRIVACY BOUNDARY: Never stores customer emails (except voluntary
// owner admin login), prompts, responses, photographs, manuals, or device data.
// ============================================================================

const DEFAULT_PLANS: PlanConfig[] = [
  {
    tier: 'free',
    displayName: 'CoreSense Free',
    description: 'Essential local diagnostics, personal device library, and AI repair guidance for everyday device care.',
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    currency: 'USD',
    limits: {
      aiMessagesPerMonth: 150,
      imageAnalysesPerMonth: 25,
      documentUploadsMax: 10,
      maxDevices: 10,
      cloudSyncEnabled: true,
      advancedDiagnosticExport: true,
      voiceCopilotEnabled: true,
    },
    active: true,
  },
  {
    tier: 'pro',
    displayName: 'CoreSense Pro',
    description: 'Expanded multimodal diagnostics, service-manual RAG indexing, cross-device sync, and full repair reporting.',
    monthlyPriceCents: 1499,
    annualPriceCents: 14900,
    currency: 'USD',
    limits: {
      aiMessagesPerMonth: 2000,
      imageAnalysesPerMonth: 250,
      documentUploadsMax: 100,
      maxDevices: 50,
      cloudSyncEnabled: true,
      advancedDiagnosticExport: true,
      voiceCopilotEnabled: true,
    },
    active: true,
  },
  {
    tier: 'premium',
    displayName: 'CoreSense Workbench',
    description: 'High-volume board-level vision, priority frontier reasoning, unlimited personal manuals, and deep repair archives.',
    monthlyPriceCents: 2999,
    annualPriceCents: 29900,
    currency: 'USD',
    limits: {
      aiMessagesPerMonth: 10000,
      imageAnalysesPerMonth: 1500,
      documentUploadsMax: 500,
      maxDevices: 250,
      cloudSyncEnabled: true,
      advancedDiagnosticExport: true,
      voiceCopilotEnabled: true,
    },
    active: true,
  },
];

export class OwnerDatabase {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;

  constructor(
    dataDir: string,
    initialOwnerEmail: string,
    initialOwnerPassword: string,
    filename = 'coresense_owner.db',
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = filename === ':memory:' ? ':memory:' : path.join(dataDir, filename);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    this.bootstrapDefaults(initialOwnerEmail, initialOwnerPassword);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_admins (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        last_login_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installer_downloads (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'direct',
        app_version TEXT NOT NULL,
        architecture TEXT NOT NULL DEFAULT 'x64',
        country_code TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_activations (
        install_id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'direct',
        country_code TEXT,
        first_activated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_lifecycle (
        anonymous_user_hash TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        plan_tier TEXT NOT NULL DEFAULT 'free',
        registered_at TEXT NOT NULL,
        deleted_at TEXT,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS product_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        anonymous_install_id TEXT NOT NULL,
        anonymous_user_hash TEXT,
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        expertise_mode TEXT,
        duration_ms INTEGER,
        success INTEGER NOT NULL DEFAULT 1,
        error_category TEXT,
        country_code TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      -- Strictly aggregate token/latency/cost ledger (ZERO prompts or user content!)
      CREATE TABLE IF NOT EXISTS ai_usage_ledger (
        id TEXT PRIMARY KEY,
        anonymous_user_hash TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        feature TEXT NOT NULL,
        modality TEXT NOT NULL DEFAULT 'text',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS billing_events (
        id TEXT PRIMARY KEY,
        anonymous_user_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        plan_tier TEXT NOT NULL,
        billing_cycle TEXT NOT NULL DEFAULT 'monthly',
        amount_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        provider TEXT NOT NULL DEFAULT 'sandbox',
        external_event_id TEXT,
        verified INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crash_reports (
        id TEXT PRIMARY KEY,
        anonymous_install_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        component TEXT NOT NULL,
        error_name TEXT NOT NULL,
        scrubbed_message TEXT NOT NULL,
        scrubbed_stack TEXT,
        startup_ms INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        route_pattern TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_feedback (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        rating INTEGER,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        non_sensitive_error_code TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL
      );

      -- Only populated when a customer EXPLICITLY clicks "Authorize Support Bundle"
      CREATE TABLE IF NOT EXISTS opt_in_support_reports (
        id TEXT PRIMARY KEY,
        consent_confirmed INTEGER NOT NULL DEFAULT 1,
        consent_timestamp TEXT NOT NULL,
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        summary TEXT NOT NULL,
        attached_diagnostics_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plan_configs (
        tier TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        metric_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        threshold_value REAL NOT NULL,
        unit TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS product_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pe_created ON product_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_pe_name ON product_events(event_name);
      CREATE INDEX IF NOT EXISTS idx_pe_user ON product_events(anonymous_user_hash);
      CREATE INDEX IF NOT EXISTS idx_ai_created ON ai_usage_ledger(created_at);
      CREATE INDEX IF NOT EXISTS idx_billing_created ON billing_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_api_created ON api_metrics(created_at);
      CREATE INDEX IF NOT EXISTS idx_crashes_created ON crash_reports(created_at);
    `);
  }

  private bootstrapDefaults(ownerEmail: string, ownerPassword: string): void {
    const now = new Date().toISOString();
    const existingAdmin = this.db.prepare('SELECT id FROM owner_admins LIMIT 1').get();
    if (!existingAdmin) {
      this.db
        .prepare(
          'INSERT INTO owner_admins (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          crypto.randomUUID(),
          ownerEmail.toLowerCase().trim(),
          'CoreSense Owner',
          hashPassword(ownerPassword),
          now,
        );
    }

    for (const plan of DEFAULT_PLANS) {
      const exists = this.db.prepare('SELECT tier FROM plan_configs WHERE tier = ?').get(plan.tier);
      if (!exists) {
        this.db
          .prepare('INSERT INTO plan_configs (tier, config_json, updated_at) VALUES (?, ?, ?)')
          .run(plan.tier, JSON.stringify(plan), now);
      }
    }

    const defaultAlerts = [
      { id: 'alert-ai-budget', metric_key: 'monthly_ai_cost_usd', label: 'Monthly AI Spend Budget', threshold_value: 250, unit: 'USD' },
      { id: 'alert-error-rate', metric_key: 'api_5xx_rate_percent', label: 'API 5xx Error Rate', threshold_value: 2.0, unit: '%' },
      { id: 'alert-crash-rate', metric_key: 'crash_rate_percent', label: 'Client Crash Rate', threshold_value: 1.5, unit: '%' },
      { id: 'alert-ai-latency', metric_key: 'ai_avg_latency_ms', label: 'AI Average Inference Latency', threshold_value: 8000, unit: 'ms' },
    ];
    for (const a of defaultAlerts) {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO alert_rules (id, metric_key, label, threshold_value, unit, enabled, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        )
        .run(a.id, a.metric_key, a.label, a.threshold_value, a.unit, now);
    }

    const defaultConfig: Record<string, unknown> = {
      latestDesktopVersion: '1.0.0',
      latestMobileVersion: '1.0.0',
      maintenanceMode: false,
      defaultFreeTrialDays: 14,
      telemetryRetentionDays: 365,
    };
    for (const [k, v] of Object.entries(defaultConfig)) {
      this.db
        .prepare('INSERT OR IGNORE INTO product_config (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(k, JSON.stringify(v), now);
    }
  }

  public getPlans(): PlanConfig[] {
    const rows = this.db.prepare('SELECT config_json FROM plan_configs').all() as Array<{ config_json: string }>;
    const order: Record<string, number> = { free: 0, pro: 1, premium: 2 };
    return rows
      .map((r) => JSON.parse(r.config_json) as PlanConfig)
      .sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9));
  }

  public getPlan(tier: string): PlanConfig | undefined {
    const row = this.db.prepare('SELECT config_json FROM plan_configs WHERE tier = ?').get(tier) as
      | { config_json: string }
      | undefined;
    return row ? (JSON.parse(row.config_json) as PlanConfig) : undefined;
  }

  public recordProductEvent(event: ProductTelemetryEvent): void {
    const now = new Date().toISOString();
    const safeMeta = scrubTelemetryMetadata(event.metadata);
    this.db
      .prepare(
        `INSERT INTO product_events (
          id, event_name, anonymous_install_id, anonymous_user_hash, platform,
          app_version, expertise_mode, duration_ms, success, error_category,
          country_code, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        event.eventName,
        event.anonymousInstallId,
        event.anonymousUserHash ?? null,
        event.platform,
        event.appVersion,
        event.expertiseMode ?? null,
        event.durationMs ?? null,
        event.success ? 1 : 0,
        event.errorCategory ? scrubSensitiveStrings(event.errorCategory).slice(0, 64) : null,
        event.countryCode ?? null,
        JSON.stringify(safeMeta),
        now,
      );

    if (event.anonymousUserHash) {
      this.db
        .prepare('UPDATE account_lifecycle SET last_active_at = ? WHERE anonymous_user_hash = ?')
        .run(now, event.anonymousUserHash);
    }
  }

  public recordActivation(
    installId: string,
    platform: string,
    appVersion: string,
    channel = 'direct',
    countryCode?: string,
  ): { isFirstActivation: boolean } {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT install_id FROM app_activations WHERE install_id = ?')
      .get(installId);
    if (existing) {
      this.db
        .prepare('UPDATE app_activations SET last_seen_at = ?, app_version = ? WHERE install_id = ?')
        .run(now, appVersion, installId);
      return { isFirstActivation: false };
    }
    this.db
      .prepare(
        'INSERT INTO app_activations (install_id, platform, app_version, channel, country_code, first_activated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(installId, platform, appVersion, channel, countryCode ?? null, now, now);
    return { isFirstActivation: true };
  }

  public recordInstallerDownload(
    platform: string,
    appVersion: string,
    channel = 'direct',
    architecture = 'x64',
    countryCode?: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO installer_downloads (id, platform, channel, app_version, architecture, country_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(crypto.randomUUID(), platform, channel, appVersion, architecture, countryCode ?? null, new Date().toISOString());
  }

  public recordAccountRegistration(anonymousUserHash: string, platform: string, planTier = 'free'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO account_lifecycle (anonymous_user_hash, platform, plan_tier, registered_at, last_active_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(anonymousUserHash, platform, planTier, now, now);
  }

  public recordAccountDeletion(anonymousUserHash: string): void {
    this.db
      .prepare('UPDATE account_lifecycle SET deleted_at = ? WHERE anonymous_user_hash = ?')
      .run(new Date().toISOString(), anonymousUserHash);
  }

  public recordAiUsage(params: {
    anonymousUserHash?: string;
    provider: string;
    model: string;
    feature: string;
    modality: 'text' | 'vision' | 'voice' | 'embedding';
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    estimatedCostUsd: number;
    success: boolean;
    errorCode?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage_ledger (
          id, anonymous_user_hash, provider, model, feature, modality,
          input_tokens, output_tokens, latency_ms, estimated_cost_usd,
          success, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        params.anonymousUserHash ?? null,
        params.provider,
        params.model,
        params.feature,
        params.modality,
        params.inputTokens,
        params.outputTokens,
        params.latencyMs,
        params.estimatedCostUsd,
        params.success ? 1 : 0,
        params.errorCode ?? null,
        new Date().toISOString(),
      );
  }

  public recordBillingEvent(params: {
    anonymousUserHash: string;
    eventType: 'subscription_started' | 'subscription_upgraded' | 'subscription_renewed' | 'subscription_cancelled' | 'refund' | 'payment_failed' | 'trial_converted';
    planTier: string;
    billingCycle: 'monthly' | 'annual';
    amountCents: number;
    currency?: string;
    provider: 'stripe' | 'apple_iap' | 'google_play' | 'sandbox';
    externalEventId?: string;
    verified?: boolean;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO billing_events (
          id, anonymous_user_hash, event_type, plan_tier, billing_cycle,
          amount_cents, currency, provider, external_event_id, verified, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        params.anonymousUserHash,
        params.eventType,
        params.planTier,
        params.billingCycle,
        params.amountCents,
        params.currency || 'USD',
        params.provider,
        params.externalEventId ?? null,
        params.verified === false ? 0 : 1,
        now,
      );

    if (
      params.eventType === 'subscription_started' ||
      params.eventType === 'subscription_upgraded' ||
      params.eventType === 'trial_converted'
    ) {
      this.db
        .prepare('UPDATE account_lifecycle SET plan_tier = ? WHERE anonymous_user_hash = ?')
        .run(params.planTier, params.anonymousUserHash);
    } else if (params.eventType === 'subscription_cancelled') {
      this.db
        .prepare("UPDATE account_lifecycle SET plan_tier = 'free' WHERE anonymous_user_hash = ?")
        .run(params.anonymousUserHash);
    }
  }

  public recordCrashReport(params: {
    anonymousInstallId: string;
    platform: string;
    appVersion: string;
    component: string;
    errorName: string;
    message: string;
    stack?: string;
    startupMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO crash_reports (
          id, anonymous_install_id, platform, app_version, component,
          error_name, scrubbed_message, scrubbed_stack, startup_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        params.anonymousInstallId,
        params.platform,
        params.appVersion,
        params.component.slice(0, 64),
        params.errorName.slice(0, 80),
        scrubSensitiveStrings(params.message).slice(0, 400),
        params.stack ? scrubSensitiveStrings(params.stack).slice(0, 2000) : null,
        params.startupMs ?? null,
        new Date().toISOString(),
      );
  }

  public recordApiMetric(method: string, routePattern: string, statusCode: number, latencyMs: number): void {
    this.db
      .prepare(
        'INSERT INTO api_metrics (method, route_pattern, status_code, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(method, routePattern, statusCode, latencyMs, new Date().toISOString());
  }

  public close(): void {
    this.db.close();
  }
}
