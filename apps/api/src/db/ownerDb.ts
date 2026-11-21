import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type ProductTelemetryEvent,
  scrubSensitiveStrings,
  scrubTelemetryMetadata,
} from '@coresense/shared';
import { hashPassword } from '../security/crypto.js';
import { type DbAdapter, PostgresAdapter, SqliteAdapter } from './adapter.js';

// ============================================================================
// Physically / Schema-Separated Owner Observability Database
// STRICT PRIVACY BOUNDARY: Never stores customer emails (except owner admin),
// prompts, responses, photographs, manuals, or personal device data.
// ============================================================================

export class OwnerDatabase {
  public readonly db: DbAdapter;
  public readonly dbPath: string;
  private readonly pgAdapter: PostgresAdapter | null;
  private readonly initialOwnerEmail: string;
  private readonly initialOwnerPassword: string;

  constructor(
    dataDir: string,
    initialOwnerEmail: string,
    initialOwnerPassword: string,
    filename = 'coresense_owner.db',
    postgresUrl?: string,
  ) {
    this.initialOwnerEmail = initialOwnerEmail;
    this.initialOwnerPassword = initialOwnerPassword;

    if (postgresUrl && filename !== ':memory:') {
      this.pgAdapter = new PostgresAdapter(postgresUrl, 'owner_observability');
      this.db = this.pgAdapter;
      this.dbPath = 'postgresql://supabase/owner_observability';
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      this.dbPath = filename === ':memory:' ? ':memory:' : path.join(dataDir, filename);
      this.pgAdapter = null;
      this.db = new SqliteAdapter(this.dbPath);
    }
  }

  public async init(): Promise<void> {
    if (this.pgAdapter) {
      await this.pgAdapter.ensureSchema();
      await this.migrate(true);
    } else {
      await this.migrate(false);
    }
    await this.bootstrapDefaults(this.initialOwnerEmail, this.initialOwnerPassword);
  }

  private async migrate(isPostgres: boolean): Promise<void> {
    const serialPk = isPostgres ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const floatType = isPostgres ? 'DOUBLE PRECISION' : 'REAL';

    await this.db.exec(`
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
        estimated_cost_usd ${floatType} NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
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
        id ${serialPk},
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

      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        metric_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        threshold_value ${floatType} NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_api_created ON api_metrics(created_at);
      CREATE INDEX IF NOT EXISTS idx_crashes_created ON crash_reports(created_at);
    `);
  }

  private async bootstrapDefaults(ownerEmail: string, ownerPassword: string): Promise<void> {
    const now = new Date().toISOString();
    const existingAdmin = await this.db.get('SELECT id FROM owner_admins LIMIT 1');
    if (!existingAdmin) {
      await this.db.run(
        'INSERT INTO owner_admins (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        crypto.randomUUID(),
        ownerEmail.toLowerCase().trim(),
        'CoreSense Owner',
        hashPassword(ownerPassword),
        now,
      );
    }

    const defaultAlerts = [
      { id: 'alert-ai-budget', metric_key: 'monthly_ai_cost_usd', label: 'Monthly AI Spend Budget', threshold_value: 250, unit: 'USD' },
      { id: 'alert-error-rate', metric_key: 'api_5xx_rate_percent', label: 'API 5xx Error Rate', threshold_value: 2.0, unit: '%' },
      { id: 'alert-crash-rate', metric_key: 'crash_rate_percent', label: 'Client Crash Rate', threshold_value: 1.5, unit: '%' },
      { id: 'alert-ai-latency', metric_key: 'ai_avg_latency_ms', label: 'AI Average Inference Latency', threshold_value: 8000, unit: 'ms' },
    ];
    for (const a of defaultAlerts) {
      await this.db.run(
        'INSERT OR IGNORE INTO alert_rules (id, metric_key, label, threshold_value, unit, enabled, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        a.id,
        a.metric_key,
        a.label,
        a.threshold_value,
        a.unit,
        now,
      );
    }

    const defaultConfig: Record<string, unknown> = {
      latestDesktopVersion: '1.2.0',
      latestMobileVersion: '1.2.0',
      maintenanceMode: false,
      telemetryRetentionDays: 365,
    };
    for (const [k, v] of Object.entries(defaultConfig)) {
      await this.db.run(
        'INSERT OR IGNORE INTO product_config (key, value_json, updated_at) VALUES (?, ?, ?)',
        k,
        JSON.stringify(v),
        now,
      );
    }
  }

