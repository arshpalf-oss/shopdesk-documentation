/**
 * Vercel serverless adapter (optional deployment target).
 *
 * The approved production target is Vercel + MongoDB Atlas. Serverless
 * functions have no durable local disk and no always-on worker, so:
 *   - the file store must NOT be used here (MONGODB_URI is required),
 *   - the outbox is drained by the authenticated /api/v1/cron/jobs endpoint,
 *   - no in-process timer is started.
 */
import { createApp } from '../../server/app.js';
import { createStore } from '../../server/store/index.js';
import { loadConfig } from '../../server/config.js';

let cached = null;

async function bootstrap() {
  if (cached) return cached;
  const config = loadConfig({ env: process.env.NODE_ENV || 'production' });
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is required on serverless: the file store needs a durable local disk.');
  }
  const { store } = await createStore({ mongoUri: config.mongoUri, mongoDbName: config.mongoDbName, dataDir: config.dataDir });
  const app = createApp({ store, config });
  cached = { app };
  return cached;
}

export default async function handler(req, res) {
  const { app } = await bootstrap();
  return app(req, res);
}
