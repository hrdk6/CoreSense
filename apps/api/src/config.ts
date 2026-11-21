import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

export interface AppConfig {
  nodeEnv: string;
  port: number;
  host: string;
  corsOrigins: string[];
  dataDir: string;
  uploadsDir: string;
  jwtSecret: string;
  ownerJwtSecret: string;
  encryptionKey: string;
  ownerInitialEmail: string;
  ownerInitialPassword: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiVisionModel: string;
  geminiEmbeddingModel: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  publicApiUrl: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const defaultDataDir = path.resolve(process.cwd(), process.cwd().endsWith('api') ? 'data' : 'apps/api/data');
  const dataDir = overrides.dataDir || process.env.DATA_DIR || defaultDataDir;
  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 4000),
    host: process.env.HOST || '127.0.0.1',
    corsOrigins: (
      process.env.CORS_ORIGINS ||
      'http://localhost:5173,http://localhost:5175,http://localhost:8081,http://localhost:1420,http://127.0.0.1:5173,http://127.0.0.1:5175,http://127.0.0.1:8081,tauri://localhost,http://tauri.localhost'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir,
    uploadsDir: overrides.uploadsDir || path.join(dataDir, 'uploads'),
    jwtSecret:
      process.env.JWT_SECRET || 'coresense-dev-customer-jwt-secret-change-in-production-64bytes',
    ownerJwtSecret:
      process.env.OWNER_JWT_SECRET || 'coresense-dev-owner-jwt-secret-completely-separate-64bytes',
    encryptionKey:
      process.env.ENCRYPTION_KEY || 'coresense-dev-aes256-encryption-key-32bytes-minimum!!',
    ownerInitialEmail: process.env.OWNER_INITIAL_EMAIL || 'owner@coresense.app',
    ownerInitialPassword: process.env.OWNER_INITIAL_PASSWORD || 'CoreSenseOwner#2026!',
    geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
    geminiVisionModel: process.env.GEMINI_VISION_MODEL || 'gemini-4-hydrogen',
    geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    publicApiUrl: process.env.PUBLIC_API_URL || 'http://127.0.0.1:4000',
    ...overrides,
  };
}
