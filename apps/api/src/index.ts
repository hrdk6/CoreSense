import { createCoreSenseServer } from './server.js';

async function main() {
  const ctx = await createCoreSenseServer({}, { logger: true });
  await ctx.app.listen({ port: ctx.config.port, host: ctx.config.host });
  console.log(
    `[CoreSense API] Listening on http://${ctx.config.host}:${ctx.config.port} ` +
      `(Customer DB: ${ctx.customerDb.dbPath} | Owner DB: ${ctx.ownerDb.dbPath})`,
  );

  const shutdown = async () => {
    console.log('[CoreSense API] Shutting down gracefully...');
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[CoreSense API] Fatal startup error:', err);
  process.exit(1);
});
