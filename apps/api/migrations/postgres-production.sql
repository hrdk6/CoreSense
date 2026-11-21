-- ============================================================================
-- CoreSense Production PostgreSQL Dual-Schema Blueprint
-- Mirrors coresense_customer.db and coresense_owner.db with physically
-- separate schemas/roles so the Owner Console DB role has ZERO grants on
-- customer_workspace tables.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS customer_workspace;
CREATE SCHEMA IF NOT EXISTS owner_observability;

-- Production RBAC separation:
--   CREATE ROLE coresense_customer_role LOGIN PASSWORD '...';
--   CREATE ROLE coresense_owner_role    LOGIN PASSWORD '...';
--   GRANT USAGE ON SCHEMA customer_workspace TO coresense_customer_role;
--   GRANT USAGE ON SCHEMA owner_observability TO coresense_owner_role;
--   REVOKE ALL ON SCHEMA customer_workspace FROM coresense_owner_role;

CREATE TABLE IF NOT EXISTS customer_workspace.users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  expertise_mode TEXT NOT NULL DEFAULT 'everyday',
  telemetry_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  cloud_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  external_ai_consent BOOLEAN NOT NULL DEFAULT TRUE,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  byok_provider TEXT,
  byok_encrypted_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS owner_observability.owner_admins (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS owner_observability.installer_downloads (
  id UUID PRIMARY KEY,
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  app_version TEXT NOT NULL,
  architecture TEXT NOT NULL,
  country_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS owner_observability.ai_usage_ledger (
  id UUID PRIMARY KEY,
  anonymous_user_hash TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  feature TEXT NOT NULL,
  modality TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