  public async recordProductEvent(event: ProductTelemetryEvent): Promise<void> {
    const now = new Date().toISOString();
    const safeMeta = scrubTelemetryMetadata(event.metadata);
    await this.db.run(
      `INSERT INTO product_events (
        id, event_name, anonymous_install_id, anonymous_user_hash, platform,
        app_version, expertise_mode, duration_ms, success, error_category,
        country_code, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      event.eventName,
      event.anonymousInstallId,
      event.anonymousUserHash ?? null,
      event.platform,
      event.appVersion,
      event.durationMs ?? null,
      event.success ? 1 : 0,
      event.errorCategory ? scrubSensitiveStrings(event.errorCategory).slice(0, 64) : null,
      event.countryCode ?? null,
      JSON.stringify(safeMeta),
      now,
    );

    if (event.anonymousUserHash) {
      await this.db.run(
        'UPDATE account_lifecycle SET last_active_at = ? WHERE anonymous_user_hash = ?',
        now,
        event.anonymousUserHash,
      );
    }
  }

  public async recordActivation(
    installId: string,
    platform: string,
    appVersion: string,
    channel = 'direct',
    countryCode?: string,
  ): Promise<{ isFirstActivation: boolean }> {
    const now = new Date().toISOString();
    const existing = await this.db.get('SELECT install_id FROM app_activations WHERE install_id = ?', installId);
    if (existing) {
      await this.db.run(
        'UPDATE app_activations SET last_seen_at = ?, app_version = ? WHERE install_id = ?',
        now,
        appVersion,
        installId,
      );
      return { isFirstActivation: false };
    }
    await this.db.run(
      'INSERT INTO app_activations (install_id, platform, app_version, channel, country_code, first_activated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      installId,
      platform,
      appVersion,
      channel,
      countryCode ?? null,
      now,
      now,
    );
    return { isFirstActivation: true };
  }

  public async recordInstallerDownload(
    platform: string,
    appVersion: string,
    channel = 'direct',
    architecture = 'x64',
    countryCode?: string,
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO installer_downloads (id, platform, channel, app_version, architecture, country_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(),
      platform,
      channel,
      appVersion,
      architecture,
      countryCode ?? null,
      new Date().toISOString(),
    );
  }

  public async recordAccountRegistration(anonymousUserHash: string, platform: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      "INSERT OR IGNORE INTO account_lifecycle (anonymous_user_hash, platform, plan_tier, registered_at, last_active_at) VALUES (?, ?, 'free', ?, ?)",
      anonymousUserHash,
      platform,
      now,
      now,
    );
  }

  public async recordAccountDeletion(anonymousUserHash: string): Promise<void> {
    await this.db.run(
      'UPDATE account_lifecycle SET deleted_at = ? WHERE anonymous_user_hash = ?',
      new Date().toISOString(),
      anonymousUserHash,
    );
  }

  public async recordAiUsage(params: {
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
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO ai_usage_ledger (
        id, anonymous_user_hash, provider, model, feature, modality,
        input_tokens, output_tokens, latency_ms, estimated_cost_usd,
        success, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  public async recordCrashReport(params: {
    anonymousInstallId: string;
    platform: string;
    appVersion: string;
    component: string;
    errorName: string;
    message: string;
    stack?: string;
    startupMs?: number;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO crash_reports (
        id, anonymous_install_id, platform, app_version, component,
        error_name, scrubbed_message, scrubbed_stack, startup_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  public async recordApiMetric(method: string, routePattern: string, statusCode: number, latencyMs: number): Promise<void> {
    await this.db.run(
      'INSERT INTO api_metrics (method, route_pattern, status_code, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)',
      method,
      routePattern,
      statusCode,
      latencyMs,
      new Date().toISOString(),
    );
  }

  public async close(): Promise<void> {
    await this.db.close();
  }
}
