import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { type AppConfig, isAllowedCorsOrigin, loadConfig } from './config.js';
import { CustomerDatabase } from './db/customerDb.js';
import { OwnerDatabase } from './db/ownerDb.js';
import { registerCustomerRoutes } from './routes/customerRoutes.js';
import { registerOwnerRoutes } from './routes/ownerRoutes.js';

export interface CoreSenseServerContext {
  app: FastifyInstance;
  customerDb: CustomerDatabase;
  ownerDb: OwnerDatabase;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createCoreSenseServer(
  overrides: Partial<AppConfig> = {},
  options: { inMemoryDbs?: boolean; logger?: boolean } = {},
): Promise<CoreSenseServerContext> {
  const config = loadConfig(overrides);
  const usePostgres = !options.inMemoryDbs && Boolean(config.customerDatabaseUrl);
  const customerDb = new CustomerDatabase(
    config.dataDir,
    options.inMemoryDbs ? ':memory:' : 'coresense_customer.db',
    usePostgres ? config.customerDatabaseUrl : undefined,
  );
  const ownerDb = new OwnerDatabase(
    config.dataDir,
    config.ownerInitialEmail,
    config.ownerInitialPassword,
    options.inMemoryDbs ? ':memory:' : 'coresense_owner.db',
    usePostgres ? config.ownerDatabaseUrl : undefined,
  );

  await customerDb.init();
  await ownerDb.init();

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 24 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin, config)),
    credentials: true,
  });

  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  // Record non-PII API availability, route latency & status codes to Owner DB
  app.addHook('onRequest', async (req) => {
    (req as unknown as { _startMs?: number })._startMs = Date.now();
  });

  app.addHook('onResponse', async (req, reply) => {
    const start = (req as unknown as { _startMs?: number })._startMs ?? Date.now();
    const latencyMs = Math.max(0, Date.now() - start);
    const routePattern = req.routeOptions?.url || req.url.split('?')[0];
    if (!routePattern.startsWith('/owner-api/v1/reliability')) {
      try {
        await ownerDb.recordApiMetric(req.method, routePattern, reply.statusCode, latencyMs);
      } catch {
        // Non-blocking metrics recording
      }
    }
  });

  // Global safe error handler (never leak internal stack traces or secrets to clients)
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode || 500;
    const message = status >= 500 ? 'Internal server error' : e.message || 'Request failed';
    reply.code(status).send({ error: message });
  });

  registerCustomerRoutes(app, { customerDb, ownerDb, config });
  registerOwnerRoutes(app, { ownerDb, config });

  const close = async () => {
    await app.close();
    await customerDb.close();
    await ownerDb.close();
  };

  return { app, customerDb, ownerDb, config, close };
}
