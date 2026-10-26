/**
 * shop desk server entrypoint.
 *
 * Local/self-hosted: a single Node process serving the API and the built SPA.
 * The approved production target is Vercel + Atlas; `app/api/[...path].js`
 * adapts this same app to a Node serverless function (see docs/DEPLOYMENT.md).
 */

import { createApp } from './app.js';
import { createStore } from './store/index.js';
import { loadConfig } from './config.js';
import { runBatch } from './domain/outbox.js';

const config = loadConfig();
const { store, driver, location } = await createStore({
  mongoUri: config.mongoUri,
  mongoDbName: config.mongoDbName,
  dataDir: config.dataDir,
});

const app = createApp({ store, config });
const server = app.listen(config.port, config.host, () => {
  const tenants = store.collection('tenants');
  console.log(`[shop desk] listening on http://${config.host}:${config.port}`);
  console.log(`[shop desk] store driver: ${driver} (${location})`);
  console.log(`[shop desk] environment: ${config.env}`);
  if (config.setupTokenGenerated) {
    console.log('[shop desk] first-run setup token (also stored in .data/setup-token.txt):');
    console.log(`             ${config.setupToken}`);
  }
  if (config.exposeSetupToken) {
    console.log('[shop desk] DEV ONLY: the setup token is exposed at GET /api/v1/setup/status');
  }
  tenants.countDocuments({}).then((count) => {
    console.log(`[shop desk] tenants: ${count}${count === 0 ? ' — complete /setup to create the first empty workspace' : ''}`);
  });
});

// Durable outbox consumer for local/self-hosted use. Vercel uses the
// authenticated /api/v1/cron/jobs endpoint instead (no always-on worker).
let ticker = null;
if (process.env.SHOPDESK_DISABLE_TICKER !== '1') {
  ticker = setInterval(async () => {
    try {
      await runBatch(async (fn) => {
        const tenant = await store.collection('tenants').findOne({});
        if (!tenant) return { claimed: 0, results: [] };
        return store.transaction(() =>
          fn({
            store,
            tenantId: tenant._id,
            userId: null,
            actorName: 'system:outbox',
            now: () => new Date(),
          })
        );
      }, { limit: 5 });
    } catch (err) {
      console.error('[shop desk] outbox tick failed', String(err.message).slice(0, 200));
    }
  }, 30_000);
  ticker.unref?.();
}

function shutdown(signal) {
  console.log(`[shop desk] ${signal} received, shutting down`);
  if (ticker) clearInterval(ticker);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
