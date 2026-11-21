import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CORESENSE_VERSION } from '@coresense/shared';
import type { AppConfig } from '../config.js';
import type { OwnerDatabase } from '../db/ownerDb.js';
import {
  generateTotpSecret,
  signJwt,
  verifyJwt,
  verifyPassword,
  verifyTotpCode,
} from '../security/crypto.js';

// ============================================================================
// Private CoreSense Owner Observability Console API (/owner-api/v1/*)
// ARCHITECTURAL PRIVACY BOUNDARY:
// Notice this module NEVER imports or receives `customerDb`. It operates
// exclusively on `owner_observability` / `coresense_owner.db`, making browsing
// of private customer chats, photos, documents, or device records structurally impossible.
// ============================================================================

interface OwnerAdminRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  last_login_at: string | null;
  created_at: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    ownerAdmin?: OwnerAdminRow;
  }
}

function getDateCutoff(range?: string): string {
  const now = Date.now();
  switch (range) {
    case '24h':
      return new Date(now - 24 * 3600 * 1000).toISOString();
    case '7d':
      return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    case '30d':
      return new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    case '90d':
      return new Date(now - 90 * 24 * 3600 * 1000).toISOString();
    case 'all':
      return '1970-01-01T00:00:00.000Z';
    default:
      return new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  }
}

