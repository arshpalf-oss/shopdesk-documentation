/**
 * Express application: security middleware, trusted context, API router,
 * static SPA hosting and sanitised error handling.
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createApiRouter } from './api.js';
import { AppError } from './errors.js';
import { loadContext, parseCookies, SESSION_COOKIE } from './auth/sessions.js';

/**
 * Defensive JSON boundary: every monetary/quantity amount is meant to be an
 * integer string, but a stray BigInt would otherwise turn a response into a 500.
 * Convert (never round) BigInts to decimal strings and warn in development.
 */
function jsonSafe(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[shop desk] BigInt reached the JSON boundary; serialised as a decimal string');
    }
    return value.toString();
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, seen);
  return out;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_EXEMPT = new Set(['/api/v1/login', '/api/v1/setup', '/api/v1/invitations/accept']);
const CSRF_HEADER = 'x-csrf-token';

export function createApp({ store, config, webDir }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') || randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // The sandbox preview embeds the app in an iframe, so frame-ancestors is not
    // locked down here. Production should add `frame-ancestors 'none'`.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  });

  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => originalJson(jsonSafe(body));
    next();
  });

  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(async (req, res, next) => {
    try {
      const cookies = parseCookies(req.get('cookie') || '');
      req.cookies = cookies;
      req.ctx = await loadContext(store, {
        token: cookies[SESSION_COOKIE],
        requestId: req.requestId,
      });
      if (req.ctx) req.ctx.actorName = req.ctx.userName;
      next();
    } catch (err) {
      next(err);
    }
  });

  // Same-origin enforcement for cookie-authenticated mutations.
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && MUTATING.has(req.method)) {
      const host = req.get('host');
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      const allowed = originHost === host || originHost === null;
      if (!allowed) {
        res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'Cross-origin request rejected', requestId: req.requestId } });
        return;
      }
    }
    next();
  });

  // CSRF: double-check the session-bound token for cookie-authenticated writes.
  app.use('/api', (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    if (CSRF_EXEMPT.has(req.path)) return next();
    if (!req.ctx) return next(); // unauthenticated calls fail in the route
    const token = req.get(CSRF_HEADER);
    if (!token || token !== req.ctx.csrfToken) {
      res.status(403).json({
        error: {
          code: 'CSRF_FAILED',
          message: 'CSRF token missing or invalid. Reload the page and retry.',
          requestId: req.requestId,
        },
      });
      return;
    }
    return next();
  });

  app.use('/api/v1', createApiRouter({ store, config }));

  const dist = webDir || path.join(process.cwd(), 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(
      express.static(dist, {
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
        },
      })
    );
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(dist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.status(200).send(
        '<!doctype html><meta charset="utf-8"><title>shop desk</title>' +
          '<body style="font-family:system-ui;background:#0b0f14;color:#e8eef5;padding:2rem">' +
          '<h1>shop desk API is running</h1>' +
          '<p>The web bundle has not been built. Run <code>npm run build</code> and restart, or use <code>npm run dev:web</code>.</p>' +
          '<p><a style="color:#7cc4ff" href="/api/v1/health">/api/v1/health</a></p></body>'
      );
    });
  }

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found', requestId: req.requestId } });
  });

  // Sanitised error handler: no stack traces, secrets or tenant data in responses.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof AppError ? err.status : err.status || (err.code === 'E11000' ? 409 : 500);
    const code =
      err.code === 'E11000'
        ? 'DUPLICATE_KEY'
        : err.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
    const safeMessage =
      status >= 500
        ? 'The request could not be completed. No partial financial action was committed; check the operation status before retrying.'
        : err.message;
    if (status >= 500) {
      // Server-side diagnostics only; never include request bodies or credentials.
      console.error(
        JSON.stringify({
          level: 'error',
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          name: err.name,
          message: String(err.message || '').slice(0, 300),
          stack: String(err.stack || '').split('\n').slice(0, 5),
        })
      );
    }
    res.status(status).json({
      error: {
        code,
        message: safeMessage,
        details: err.details || undefined,
        requestId: req.requestId,
      },
    });
  });

  return app;
}
