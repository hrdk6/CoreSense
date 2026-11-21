import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { type DbAdapter, PostgresAdapter, SqliteAdapter } from './adapter.js';

export class CustomerDatabase {
  public readonly db: DbAdapter;
  public readonly dbPath: string;
  private readonly pgAdapter: PostgresAdapter | null;

  constructor(dataDir: string, filename = 'coresense_customer.db', postgresUrl?: string) {
    if (postgresUrl && filename !== ':memory:') {
      this.pgAdapter = new PostgresAdapter(postgresUrl, 'customer_workspace');
      this.db = this.pgAdapter;
      this.dbPath = 'postgresql://supabase/customer_workspace';
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
      await this.migratePostgres();
    } else {
      await this.migrateSqlite();
    }
  }

  private async migratePostgres(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        expertise_mode TEXT NOT NULL DEFAULT 'everyday',
        telemetry_opt_in INTEGER NOT NULL DEFAULT 1,
        geo_opt_in INTEGER NOT NULL DEFAULT 0,
        cloud_sync_enabled INTEGER NOT NULL DEFAULT 1,
        external_ai_consent INTEGER NOT NULL DEFAULT 1,
        plan_tier TEXT NOT NULL DEFAULT 'free',
        subscription_status TEXT NOT NULL DEFAULT 'active',
        billing_cycle TEXT NOT NULL DEFAULT 'monthly',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        byok_provider TEXT,
        byok_encrypted_key TEXT,
        byok_base_url TEXT,
        byok_model TEXT,
        onboarding_completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        manufacturer TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        serial_or_tag TEXT,
        os_name TEXT,
        os_version TEXT,
        specs_json TEXT NOT NULL DEFAULT '{}',
        notes TEXT NOT NULL DEFAULT '',
        purchase_date TEXT,
        purchase_price DOUBLE PRECISION,
        currency TEXT NOT NULL DEFAULT 'USD',
        photo_url TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagnostic_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        investigation_id TEXT,
        tool_id TEXT NOT NULL,
        measurement_type TEXT NOT NULL,
        simulated_scenario_id TEXT,
        source TEXT NOT NULL,
        platform TEXT NOT NULL,
        os_version TEXT NOT NULL,
        summary TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        limitations_json TEXT NOT NULL DEFAULT '[]',
        data_json TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        collected_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investigations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        initial_symptom TEXT NOT NULL,
        expertise_mode TEXT NOT NULL DEFAULT 'everyday',
        status TEXT NOT NULL DEFAULT 'active',
        verification_outcome TEXT,
        verification_report_json TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        hypotheses_json TEXT NOT NULL DEFAULT '[]',
        pending_tools_json TEXT NOT NULL DEFAULT '[]',
        safety_flags_json TEXT NOT NULL DEFAULT '[]',
        baseline_snapshot_id TEXT,
        followup_snapshot_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investigation_messages (
        id TEXT PRIMARY KEY,
        investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        input_modality TEXT NOT NULL DEFAULT 'text',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        citations_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        ai_provider TEXT,
        ai_model TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 1,
        doc_version TEXT NOT NULL DEFAULT '1.0',
        summary TEXT NOT NULL DEFAULT '',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'indexed',
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        page_number INTEGER NOT NULL DEFAULT 1,
        section_heading TEXT NOT NULL DEFAULT '',
        has_table INTEGER NOT NULL DEFAULT 0,
        has_command_block INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        embedding_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_attachments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT,
        investigation_id TEXT,
        repair_case_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        clarity_note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repair_cases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        investigation_id TEXT REFERENCES investigations(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        symptom_summary TEXT NOT NULL DEFAULT '',
        diagnosis_summary TEXT NOT NULL DEFAULT '',
        resolution_notes TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'open',
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repair_case_entries (
        id TEXT PRIMARY KEY,
        repair_case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        measurement_value TEXT,
        attachment_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repair_expenses (
        id TEXT PRIMARY KEY,
        repair_case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'part',
        amount DOUBLE PRECISION NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        vendor TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_counters (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period_ym TEXT NOT NULL,
        ai_messages INTEGER NOT NULL DEFAULT 0,
        image_analyses INTEGER NOT NULL DEFAULT 0,
        voice_interactions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, period_ym)
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        seq BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_investigations_user ON investigations(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_inv ON investigation_messages(investigation_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_user ON diagnostic_snapshots(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_user ON document_chunks(user_id);
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_fts ON document_chunks USING GIN (to_tsvector('english', section_heading || ' ' || content));
      CREATE INDEX IF NOT EXISTS idx_cases_user ON repair_cases(user_id);
      CREATE INDEX IF NOT EXISTS idx_sync_user_seq ON sync_log(user_id, seq);
    `);
  }

  private async migrateSqlite(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        expertise_mode TEXT NOT NULL DEFAULT 'everyday',
        telemetry_opt_in INTEGER NOT NULL DEFAULT 1,
        geo_opt_in INTEGER NOT NULL DEFAULT 0,
        cloud_sync_enabled INTEGER NOT NULL DEFAULT 1,
        external_ai_consent INTEGER NOT NULL DEFAULT 1,
        plan_tier TEXT NOT NULL DEFAULT 'free',
        subscription_status TEXT NOT NULL DEFAULT 'active',
        billing_cycle TEXT NOT NULL DEFAULT 'monthly',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        byok_provider TEXT,
        byok_encrypted_key TEXT,
        byok_base_url TEXT,
        byok_model TEXT,
        onboarding_completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        manufacturer TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        serial_or_tag TEXT,
        os_name TEXT,
        os_version TEXT,
        specs_json TEXT NOT NULL DEFAULT '{}',
        notes TEXT NOT NULL DEFAULT '',
        purchase_date TEXT,
        purchase_price REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        photo_url TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagnostic_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        investigation_id TEXT,
        tool_id TEXT NOT NULL,
        measurement_type TEXT NOT NULL,
        simulated_scenario_id TEXT,
        source TEXT NOT NULL,
        platform TEXT NOT NULL,
        os_version TEXT NOT NULL,
        summary TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        limitations_json TEXT NOT NULL DEFAULT '[]',
        data_json TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        collected_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investigations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        initial_symptom TEXT NOT NULL,
        expertise_mode TEXT NOT NULL DEFAULT 'everyday',
        status TEXT NOT NULL DEFAULT 'active',
        verification_outcome TEXT,
        verification_report_json TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        hypotheses_json TEXT NOT NULL DEFAULT '[]',
        pending_tools_json TEXT NOT NULL DEFAULT '[]',
        safety_flags_json TEXT NOT NULL DEFAULT '[]',
        baseline_snapshot_id TEXT,
        followup_snapshot_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investigation_messages (
        id TEXT PRIMARY KEY,
        investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        input_modality TEXT NOT NULL DEFAULT 'text',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        citations_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        ai_provider TEXT,
        ai_model TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 1,
        doc_version TEXT NOT NULL DEFAULT '1.0',
        summary TEXT NOT NULL DEFAULT '',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'indexed',
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        page_number INTEGER NOT NULL DEFAULT 1,
        section_heading TEXT NOT NULL DEFAULT '',
        has_table INTEGER NOT NULL DEFAULT 0,
        has_command_block INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        embedding_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        user_id UNINDEXED,
        title,
        section_heading,
        content
      );

      CREATE TABLE IF NOT EXISTS media_attachments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT,
        investigation_id TEXT,
        repair_case_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        clarity_note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repair_cases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        investigation_id TEXT REFERENCES investigations(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        symptom_summary TEXT NOT NULL DEFAULT '',
        diagnosis_summary TEXT NOT NULL DEFAULT '',
        resolution_notes TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'open',
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repair_case_entries (
        id TEXT PRIMARY KEY,
        repair_case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        measurement_value TEXT,
        attachment_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repair_expenses (
        id TEXT PRIMARY KEY,
        repair_case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'part',
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        vendor TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_counters (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period_ym TEXT NOT NULL,
        ai_messages INTEGER NOT NULL DEFAULT 0,
        image_analyses INTEGER NOT NULL DEFAULT 0,
        voice_interactions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, period_ym)
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_investigations_user ON investigations(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_inv ON investigation_messages(investigation_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_user ON diagnostic_snapshots(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_cases_user ON repair_cases(user_id);
      CREATE INDEX IF NOT EXISTS idx_sync_user_seq ON sync_log(user_id, seq);
    `);
  }

  public async recordSyncChange(
    userId: string,
    entityType: string,
    entityId: string,
    operation: 'upsert' | 'delete',
    revision: number,
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO sync_log (user_id, entity_type, entity_id, operation, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId,
      entityType,
      entityId,
      operation,
      revision,
      new Date().toISOString(),
    );
  }

  public async recordAudit(
    userId: string,
    action: string,
    resourceType: string,
    resourceId?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(),
      userId,
      action,
      resourceType,
      resourceId ?? null,
      JSON.stringify(metadata),
      new Date().toISOString(),
    );
  }

  public async close(): Promise<void> {
    await this.db.close();
  }
}