export function registerOwnerRoutes(
  app: FastifyInstance,
  deps: { ownerDb: OwnerDatabase; config: AppConfig },
): void {
  const { ownerDb, config } = deps;

  const requireOwnerAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Owner authentication required' });
    }
    const token = authHeader.slice(7);
    const payload = verifyJwt(token, config.ownerJwtSecret, 'coresense-owner');
    if (!payload || payload.role !== 'owner_admin') {
      return reply.code(403).send({ error: 'Forbidden: Privileged Owner token required.' });
    }
    const admin = await ownerDb.db.get<OwnerAdminRow>('SELECT * FROM owner_admins WHERE id = ?', payload.sub);
    if (!admin) return reply.code(401).send({ error: 'Owner account not found' });
    req.ownerAdmin = admin;
  };

  // ==========================================================================
  // Separate Privileged Owner Authentication + Optional TOTP MFA
  // ==========================================================================
  app.post('/owner-api/v1/auth/login', async (req, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
      totpCode: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const admin = await ownerDb.db.get<OwnerAdminRow>(
      'SELECT * FROM owner_admins WHERE email = ?',
      parsed.data.email.toLowerCase().trim(),
    );

    if (!admin || !verifyPassword(parsed.data.password, admin.password_hash)) {
      return reply.code(401).send({ error: 'Invalid owner credentials.' });
    }

    if (admin.totp_enabled === 1 && admin.totp_secret) {
      if (!parsed.data.totpCode) {
        return reply.code(401).send({ error: 'MFA verification code required.', mfaRequired: true });
      }
      if (!verifyTotpCode(admin.totp_secret, parsed.data.totpCode)) {
        return reply.code(401).send({ error: 'Invalid MFA verification code.', mfaRequired: true });
      }
    }

    const now = new Date().toISOString();
    await ownerDb.db.run('UPDATE owner_admins SET last_login_at = ? WHERE id = ?', now, admin.id);
    const token = signJwt(
      { sub: admin.id, aud: 'coresense-owner', role: 'owner_admin' },
      config.ownerJwtSecret,
      60 * 60 * 12,
    );

    return {
      accessToken: token,
      owner: {
        id: admin.id,
        email: admin.email,
        displayName: admin.display_name,
        totpEnabled: admin.totp_enabled === 1,
        lastLoginAt: now,
      },
    };
  });

  app.get('/owner-api/v1/auth/me', { preHandler: requireOwnerAuth }, async (req) => {
    const a = req.ownerAdmin!;
    return {
      owner: {
        id: a.id,
        email: a.email,
        displayName: a.display_name,
        totpEnabled: a.totp_enabled === 1,
        lastLoginAt: a.last_login_at,
      },
      privacyGuarantee:
        'Owner Console operates on an isolated telemetry store (owner_observability) with zero access to customer conversations, photos, documents, or personal repair workspaces.',
    };
  });

  app.post('/owner-api/v1/auth/mfa/setup', { preHandler: requireOwnerAuth }, async (req) => {
    const secret = generateTotpSecret();
    await ownerDb.db.run('UPDATE owner_admins SET totp_secret = ? WHERE id = ?', secret, req.ownerAdmin!.id);
    return {
      secret,
      otpauthUri: `otpauth://totp/CoreSenseOwner:${encodeURIComponent(req.ownerAdmin!.email)}?secret=${secret}&issuer=CoreSenseOwner`,
    };
  });

  app.post('/owner-api/v1/auth/mfa/enable', { preHandler: requireOwnerAuth }, async (req, reply) => {
    const schema = z.object({ code: z.string().length(6) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '6-digit code required' });
    const secret = req.ownerAdmin!.totp_secret;
    if (!secret || !verifyTotpCode(secret, parsed.data.code)) {
      return reply.code(400).send({ error: 'Invalid TOTP verification code.' });
    }
    await ownerDb.db.run('UPDATE owner_admins SET totp_enabled = 1 WHERE id = ?', req.ownerAdmin!.id);
    return { totpEnabled: true };
  });

  // ==========================================================================
  // Executive Overview + Alert Status
  // ==========================================================================
  app.get('/owner-api/v1/overview', { preHandler: requireOwnerAuth }, async (req) => {
    const { range } = req.query as { range?: string };
    const cutoff = getDateCutoff(range || '30d');
    const now = Date.now();
    const cut1d = new Date(now - 24 * 3600 * 1000).toISOString();
    const cut7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const cut30d = new Date(now - 30 * 24 * 3600 * 1000).toISOString();

    const installerDownloads = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM installer_downloads WHERE created_at >= ?', cutoff))?.c ?? 0,
    );
    const firstActivations = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM app_activations WHERE first_activated_at >= ?', cutoff))?.c ?? 0,
    );
    const activeInstallations30d = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM app_activations WHERE last_seen_at >= ?', cut30d))?.c ?? 0,
    );

    const totalRegistered = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NULL'))?.c ?? 0,
    );
    const totalDeleted = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NOT NULL AND deleted_at >= ?', cutoff))?.c ?? 0,
    );
    const newRegistrations = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM account_lifecycle WHERE registered_at >= ?', cutoff))?.c ?? 0,
    );

    const dau = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?', cut1d))?.c ?? 0,
    );
    const wau = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?', cut7d))?.c ?? 0,
    );
    const mau = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?', cut30d))?.c ?? 0,
    );

    const totalScans = Number(
      (await ownerDb.db.get<{ c: number }>("SELECT COUNT(*) as c FROM product_events WHERE event_name = 'diagnostic_scan_run' AND created_at >= ?", cutoff))?.c ?? 0,
    );
    const totalInvestigations = Number(
      (await ownerDb.db.get<{ c: number }>("SELECT COUNT(*) as c FROM product_events WHERE event_name = 'investigation_started' AND created_at >= ?", cutoff))?.c ?? 0,
    );

    const aiStats = (await ownerDb.db.get<{
      total_requests: number;
      input_tokens: number;
      output_tokens: number;
      total_cost_usd: number;
      avg_latency_ms: number;
      failed_requests: number;
    }>(
      `SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(estimated_cost_usd), 0) as total_cost_usd,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failed_requests
      FROM ai_usage_ledger WHERE created_at >= ?`,
      cutoff,
    )) ?? {
      total_requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_cost_usd: 0,
      avg_latency_ms: 0,
      failed_requests: 0,
    };

    const apiStats = (await ownerDb.db.get<{
      total_calls: number;
      avg_latency_ms: number;
      server_errors: number;
    }>(
      `SELECT
        COUNT(*) as total_calls,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
        COALESCE(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END), 0) as server_errors
      FROM api_metrics WHERE created_at >= ?`,
      cutoff,
    )) ?? { total_calls: 0, avg_latency_ms: 0, server_errors: 0 };

    const crashesCount = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM crash_reports WHERE created_at >= ?', cutoff))?.c ?? 0,
    );
    const launchesCount = Number(
      (await ownerDb.db.get<{ c: number }>("SELECT COUNT(*) as c FROM product_events WHERE event_name = 'app_launched' AND created_at >= ?", cutoff))?.c ?? 0,
    );
    const crashFreeRate =
      launchesCount > 0
        ? Math.max(0, Math.min(100, Math.round(((launchesCount - crashesCount) / launchesCount) * 1000) / 10))
        : crashesCount === 0
          ? 100
          : 0;

    // Evaluate live alert rules
    const rules = await ownerDb.db.all<{
      id: string;
      metric_key: string;
      label: string;
      threshold_value: number;
      unit: string;
    }>('SELECT * FROM alert_rules WHERE enabled = 1');

    const totalCalls = Number(apiStats.total_calls);
    const serverErrors = Number(apiStats.server_errors);
    const aiTotalCost = Number(aiStats.total_cost_usd);
    const aiAvgLatency = Number(aiStats.avg_latency_ms);
    const api5xxRate = totalCalls > 0 ? (serverErrors / totalCalls) * 100 : 0;
    const crashRate = launchesCount > 0 ? (crashesCount / launchesCount) * 100 : 0;
    const currentMetricValues: Record<string, number> = {
      monthly_ai_cost_usd: aiTotalCost,
      api_5xx_rate_percent: Math.round(api5xxRate * 100) / 100,
      crash_rate_percent: Math.round(crashRate * 100) / 100,
      ai_avg_latency_ms: Math.round(aiAvgLatency),
    };
    const alerts = rules.map((r) => {
      const current = currentMetricValues[r.metric_key] ?? 0;
      const threshold = Number(r.threshold_value);
      return {
        id: r.id,
        metricKey: r.metric_key,
        label: r.label,
        currentValue: current,
        thresholdValue: threshold,
        unit: r.unit,
        triggered: current > threshold,
      };
    });

    return {
      range: range || '30d',
      kpis: {
        installerDownloads,
        firstActivations,
        activeInstallations30d,
        totalRegisteredUsers: totalRegistered,
        newRegistrations,
        accountDeletions: totalDeleted,
        dau,
        wau,
        mau,
        totalScans,
        totalInvestigations,
        aiTotalRequests: Number(aiStats.total_requests),
        aiTotalCostUsd: Math.round(aiTotalCost * 10000) / 10000,
        aiCostPerActiveUserUsd: mau > 0 ? Math.round((aiTotalCost / mau) * 10000) / 10000 : 0,
        aiAvgLatencyMs: Math.round(aiAvgLatency),
        apiTotalCalls: totalCalls,
        apiAvgLatencyMs: Math.round(Number(apiStats.avg_latency_ms)),
        apiErrorRatePercent: Math.round(api5xxRate * 100) / 100,
        crashFreeSessionsPercent: crashFreeRate,
        crashCount: crashesCount,
      },
      alerts,
    };
  });

  // ==========================================================================
  // A. Downloads & Installations (Strictly Separated Metrics)
  // ==========================================================================
  app.get('/owner-api/v1/downloads', { preHandler: requireOwnerAuth }, async (req) => {
    const cutoff = getDateCutoff((req.query as { range?: string }).range);
    const downloadsByPlatform = await ownerDb.db.all(
      'SELECT platform, channel, app_version, COUNT(*) as count FROM installer_downloads WHERE created_at >= ? GROUP BY platform, channel, app_version ORDER BY count DESC',
      cutoff,
    );
    const activationsByPlatform = await ownerDb.db.all(
      'SELECT platform, app_version, COUNT(*) as activations FROM app_activations WHERE first_activated_at >= ? GROUP BY platform, app_version ORDER BY activations DESC',
      cutoff,
    );
    const activeByVersion = await ownerDb.db.all(
      'SELECT app_version, platform, COUNT(*) as installs FROM app_activations GROUP BY app_version, platform ORDER BY installs DESC',
    );
    const geoAggregates = await ownerDb.db.all(
      "SELECT COALESCE(country_code, 'UNSPECIFIED') as country, COUNT(*) as installs FROM app_activations GROUP BY country ORDER BY installs DESC LIMIT 20",
    );

    return {
      separationNote:
        'Installer downloads, first-launch activations, active installations, and registered accounts are tracked as distinct tables and never fabricated from each other.',
      downloadsByPlatform,
      activationsByPlatform,
      activeByVersion,
      geoAggregates,
    };
  });

  // ==========================================================================
  // B. User Analytics, Retention & Platform Adoption
  // ==========================================================================
  app.get('/owner-api/v1/users', { preHandler: requireOwnerAuth }, async (req) => {
    const cutoff = getDateCutoff((req.query as { range?: string }).range);
    const dailySignups = await ownerDb.db.all(
      'SELECT substr(registered_at, 1, 10) as day, COUNT(*) as registrations FROM account_lifecycle WHERE registered_at >= ? GROUP BY day ORDER BY day ASC',
      cutoff,
    );
    const dailyActive = await ownerDb.db.all(
      'SELECT substr(created_at, 1, 10) as day, COUNT(DISTINCT anonymous_user_hash) as active_users FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ? GROUP BY day ORDER BY day ASC',
      cutoff,
    );
    const platformAdoption = await ownerDb.db.all(
      'SELECT platform, COUNT(*) as users FROM account_lifecycle WHERE deleted_at IS NULL GROUP BY platform ORDER BY users DESC',
    );

    const totalEver = Number((await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM account_lifecycle'))?.c ?? 0);
    const deletedEver = Number(
      (await ownerDb.db.get<{ c: number }>('SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NOT NULL'))?.c ?? 0,
    );
    const returningUsers = Number(
      (await ownerDb.db.get<{ c: number }>(
        `SELECT COUNT(*) as c FROM (
          SELECT anonymous_user_hash FROM product_events
          WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?
          GROUP BY anonymous_user_hash HAVING COUNT(DISTINCT substr(created_at, 1, 10)) >= 2
        ) AS sub`,
        cutoff,
      ))?.c ?? 0,
    );
    const activePeriodUsers = Number(
      (await ownerDb.db.get<{ c: number }>(
        'SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?',
        cutoff,
      ))?.c ?? 0,
    );

    return {
      dailySignups,
      dailyActive,
      platformAdoption,
      summary: {
        totalRegisteredEver: totalEver,
        activeAccounts: totalEver - deletedEver,
        accountDeletions: deletedEver,
        churnRatePercent: totalEver > 0 ? Math.round((deletedEver / totalEver) * 1000) / 10 : 0,
        returningUsers,
        retentionRatePercent: activePeriodUsers > 0 ? Math.round((returningUsers / activePeriodUsers) * 1000) / 10 : 0,
      },
    };
  });

  // ==========================================================================
  // C. Product Engagement & Workflow Funnel
  // ==========================================================================
  app.get('/owner-api/v1/engagement', { preHandler: requireOwnerAuth }, async (req) => {
    const cutoff = getDateCutoff((req.query as { range?: string }).range);
    const featureCounts = await ownerDb.db.all<{ event_name: string; count: number; unique_users: number }>(
      'SELECT event_name, COUNT(*) as count, COUNT(DISTINCT anonymous_user_hash) as unique_users FROM product_events WHERE created_at >= ? GROUP BY event_name ORDER BY count DESC',
      cutoff,
    );

    const map = new Map(featureCounts.map((f) => [f.event_name, Number(f.count)]));
    const funnel = [
      { stage: 'Account Registered', count: map.get('account_registered') ?? 0 },
      { stage: 'Onboarding Completed', count: map.get('onboarding_completed') ?? 0 },
      { stage: 'Device Added', count: map.get('device_added') ?? 0 },
      { stage: 'Diagnostic Scan Run', count: map.get('diagnostic_scan_run') ?? 0 },
      { stage: 'Investigation Started', count: map.get('investigation_started') ?? 0 },
      { stage: 'Investigation Verified / Completed', count: map.get('investigation_completed') ?? 0 },
      { stage: 'Report Exported', count: map.get('diagnostic_report_exported') ?? 0 },
    ];

    return { featureCounts, funnel };
  });

  // ==========================================================================
  // D. AI Usage & Operating Costs (Zero Private Prompts)
  // ==========================================================================
  app.get('/owner-api/v1/ai-costs', { preHandler: requireOwnerAuth }, async (req) => {
    const cutoff = getDateCutoff((req.query as { range?: string }).range);
    const byProviderModel = await ownerDb.db.all(
      `SELECT provider, model, COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
        COALESCE(SUM(estimated_cost_usd), 0) as cost_usd,
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failures
      FROM ai_usage_ledger WHERE created_at >= ?
      GROUP BY provider, model ORDER BY requests DESC`,
      cutoff,
    );
    const byFeature = await ownerDb.db.all(
      `SELECT feature, modality, COUNT(*) as requests,
        COALESCE(SUM(estimated_cost_usd), 0) as cost_usd,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms
      FROM ai_usage_ledger WHERE created_at >= ?
      GROUP BY feature, modality ORDER BY requests DESC`,
      cutoff,
    );
    const dailyTrend = await ownerDb.db.all(
      `SELECT substr(created_at, 1, 10) as day, COUNT(*) as requests,
        COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
        COALESCE(SUM(estimated_cost_usd), 0) as cost_usd
      FROM ai_usage_ledger WHERE created_at >= ?
      GROUP BY day ORDER BY day ASC`,
      cutoff,
    );

    return {
      privacyNotice:
        'AI usage telemetry records only model identifiers, token counts, latencies, status codes, and cost estimates. User prompts, photos, and repair outputs are never stored here.',
      byProviderModel,
      byFeature,
      dailyTrend,
    };
  });

  // ==========================================================================
  // F. Reliability, API Health & Crash Telemetry
  // ==========================================================================
  app.get('/owner-api/v1/reliability', { preHandler: requireOwnerAuth }, async (req) => {
    const cutoff = getDateCutoff((req.query as { range?: string }).range);
    const routeStats = await ownerDb.db.all(
      `SELECT route_pattern, method, COUNT(*) as calls,
        ROUND(AVG(latency_ms), 1) as avg_latency_ms,
        MAX(latency_ms) as max_latency_ms,
        COALESCE(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END), 0) as errors_5xx,
        COALESCE(SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END), 0) as errors_4xx
      FROM api_metrics WHERE created_at >= ?
      GROUP BY route_pattern, method ORDER BY calls DESC LIMIT 25`,
      cutoff,
    );
    const recentCrashes = await ownerDb.db.all(
      'SELECT id, platform, app_version, component, error_name, scrubbed_message, startup_ms, created_at FROM crash_reports WHERE created_at >= ? ORDER BY created_at DESC LIMIT 30',
      cutoff,
    );
    const crashesByPlatform = await ownerDb.db.all(
      'SELECT platform, app_version, COUNT(*) as crashes FROM crash_reports WHERE created_at >= ? GROUP BY platform, app_version ORDER BY crashes DESC',
      cutoff,
    );
    const operationalFailures = await ownerDb.db.all(
      'SELECT error_category, COUNT(*) as count FROM product_events WHERE success = 0 AND created_at >= ? GROUP BY error_category ORDER BY count DESC',
      cutoff,
    );

    let ownerDbSizeKb = 0;
    try {
      if (ownerDb.db.dialect === 'postgres') {
        const sizeRow = await ownerDb.db.get<{ kb: number }>(
          "SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) / 1024 AS kb FROM pg_tables WHERE schemaname = 'owner_observability'",
        );
        ownerDbSizeKb = Math.round(Number(sizeRow?.kb ?? 0));
      } else if (ownerDb.dbPath !== ':memory:' && fs.existsSync(ownerDb.dbPath)) {
        ownerDbSizeKb = Math.round(fs.statSync(ownerDb.dbPath).size / 1024);
      }
    } catch {}

    return {
      serviceHealth: {
        apiStatus: 'healthy',
        ownerDbStatus: 'healthy',
        ownerDbSizeKb,
        productVersion: CORESENSE_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
      },
      routeStats,
      crashesByPlatform,
      recentCrashes,
      operationalFailures,
    };
  });

  // ==========================================================================
  // G. Voluntary User Feedback & Opt-In Support Reports
  // ==========================================================================
  app.get('/owner-api/v1/feedback', { preHandler: requireOwnerAuth }, async () => {
    const feedback = await ownerDb.db.all('SELECT * FROM user_feedback ORDER BY created_at DESC LIMIT 100');
    const supportReports = await ownerDb.db.all<Record<string, unknown>>(
      'SELECT * FROM opt_in_support_reports ORDER BY created_at DESC LIMIT 50',
    );
    const avgRatingRow = (await ownerDb.db.get<{ avg_rating: number | null; rating_count: number }>(
      'SELECT ROUND(AVG(rating), 2) as avg_rating, COUNT(rating) as rating_count FROM user_feedback WHERE rating IS NOT NULL',
    )) ?? { avg_rating: null, rating_count: 0 };

    return {
      averageRating: avgRatingRow.avg_rating !== null ? Number(avgRatingRow.avg_rating) : null,
      ratingCount: Number(avgRatingRow.rating_count),
      feedback,
      optInSupportReports: supportReports.map((s) => ({
        ...s,
        attachedDiagnostics: JSON.parse(String(s.attached_diagnostics_json || '{}')),
      })),
    };
  });

  app.patch('/owner-api/v1/feedback/:id', { preHandler: requireOwnerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({ status: z.enum(['new', 'reviewed', 'planned', 'resolved', 'dismissed']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await ownerDb.db.run('UPDATE user_feedback SET status = ? WHERE id = ?', parsed.data.status, id);
    return { ok: true };
  });

  // ==========================================================================
  // H. Live Product Configuration & Budget Alert Rules
  // ==========================================================================
  app.get('/owner-api/v1/config', { preHandler: requireOwnerAuth }, async () => {
    const alerts = await ownerDb.db.all('SELECT * FROM alert_rules');
    const cfgRows = await ownerDb.db.all<{ key: string; value_json: string }>(
      'SELECT key, value_json FROM product_config',
    );
    const productConfig: Record<string, unknown> = {};
    for (const r of cfgRows) productConfig[r.key] = JSON.parse(r.value_json);
    return { alerts, productConfig };
  });

  app.patch('/owner-api/v1/config/alerts/:id', { preHandler: requireOwnerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({
      thresholdValue: z.number().min(0).optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const existing = await ownerDb.db.get<{ threshold_value: number; enabled: number }>(
      'SELECT * FROM alert_rules WHERE id = ?',
      id,
    );
    if (!existing) return reply.code(404).send({ error: 'Alert rule not found' });

    await ownerDb.db.run(
      'UPDATE alert_rules SET threshold_value = ?, enabled = ?, updated_at = ? WHERE id = ?',
      parsed.data.thresholdValue ?? existing.threshold_value,
      parsed.data.enabled !== undefined ? (parsed.data.enabled ? 1 : 0) : existing.enabled,
      new Date().toISOString(),
      id,
    );
    return { ok: true };
  });
}
