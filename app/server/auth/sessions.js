/**
 * Session, membership and trusted request context.
 *
 * - opaque high-entropy session cookie (HttpOnly, SameSite, Secure in prod);
 * - only the SHA-256 hash of the token is stored;
 * - the trusted context is derived server-side from the membership record on
 *   EVERY request, so deactivation or a role change applies immediately;
 * - tenant selection is validated against actual memberships; a body/header/
 *   route tenant id is never trusted as authorisation.
 */

import { forbidden, tooMany, unauthorized, unprocessable } from '../errors.js';
import { newId, newToken, sha256 } from '../ids.js';
import { repo } from '../tenancy/repo.js';
import { ROLES, effectivePermissions, hasPermission, NAV_ITEMS } from './permissions.js';
import { hashPassword, verifyPassword, passwordPolicyIssues } from './passwords.js';

export const SESSION_COOKIE = 'sd_session';

const attempts = new Map();
const WINDOW_MS = 15 * 60_000;

/** In-process rate limiter. Documented limitation: not distributed across instances. */
export function rateLimit(key, { max = 10, windowMs = WINDOW_MS } = {}) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.start > windowMs) {
    attempts.set(key, { count: 1, start: now });
    return;
  }
  entry.count += 1;
  if (entry.count > max) throw tooMany('Too many attempts. Try again later.');
}

export function resetRateLimits() {
  attempts.clear();
}

export async function createUser(ctx, { name, email, password }) {
  const emailLower = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailLower)) throw unprocessable('a valid email is required');
  const issues = passwordPolicyIssues(password);
  if (issues.length) throw unprocessable(`password must have ${issues.join(', ')}`);
  const existing = await ctx.store.collection('users').findOne({ emailLower });
  if (existing) throw unprocessable('an account with this email already exists');
  const user = {
    _id: newId(),
    name: String(name || '').trim() || emailLower,
    emailLower,
    passwordHash: await hashPassword(password),
    status: 'active',
    createdAt: ctx.now ? ctx.now() : new Date(),
    lastLoginAt: null,
  };
  await ctx.store.collection('users').insertOne(user);
  return user;
}

export async function findUserByEmail(store, email) {
  return store.collection('users').findOne({ emailLower: String(email || '').trim().toLowerCase() });
}

export async function startSession(store, user, { tenantId, ip, userAgent }) {
  const token = newToken(32);
  const csrf = newToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const session = {
    _id: newId(),
    tokenHash: sha256(token),
    userId: user._id,
    activeTenantId: tenantId || null,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ipHash: ip ? sha256(String(ip)) : null,
    userAgent: userAgent ? String(userAgent).slice(0, 200) : null,
    revokedAt: null,
  };
  await store.collection('sessions').insertOne(session);
  await store.collection('users').updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
  return { token, session };
}

export function cookieHeader(token, { secure, maxAgeSeconds }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader({ secure }) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Build the trusted context. Returns null when there is no valid session.
 * Called once per request by middleware.
 */
export async function loadContext(store, { token, requestId, now = new Date() }) {
  if (!token) return null;
  const session = await store.collection('sessions').findOne({ tokenHash: sha256(token) });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() <= now.getTime()) return null;
  const user = await store.collection('users').findOne({ _id: session.userId });
  if (!user || user.status !== 'active') return null;

  const memberships = await store.collection('memberships').find({ userId: user._id, status: 'active' });
  // No active membership (e.g. deactivated staff) invalidates the session on the
  // very next request — a captured cookie cannot outlive the revocation.
  if (memberships.length === 0) return null;
  let membership = null;
  if (memberships.length === 1) membership = memberships[0];
  else if (session.activeTenantId) membership = memberships.find((m) => m.tenantId === session.activeTenantId) || null;
  if (!membership) membership = memberships[0] || null;

  const permissions = (membership?.permissions?.length ? membership.permissions : ROLES[membership?.role]?.permissions) || [];
  return {
    store,
    requestId,
    userId: user._id,
    userName: user.name,
    userEmail: user.emailLower,
    sessionId: session._id,
    csrfToken: session.csrfToken,
    memberships,
    tenantId: membership?.tenantId || null,
    membershipId: membership?._id || null,
    role: membership?.role || null,
    permissions,
    allowedBranchIds: membership?.branchIds || [],
    branchId: membership?.branchIds?.[0] || null,
    now: () => now,
  };
}

export function requireSession(ctx) {
  if (!ctx || !ctx.userId) throw unauthorized();
  return ctx;
}

export function requireTenantContext(ctx) {
  requireSession(ctx);
  if (!ctx.tenantId) throw forbidden('Select a clinic workspace first');
  return ctx;
}

export function assertCsrf(ctx, headerToken) {
  if (!ctx?.csrfToken) throw forbidden('Session is not ready');
  if (!headerToken || headerToken !== ctx.csrfToken) {
    throw forbidden('CSRF token missing or invalid; reload the page and retry');
  }
}

export function visibleNavigation(ctx) {
  return NAV_ITEMS.filter((item) => !item.permission || hasPermission(ctx.permissions, item.permission));
}

export function permissionSnapshot(ctx) {
  const eff = effectivePermissions(ctx.permissions);
  return {
    role: ctx.role,
    roleLabel: ROLES[ctx.role]?.label || ctx.role,
    permissions: eff.all ? ['*'] : [...eff.set].sort(),
    can: Object.fromEntries(
      ['billing.use', 'documents.read.cost', 'returns.create', 'returns.restock', 'payments.record',
        'accounts.read', 'accounts.post', 'reports.read', 'reports.export', 'staff.manage',
        'settings.manage', 'audit.read', 'inventory.adjust', 'inventory.cost'].map((p) => [p, hasPermission(ctx.permissions, p)])
    ),
  };
}
