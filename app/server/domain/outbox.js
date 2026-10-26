/**
 * Transactional outbox with leased jobs.
 *
 * Jobs are inserted in the same transaction as their source event. A bounded,
 * authenticated worker (or the local in-process ticker) claims due jobs with a
 * lease token, runs an idempotent handler, and commits a checkpoint. External
 * side effects never run inside a financial transaction.
 */

import { newId, newToken } from '../ids.js';
import { repo } from '../tenancy/repo.js';

export async function enqueue(ctx, { eventKey, type, payload = {}, sourceId = null }) {
  const existing = await repo(ctx, 'outbox_jobs').findOne({ eventKey });
  if (existing) return existing;
  const job = {
    _id: newId(),
    eventKey,
    type,
    payload,
    sourceId,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: ctx.now ? ctx.now() : new Date(),
    leaseToken: null,
    leaseUntil: null,
    lastError: null,
    createdAt: ctx.now ? ctx.now() : new Date(),
  };
  await repo(ctx, 'outbox_jobs').insertOne(job);
  return job;
}

const handlers = new Map();

export function registerJobHandler(type, fn) {
  handlers.set(type, fn);
}

/** Default handlers are deterministic local artifacts; nothing external is faked. */
registerJobHandler('document.artifact', async (ctx, job) => ({
  ok: true,
  note: 'document artifact rendered on demand from the immutable snapshot',
  documentId: job.payload.documentId,
}));
registerJobHandler('report.export', async (ctx, job) => ({
  ok: true,
  note: 'export generated from a defined report snapshot',
  report: job.payload.report,
}));
registerJobHandler('notification.email', async (ctx, job) => ({
  ok: true,
  note: 'email delivery is not configured; no message was sent',
  skipped: true,
}));

/** Claim due jobs inside a transaction. Returns claimed jobs with lease tokens. */
export async function claimDue(ctx, { limit = 10 } = {}) {
  const now = ctx.now ? ctx.now() : new Date();
  const jobs = repo(ctx, 'outbox_jobs');
  const due = await jobs.find(
    {
      state: { $in: ['pending', 'failed'] },
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
    },
    { sort: { nextAttemptAt: 1 }, limit }
  );
  const claimed = [];
  for (const job of due) {
    const leaseToken = newToken(16);
    const leaseUntil = new Date(now.getTime() + 60_000);
    const res = await jobs.updateOne(
      { _id: job._id, state: job.state, nextAttemptAt: job.nextAttemptAt, leaseToken: job.leaseToken ?? null },
      { $set: { state: 'leased', leaseToken, leaseUntil, attempts: (job.attempts || 0) + 1 } }
    );
    if (res.modifiedCount === 1) claimed.push({ ...job, state: 'leased', leaseToken, leaseUntil });
  }
  return claimed;
}

/** Commit a successful job result; only the current lease token may commit. */
export async function completeJob(ctx, job, result) {
  const jobs = repo(ctx, 'outbox_jobs');
  const res = await jobs.updateOne(
    { _id: job._id, leaseToken: job.leaseToken, state: 'leased' },
    { $set: { state: 'done', result, finishedAt: ctx.now ? ctx.now() : new Date(), leaseToken: null, leaseUntil: null } }
  );
  if (res.modifiedCount !== 1) return { committed: false, reason: 'stale_lease' };
  return { committed: true };
}

export async function failJob(ctx, job, error) {
  const jobs = repo(ctx, 'outbox_jobs');
  const attempts = job.attempts || 1;
  const delayMs = Math.min(2 ** attempts * 1000, 300_000);
  const dead = attempts >= 6;
  const res = await jobs.updateOne(
    { _id: job._id, leaseToken: job.leaseToken, state: 'leased' },
    {
      $set: {
        state: dead ? 'dead_letter' : 'failed',
        lastError: String(error && error.message ? error.message : error).slice(0, 500),
        nextAttemptAt: new Date((ctx.now ? ctx.now() : new Date()).getTime() + delayMs),
        leaseToken: null,
        leaseUntil: null,
      },
    }
  );
  return { committed: res.modifiedCount === 1, deadLettered: dead };
}

export function handlerFor(type) {
  return handlers.get(type) || null;
}

/**
 * Process one bounded batch. Children are processed sequentially and each job
 * gets its own transaction so a poisoned job cannot roll back the whole batch.
 */
export async function runBatch(storeFactory, { limit = 10 } = {}) {
  const claimed = await storeFactory(async (ctx) => claimDue(ctx, { limit }));
  const results = [];
  for (const job of claimed) {
    const handler = handlerFor(job.type);
    if (!handler) {
      await storeFactory(async (ctx) => failJob(ctx, job, new Error(`no handler for ${job.type}`)));
      results.push({ id: job._id, state: 'dead_letter', reason: 'no handler' });
      continue;
    }
    try {
      const outcome = await handler(null, job);
      await storeFactory(async (ctx) => completeJob(ctx, job, outcome));
      results.push({ id: job._id, state: 'done' });
    } catch (err) {
      await storeFactory(async (ctx) => failJob(ctx, job, err));
      results.push({ id: job._id, state: 'failed', error: err.message });
    }
  }
  return { claimed: claimed.length, results };
}
