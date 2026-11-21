import crypto from 'node:crypto';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CORESENSE_VERSION,
  DIAGNOSTIC_TOOL_REGISTRY,
  DeviceCreateSchema,
  type DiagnosticResult,
  DiagnosticResultSchema,
  type EvidenceItem,
  type Hypothesis,
  PlatformSchema,
  ProductTelemetryEventSchema,
  RepairCaseCreateSchema,
  RepairExpenseSchema,
  SyncMutationSchema,
  getToolDefinition,
} from '@coresense/shared';
import {
  type SimulationScenarioId,
  buildSimulatedDiagnostic,
  executeValidatedDiagnosticTool,
} from '@coresense/diagnostics-core';
import type { AppConfig } from '../config.js';
import type { CustomerDatabase } from '../db/customerDb.js';
import type { OwnerDatabase } from '../db/ownerDb.js';
import {
  createAnonymousUserHash,
  decryptSecret,
  encryptSecret,
  hashPassword,
  signJwt,
  validateUploadedFile,
  verifyJwt,
  verifyPassword,
} from '../security/crypto.js';
import {
  deleteUserDocument,
  ingestTechnicalDocument,
  searchUserKnowledgeBase,
} from '../services/rag.js';
import { inspectImageBuffer, saveUserAttachment } from '../services/imageInspector.js';
import {
  type ProposedToolCall,
  runCopilotTurn,
  testAiProviderConnection,
  verifyInvestigationResolution,
} from '../services/copilot.js';

interface CustomerUserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  telemetry_opt_in: number;
  geo_opt_in: number;
  cloud_sync_enabled: number;
  external_ai_consent: number;
  byok_provider: string | null;
  byok_encrypted_key: string | null;
  byok_base_url: string | null;
  byok_model: string | null;
  onboarding_completed: number;
  created_at: string;
  updated_at: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    customerUser?: CustomerUserRow;
  }
}

function getCurrentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

function serializeUserProfile(u: CustomerUserRow) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    telemetryOptIn: u.telemetry_opt_in === 1,
    geoOptIn: u.geo_opt_in === 1,
    cloudSyncEnabled: u.cloud_sync_enabled === 1,
    externalAiConsent: u.external_ai_consent === 1,
    onboardingCompleted: u.onboarding_completed === 1,
    byokConfigured: Boolean(u.byok_encrypted_key || u.byok_provider === 'ollama'),
    byokProvider: u.byok_provider,
    byokBaseUrl: u.byok_base_url,
    byokModel: u.byok_model,
    createdAt: u.created_at,
  };
}

