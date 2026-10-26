/**
 * Durable financial idempotency.
 *
 * A financial mutation supplies an `Idempotency-Key` and a canonical payload
 * hash. Repeating the same identity with the same payload returns the original
 * committed result. The same identity with a different payload is rejected.
 * Records are written in the SAME transaction as the financial effect, so a
 * rolled-back attempt leaves no false "already done" marker.
 */

import { conflict, unprocessable } from '../errors.js';
import { canonicalHash, newId } from '../ids.js';
import { repo } from '../tenancy/repo.js';

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function requireIdempotencyKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw unprocessable('Idempotency-Key header is required for this financial action', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!KEY_RE.test(key)) {
    throw unprocessable(
      'Idempotency-Key must be 8–128 characters of letters, digits, dot, colon, underscore or hyphen',
      'IDEMPOTENCY_KEY_INVALID'
    );
  }
  return key;
}

export function payloadHash(payload) {
  return canonicalHash(payload);
}

/**
 * Check an operation identity. Returns the previously committed result when it
 * is a true replay; throws when the payload changed under the same identity.
 */
export async function checkOperation(ctx, { action, key, hash }) {
  const existing = await repo(ctx, 'idempotency_operations').findOne({ actorId: ctx.userId, action, key });
  if (!existing) return null;
  if (existing.payloadHash !== hash) {
    throw conflict(
      'This operation key was already used with a different payload. Use a new key for a different action.',
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      { originalAction: existing.action, originalAt: existing.at }
    );
  }
  return existing;
}

export async function recordOperation(ctx, { action, key, hash, result, status = 'completed' }) {
  const doc = {
    _id: newId(),
    actorId: ctx.userId,
    action,
    key,
    payloadHash: hash,
    status,
    result,
    at: ctx.now ? ctx.now() : new Date(),
    requestId: ctx.requestId || null,
  };
  await repo(ctx, 'idempotency_operations').insertOne(doc);
  return doc;
}

/**
 * Resolve an unknown outcome without creating a new financial action.
 * `action` may be omitted to search every action by key for this actor.
 */
export async function lookupOperation(ctx, { key, action }) {
  const filter = { actorId: ctx.userId, key };
  if (action) filter.action = action;
  const rows = await repo(ctx, 'idempotency_operations').find(filter, { sort: { at: -1 }, limit: 20 });
  return rows.map((r) => ({
    action: r.action,
    status: r.status,
    at: r.at,
    payloadHash: r.payloadHash,
    result: r.result,
  }));
}

/** Detect only the expected idempotency unique-index conflict (not every E11000). */
export function isExpectedIdempotencyConflict(err) {
  return Boolean(
    err &&
      err.code === 'E11000' &&
      (err.index === 'uq_operation_identity' || String(err.message).includes('uq_operation_identity'))
  );
}
