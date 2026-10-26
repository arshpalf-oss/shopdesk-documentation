/**
 * Append-only audit trail.
 *
 * There is no update/delete path in the application for audit events. Each
 * tenant has a sequence and a hash chain so that privileged tampering is
 * detectable during reconciliation. A hash chain is tamper-EVIDENT evidence,
 * not a statutory digital signature or a compliance certificate.
 */

import { canonicalJson, newId, sha256 } from '../ids.js';
import { businessTimeLabel } from '../time.js';

const REDACTED_KEYS = /(password|passwordHash|token|tokenHash|secret|cookie|authorization|cvv|pin|cardPan)/i;

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACTED_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…`;
  return value;
}

/**
 * Append one audit event. MUST be called inside the same transaction as the
 * action it records, so a committed change always has its audit entry.
 */
export async function appendAudit(ctx, event) {
  const coll = ctx.store.collection('audit_events');
  const previous = await coll.findOne(
    { tenantId: ctx.tenantId },
    { sort: { sequence: -1 }, limit: 1 }
  );
  const sequence = (previous?.sequence || 0) + 1;
  const at = ctx.now ? ctx.now() : new Date();
  const body = {
    _id: newId(),
    tenantId: ctx.tenantId,
    sequence,
    at,
    atLabel: businessTimeLabel(at),
    actorId: ctx.userId || null,
    actorName: ctx.actorName || null,
    requestId: ctx.requestId || null,
    action: event.action,
    entityType: event.entityType || null,
    entityId: event.entityId || null,
    branchId: event.branchId || ctx.branchId || null,
    reason: event.reason || null,
    before: redact(event.before ?? null),
    after: redact(event.after ?? null),
    meta: redact(event.meta ?? null),
    source: event.source || 'api',
    prevHash: previous?.hash || null,
  };
  body.hash = sha256(`${body.prevHash || ''}|${canonicalJson({ ...body, hash: undefined })}`);
  await coll.insertOne(body);
  return body;
}

/** Recompute the chain to detect direct database tampering. */
export async function verifyAuditChain(ctx) {
  const rows = await ctx.store
    .collection('audit_events')
    .find({ tenantId: ctx.tenantId }, { sort: { sequence: 1 } });
  let prevHash = null;
  const problems = [];
  let expected = 1;
  for (const row of rows) {
    if (row.sequence !== expected) problems.push({ sequence: row.sequence, issue: 'sequence gap' });
    if ((row.prevHash || null) !== prevHash) problems.push({ sequence: row.sequence, issue: 'broken link' });
    const recomputed = sha256(`${row.prevHash || ''}|${canonicalJson({ ...row, hash: undefined })}`);
    if (recomputed !== row.hash) problems.push({ sequence: row.sequence, issue: 'hash mismatch' });
    prevHash = row.hash;
    expected = row.sequence + 1;
  }
  return { events: rows.length, problems, ok: problems.length === 0 };
}

/** Safe operational/security trail for failed privileged attempts (no finance claim). */
export async function recordSecurityEvent(ctx, { action, detail, requestId }) {
  return appendAudit(ctx, {
    action: `security.${action}`,
    entityType: 'security',
    source: 'security',
    reason: detail ? String(detail).slice(0, 500) : null,
    meta: { requestId: requestId || ctx.requestId || null },
  });
}
