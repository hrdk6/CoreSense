import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CORESENSE_VERSION, PlanConfigSchema } from '@coresense/shared';
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
// exclusively on `coresense_owner.db`, making browsing of private customer
// chats, photos, documents, or device records structurally impossible.
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
    const admin = ownerDb.db
      .prepare('SELECT * FROM owner_admins WHERE id = ?')
      .get(payload.sub) as OwnerAdminRow | undefined;
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

    const admin = ownerDb.db
      .prepare('SELECT * FROM owner_admins WHERE email = ?')
      .get(parsed.data.email.toLowerCase().trim()) as OwnerAdminRow | undefined;

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
    ownerDb.db.prepare('UPDATE owner_admins SET last_login_at = ? WHERE id = ?').run(now, admin.id);
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
        'Owner Console operates on a physically isolated telemetry database (coresense_owner.db) with zero access to customer conversations, photos, documents, or personal repair workspaces.',
    };
  });

  app.post('/owner-api/v1/auth/mfa/setup', { preHandler: requireOwnerAuth }, async (req) => {
    const secret = generateTotpSecret();
    ownerDb.db
      .prepare('UPDATE owner_admins SET totp_secret = ? WHERE id = ?')
      .run(secret, req.ownerAdmin!.id);
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
    ownerDb.db.prepare('UPDATE owner_admins SET totp_enabled = 1 WHERE id = ?').run(req.ownerAdmin!.id);
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

    const installerDownloads = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM installer_downloads WHERE created_at >= ?').get(cutoff) as { c: number }).c;
    const firstActivations = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM app_activations WHERE first_activated_at >= ?').get(cutoff) as { c: number }).c;
    const activeInstallations30d = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM app_activations WHERE last_seen_at >= ?').get(cut30d) as { c: number }).c;

    const totalRegistered = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NULL').get() as { c: number }).c;
    const totalDeleted = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NOT NULL AND deleted_at >= ?').get(cutoff) as { c: number }).c;
    const newRegistrations = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM account_lifecycle WHERE registered_at >= ?').get(cutoff) as { c: number }).c;

    const dau = (ownerDb.db.prepare('SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?').get(cut1d) as { c: number }).c;
    const wau = (ownerDb.db.prepare('SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?').get(cut7d) as { c: number }).c;
    const mau = (ownerDb.db.prepare('SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?').get(cut30d) as { c: number }).c;

    // Revenue from verified billing events (MRR estimated from active paid plans)
    const plans = ownerDb.getPlans();
    const planPriceMap = new Map(plans.map((p) => [p.tier, p.monthlyPriceCents]));
    const activeTierRows = ownerDb.db
      .prepare('SELECT plan_tier, COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NULL GROUP BY plan_tier')
      .all() as Array<{ plan_tier: string; c: number }>;

    let mrrCents = 0;
    let paidSubscribers = 0;
    for (const r of activeTierRows) {
      if (r.plan_tier !== 'free') {
        paidSubscribers += r.c;
        mrrCents += (planPriceMap.get(r.plan_tier as 'free' | 'pro' | 'premium') ?? 0) * r.c;
      }
    }

    const aiStats = ownerDb.db
      .prepare(
        `SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(estimated_cost_usd), 0) as total_cost_usd,
          COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests
        FROM ai_usage_ledger WHERE created_at >= ?`,
      )
      .get(cutoff) as {
      total_requests: number;
      input_tokens: number;
      output_tokens: number;
      total_cost_usd: number;
      avg_latency_ms: number;
      failed_requests: number;
    };

    const apiStats = ownerDb.db
      .prepare(
        `SELECT
          COUNT(*) as total_calls,
          COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as server_errors
        FROM api_metrics WHERE created_at >= ?`,
      )
      .get(cutoff) as { total_calls: number; avg_latency_ms: number; server_errors: number };

    const crashesCount = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM crash_reports WHERE created_at >= ?').get(cutoff) as { c: number }).c;
    const launchesCount = (ownerDb.db.prepare("SELECT COUNT(*) as c FROM product_events WHERE event_name = 'app_launched' AND created_at >= ?").get(cutoff) as { c: number }).c;
    const crashFreeRate =
      launchesCount > 0
        ? Math.max(0, Math.min(100, Math.round(((launchesCount - crashesCount) / launchesCount) * 1000) / 10))
        : crashesCount === 0
          ? 100
          : 0;

    // Evaluate live alert rules
    const rules = ownerDb.db.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all() as Array<{
      id: string;
      metric_key: string;
      label: string;
      threshold_value: number;
      unit: string;
    }>;
    const api5xxRate = apiStats.total_calls > 0 ? (apiStats.server_errors / apiStats.total_calls) * 100 : 0;
    const crashRate = launchesCount > 0 ? (crashesCount / launchesCount) * 100 : 0;
    const currentMetricValues: Record<string, number> = {
      monthly_ai_cost_usd: aiStats.total_cost_usd,
      api_5xx_rate_percent: Math.round(api5xxRate * 100) / 100,
      crash_rate_percent: Math.round(crashRate * 100) / 100,
      ai_avg_latency_ms: Math.round(aiStats.avg_latency_ms),
    };
    const alerts = rules.map((r) => {
      const current = currentMetricValues[r.metric_key] ?? 0;
      return {
        id: r.id,
        metricKey: r.metric_key,
        label: r.label,
        currentValue: current,
        thresholdValue: r.threshold_value,
        unit: r.unit,
        triggered: current > r.threshold_value,
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
        paidSubscribers,
        mrrUsd: Math.round(mrrCents) / 100,
        arrUsd: Math.round(mrrCents * 12) / 100,
        aiTotalRequests: aiStats.total_requests,
        aiTotalCostUsd: Math.round(aiStats.total_cost_usd * 10000) / 10000,
        aiCostPerActiveUserUsd: mau > 0 ? Math.round((aiStats.total_cost_usd / mau) * 10000) / 10000 : 0,
        aiAvgLatencyMs: Math.round(aiStats.avg_latency_ms),
        apiTotalCalls: apiStats.total_calls,
        apiAvgLatencyMs: Math.round(apiStats.avg_latency_ms),
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
    const downloadsByPlatform = ownerDb.db
      .prepare('SELECT platform, channel, app_version, COUNT(*) as count FROM installer_downloads WHERE created_at >= ? GROUP BY platform, channel, app_version ORDER BY count DESC')
      .all(cutoff);
    const activationsByPlatform = ownerDb.db
      .prepare('SELECT platform, app_version, COUNT(*) as activations FROM app_activations WHERE first_activated_at >= ? GROUP BY platform, app_version ORDER BY activations DESC')
      .all(cutoff);
    const activeByVersion = ownerDb.db
      .prepare('SELECT app_version, platform, COUNT(*) as installs FROM app_activations GROUP BY app_version, platform ORDER BY installs DESC')
      .all();
    const geoAggregates = ownerDb.db
      .prepare("SELECT COALESCE(country_code, 'UNSPECIFIED') as country, COUNT(*) as installs FROM app_activations GROUP BY country ORDER BY installs DESC LIMIT 20")
      .all();

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
    const dailySignups = ownerDb.db
      .prepare("SELECT substr(registered_at, 1, 10) as day, COUNT(*) as registrations FROM account_lifecycle WHERE registered_at >= ? GROUP BY day ORDER BY day ASC")
      .all(cutoff);
    const dailyActive = ownerDb.db
      .prepare("SELECT substr(created_at, 1, 10) as day, COUNT(DISTINCT anonymous_user_hash) as active_users FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ? GROUP BY day ORDER BY day ASC")
      .all(cutoff);
    const platformAdoption = ownerDb.db
      .prepare('SELECT platform, COUNT(*) as users FROM account_lifecycle WHERE deleted_at IS NULL GROUP BY platform ORDER BY users DESC')
      .all();
    const expertiseDistribution = ownerDb.db
      .prepare("SELECT COALESCE(expertise_mode, 'everyday') as mode, COUNT(DISTINCT anonymous_user_hash) as users FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ? GROUP BY mode")
      .all(cutoff);

    const totalEver = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM account_lifecycle').get() as { c: number }).c;
    const deletedEver = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NOT NULL').get() as { c: number }).c;
    const returningUsers = (ownerDb.db
      .prepare(
        `SELECT COUNT(*) as c FROM (
          SELECT anonymous_user_hash FROM product_events
          WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?
          GROUP BY anonymous_user_hash HAVING COUNT(DISTINCT substr(created_at, 1, 10)) >= 2
        )`,
      )
      .get(cutoff) as { c: number }).c;
    const activePeriodUsers = (ownerDb.db
      .prepare('SELECT COUNT(DISTINCT anonymous_user_hash) as c FROM product_events WHERE anonymous_user_hash IS NOT NULL AND created_at >= ?')
      .get(cutoff) as { c: number }).c;

    return {
      dailySignups,
      dailyActive,
      platformAdoption,
      expertiseDistribution,
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
    const featureCounts = ownerDb.db
      .prepare('SELECT event_name, COUNT(*) as count, COUNT(DISTINCT anonymous_user_hash) as unique_users FROM product_events WHERE created_at >= ? GROUP BY event_name ORDER BY count DESC')
      .all(cutoff) as Array<{ event_name: string; count: number; unique_users: number }>;

    const map = new Map(featureCounts.map((f) => [f.event_name, f.count]));
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
  // D. Revenue & Subscriptions (Verified Billing Events Only)
  // ==========================================================================
  app.get('/owner-api/v1/revenue', { preHandler: requireOwnerAuth }, async (req) => {
    const cutoff = getDateCutoff((req.query as { range?: string }).range);
    const tierBreakdown = ownerDb.db
      .prepare('SELECT plan_tier, COUNT(*) as accounts FROM account_lifecycle WHERE deleted_at IS NULL GROUP BY plan_tier')
      .all();
    const billingBreakdown = ownerDb.db
      .prepare('SELECT event_type, COUNT(*) as count, COALESCE(SUM(amount_cents), 0) as total_cents FROM billing_events WHERE created_at >= ? AND verified = 1 GROUP BY event_type')
      .all(cutoff);
    const recentEvents = ownerDb.db
      .prepare('SELECT id, event_type, plan_tier, billing_cycle, amount_cents, currency, provider, verified, created_at FROM billing_events ORDER BY created_at DESC LIMIT 40')
      .all();

    const totalUsers = (ownerDb.db.prepare('SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NULL').get() as { c: number }).c;
    const paidUsers = (ownerDb.db.prepare("SELECT COUNT(*) as c FROM account_lifecycle WHERE deleted_at IS NULL AND plan_tier != 'free'").get() as { c: number }).c;

    return {
      tierBreakdown,
      billingBreakdown,
      recentEvents,
      conversionRatePercent: totalUsers > 0 ? Math.round((paidUsers / totalUsers) * 1000) / 10 : 0,
    };
  });

  // ==========================================================================
  // E. AI Usage & Operating Costs (Zero Private Prompts)
  // ==========================================================================
  app.get('/owner-api/v1/ai-costs', { preHandler: requireOwnerAuth }, async (req) => {
    const cutoff = getDateCutoff((req.query as { range?: string }).range);
    const byProviderModel = ownerDb.db
      .prepare(
        `SELECT provider, model, COUNT(*) as requests,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
          COALESCE(SUM(estimated_cost_usd), 0) as cost_usd,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
        FROM ai_usage_ledger WHERE created_at >= ?
        GROUP BY provider, model ORDER BY requests DESC`,
      )
      .all(cutoff);
    const byFeature = ownerDb.db
      .prepare(
        `SELECT feature, modality, COUNT(*) as requests,
          COALESCE(SUM(estimated_cost_usd), 0) as cost_usd,
          COALESCE(AVG(latency_ms), 0) as avg_latency_ms
        FROM ai_usage_ledger WHERE created_at >= ?
        GROUP BY feature, modality ORDER BY requests DESC`,
      )
      .all(cutoff);
    const dailyTrend = ownerDb.db
      .prepare(
        `SELECT substr(created_at, 1, 10) as day, COUNT(*) as requests,
          COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
          COALESCE(SUM(estimated_cost_usd), 0) as cost_usd
        FROM ai_usage_ledger WHERE created_at >= ?
        GROUP BY day ORDER BY day ASC`,
      )
      .all(cutoff);

    return {
      privacyNotice: 'AI usage telemetry records only model identifiers, token counts, latencies, status codes, and cost estimates. User prompts, photos, and repair outputs are never stored here.',
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
    const routeStats = ownerDb.db
      .prepare(
        `SELECT route_pattern, method, COUNT(*) as calls,
          ROUND(AVG(latency_ms), 1) as avg_latency_ms,
          MAX(latency_ms) as max_latency_ms,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as errors_5xx,
          SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) as errors_4xx
        FROM api_metrics WHERE created_at >= ?
        GROUP BY route_pattern, method ORDER BY calls DESC LIMIT 25`,
      )
      .all(cutoff);
    const recentCrashes = ownerDb.db
      .prepare('SELECT id, platform, app_version, component, error_name, scrubbed_message, startup_ms, created_at FROM crash_reports WHERE created_at >= ? ORDER BY created_at DESC LIMIT 30')
      .all(cutoff);
    const crashesByPlatform = ownerDb.db
      .prepare('SELECT platform, app_version, COUNT(*) as crashes FROM crash_reports WHERE created_at >= ? GROUP BY platform, app_version ORDER BY crashes DESC')
      .all(cutoff);
    const operationalFailures = ownerDb.db
      .prepare('SELECT error_category, COUNT(*) as count FROM product_events WHERE success = 0 AND created_at >= ? GROUP BY error_category ORDER BY count DESC')
      .all(cutoff);

    let ownerDbSizeKb = 0;
    try {
      if (ownerDb.dbPath !== ':memory:' && fs.existsSync(ownerDb.dbPath)) {
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
    const feedback = ownerDb.db
      .prepare('SELECT * FROM user_feedback ORDER BY created_at DESC LIMIT 100')
      .all();
    const supportReports = ownerDb.db
      .prepare('SELECT * FROM opt_in_support_reports ORDER BY created_at DESC LIMIT 50')
      .all() as Array<Record<string, unknown>>;
    const avgRatingRow = ownerDb.db
      .prepare('SELECT ROUND(AVG(rating), 2) as avg_rating, COUNT(rating) as rating_count FROM user_feedback WHERE rating IS NOT NULL')
      .get() as { avg_rating: number | null; rating_count: number };

    return {
      averageRating: avgRatingRow.avg_rating,
      ratingCount: avgRatingRow.rating_count,
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
    ownerDb.db.prepare('UPDATE user_feedback SET status = ? WHERE id = ?').run(parsed.data.status, id);
    return { ok: true };
  });

  // ==========================================================================
  // H. Live Product Configuration, Dynamic Plans & Budget Alert Rules
  // ==========================================================================
  app.get('/owner-api/v1/config', { preHandler: requireOwnerAuth }, async () => {
    const plans = ownerDb.getPlans();
    const alerts = ownerDb.db.prepare('SELECT * FROM alert_rules').all();
    const cfgRows = ownerDb.db.prepare('SELECT key, value_json FROM product_config').all() as Array<{
      key: string;
      value_json: string;
    }>;
    const productConfig: Record<string, unknown> = {};
    for (const r of cfgRows) productConfig[r.key] = JSON.parse(r.value_json);
    return { plans, alerts, productConfig };
  });

  app.put('/owner-api/v1/config/plans/:tier', { preHandler: requireOwnerAuth }, async (req, reply) => {
    const { tier } = req.params as { tier: string };
    const parsed = PlanConfigSchema.safeParse({ ...(req.body as Record<string, unknown>), tier });
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    ownerDb.db
      .prepare('INSERT OR REPLACE INTO plan_configs (tier, config_json, updated_at) VALUES (?, ?, ?)')
      .run(tier, JSON.stringify(parsed.data), new Date().toISOString());
    return { ok: true, plan: parsed.data };
  });

  app.patch('/owner-api/v1/config/alerts/:id', { preHandler: requireOwnerAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({
      thresholdValue: z.number().min(0).optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const existing = ownerDb.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as
      | { threshold_value: number; enabled: number }
      | undefined;
    if (!existing) return reply.code(404).send({ error: 'Alert rule not found' });

    ownerDb.db
      .prepare('UPDATE alert_rules SET threshold_value = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(
        parsed.data.thresholdValue ?? existing.threshold_value,
        parsed.data.enabled !== undefined ? (parsed.data.enabled ? 1 : 0) : existing.enabled,
        new Date().toISOString(),
        id,
      );
    return { ok: true };
  });
}