export function registerCustomerRoutes(
  app: FastifyInstance,
  deps: { customerDb: CustomerDatabase; ownerDb: OwnerDatabase; config: AppConfig },
): void {
  const { customerDb, ownerDb, config } = deps;

  const supabaseEnabled = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const supabaseClient = supabaseEnabled
    ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

  // Short-lived cache (60s) of verified Supabase JWT -> user metadata to avoid redundant network hops
  const verifiedSupabaseCache = new Map<
    string,
    { id: string; email: string; displayName: string; expMs: number }
  >();

  const provisionSupabaseUser = async (
    sbUser: { id: string; email: string; displayName: string },
    req: FastifyRequest,
  ): Promise<CustomerUserRow> => {
    const existingById = (await customerDb.db.get(
      'SELECT * FROM users WHERE id = ?',
      sbUser.id,
    )) as CustomerUserRow | undefined;
    if (existingById) return existingById;

    const email = sbUser.email.toLowerCase().trim();
    const existingByEmail = (await customerDb.db.get(
      'SELECT * FROM users WHERE email = ?',
      email,
    )) as CustomerUserRow | undefined;
    if (existingByEmail) return existingByEmail;

    const now = new Date().toISOString();
    await customerDb.db.run(
      `INSERT OR IGNORE INTO users (
        id, email, display_name, password_hash,
        telemetry_opt_in, external_ai_consent, onboarding_completed, created_at, updated_at
      ) VALUES (?, ?, ?, 'supabase_managed', 1, 1, 0, ?, ?)`,
      sbUser.id,
      email,
      sbUser.displayName,
      now,
      now,
    );

    const platformHeader = String(req.headers['x-coresense-platform'] || 'windows');
    const platform = PlatformSchema.safeParse(platformHeader).success
      ? (platformHeader as z.infer<typeof PlatformSchema>)
      : 'windows';
    const anonHash = createAnonymousUserHash(sbUser.id, config.jwtSecret);
    await ownerDb.recordAccountRegistration(anonHash, platform);
    await ownerDb.recordProductEvent({
      eventName: 'account_registered',
      anonymousInstallId: String(req.headers['x-coresense-install-id'] || `sb-${anonHash.slice(0, 12)}`).slice(0, 80),
      anonymousUserHash: anonHash,
      platform,
      appVersion: String(req.headers['x-coresense-version'] || CORESENSE_VERSION).slice(0, 32),
      success: true,
    });
    await customerDb.recordAudit(sbUser.id, 'account_registered', 'user', sbUser.id, { provider: 'supabase' });

    const created = (await customerDb.db.get(
      'SELECT * FROM users WHERE id = ? OR email = ?',
      sbUser.id,
      email,
    )) as unknown as CustomerUserRow;
    return created;
  };

  const requireCustomerAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const token = authHeader.slice(7);

    // 1. Check local HS256 JWT (offline / self-hosted / test mode)
    const localPayload = verifyJwt(token, config.jwtSecret, 'coresense-customer');
    if (localPayload) {
      const user = (await customerDb.db.get(
        'SELECT * FROM users WHERE id = ?',
        localPayload.sub,
      )) as CustomerUserRow | undefined;
      if (!user) {
        return reply.code(401).send({ error: 'Account not found' });
      }
      req.customerUser = user;
      return;
    }

    // 2. Verify Supabase Auth JWT when Supabase is configured
    if (supabaseClient) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const cached = verifiedSupabaseCache.get(tokenHash);
      if (cached && cached.expMs > Date.now()) {
        req.customerUser = await provisionSupabaseUser(cached, req);
        return;
      }

      const { data, error } = await supabaseClient.auth.getUser(token);
      if (error || !data?.user || !data.user.email) {
        return reply.code(401).send({ error: 'Invalid or expired session token. Please sign in again.' });
      }
      const meta = (data.user.user_metadata || {}) as Record<string, unknown>;
      const displayName =
        String(meta.display_name || meta.full_name || meta.name || data.user.email.split('@')[0]).slice(0, 80);
      const sbInfo = {
        id: data.user.id,
        email: data.user.email,
        displayName,
        expMs: Date.now() + 60_000,
      };
      if (verifiedSupabaseCache.size > 2000) verifiedSupabaseCache.clear();
      verifiedSupabaseCache.set(tokenHash, sbInfo);
      req.customerUser = await provisionSupabaseUser(sbInfo, req);
      return;
    }

    return reply.code(401).send({ error: 'Invalid or expired customer token' });
  };

  const emitUserTelemetry = async (
    user: CustomerUserRow,
    eventName: Parameters<typeof ownerDb.recordProductEvent>[0]['eventName'],
    req: FastifyRequest,
    extra: Partial<Parameters<typeof ownerDb.recordProductEvent>[0]> = {},
  ) => {
    if (user.telemetry_opt_in !== 1) return;
    const platformHeader = String(req.headers['x-coresense-platform'] || 'windows');
    const platform = PlatformSchema.safeParse(platformHeader).success
      ? (platformHeader as z.infer<typeof PlatformSchema>)
      : 'windows';
    const appVersion = String(req.headers['x-coresense-version'] || CORESENSE_VERSION).slice(0, 32);
    const installId = String(req.headers['x-coresense-install-id'] || `user-${user.id.slice(0, 12)}`).slice(0, 80);

    await ownerDb.recordProductEvent({
      eventName,
      anonymousInstallId: installId,
      anonymousUserHash: createAnonymousUserHash(user.id, config.jwtSecret),
      platform,
      appVersion,
      success: true,
      ...extra,
    });
  };

  // ==========================================================================
  // Public System Capabilities & Distribution Tracking
  // ==========================================================================
  app.get('/api/v1/health', async () => {
    return {
      status: 'ok',
      product: 'CoreSense',
      version: CORESENSE_VERSION,
      database: customerDb.db.dialect,
      integrations: {
        supabaseAuthConfigured: supabaseEnabled,
        geminiConfigured: Boolean(config.geminiApiKey),
        openaiConfigured: Boolean(config.openaiApiKey),
        localDiagnosticEngineActive: true,
      },
      timestamp: new Date().toISOString(),
    };
  });

  // Public non-secret auth discovery for Desktop & Mobile clients
  app.get('/api/v1/auth/config', async () => {
    return {
      supabaseEnabled,
      supabaseUrl: supabaseEnabled ? config.supabaseUrl : null,
      supabaseAnonKey: supabaseEnabled ? config.supabaseAnonKey : null,
    };
  });

  // Commercial Release & Auto-Update Manifest Endpoint
  app.get('/api/v1/releases/latest', async () => {
    const cfgRows = (await ownerDb.db.all('SELECT key, value_json FROM product_config WHERE key IN (?, ?)', 'latestDesktopVersion', 'latestMobileVersion')) as Array<{ key: string; value_json: string }>;
    const map = new Map(cfgRows.map((r) => [r.key, JSON.parse(r.value_json)]));
    return {
      product: 'CoreSense',
      desktop: {
        version: String(map.get('latestDesktopVersion') || CORESENSE_VERSION),
        releaseDate: '2026-11-21',
        releaseUrl: 'https://github.com/hrdk6/CoreSense-Releases/releases/tag/v1.0.0',
        notes: 'CoreSense v1.0.0 — 100% Free AI Electronics Diagnostics, Native Rust Tauri Diagnostics, Multimodal AI Repair Copilot, Technical Manuals RAG, and Desktop↔Mobile Sync.',
        installers: {
          windowsNsis: 'CoreSense_1.0.0_x64-setup.exe',
          windowsMsi: 'CoreSense_1.0.0_x64_en-US.msi',
          macosDmg: 'CoreSense_1.0.0_aarch64.dmg',
          linuxDeb: 'CoreSense_1.0.0_amd64.deb',
          linuxAppImage: 'CoreSense_1.0.0_amd64.AppImage',
        },
      },
      mobile: {
        version: String(map.get('latestMobileVersion') || CORESENSE_VERSION),
        androidPackage: 'com.coresense.mobile',
        iosBundleId: 'com.coresense.mobile',
      },
    };
  });

  app.post('/api/v1/downloads/track', async (req, reply) => {
    const schema = z.object({
      platform: PlatformSchema,
      appVersion: z.string().max(32).default(CORESENSE_VERSION),
      channel: z.enum(['direct', 'github', 'microsoft_store', 'app_store', 'google_play']).default('direct'),
      architecture: z.string().max(24).default('x64'),
      countryCode: z.string().max(4).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await ownerDb.recordInstallerDownload(
      parsed.data.platform,
      parsed.data.appVersion,
      parsed.data.channel,
      parsed.data.architecture,
      parsed.data.countryCode,
    );
    return { recorded: true };
  });

  app.post('/api/v1/telemetry/activation', async (req, reply) => {
    const schema = z.object({
      installId: z.string().min(8).max(80),
      platform: PlatformSchema,
      appVersion: z.string().max(32).default(CORESENSE_VERSION),
      channel: z.string().max(32).default('direct'),
      countryCode: z.string().max(4).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await ownerDb.recordActivation(
      parsed.data.installId,
      parsed.data.platform,
      parsed.data.appVersion,
      parsed.data.channel,
      parsed.data.countryCode,
    );
    await ownerDb.recordProductEvent({
      eventName: 'app_launched',
      anonymousInstallId: parsed.data.installId,
      platform: parsed.data.platform,
      appVersion: parsed.data.appVersion,
      success: true,
      countryCode: parsed.data.countryCode,
    });
    return { ok: true, ...res };
  });

  app.post('/api/v1/telemetry/event', async (req, reply) => {
    const parsed = ProductTelemetryEventSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await ownerDb.recordProductEvent(parsed.data);
    return { ok: true };
  });

  app.post('/api/v1/telemetry/crash', async (req, reply) => {
    const schema = z.object({
      anonymousInstallId: z.string().min(8).max(80),
      platform: PlatformSchema,
      appVersion: z.string().max(32),
      component: z.string().max(64),
      errorName: z.string().max(80),
      message: z.string().max(600),
      stack: z.string().max(3000).optional(),
      startupMs: z.number().int().min(0).max(120000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await ownerDb.recordCrashReport(parsed.data);
    return { recorded: true };
  });

  // ==========================================================================
  // Personal Account Authentication & Privacy Controls
  // ==========================================================================
  app.post('/api/v1/auth/register', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const schema = z.object({
      email: z.string().email().max(160),
      password: z.string().min(8).max(128),
      displayName: z.string().min(1).max(80),
      telemetryOptIn: z.boolean().default(true),
      externalAiConsent: z.boolean().default(true),
      platform: PlatformSchema.default('windows'),
      installId: z.string().min(8).max(80).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const email = parsed.data.email.toLowerCase().trim();
    const existing = await customerDb.db.get('SELECT id FROM users WHERE email = ?', email);
    if (existing) return reply.code(409).send({ error: 'An account with this email already exists.' });

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    await customerDb.db.run(
        `INSERT INTO users (
          id, email, display_name, password_hash,
          telemetry_opt_in, external_ai_consent, onboarding_completed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`, userId,
        email,
        parsed.data.displayName.trim(),
        hashPassword(parsed.data.password),
        parsed.data.telemetryOptIn ? 1 : 0,
        parsed.data.externalAiConsent ? 1 : 0,
        now,
        now,);

    await customerDb.recordAudit(userId, 'account_registered', 'user', userId, {});

    const anonHash = createAnonymousUserHash(userId, config.jwtSecret);
    await ownerDb.recordAccountRegistration(anonHash, parsed.data.platform);
    if (parsed.data.telemetryOptIn) {
      await ownerDb.recordProductEvent({
        eventName: 'account_registered',
        anonymousInstallId: parsed.data.installId || `reg-${anonHash.slice(0, 12)}`,
        anonymousUserHash: anonHash,
        platform: parsed.data.platform,
        appVersion: String(req.headers['x-coresense-version'] || CORESENSE_VERSION),
        success: true,
      });
    }

    const user = (await customerDb.db.get('SELECT * FROM users WHERE id = ?', userId)) as unknown as CustomerUserRow;
    const accessToken = signJwt({ sub: user.id, aud: 'coresense-customer', role: 'customer' }, config.jwtSecret, 60 * 60 * 24 * 7);

    return reply.code(201).send({
      accessToken,
      user: serializeUserProfile(user),
    });
  });

  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
      platform: PlatformSchema.default('windows'),
      installId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const email = parsed.data.email.toLowerCase().trim();
    const user = (await customerDb.db.get('SELECT * FROM users WHERE email = ?', email)) as CustomerUserRow | undefined;
    if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
      await ownerDb.recordProductEvent({
        eventName: 'app_launched',
        anonymousInstallId: parsed.data.installId || 'auth-attempt',
        platform: parsed.data.platform,
        appVersion: String(req.headers['x-coresense-version'] || CORESENSE_VERSION),
        success: false,
        errorCategory: 'auth_invalid_credentials',
      });
      return reply.code(401).send({ error: 'Invalid email or password.' });
    }

    const accessToken = signJwt({ sub: user.id, aud: 'coresense-customer', role: 'customer' }, config.jwtSecret, 60 * 60 * 24 * 7);
    await customerDb.recordAudit(user.id, 'account_login', 'user', user.id, { platform: parsed.data.platform });
    await emitUserTelemetry(user, 'app_launched', req, { platform: parsed.data.platform });

    return { accessToken, user: serializeUserProfile(user) };
  });

  app.post('/api/v1/auth/recover/request', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const schema = z.object({ email: z.string().email() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Valid email required.' });
    const user = (await customerDb.db.get('SELECT id FROM users WHERE email = ?', parsed.data.email.toLowerCase().trim())) as { id: string } | undefined;

    if (user) {
      const resetCode = String(crypto.randomInt(100000, 999999));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await customerDb.db.run('INSERT INTO password_resets (id, user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', crypto.randomUUID(), user.id, hashPassword(resetCode), expiresAt, new Date().toISOString());
      await customerDb.recordAudit(user.id, 'password_recovery_requested', 'user', user.id);
      return {
        message: 'If an account matches this email, a recovery code has been generated.',
        // Returned ONLY in development mode so users can test account recovery without SMTP
        ...(config.nodeEnv !== 'production' ? { devRecoveryCode: resetCode } : {}),
      };
    }
    return { message: 'If an account matches this email, a recovery code has been generated.' };
  });

  app.post('/api/v1/auth/recover/confirm', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const schema = z.object({
      email: z.string().email(),
      code: z.string().min(6).max(16),
      newPassword: z.string().min(8).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const user = (await customerDb.db.get('SELECT id FROM users WHERE email = ?', parsed.data.email.toLowerCase().trim())) as { id: string } | undefined;
    if (!user) return reply.code(400).send({ error: 'Invalid recovery request.' });

    const resets = (await customerDb.db.all('SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 5', user.id)) as Array<{ id: string; code_hash: string; expires_at: string }>;

    const matched = resets.find(
      (r) => new Date(r.expires_at).getTime() > Date.now() && verifyPassword(parsed.data.code, r.code_hash),
    );
    if (!matched) return reply.code(400).send({ error: 'Invalid or expired recovery code.' });

    const now = new Date().toISOString();
    await customerDb.db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', now, matched.id);
    await customerDb.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(parsed.data.newPassword), now, user.id);
    await customerDb.recordAudit(user.id, 'password_recovered', 'user', user.id);

    return { ok: true, message: 'Password updated successfully. You may now sign in.' };
  });

  app.get('/api/v1/account/me', { preHandler: requireCustomerAuth }, async (req) => {
    const user = req.customerUser!;
    const ym = getCurrentYm();
    const usage = ((await customerDb.db.get('SELECT * FROM usage_counters WHERE user_id = ? AND period_ym = ?', user.id, ym)) as { ai_messages: number; image_analyses: number; voice_interactions: number } | undefined) ?? {
      ai_messages: 0,
      image_analyses: 0,
      voice_interactions: 0,
    };
    const counts = {
      devices: ((await customerDb.db.get('SELECT COUNT(*) as c FROM devices WHERE user_id = ? AND deleted_at IS NULL', user.id)) as { c: number }).c,
      documents: ((await customerDb.db.get('SELECT COUNT(*) as c FROM documents WHERE user_id = ? AND deleted_at IS NULL', user.id)) as { c: number }).c,
      investigations: ((await customerDb.db.get('SELECT COUNT(*) as c FROM investigations WHERE user_id = ? AND deleted_at IS NULL', user.id)) as { c: number }).c,
      cases: ((await customerDb.db.get('SELECT COUNT(*) as c FROM repair_cases WHERE user_id = ? AND deleted_at IS NULL', user.id)) as { c: number }).c,
    };
    return {
      user: serializeUserProfile(user),
      usage: {
        periodYm: ym,
        aiMessages: usage.ai_messages,
        imageAnalyses: usage.image_analyses,
        voiceInteractions: usage.voice_interactions,
        ...counts,
      },
      aiRuntime: {
        activeMode:
          (user.byok_encrypted_key || user.byok_provider === 'ollama') && user.external_ai_consent
            ? `BYOK (${user.byok_provider})`
            : config.geminiApiKey && user.external_ai_consent
              ? `CoreSense Cloud Gemini (${config.geminiModel})`
              : config.openaiApiKey && user.external_ai_consent
                ? `CoreSense Cloud OpenAI (${config.openaiModel})`
                : 'CoreSense Local Diagnostic Engine (On-Device / Offline Ready)',
        externalDataTransmissionEnabled:
          user.external_ai_consent === 1 &&
          Boolean(user.byok_encrypted_key || config.geminiApiKey || config.openaiApiKey),
      },
    };
  });

  app.patch('/api/v1/account/settings', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      displayName: z.string().min(1).max(80).optional(),
      telemetryOptIn: z.boolean().optional(),
      geoOptIn: z.boolean().optional(),
      cloudSyncEnabled: z.boolean().optional(),
      externalAiConsent: z.boolean().optional(),
      onboardingCompleted: z.boolean().optional(),
      byok: z
        .object({
          provider: z.enum(['gemini', 'openai', 'ollama']),
          apiKey: z.string().max(300),
          baseUrl: z.string().max(300).optional(),
          model: z.string().max(120).optional(),
        })
        .nullable()
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const user = req.customerUser!;
    const d = parsed.data;
    const now = new Date().toISOString();

    let byokProvider = user.byok_provider;
    let byokEncryptedKey = user.byok_encrypted_key;
    let byokBaseUrl = user.byok_base_url;
    let byokModel = user.byok_model;

    if (d.byok === null) {
      byokProvider = null;
      byokEncryptedKey = null;
      byokBaseUrl = null;
      byokModel = null;
    } else if (d.byok) {
      byokProvider = d.byok.provider;
      byokEncryptedKey = d.byok.apiKey ? encryptSecret(d.byok.apiKey, config.encryptionKey) : null;
      byokBaseUrl = d.byok.baseUrl ?? null;
      byokModel = d.byok.model ?? null;
    }

    await customerDb.db.run(
        `UPDATE users SET
          display_name = ?,
          telemetry_opt_in = ?,
          geo_opt_in = ?,
          cloud_sync_enabled = ?,
          external_ai_consent = ?,
          onboarding_completed = ?,
          byok_provider = ?,
          byok_encrypted_key = ?,
          byok_base_url = ?,
          byok_model = ?,
          updated_at = ?
        WHERE id = ?`, d.displayName ?? user.display_name,
        d.telemetryOptIn !== undefined ? (d.telemetryOptIn ? 1 : 0) : user.telemetry_opt_in,
        d.geoOptIn !== undefined ? (d.geoOptIn ? 1 : 0) : user.geo_opt_in,
        d.cloudSyncEnabled !== undefined ? (d.cloudSyncEnabled ? 1 : 0) : user.cloud_sync_enabled,
        d.externalAiConsent !== undefined ? (d.externalAiConsent ? 1 : 0) : user.external_ai_consent,
        d.onboardingCompleted !== undefined ? (d.onboardingCompleted ? 1 : 0) : user.onboarding_completed,
        byokProvider,
        byokEncryptedKey,
        byokBaseUrl,
        byokModel,
        now,
        user.id,);

    const updated = (await customerDb.db.get('SELECT * FROM users WHERE id = ?', user.id)) as unknown as CustomerUserRow;
    if (d.onboardingCompleted && !user.onboarding_completed) {
      await emitUserTelemetry(updated, 'onboarding_completed', req);
    }
    await customerDb.recordAudit(user.id, 'account_settings_updated', 'user', user.id);

    return { user: serializeUserProfile(updated) };
  });

  // Live AI Provider Connection Tester (validates BYOK or Server provider without saving)
  app.post('/api/v1/account/test-ai', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      provider: z.enum(['gemini', 'openai', 'ollama', 'coresense-local']).optional(),
      apiKey: z.string().max(300).optional(),
      baseUrl: z.string().max(300).optional(),
      model: z.string().max(120).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const user = req.customerUser!;
    let provider = parsed.data.provider;
    let apiKey = parsed.data.apiKey;
    let baseUrl = parsed.data.baseUrl;
    let model = parsed.data.model;

    if (!provider) {
      if (user.byok_provider && (user.byok_encrypted_key || user.byok_provider === 'ollama')) {
        provider = user.byok_provider as 'gemini' | 'openai' | 'ollama';
        apiKey = user.byok_encrypted_key ? decryptSecret(user.byok_encrypted_key, config.encryptionKey) : '';
        baseUrl = user.byok_base_url || undefined;
        model = user.byok_model || undefined;
      } else if (config.geminiApiKey) {
        provider = 'gemini';
      } else if (config.openaiApiKey) {
        provider = 'openai';
      } else {
        provider = 'coresense-local';
      }
    }

    const result = await testAiProviderConnection({
      provider,
      apiKey,
      baseUrl,
      model,
      config,
    });
    return result;
  });

  app.get('/api/v1/account/export', { preHandler: requireCustomerAuth }, async (req) => {
    const user = req.customerUser!;
    const devices = await customerDb.db.all('SELECT * FROM devices WHERE user_id = ?', user.id);
    const investigations = await customerDb.db.all('SELECT * FROM investigations WHERE user_id = ?', user.id);
    const messages = await customerDb.db.all('SELECT * FROM investigation_messages WHERE user_id = ?', user.id);
    const snapshots = await customerDb.db.all('SELECT * FROM diagnostic_snapshots WHERE user_id = ?', user.id);
    const documents = await customerDb.db.all('SELECT * FROM documents WHERE user_id = ?', user.id);
    const cases = await customerDb.db.all('SELECT * FROM repair_cases WHERE user_id = ?', user.id);
    const caseEntries = await customerDb.db.all('SELECT * FROM repair_case_entries WHERE user_id = ?', user.id);
    const expenses = await customerDb.db.all('SELECT * FROM repair_expenses WHERE user_id = ?', user.id);
    const auditLogs = await customerDb.db.all('SELECT * FROM audit_logs WHERE user_id = ?', user.id);

    await customerDb.recordAudit(user.id, 'account_data_exported', 'user', user.id);
    return {
      exportedAt: new Date().toISOString(),
      product: 'CoreSense Personal Data Export',
      profile: serializeUserProfile(user),
      devices,
      investigations,
      messages,
      diagnosticSnapshots: snapshots,
      documents,
      repairCases: cases,
      repairCaseEntries: caseEntries,
      repairExpenses: expenses,
      auditLogs,
    };
  });

  app.delete('/api/v1/account', { preHandler: requireCustomerAuth }, async (req) => {
    const user = req.customerUser!;
    const anonHash = createAnonymousUserHash(user.id, config.jwtSecret);
    // Clean up FTS chunks (SQLite) and uploaded files
    if (customerDb.db.dialect === 'sqlite') {
      await customerDb.db.run('DELETE FROM document_chunks_fts WHERE user_id = ?', user.id);
    }
    const attachments = (await customerDb.db.all('SELECT storage_path FROM media_attachments WHERE user_id = ?', user.id)) as Array<{ storage_path: string }>;
    for (const a of attachments) {
      try {
        if (fs.existsSync(a.storage_path)) fs.unlinkSync(a.storage_path);
      } catch {}
    }
    await customerDb.db.run('DELETE FROM users WHERE id = ?', user.id);

    await ownerDb.recordAccountDeletion(anonHash);
    await emitUserTelemetry(user, 'account_deleted', req);
    return { deleted: true, message: 'Account and all associated private personal workspace records permanently deleted.' };
  });

  // ==========================================================================
  // Personal Device Library
  // ==========================================================================
  app.get('/api/v1/devices', { preHandler: requireCustomerAuth }, async (req) => {
    const includeArchived = (req.query as Record<string, string>).includeArchived === 'true';
    const rows = (await customerDb.db.all(
        `SELECT d.*,
          (SELECT COUNT(*) FROM repair_cases rc WHERE rc.device_id = d.id AND rc.deleted_at IS NULL) AS case_count,
          (SELECT COUNT(*) FROM diagnostic_snapshots ds WHERE ds.device_id = d.id) AS snapshot_count,
          (SELECT COALESCE(SUM(re.amount), 0) FROM repair_expenses re JOIN repair_cases rc2 ON rc2.id = re.repair_case_id WHERE rc2.device_id = d.id) AS total_repair_spend
         FROM devices d
         WHERE d.user_id = ? AND d.deleted_at IS NULL ${includeArchived ? '' : 'AND d.archived = 0'}
         ORDER BY d.updated_at DESC`, req.customerUser!.id)) as Array<Record<string, unknown>>;

    return {
      devices: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        manufacturer: r.manufacturer,
        model: r.model,
        serialOrTag: r.serial_or_tag,
        osName: r.os_name,
        osVersion: r.os_version,
        specs: JSON.parse(String(r.specs_json || '{}')),
        notes: r.notes,
        purchaseDate: r.purchase_date,
        purchasePrice: r.purchase_price,
        currency: r.currency,
        archived: r.archived === 1,
        revision: r.revision,
        caseCount: r.case_count,
        snapshotCount: r.snapshot_count,
        totalRepairSpend: r.total_repair_spend,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post('/api/v1/devices', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const parsed = DeviceCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const user = req.customerUser!;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const d = parsed.data;
    await customerDb.db.run(
        `INSERT INTO devices (
          id, user_id, name, category, manufacturer, model, serial_or_tag,
          os_name, os_version, specs_json, notes, purchase_date, purchase_price,
          currency, archived, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`, id,
        user.id,
        d.name,
        d.category,
        d.manufacturer,
        d.model,
        d.serialOrTag ?? null,
        d.osName ?? null,
        d.osVersion ?? null,
        JSON.stringify(d.specs),
        d.notes,
        d.purchaseDate ?? null,
        d.purchasePrice ?? null,
        d.currency,
        now,
        now,);
    await customerDb.recordSyncChange(user.id, 'device', id, 'upsert', 1);
    await emitUserTelemetry(user, 'device_added', req, { metadata: { category: d.category } });

    return reply.code(201).send({
      device: { id, ...d, archived: false, revision: 1, createdAt: now, updatedAt: now },
    });
  });

  app.patch('/api/v1/devices/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.customerUser!;
    const existing = (await customerDb.db.get('SELECT * FROM devices WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, user.id)) as Record<string, unknown> | undefined;
    if (!existing) return reply.code(404).send({ error: 'Device not found' });

    const schema = DeviceCreateSchema.partial().extend({ archived: z.boolean().optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    const now = new Date().toISOString();
    const nextRev = Number(existing.revision) + 1;

    await customerDb.db.run(
        `UPDATE devices SET
          name = ?, category = ?, manufacturer = ?, model = ?, serial_or_tag = ?,
          os_name = ?, os_version = ?, specs_json = ?, notes = ?, purchase_date = ?,
          purchase_price = ?, currency = ?, archived = ?, revision = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`, String(d.name ?? existing.name),
        String(d.category ?? existing.category),
        String(d.manufacturer ?? existing.manufacturer),
        String(d.model ?? existing.model),
        d.serialOrTag !== undefined ? d.serialOrTag : (existing.serial_or_tag as string | null),
        d.osName !== undefined ? d.osName : (existing.os_name as string | null),
        d.osVersion !== undefined ? d.osVersion : (existing.os_version as string | null),
        d.specs !== undefined ? JSON.stringify(d.specs) : String(existing.specs_json ?? '{}'),
        String(d.notes ?? existing.notes ?? ''),
        d.purchaseDate !== undefined ? d.purchaseDate : (existing.purchase_date as string | null),
        d.purchasePrice !== undefined ? d.purchasePrice : (existing.purchase_price as number | null),
        String(d.currency ?? existing.currency ?? 'USD'),
        d.archived !== undefined ? (d.archived ? 1 : 0) : Number(existing.archived ?? 0),
        nextRev,
        now,
        id,
        user.id,);
    await customerDb.recordSyncChange(user.id, 'device', id, 'upsert', nextRev);
    return { ok: true, id, revision: nextRev, updatedAt: now };
  });

  app.delete('/api/v1/devices/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.customerUser!;
    const existing = (await customerDb.db.get('SELECT revision FROM devices WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, user.id)) as { revision: number } | undefined;
    if (!existing) return reply.code(404).send({ error: 'Device not found' });

    const now = new Date().toISOString();
    const nextRev = existing.revision + 1;
    await customerDb.db.run('UPDATE devices SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ? AND user_id = ?', now, nextRev, now, id, user.id);
    await customerDb.recordSyncChange(user.id, 'device', id, 'delete', nextRev);
    return { deleted: true };
  });

  // ==========================================================================
  // Validated Local & Mobile Diagnostics + Labeled Simulation Fixtures
  // ==========================================================================
  app.get('/api/v1/diagnostics/tools', { preHandler: requireCustomerAuth }, async () => {
    return { tools: DIAGNOSTIC_TOOL_REGISTRY };
  });

  const saveSnapshot = async (
    userId: string,
    snapshot: DiagnosticResult,
    deviceId?: string | null,
    investigationId?: string | null,
  ) => {
    const now = new Date().toISOString();
    await customerDb.db.run(
        `INSERT INTO diagnostic_snapshots (
          id, user_id, device_id, investigation_id, tool_id, measurement_type,
          simulated_scenario_id, source, platform, os_version, summary,
          warnings_json, limitations_json, data_json, duration_ms, revision,
          collected_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, snapshot.id,
        userId,
        deviceId ?? null,
        investigationId ?? null,
        snapshot.toolId,
        snapshot.measurementType,
        snapshot.simulatedScenarioId ?? null,
        snapshot.source,
        snapshot.platform,
        snapshot.osVersion,
        snapshot.summary,
        JSON.stringify(snapshot.warnings),
        JSON.stringify(snapshot.limitations),
        JSON.stringify(snapshot.data),
        snapshot.durationMs,
        snapshot.collectedAt,
        now,);
    await customerDb.recordSyncChange(userId, 'diagnostic_snapshot', snapshot.id, 'upsert', 1);
  };

  app.post('/api/v1/diagnostics/run', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      toolId: z.string(),
      parameters: z.record(z.unknown()).default({}),
      explicitUserApproval: z.boolean().default(false),
      deviceId: z.string().optional(),
      investigationId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const def = getToolDefinition(parsed.data.toolId);
    if (!def) {
      return reply.code(403).send({
        error: `Tool "${parsed.data.toolId}" is not registered in the validated CoreSense Diagnostic Tool Registry.`,
      });
    }
    if (def.requiresExplicitApproval && !parsed.data.explicitUserApproval) {
      return reply.code(403).send({
        error: 'Explicit user approval required for state-modifying tool.',
        approvalRequired: true,
        approvalWarning: def.approvalWarning,
      });
    }

    try {
      const result = await executeValidatedDiagnosticTool(parsed.data.toolId, parsed.data.parameters, {
        explicitUserApproval: parsed.data.explicitUserApproval,
      });
      await saveSnapshot(req.customerUser!.id, result, parsed.data.deviceId, parsed.data.investigationId);
      await customerDb.recordAudit(req.customerUser!.id, 'diagnostic_tool_executed', 'diagnostic', result.id, {
        toolId: parsed.data.toolId,
        riskLevel: def.riskLevel,
      });
      await emitUserTelemetry(req.customerUser!, 'diagnostic_scan_run', req, {
        durationMs: result.durationMs,
        metadata: { toolId: parsed.data.toolId, warningCount: result.warnings.length },
      });
      return { snapshot: result };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Diagnostic execution failed' });
    }
  });

  // Ingest native desktop (Tauri Rust) or mobile client diagnostic snapshot
  app.post('/api/v1/diagnostics/ingest', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      deviceId: z.string().optional(),
      investigationId: z.string().optional(),
      snapshot: DiagnosticResultSchema,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await saveSnapshot(req.customerUser!.id, parsed.data.snapshot, parsed.data.deviceId, parsed.data.investigationId);
    await emitUserTelemetry(req.customerUser!, 'diagnostic_scan_run', req, {
      platform: parsed.data.snapshot.platform,
      durationMs: parsed.data.snapshot.durationMs,
      metadata: { toolId: parsed.data.snapshot.toolId, clientIngested: true },
    });
    return reply.code(201).send({ snapshot: parsed.data.snapshot });
  });

  // Explicitly labeled Simulation Fixture endpoint (for evaluation & training — never real hardware!)
  app.post('/api/v1/diagnostics/simulate', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      scenarioId: z.enum([
        'high_cpu_runaway',
        'high_ram_pressure',
        'low_disk_space',
        'smart_ssd_failing',
        'wifi_disabled_or_down',
        'dns_failure_ip_ok',
        'battery_degraded',
        'thermal_overheating',
        'app_crash_loop',
        'windows_kernel_power_bsod',
        'healthy_baseline_after_fix',
      ]),
      deviceId: z.string().optional(),
      investigationId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const sim = buildSimulatedDiagnostic(parsed.data.scenarioId as SimulationScenarioId);
    await saveSnapshot(req.customerUser!.id, sim, parsed.data.deviceId, parsed.data.investigationId);
    return reply.code(201).send({ snapshot: sim });
  });

  app.get('/api/v1/diagnostics/history', { preHandler: requireCustomerAuth }, async (req) => {
    const { deviceId, limit } = req.query as { deviceId?: string; limit?: string };
    const max = Math.min(100, Math.max(1, Number(limit) || 30));
    const rows = deviceId
      ? ((await customerDb.db.all('SELECT * FROM diagnostic_snapshots WHERE user_id = ? AND device_id = ? ORDER BY collected_at DESC LIMIT ?', req.customerUser!.id, deviceId, max)) as Array<Record<string, unknown>>)
      : ((await customerDb.db.all('SELECT * FROM diagnostic_snapshots WHERE user_id = ? ORDER BY collected_at DESC LIMIT ?', req.customerUser!.id, max)) as Array<Record<string, unknown>>);

    return {
      snapshots: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        investigationId: r.investigation_id,
        toolId: r.tool_id,
        measurementType: r.measurement_type,
        simulatedScenarioId: r.simulated_scenario_id,
        source: r.source,
        platform: r.platform,
        osVersion: r.os_version,
        summary: r.summary,
        warnings: JSON.parse(String(r.warnings_json || '[]')),
        limitations: JSON.parse(String(r.limitations_json || '[]')),
        data: JSON.parse(String(r.data_json || '{}')),
        durationMs: r.duration_ms,
        collectedAt: r.collected_at,
      })),
    };
  });

  // ==========================================================================
  // AI Repair Copilot — Structured Diagnostic Investigations
  // ==========================================================================
  const loadSnapshotsByIds = async (userId: string, ids: string[]): Promise<DiagnosticResult[]> => {
    const out: DiagnosticResult[] = [];
    for (const sid of ids) {
      const r = (await customerDb.db.get('SELECT * FROM diagnostic_snapshots WHERE id = ? AND user_id = ?', sid, userId)) as Record<string, unknown> | undefined;
      if (r) {
        out.push({
          id: String(r.id),
          toolId: String(r.tool_id),
          measurementType: r.measurement_type as DiagnosticResult['measurementType'],
          simulatedScenarioId: r.simulated_scenario_id ? String(r.simulated_scenario_id) : undefined,
          source: String(r.source),
          platform: r.platform as DiagnosticResult['platform'],
          osVersion: String(r.os_version),
          collectedAt: String(r.collected_at),
          durationMs: Number(r.duration_ms),
          summary: String(r.summary),
          warnings: JSON.parse(String(r.warnings_json || '[]')),
          limitations: JSON.parse(String(r.limitations_json || '[]')),
          data: JSON.parse(String(r.data_json || '{}')),
        });
      }
    }
    return out;
  };

  const incrementUsage = async (userId: string, field: 'ai_messages' | 'image_analyses' | 'voice_interactions') => {
    const ym = getCurrentYm();
    await customerDb.db.run('INSERT OR IGNORE INTO usage_counters (user_id, period_ym) VALUES (?, ?)', userId, ym);
    await customerDb.db.run(`UPDATE usage_counters SET ${field} = ${field} + 1 WHERE user_id = ? AND period_ym = ?`, userId, ym);
  };

  const executeInvestigationTurn = async (params: {
    user: CustomerUserRow;
    req: FastifyRequest;
    investigationId: string;
    messageText: string;
    inputModality: 'text' | 'voice' | 'image';
    snapshotIds: string[];
    imageBase64?: string;
    imageMimeType?: string;
    imageFilename?: string;
  }) => {
    const { user, req, investigationId, messageText, inputModality, snapshotIds } = params;
    const inv = (await customerDb.db.get('SELECT * FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', investigationId, user.id)) as Record<string, unknown>;

    const deviceRow = inv.device_id
      ? ((await customerDb.db.get('SELECT * FROM devices WHERE id = ? AND user_id = ?', String(inv.device_id), user.id)) as Record<string, unknown> | undefined)
      : undefined;

    const historyRows = (await customerDb.db.all('SELECT role, content FROM investigation_messages WHERE investigation_id = ? ORDER BY created_at ASC', investigationId)) as Array<{ role: string; content: string }>;

    const existingEvidence = JSON.parse(String(inv.evidence_json || '[]')) as EvidenceItem[];
    const existingHypotheses = JSON.parse(String(inv.hypotheses_json || '[]')) as Hypothesis[];
    const attachedSnapshots = await loadSnapshotsByIds(user.id, snapshotIds);

    // Optional uploaded image attachment validation & clarity check
    let imageAttachment: Parameters<typeof runCopilotTurn>[0]['imageAttachment'] = null;
    const storedAttachments: Array<{ id: string; filename: string; mimeType: string; clarityNote: string }> = [];
    if (params.imageBase64 && params.imageMimeType) {
      const cleanB64 = params.imageBase64.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(cleanB64, 'base64');
      const fname = params.imageFilename || 'capture.png';
      const check = validateUploadedFile(buf, params.imageMimeType, fname);
      if (check.valid && check.detectedKind === 'image') {
        const meta = inspectImageBuffer(buf);
        const saved = saveUserAttachment(config.uploadsDir, user.id, fname, buf);
        const attId = crypto.randomUUID();
        await customerDb.db.run(
            `INSERT INTO media_attachments (
              id, user_id, device_id, investigation_id, filename, mime_type,
              size_bytes, storage_path, width, height, clarity_note, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, attId,
            user.id,
            inv.device_id ? String(inv.device_id) : null,
            investigationId,
            fname,
            params.imageMimeType,
            buf.length,
            saved.storagePath,
            meta.width,
            meta.height,
            meta.clarityNote,
            new Date().toISOString(),);
        imageAttachment = { filename: fname, mimeType: params.imageMimeType, base64Data: cleanB64, metadata: meta };
        storedAttachments.push({ id: attId, filename: fname, mimeType: params.imageMimeType, clarityNote: meta.clarityNote });
        await incrementUsage(user.id, 'image_analyses');
        await emitUserTelemetry(user, 'image_analysis_requested', req);
      }
    }

    const now = new Date().toISOString();
    const userMsgId = crypto.randomUUID();
    await customerDb.db.run(
        `INSERT INTO investigation_messages (
          id, investigation_id, user_id, role, content, input_modality, attachments_json, created_at
        ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`, userMsgId, investigationId, user.id, messageText, inputModality, JSON.stringify(storedAttachments), now);

    // Search user's private technical documents for traceable citations
    const anonHash = createAnonymousUserHash(user.id, config.jwtSecret);
    const retrievedCitations = await searchUserKnowledgeBase({
      customerDb,
      ownerDb,
      config,
      userId: user.id,
      anonymousUserHash: anonHash,
      query: `${String(inv.title)} ${messageText}`,
      deviceId: inv.device_id ? String(inv.device_id) : undefined,
      limit: 4,
    });

    // Decrypt BYOK key if configured (Ollama allowed without key)
    let byokConfig: Parameters<typeof runCopilotTurn>[0]['byokConfig'] = null;
    if (user.byok_provider && (user.byok_encrypted_key || user.byok_provider === 'ollama')) {
      try {
        byokConfig = {
          provider: user.byok_provider,
          apiKey: user.byok_encrypted_key ? decryptSecret(user.byok_encrypted_key, config.encryptionKey) : '',
          baseUrl: user.byok_base_url,
          model: user.byok_model,
        };
      } catch {
        byokConfig = null;
      }
    }

    const turnOut = await runCopilotTurn({
      userMessage: messageText,
      deviceProfile: deviceRow
        ? {
            name: String(deviceRow.name),
            category: String(deviceRow.category),
            manufacturer: String(deviceRow.manufacturer),
            model: String(deviceRow.model),
            osName: deviceRow.os_name ? String(deviceRow.os_name) : null,
            osVersion: deviceRow.os_version ? String(deviceRow.os_version) : null,
            specs: JSON.parse(String(deviceRow.specs_json || '{}')),
          }
        : null,
      history: historyRows,
      existingEvidence,
      existingHypotheses,
      attachedSnapshots,
      retrievedCitations,
      imageAttachment,
      externalAiConsent: user.external_ai_consent === 1,
      byokConfig,
      config,
      ownerDb,
      anonymousUserHash: anonHash,
    });

    const assistantMsgId = crypto.randomUUID();
    const replyTime = new Date().toISOString();
    await customerDb.db.run(
        `INSERT INTO investigation_messages (
          id, investigation_id, user_id, role, content, input_modality,
          citations_json, tool_calls_json, ai_provider, ai_model, created_at
        ) VALUES (?, ?, ?, 'assistant', ?, 'text', ?, ?, ?, ?, ?)`, assistantMsgId,
        investigationId,
        user.id,
        turnOut.assistantReply,
        JSON.stringify(turnOut.citationsUsed),
        JSON.stringify(turnOut.proposedTools),
        turnOut.aiProvider,
        turnOut.aiModel,
        replyTime,);

    const combinedEvidence = [...existingEvidence, ...turnOut.newEvidence].slice(-60);
    const existingSafety = JSON.parse(String(inv.safety_flags_json || '[]')) as Array<unknown>;
    const combinedSafety = [...existingSafety, ...turnOut.safetyFlags];
    const baselineId: string | null = inv.baseline_snapshot_id ? String(inv.baseline_snapshot_id) : snapshotIds[0] ?? null;
    const followupId: string | null = inv.baseline_snapshot_id && snapshotIds[0] ? snapshotIds[0] : (inv.followup_snapshot_id ? String(inv.followup_snapshot_id) : null);
    const nextRev = Number(inv.revision) + 1;

    await customerDb.db.run(
        `UPDATE investigations SET
          evidence_json = ?,
          hypotheses_json = ?,
          pending_tools_json = ?,
          safety_flags_json = ?,
          baseline_snapshot_id = ?,
          followup_snapshot_id = ?,
          revision = ?,
          updated_at = ?
         WHERE id = ? AND user_id = ?`, JSON.stringify(combinedEvidence),
        JSON.stringify(turnOut.updatedHypotheses),
        JSON.stringify(turnOut.proposedTools),
        JSON.stringify(combinedSafety),
        baselineId,
        followupId,
        nextRev,
        replyTime,
        investigationId,
        user.id,);

    await customerDb.recordSyncChange(user.id, 'investigation', investigationId, 'upsert', nextRev);
    await incrementUsage(user.id, 'ai_messages');
    if (inputModality === 'voice') {
      await incrementUsage(user.id, 'voice_interactions');
      await emitUserTelemetry(user, 'voice_interaction_used', req);
    }
    await emitUserTelemetry(user, 'investigation_message_sent', req, {
      metadata: {
        modality: inputModality,
        safetyTriggered: turnOut.safetyTriggered,
        citationCount: turnOut.citationsUsed.length,
      },
    });

    return {
      userMessageId: userMsgId,
      assistantMessage: {
        id: assistantMsgId,
        role: 'assistant',
        content: turnOut.assistantReply,
        aiProvider: turnOut.aiProvider,
        aiModel: turnOut.aiModel,
        citations: turnOut.citationsUsed,
        proposedTools: turnOut.proposedTools,
        createdAt: replyTime,
      },
      evidence: combinedEvidence,
      hypotheses: turnOut.updatedHypotheses,
      proposedTools: turnOut.proposedTools,
      safetyTriggered: turnOut.safetyTriggered,
      safetyFlags: combinedSafety,
      requiresProfessionalInspection: turnOut.requiresProfessionalInspection,
    };
  };

  app.get('/api/v1/investigations', { preHandler: requireCustomerAuth }, async (req) => {
    const rows = (await customerDb.db.all(
        `SELECT i.*, d.name AS device_name, d.category AS device_category
         FROM investigations i
         LEFT JOIN devices d ON d.id = i.device_id
         WHERE i.user_id = ? AND i.deleted_at IS NULL
         ORDER BY i.updated_at DESC`, req.customerUser!.id)) as Array<Record<string, unknown>>;

    return {
      investigations: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        deviceName: r.device_name,
        deviceCategory: r.device_category,
        title: r.title,
        initialSymptom: r.initial_symptom,
        status: r.status,
        verificationOutcome: r.verification_outcome,
        hypothesisCount: (JSON.parse(String(r.hypotheses_json || '[]')) as unknown[]).length,
        evidenceCount: (JSON.parse(String(r.evidence_json || '[]')) as unknown[]).length,
        safetyFlagCount: (JSON.parse(String(r.safety_flags_json || '[]')) as unknown[]).length,
        revision: r.revision,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post('/api/v1/investigations', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      title: z.string().min(2).max(160).optional(),
      initialSymptom: z.string().min(2).max(4000),
      deviceId: z.string().optional(),
      inputModality: z.enum(['text', 'voice', 'image']).default('text'),
      snapshotIds: z.array(z.string()).default([]),
      imageBase64: z.string().optional(),
      imageMimeType: z.string().optional(),
      imageFilename: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const user = req.customerUser!;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = parsed.data.title || parsed.data.initialSymptom.slice(0, 72);

    await customerDb.db.run(
        `INSERT INTO investigations (
          id, user_id, device_id, title, initial_symptom,
          status, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`, id, user.id, parsed.data.deviceId ?? null, title, parsed.data.initialSymptom, now, now);

    await emitUserTelemetry(user, 'investigation_started', req);

    const turnResult = await executeInvestigationTurn({
      user,
      req,
      investigationId: id,
      messageText: parsed.data.initialSymptom,
      inputModality: parsed.data.inputModality,
      snapshotIds: parsed.data.snapshotIds,
      imageBase64: parsed.data.imageBase64,
      imageMimeType: parsed.data.imageMimeType,
      imageFilename: parsed.data.imageFilename,
    });

    return reply.code(201).send({
      investigation: {
        id,
        title,
        deviceId: parsed.data.deviceId ?? null,
        status: 'active',
        createdAt: now,
      },
      ...turnResult,
    });
  });

  app.get('/api/v1/investigations/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = (await customerDb.db.get('SELECT * FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id)) as Record<string, unknown> | undefined;
    if (!inv) return reply.code(404).send({ error: 'Investigation not found' });

    const messages = (await customerDb.db.all('SELECT * FROM investigation_messages WHERE investigation_id = ? ORDER BY created_at ASC', id)) as Array<Record<string, unknown>>;

    return {
      investigation: {
        id: inv.id,
        deviceId: inv.device_id,
        title: inv.title,
        initialSymptom: inv.initial_symptom,
        status: inv.status,
        verificationOutcome: inv.verification_outcome,
        verificationReport: inv.verification_report_json ? JSON.parse(String(inv.verification_report_json)) : null,
        evidence: JSON.parse(String(inv.evidence_json || '[]')),
        hypotheses: JSON.parse(String(inv.hypotheses_json || '[]')),
        pendingTools: JSON.parse(String(inv.pending_tools_json || '[]')),
        safetyFlags: JSON.parse(String(inv.safety_flags_json || '[]')),
        baselineSnapshotId: inv.baseline_snapshot_id,
        followupSnapshotId: inv.followup_snapshot_id,
        revision: inv.revision,
        createdAt: inv.created_at,
        updatedAt: inv.updated_at,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        inputModality: m.input_modality,
        attachments: JSON.parse(String(m.attachments_json || '[]')),
        citations: JSON.parse(String(m.citations_json || '[]')),
        toolCalls: JSON.parse(String(m.tool_calls_json || '[]')),
        aiProvider: m.ai_provider,
        aiModel: m.ai_model,
        createdAt: m.created_at,
      })),
    };
  });

  app.post('/api/v1/investigations/:id/messages', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = await customerDb.db.get('SELECT id FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id);
    if (!inv) return reply.code(404).send({ error: 'Investigation not found' });

    const schema = z.object({
      message: z.string().min(1).max(6000),
      inputModality: z.enum(['text', 'voice', 'image']).default('text'),
      snapshotIds: z.array(z.string()).default([]),
      imageBase64: z.string().optional(),
      imageMimeType: z.string().optional(),
      imageFilename: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const out = await executeInvestigationTurn({
      user: req.customerUser!,
      req,
      investigationId: id,
      messageText: parsed.data.message,
      inputModality: parsed.data.inputModality,
      snapshotIds: parsed.data.snapshotIds,
      imageBase64: parsed.data.imageBase64,
      imageMimeType: parsed.data.imageMimeType,
      imageFilename: parsed.data.imageFilename,
    });
    return out;
  });

  // Add manual user measurement (e.g., multimeter voltage/resistance, USB meter reading)
  app.post('/api/v1/investigations/:id/measurements', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.customerUser!;
    const inv = (await customerDb.db.get('SELECT * FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, user.id)) as Record<string, unknown> | undefined;
    if (!inv) return reply.code(404).send({ error: 'Investigation not found' });

    const schema = z.object({
      title: z.string().min(2).max(120),
      value: z.string().min(1).max(160),
      instrument: z.string().max(100).default('User-supplied manual measurement'),
      notes: z.string().max(600).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const ev = JSON.parse(String(inv.evidence_json || '[]')) as EvidenceItem[];
    const item: EvidenceItem = {
      id: crypto.randomUUID(),
      kind: 'user_measurement',
      measurementType: 'user_reported',
      title: parsed.data.title,
      summary: `${parsed.data.value}${parsed.data.notes ? ` — ${parsed.data.notes}` : ''}`,
      source: parsed.data.instrument,
      collectedAt: new Date().toISOString(),
    };
    ev.push(item);
    const nextRev = Number(inv.revision) + 1;
    await customerDb.db.run('UPDATE investigations SET evidence_json = ?, revision = ?, updated_at = ? WHERE id = ?', JSON.stringify(ev), nextRev, new Date().toISOString(), id);
    await customerDb.recordSyncChange(user.id, 'investigation', id, 'upsert', nextRev);

    return reply.code(201).send({ measurement: item, evidence: ev });
  });

  // Execute an approved proposed tool directly inside an investigation & feed results to copilot
  app.post('/api/v1/investigations/:id/execute-tool', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.customerUser!;
    const inv = (await customerDb.db.get('SELECT * FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, user.id)) as Record<string, unknown> | undefined;
    if (!inv) return reply.code(404).send({ error: 'Investigation not found' });

    const schema = z.object({
      toolId: z.string(),
      parameters: z.record(z.unknown()).default({}),
      explicitUserApproval: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const def = getToolDefinition(parsed.data.toolId);
    if (!def) return reply.code(403).send({ error: 'Unknown or unauthorized tool ID.' });
    if (def.requiresExplicitApproval && !parsed.data.explicitUserApproval) {
      return reply.code(403).send({
        error: 'Explicit user approval required.',
        approvalWarning: def.approvalWarning,
      });
    }

    const snap = await executeValidatedDiagnosticTool(parsed.data.toolId, parsed.data.parameters, {
      explicitUserApproval: parsed.data.explicitUserApproval,
    });
    await saveSnapshot(user.id, snap, inv.device_id ? String(inv.device_id) : null, id);

    // Mark tool executed in pending_tools_json
    const pending = JSON.parse(String(inv.pending_tools_json || '[]')) as ProposedToolCall[];
    for (const t of pending) {
      if (t.toolId === parsed.data.toolId) t.status = 'executed';
    }
    await customerDb.db.run('UPDATE investigations SET pending_tools_json = ? WHERE id = ?', JSON.stringify(pending), id);

    const turnOut = await executeInvestigationTurn({
      user,
      req,
      investigationId: id,
      messageText: `Completed diagnostic tool "${def.name}". Please analyze these fresh measurements and update hypotheses.`,
      inputModality: 'text',
      snapshotIds: [snap.id],
    });

    return { snapshot: snap, ...turnOut };
  });

  // Formal 5-outcome Resolution Verification
  app.post('/api/v1/investigations/:id/verify', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.customerUser!;
    const inv = (await customerDb.db.get('SELECT * FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, user.id)) as Record<string, unknown> | undefined;
    if (!inv) return reply.code(404).send({ error: 'Investigation not found' });

    const schema = z.object({
      userSymptomStatus: z.enum(['resolved', 'improved', 'unchanged', 'worsened', 'unknown']),
      baselineSnapshotId: z.string().optional(),
      followupSnapshotId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const baseId = parsed.data.baselineSnapshotId || (inv.baseline_snapshot_id ? String(inv.baseline_snapshot_id) : undefined);
    const followId = parsed.data.followupSnapshotId || (inv.followup_snapshot_id ? String(inv.followup_snapshot_id) : undefined);
    const baseline = baseId ? (await loadSnapshotsByIds(user.id, [baseId]))[0] : null;
    const followup = followId ? (await loadSnapshotsByIds(user.id, [followId]))[0] : null;
    const safetyFlags = JSON.parse(String(inv.safety_flags_json || '[]')) as Array<{ severity: string }>;
    const safetyRequiresPro = safetyFlags.some((f) => f.severity === 'critical_stop');

    const report = verifyInvestigationResolution({
      baseline,
      followup,
      userSymptomStatus: parsed.data.userSymptomStatus,
      safetyRequiresPro,
    });

    const nextStatus = report.outcome === 'verified_resolved' ? 'resolved' : 'active';
    const nextRev = Number(inv.revision) + 1;
    const now = new Date().toISOString();
    await customerDb.db.run(
        `UPDATE investigations SET
          status = ?,
          verification_outcome = ?,
          verification_report_json = ?,
          followup_snapshot_id = ?,
          revision = ?,
          updated_at = ?
         WHERE id = ? AND user_id = ?`, nextStatus, report.outcome, JSON.stringify(report), followId ?? null, nextRev, now, id, user.id);

    await customerDb.recordSyncChange(user.id, 'investigation', id, 'upsert', nextRev);
    await emitUserTelemetry(user, 'investigation_completed', req, {
      metadata: { outcome: report.outcome },
    });

    return { verificationReport: report, status: nextStatus };
  });

  app.get('/api/v1/investigations/:id/report', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.customerUser!;
    const inv = (await customerDb.db.get('SELECT * FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, user.id)) as Record<string, unknown> | undefined;
    if (!inv) return reply.code(404).send({ error: 'Investigation not found' });

    const evidence = JSON.parse(String(inv.evidence_json || '[]')) as EvidenceItem[];
    const hypotheses = JSON.parse(String(inv.hypotheses_json || '[]')) as Hypothesis[];
    const verification = inv.verification_report_json ? JSON.parse(String(inv.verification_report_json)) : null;

    const md = [
      `# CoreSense Diagnostic Investigation Report`,
      `**Investigation:** ${String(inv.title)}`,
      `**Generated:** ${new Date().toISOString()}`,
      `**Status:** ${String(inv.status)} | **Verification Outcome:** ${String(inv.verification_outcome || 'Not yet verified')}`,
      `\n## Initial Symptom\n${String(inv.initial_symptom)}`,
      `\n## Collected Evidence & Provenance`,
      ...evidence.map((e) => `- **[${e.kind} • ${e.measurementType}]** ${e.title}: ${e.summary} _(Source: ${e.source}, ${e.collectedAt})_`),
      `\n## Diagnostic Hypotheses`,
      ...hypotheses.map(
        (h, i) =>
          `### ${i + 1}. ${h.title} (${h.status})\n- **Why Possible:** ${h.whyPossible}\n- **Supporting Evidence:** ${h.supportingEvidence.join('; ') || 'None'}\n- **Conflicting Evidence:** ${h.conflictingEvidence.join('; ') || 'None'}\n- **Discriminating Test:** ${h.discriminatingTest}`,
      ),
      ...(verification
        ? [
            `\n## Resolution Verification`,
            `**Outcome:** \`${verification.outcome}\`\n\n${verification.summary}`,
          ]
        : []),
    ].join('\n');

    await emitUserTelemetry(user, 'diagnostic_report_exported', req);
    return {
      reportId: crypto.randomUUID(),
      investigationId: id,
      markdown: md,
      structured: { investigation: inv.title, status: inv.status, verification, evidence, hypotheses },
    };
  });

  app.delete('/api/v1/investigations/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = (await customerDb.db.get('SELECT revision FROM investigations WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id)) as { revision: number } | undefined;
    if (!existing) return reply.code(404).send({ error: 'Investigation not found' });

    const now = new Date().toISOString();
    await customerDb.db.run('UPDATE investigations SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ?', now, existing.revision + 1, now, id);
    await customerDb.recordSyncChange(req.customerUser!.id, 'investigation', id, 'delete', existing.revision + 1);
    return { deleted: true };
  });

  // ==========================================================================
  // Knowledge Base & Technical Documents (PDF / MD / TXT + FTS5 RAG)
  // ==========================================================================
  app.get('/api/v1/documents', { preHandler: requireCustomerAuth }, async (req) => {
    const rows = (await customerDb.db.all('SELECT * FROM documents WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', req.customerUser!.id)) as Array<Record<string, unknown>>;
    return {
      documents: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        title: r.title,
        filename: r.filename,
        mimeType: r.mime_type,
        fileSizeBytes: r.file_size_bytes,
        pageCount: r.page_count,
        docVersion: r.doc_version,
        summary: r.summary,
        chunkCount: r.chunk_count,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/v1/documents', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const user = req.customerUser!;

    let title = '';
    let filename = 'manual.txt';
    let mimeType = 'text/plain';
    let deviceId: string | undefined;
    let docVersion = '1.0';
    let buffer: Buffer;

    if (req.isMultipart()) {
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'No file uploaded' });
      buffer = await part.toBuffer();
      filename = part.filename || 'manual.pdf';
      mimeType = part.mimetype || 'application/octet-stream';
      const fields = part.fields as Record<string, { value?: string } | undefined>;
      title = fields.title?.value || filename.replace(/\.[^.]+$/, '');
      deviceId = fields.deviceId?.value || undefined;
      docVersion = fields.docVersion?.value || '1.0';
    } else {
      const schema = z.object({
        title: z.string().min(1).max(160),
        filename: z.string().min(1).max(160).default('manual.md'),
        mimeType: z.string().default('text/markdown'),
        contentText: z.string().optional(),
        contentBase64: z.string().optional(),
        deviceId: z.string().optional(),
        docVersion: z.string().max(24).default('1.0'),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      title = parsed.data.title;
      filename = parsed.data.filename;
      mimeType = parsed.data.mimeType;
      deviceId = parsed.data.deviceId;
      docVersion = parsed.data.docVersion;
      if (parsed.data.contentBase64) {
        buffer = Buffer.from(parsed.data.contentBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      } else if (parsed.data.contentText) {
        buffer = Buffer.from(parsed.data.contentText, 'utf8');
      } else {
        return reply.code(400).send({ error: 'Provide either contentText or contentBase64.' });
      }
    }

    const check = validateUploadedFile(buffer, mimeType, filename);
    if (!check.valid || (check.detectedKind !== 'pdf' && check.detectedKind !== 'text')) {
      return reply.code(400).send({ error: check.reason || 'Only PDF, Markdown, TXT, JSON, or CSV technical documents are supported.' });
    }

    const res = await ingestTechnicalDocument({
      customerDb,
      ownerDb,
      config,
      userId: user.id,
      anonymousUserHash: createAnonymousUserHash(user.id, config.jwtSecret),
      deviceId,
      title,
      filename,
      mimeType,
      buffer,
      detectedKind: check.detectedKind,
      docVersion,
    });

    await emitUserTelemetry(user, 'document_uploaded', req, {
      metadata: { kind: check.detectedKind, pages: res.pageCount, chunks: res.chunkCount },
    });

    return reply.code(201).send({ document: { id: res.documentId, title, filename, ...res } });
  });

  app.get('/api/v1/documents/search', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { q, limit } = req.query as { q?: string; limit?: string };
    if (!q || q.trim().length < 2) return reply.code(400).send({ error: 'Query parameter q (min 2 chars) required.' });
    const hits = await searchUserKnowledgeBase({
      customerDb,
      ownerDb,
      config,
      userId: req.customerUser!.id,
      anonymousUserHash: createAnonymousUserHash(req.customerUser!.id, config.jwtSecret),
      query: q,
      limit: Math.min(15, Number(limit) || 6),
    });
    return { results: hits };
  });

  app.delete('/api/v1/documents/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteUserDocument(customerDb, req.customerUser!.id, id);
    if (!ok) return reply.code(404).send({ error: 'Document not found' });
    return { deleted: true };
  });

  // ==========================================================================
  // Personal Repair Cases, Measurements, Expenses & Reports
  // ==========================================================================
  app.get('/api/v1/cases', { preHandler: requireCustomerAuth }, async (req) => {
    const rows = (await customerDb.db.all(
        `SELECT rc.*, d.name AS device_name,
          (SELECT COALESCE(SUM(amount), 0) FROM repair_expenses re WHERE re.repair_case_id = rc.id) AS total_expense,
          (SELECT COUNT(*) FROM repair_case_entries rce WHERE rce.repair_case_id = rc.id) AS entry_count
         FROM repair_cases rc
         LEFT JOIN devices d ON d.id = rc.device_id
         WHERE rc.user_id = ? AND rc.deleted_at IS NULL
         ORDER BY rc.updated_at DESC`, req.customerUser!.id)) as Array<Record<string, unknown>>;

    return {
      cases: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        deviceName: r.device_name,
        investigationId: r.investigation_id,
        title: r.title,
        symptomSummary: r.symptom_summary,
        diagnosisSummary: r.diagnosis_summary,
        resolutionNotes: r.resolution_notes,
        priority: r.priority,
        status: r.status,
        totalExpense: r.total_expense,
        entryCount: r.entry_count,
        revision: r.revision,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post('/api/v1/cases', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const parsed = RepairCaseCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const d = parsed.data;
    await customerDb.db.run(
        `INSERT INTO repair_cases (
          id, user_id, device_id, investigation_id, title, symptom_summary,
          priority, status, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, id, req.customerUser!.id, d.deviceId ?? null, d.investigationId ?? null, d.title, d.symptomSummary, d.priority, d.status, now, now);
    await customerDb.recordSyncChange(req.customerUser!.id, 'repair_case', id, 'upsert', 1);
    await emitUserTelemetry(req.customerUser!, 'repair_case_created', req);
    return reply.code(201).send({ repairCase: { id, ...d, revision: 1, createdAt: now, updatedAt: now } });
  });

  app.get('/api/v1/cases/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rc = (await customerDb.db.get('SELECT * FROM repair_cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id)) as Record<string, unknown> | undefined;
    if (!rc) return reply.code(404).send({ error: 'Repair case not found' });

    const entries = await customerDb.db.all('SELECT * FROM repair_case_entries WHERE repair_case_id = ? ORDER BY created_at DESC', id);
    const expenses = await customerDb.db.all('SELECT * FROM repair_expenses WHERE repair_case_id = ? ORDER BY created_at DESC', id);

    return {
      repairCase: {
        id: rc.id,
        deviceId: rc.device_id,
        investigationId: rc.investigation_id,
        title: rc.title,
        symptomSummary: rc.symptom_summary,
        diagnosisSummary: rc.diagnosis_summary,
        resolutionNotes: rc.resolution_notes,
        priority: rc.priority,
        status: rc.status,
        revision: rc.revision,
        createdAt: rc.created_at,
        updatedAt: rc.updated_at,
      },
      entries,
      expenses,
    };
  });

  app.patch('/api/v1/cases/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rc = (await customerDb.db.get('SELECT * FROM repair_cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id)) as Record<string, unknown> | undefined;
    if (!rc) return reply.code(404).send({ error: 'Repair case not found' });

    const schema = z.object({
      title: z.string().min(2).max(160).optional(),
      symptomSummary: z.string().max(3000).optional(),
      diagnosisSummary: z.string().max(4000).optional(),
      resolutionNotes: z.string().max(4000).optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      status: z.enum(['open', 'investigating', 'waiting_parts', 'resolved', 'referred_pro', 'closed']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    const now = new Date().toISOString();
    const nextRev = Number(rc.revision) + 1;

    await customerDb.db.run(
        `UPDATE repair_cases SET
          title = ?, symptom_summary = ?, diagnosis_summary = ?, resolution_notes = ?,
          priority = ?, status = ?, revision = ?, updated_at = ?
         WHERE id = ?`, String(d.title ?? rc.title),
        String(d.symptomSummary ?? rc.symptom_summary ?? ''),
        String(d.diagnosisSummary ?? rc.diagnosis_summary ?? ''),
        String(d.resolutionNotes ?? rc.resolution_notes ?? ''),
        String(d.priority ?? rc.priority ?? 'medium'),
        String(d.status ?? rc.status ?? 'open'),
        nextRev,
        now,
        id,);
    await customerDb.recordSyncChange(req.customerUser!.id, 'repair_case', id, 'upsert', nextRev);
    return { ok: true, revision: nextRev };
  });

  app.post('/api/v1/cases/:id/entries', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rc = await customerDb.db.get('SELECT id FROM repair_cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id);
    if (!rc) return reply.code(404).send({ error: 'Repair case not found' });

    const schema = z.object({
      entryType: z.enum(['note', 'measurement', 'photo', 'step', 'finding']).default('note'),
      title: z.string().min(1).max(140),
      body: z.string().max(4000),
      measurementValue: z.string().max(120).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const entryId = crypto.randomUUID();
    const now = new Date().toISOString();
    await customerDb.db.run(
        'INSERT INTO repair_case_entries (id, repair_case_id, user_id, entry_type, title, body, measurement_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', entryId, id, req.customerUser!.id, parsed.data.entryType, parsed.data.title, parsed.data.body, parsed.data.measurementValue ?? null, now);
    return reply.code(201).send({ entry: { id: entryId, ...parsed.data, createdAt: now } });
  });

  app.post('/api/v1/cases/:id/expenses', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rc = await customerDb.db.get('SELECT id FROM repair_cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id);
    if (!rc) return reply.code(404).send({ error: 'Repair case not found' });

    const parsed = RepairExpenseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const expId = crypto.randomUUID();
    const now = new Date().toISOString();
    const d = parsed.data;
    await customerDb.db.run(
        'INSERT INTO repair_expenses (id, repair_case_id, user_id, item_name, category, amount, currency, vendor, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', expId, id, req.customerUser!.id, d.itemName, d.category, d.amount, d.currency, d.vendor ?? null, d.notes ?? null, now);
    return reply.code(201).send({ expense: { id: expId, ...d, createdAt: now } });
  });

  app.delete('/api/v1/cases/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rc = (await customerDb.db.get('SELECT revision FROM repair_cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, req.customerUser!.id)) as { revision: number } | undefined;
    if (!rc) return reply.code(404).send({ error: 'Repair case not found' });
    const now = new Date().toISOString();
    await customerDb.db.run('UPDATE repair_cases SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ?', now, rc.revision + 1, now, id);
    await customerDb.recordSyncChange(req.customerUser!.id, 'repair_case', id, 'delete', rc.revision + 1);
    return { deleted: true };
  });

  // ==========================================================================
  // Cross-Device Synchronization (Desktop <-> Mobile Delta Sync + Conflicts)
  // ==========================================================================
  app.get('/api/v1/sync/pull', { preHandler: requireCustomerAuth }, async (req) => {
    const user = req.customerUser!;
    if (user.cloud_sync_enabled !== 1) {
      return { syncEnabled: false, latestSeq: 0, changes: [] };
    }
    const sinceSeq = Math.max(0, Number((req.query as { sinceSeq?: string }).sinceSeq) || 0);
    const logs = (await customerDb.db.all('SELECT * FROM sync_log WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200', user.id, sinceSeq)) as Array<{
      seq: number;
      entity_type: string;
      entity_id: string;
      operation: string;
      revision: number;
      updated_at: string;
    }>;

    const latestRow = (await customerDb.db.get('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM sync_log WHERE user_id = ?', user.id)) as { max_seq: number };

    const tableMap: Record<string, string> = {
      device: 'devices',
      investigation: 'investigations',
      repair_case: 'repair_cases',
      document: 'documents',
      diagnostic_snapshot: 'diagnostic_snapshots',
    };

    const changes = await Promise.all(logs.map(async (l) => {
      const tbl = tableMap[l.entity_type];
      const record = tbl
        ? await customerDb.db.get(`SELECT * FROM ${tbl} WHERE id = ? AND user_id = ?`, l.entity_id, user.id)
        : null;
      return {
        seq: l.seq,
        entityType: l.entity_type,
        entityId: l.entity_id,
        operation: l.operation,
        revision: l.revision,
        updatedAt: l.updated_at,
        record: record ?? null,
      };
    }));

    await emitUserTelemetry(user, 'sync_completed', req, { metadata: { direction: 'pull', count: changes.length } });
    return { syncEnabled: true, latestSeq: latestRow.max_seq, changes };
  });

  app.post('/api/v1/sync/push', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const user = req.customerUser!;
    if (user.cloud_sync_enabled !== 1) {
      return reply.code(403).send({ error: 'Cloud synchronization is disabled in your privacy settings.' });
    }
    const schema = z.object({ mutations: z.array(SyncMutationSchema).max(50) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const applied: Array<{ clientMutationId: string; entityId: string; newRevision: number }> = [];
    const conflicts: Array<{
      clientMutationId: string;
      entityType: string;
      entityId: string;
      clientBaseRevision: number;
      serverRevision: number;
      serverRecord: unknown;
    }> = [];

    const now = new Date().toISOString();
    for (const m of parsed.data.mutations) {
      if (m.entityType === 'device') {
        const existing = (await customerDb.db.get('SELECT * FROM devices WHERE id = ? AND user_id = ?', m.entityId, user.id)) as Record<string, unknown> | undefined;

        if (existing && Number(existing.revision) > m.baseRevision) {
          conflicts.push({
            clientMutationId: m.clientMutationId,
            entityType: m.entityType,
            entityId: m.entityId,
            clientBaseRevision: m.baseRevision,
            serverRevision: Number(existing.revision),
            serverRecord: existing,
          });
          continue;
        }

        if (m.operation === 'delete' && existing) {
          const nextRev = Number(existing.revision) + 1;
          await customerDb.db.run('UPDATE devices SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ?', now, nextRev, now, m.entityId);
          await customerDb.recordSyncChange(user.id, 'device', m.entityId, 'delete', nextRev);
          applied.push({ clientMutationId: m.clientMutationId, entityId: m.entityId, newRevision: nextRev });
        } else if (m.operation === 'upsert') {
          const p = m.payload;
          if (existing) {
            const nextRev = Number(existing.revision) + 1;
            await customerDb.db.run(
                'UPDATE devices SET name = ?, notes = ?, model = ?, manufacturer = ?, revision = ?, updated_at = ? WHERE id = ?', String(p.name ?? existing.name),
                String(p.notes ?? existing.notes),
                String(p.model ?? existing.model),
                String(p.manufacturer ?? existing.manufacturer),
                nextRev,
                now,
                m.entityId,);
            await customerDb.recordSyncChange(user.id, 'device', m.entityId, 'upsert', nextRev);
            applied.push({ clientMutationId: m.clientMutationId, entityId: m.entityId, newRevision: nextRev });
          } else {
            await customerDb.db.run(
                `INSERT INTO devices (
                  id, user_id, name, category, manufacturer, model, notes, specs_json,
                  archived, revision, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`, m.entityId,
                user.id,
                String(p.name || 'Synced Device'),
                String(p.category || 'other'),
                String(p.manufacturer || ''),
                String(p.model || ''),
                String(p.notes || ''),
                JSON.stringify(p.specs || {}),
                now,
                now,);
            await customerDb.recordSyncChange(user.id, 'device', m.entityId, 'upsert', 1);
            applied.push({ clientMutationId: m.clientMutationId, entityId: m.entityId, newRevision: 1 });
          }
        }
      } else if (m.entityType === 'repair_case') {
        const existing = (await customerDb.db.get('SELECT * FROM repair_cases WHERE id = ? AND user_id = ?', m.entityId, user.id)) as Record<string, unknown> | undefined;
        if (existing && Number(existing.revision) > m.baseRevision) {
          conflicts.push({
            clientMutationId: m.clientMutationId,
            entityType: m.entityType,
            entityId: m.entityId,
            clientBaseRevision: m.baseRevision,
            serverRevision: Number(existing.revision),
            serverRecord: existing,
          });
          continue;
        }
        const p = m.payload;
        if (existing) {
          const nextRev = Number(existing.revision) + 1;
          await customerDb.db.run('UPDATE repair_cases SET title = ?, status = ?, resolution_notes = ?, revision = ?, updated_at = ? WHERE id = ?', String(p.title ?? existing.title),
              String(p.status ?? existing.status),
              String(p.resolutionNotes ?? existing.resolution_notes),
              nextRev,
              now,
              m.entityId,);
          await customerDb.recordSyncChange(user.id, 'repair_case', m.entityId, 'upsert', nextRev);
          applied.push({ clientMutationId: m.clientMutationId, entityId: m.entityId, newRevision: nextRev });
        } else {
          await customerDb.db.run(
              'INSERT INTO repair_cases (id, user_id, device_id, title, symptom_summary, priority, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', m.entityId,
              user.id,
              p.deviceId ? String(p.deviceId) : null,
              String(p.title || 'Synced Repair Case'),
              String(p.symptomSummary || ''),
              String(p.priority || 'medium'),
              String(p.status || 'open'),
              now,
              now,);
          await customerDb.recordSyncChange(user.id, 'repair_case', m.entityId, 'upsert', 1);
          applied.push({ clientMutationId: m.clientMutationId, entityId: m.entityId, newRevision: 1 });
        }
      }
    }

    await emitUserTelemetry(user, conflicts.length > 0 ? 'sync_failed' : 'sync_completed', req, {
      success: conflicts.length === 0,
      metadata: { direction: 'push', applied: applied.length, conflicts: conflicts.length },
    });

    return { applied, conflicts };
  });

  // ==========================================================================
  // Voluntary User Feedback & Explicit Opt-In Support Reports
  // ==========================================================================
  app.post('/api/v1/feedback', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      category: z.enum(['feedback', 'bug_report', 'feature_request']),
      rating: z.number().int().min(1).max(5).optional(),
      title: z.string().min(2).max(140),
      message: z.string().min(4).max(2000),
      platform: PlatformSchema.default('windows'),
      appVersion: z.string().max(32).default(CORESENSE_VERSION),
      nonSensitiveErrorCode: z.string().max(64).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const id = crypto.randomUUID();
    await ownerDb.db.run(
        `INSERT INTO user_feedback (
          id, category, rating, title, message, platform, app_version,
          non_sensitive_error_code, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`, id,
        parsed.data.category,
        parsed.data.rating ?? null,
        parsed.data.title,
        parsed.data.message,
        parsed.data.platform,
        parsed.data.appVersion,
        parsed.data.nonSensitiveErrorCode ?? null,
        new Date().toISOString(),);
    await emitUserTelemetry(req.customerUser!, 'feedback_submitted', req, {
      metadata: { category: parsed.data.category },
    });
    return reply.code(201).send({ feedbackId: id, submitted: true });
  });

  app.post('/api/v1/support/opt-in-report', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const schema = z.object({
      explicitUserConsent: z.literal(true),
      summary: z.string().min(5).max(1500),
      platform: PlatformSchema.default('windows'),
      appVersion: z.string().max(32).default(CORESENSE_VERSION),
      selectedDiagnosticSummary: z.record(z.unknown()).default({}),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Explicit user consent is required to share a support report.' });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await ownerDb.db.run(
        `INSERT INTO opt_in_support_reports (
          id, consent_confirmed, consent_timestamp, platform, app_version,
          summary, attached_diagnostics_json, status, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, 'open', ?)`, id,
        now,
        parsed.data.platform,
        parsed.data.appVersion,
        parsed.data.summary,
        JSON.stringify(parsed.data.selectedDiagnosticSummary),
        now,);
    await customerDb.recordAudit(req.customerUser!.id, 'support_report_authorized', 'support', id);
    return reply.code(201).send({ reportId: id, authorized: true });
  });
}
