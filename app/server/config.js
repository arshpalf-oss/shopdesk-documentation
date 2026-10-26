import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Server configuration from the environment only.
 * No secret is ever exposed through VITE_ variables or the browser bundle.
 */
export function loadConfig(overrides = {}) {
  const rootDir = path.resolve(process.cwd());
  const dataDir = overrides.dataDir || process.env.SHOPDESK_DATA_DIR || path.join(rootDir, '.data');
  const env = overrides.env || process.env.NODE_ENV || 'development';

  let setupToken = overrides.setupToken || process.env.SHOPDESK_SETUP_TOKEN || '';
  let setupTokenGenerated = false;
  if (!setupToken) {
    const tokenFile = path.join(dataDir, 'setup-token.txt');
    try {
      if (fs.existsSync(tokenFile)) setupToken = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      /* ignore */
    }
    if (!setupToken) {
      setupToken = randomBytes(24).toString('base64url');
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(tokenFile, `${setupToken}\n`, { mode: 0o600 });
      } catch {
        /* the token still works for this process */
      }
      setupTokenGenerated = true;
    }
  }

  return {
    env,
    isProduction: env === 'production',
    port: Number(overrides.port || process.env.PORT || 3000),
    host: overrides.host || process.env.SHOPDESK_HOST || '0.0.0.0',
    dataDir,
    mongoUri: overrides.mongoUri ?? process.env.MONGODB_URI ?? '',
    mongoDbName: overrides.mongoDbName ?? process.env.MONGODB_DB ?? 'shopdesk',
    setupToken,
    setupTokenGenerated,
    // Dev-only convenience so the sandbox preview can complete first-run setup.
    // MUST be off in production; production onboarding requires the secret token.
    exposeSetupToken:
      overrides.exposeSetupToken ??
      (process.env.SHOPDESK_DEV_EXPOSE_SETUP_TOKEN === '1' && env !== 'production'),
    secureCookies:
      overrides.secureCookies ?? (process.env.SHOPDESK_SECURE_COOKIES === '1' || env === 'production'),
    sessionHours: Number(process.env.SHOPDESK_SESSION_HOURS || 12),
    trustProxy: process.env.SHOPDESK_TRUST_PROXY === '1',
    cronSecret: process.env.SHOPDESK_CRON_SECRET || '',
    cashLimitPaise: '20000000',
    region: process.env.SHOPDESK_REGION || 'local',
  };
}
