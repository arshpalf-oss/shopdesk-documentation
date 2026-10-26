/**
 * Payments, refunds, receipt reversals and cash close.
 *
 * Separation that the specification requires and this module enforces:
 *  - a credit note/customer credit does NOT move money;
 *  - only a confirmed receipt/refund changes cash;
 *  - refunds are a separate permission, capped transactionally by real entitlement;
 *  - pending/unverified UPI or card attempts are recorded separately and are not "paid";
 *  - cash receipts are checked against the ₹2,00,000 section 186 event tests.
 */

import { conflict, legalGate, forbidden, notFound, unprocessable } from '../errors.js';
import { canonicalHash, newId } from '../ids.js';
import { toPaise } from '../money.js';
import { businessDate } from '../time.js';
import { assertBranch, repo, requireTenantDoc } from '../tenancy/repo.js';
import { appendAudit } from './audit.js';
import { checkOperation, recordOperation, requireIdempotencyKey } from './idempotency.js';
import { postReceipt, postReceiptReversal } from './accounting.js';
import { PAYMENT_METHODS } from './chart.js';
import { settlementFor } from './sales.js';
import { hasPermission } from '../auth/permissions.js';

export const CASH_LIMIT_PAISE = 20000000n; // ₹2,00,000

/**
 * Section 186 style cash-receipt gate (fail closed).
 * Aggregates by actual receiving legal entity (tenant), payer and business day,
 * plus a single-transaction test. It cannot see money collected outside this
 * system; those receipts need reconciliation and reviewed evidence.
 */
export async function assertCashLimit(ctx, { method, amountPaise, partyId, branchId, businessDate: date, override }) {
  if (method !== 'cash') return { checked: false };
  const amount = toPaise(amountPaise, 'cash amount');
  const existing = await repo(ctx, 'payments').find({
    kind: 'receipt',
    status: 'confirmed',
    method: 'cash',
    businessDate: date,
  });
  let samePayer = 0n;
  let unassigned = 0n;
  for (const payment of existing) {
    if (partyId && payment.partyId === partyId) samePayer += BigInt(payment.amountPaise);
    if (!payment.partyId) unassigned += BigInt(payment.amountPaise);
  }
  const aggregate = partyId ? samePayer + amount : unassigned + amount;
  const singleExceeds = amount >= CASH_LIMIT_PAISE;
  const aggregateExceeds = aggregate >= CASH_LIMIT_PAISE;
  if (!singleExceeds && !aggregateExceeds) return { checked: true, aggregatePaise: aggregate.toString() };

  if (override?.reason && override?.evidence && hasPermission(ctx.permissions, 'accounts.review')) {
    await appendAudit(ctx, {
      action: 'payments.cash_limit_override',
      entityType: 'payment',
      branchId,
      reason: override.reason,
      meta: { evidence: override.evidence, amountPaise: amount.toString(), aggregatePaise: aggregate.toString(), businessDate: date },
    });
    return { checked: true, overridden: true, aggregatePaise: aggregate.toString() };
  }
  throw legalGate(
    'This cash receipt reaches the ₹2,00,000 threshold that the Income-tax Act 2025 s.186 restrictions address. ' +
      'Record the verified payer/exception evidence and an authorised override, or collect through a permitted banking mode.',
    {
      code: 'CASH_LIMIT_BLOCKED',
      amountPaise: amount.toString(),
      aggregatePaise: aggregate.toString(),
      singleExceeds,
      aggregateExceeds,
      note: 'Applicability and exemptions require CA review. The check aggregates confirmed cash receipts for the payer/day and cannot see money received outside this system.',
    }
  );
}

async function nextReceiptNumber(ctx, registrationId, docKind) {
  const { nextNumber } = await import('./numbering.js');
  const registration = await requireTenantDoc(ctx, 'tax_registrations', registrationId, 'registration');
  const series = registration.series?.find((s) => s.docKind === docKind);
  if (!series) return null;
  const { financialYear } = await import('../time.js');
  ctx.fyLabel = financialYear(ctx.now());
  const info = await nextNumber(ctx, {
    registrationId,
    series: series.series,
    padding: series.padding,
    businessDate: businessDate(ctx.now()),
  });
  return info.number;
}

export async function recordReceipt(ctx, input, { idempotencyKey } = {}) {
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'payment.receipt';
  const hash = canonicalHash({ ...input, kind: 'receipt' });
  const store = ctx.store;
  const document = await requireTenantDoc(ctx, 'financial_documents', input.documentId, 'invoice');
  if (document.status === 'cancelled') throw conflict('this document is cancelled', 'DOCUMENT_CANCELLED');
  const amount = toPaise(input.amountPaise, 'receipt amount');
  if (amount <= 0n) throw unprocessable('receipt amount must be greater than zero');
  if (!PAYMENT_METHODS.includes(input.method)) throw unprocessable('unsupported payment method');
  const bDate = input.businessDate || businessDate(ctx.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bDate)) throw unprocessable('businessDate must be YYYY-MM-DD');

  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };

    const settlement = await settlementFor(ctx, document);
    const due = BigInt(settlement.duePaise);
    if (amount > due) {
      throw unprocessable(
        `receipt exceeds the outstanding balance (${settlement.duePaise} paise). Record the actual amount received; unexplained overpayments are blocked.`,
        'OVERPAYMENT_BLOCKED'
      );
    }
    await assertCashLimit(ctx, {
      method: input.method,
      amountPaise: amount.toString(),
      partyId: document.partyId || null,
      branchId: document.branchId,
      businessDate: bDate,
      override: input.cashOverride,
    });
    const number = await nextReceiptNumber(ctx, document.registrationId, 'receipt');
    const payment = {
      _id: newId(),
      kind: 'receipt',
      number: number || `RCPT-${newId().slice(0, 8).toUpperCase()}`,
      partyId: document.partyId || null,
      partyName: document.partySnapshot?.name || 'Walk-in customer',
      branchId: document.branchId,
      registrationId: document.registrationId,
      documentId: document._id,
      amountPaise: amount.toString(),
      method: input.method,
      reference: input.reference ? String(input.reference).slice(0, 100) : null,
      status: 'confirmed',
      businessDate: bDate,
      at: ctx.now(),
      recordedBy: ctx.userId,
      recordedByName: ctx.actorName || ctx.userName,
      idempotencyKey: key,
    };
    await repo(ctx, 'payments').insertOne(payment);
    await repo(ctx, 'payment_allocations').insertOne({
      _id: newId(),
      paymentId: payment._id,
      documentId: document._id,
      amountPaise: amount.toString(),
      partyId: document.partyId || null,
    });
    await postReceipt(ctx, { payment, businessDate: bDate, branchId: document.branchId });
    await appendAudit(ctx, {
      action: 'payment.receipt_recorded',
      entityType: 'payment',
      entityId: payment._id,
      branchId: document.branchId,
      after: { documentId: document._id, amountPaise: amount.toString(), method: payment.method, reference: payment.reference },
    });
    const result = { paymentId: payment._id, number: payment.number, amountPaise: amount.toString(), dueAfterPaise: (due - amount).toString() };
    await recordOperation(ctx, { action, key, hash, result });
    return { replayed: false, ...result };
  });
}

export async function recordRefund(ctx, input, { idempotencyKey } = {}) {
  if (!hasPermission(ctx.permissions, 'payments.refund')) throw forbidden('Refund permission is required');
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'payment.refund';
  const hash = canonicalHash({ ...input, kind: 'refund' });
  const store = ctx.store;
  const document = await requireTenantDoc(ctx, 'financial_documents', input.documentId, 'invoice');
  const amount = toPaise(input.amountPaise, 'refund amount');
  if (amount <= 0n) throw unprocessable('refund amount must be greater than zero');
  if (!PAYMENT_METHODS.includes(input.method)) throw unprocessable('unsupported payment method');
  if (!input.reason || String(input.reason).trim().length < 5) throw unprocessable('a refund reason is required');
  const bDate = input.businessDate || businessDate(ctx.now());

  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };
    const settlement = await settlementFor(ctx, document);
    const entitlement = BigInt(settlement.refundablePaise);
    if (amount > entitlement) {
      throw unprocessable(
        `refund exceeds the customer's refundable entitlement (${settlement.refundablePaise} paise). A credit note does not create cash.`,
        'REFUND_EXCEEDS_ENTITLEMENT'
      );
    }
    const payment = {
      _id: newId(),
      kind: 'refund',
      number: `REF-${newId().slice(0, 8).toUpperCase()}`,
      partyId: document.partyId || null,
      partyName: document.partySnapshot?.name || 'Walk-in customer',
      branchId: document.branchId,
      documentId: document._id,
      amountPaise: amount.toString(),
      method: input.method,
      reference: input.reference ? String(input.reference).slice(0, 100) : null,
      reason: String(input.reason).slice(0, 300),
      status: 'confirmed',
      businessDate: bDate,
      at: ctx.now(),
      recordedBy: ctx.userId,
      recordedByName: ctx.actorName || ctx.userName,
      idempotencyKey: key,
    };
    await repo(ctx, 'payments').insertOne(payment);
    await postReceipt(ctx, {
      payment,
      businessDate: bDate,
      branchId: document.branchId,
      narration: `Refund ${payment.number} for ${document.number} — ${payment.reason}`,
    });
    await appendAudit(ctx, {
      action: 'payment.refund_recorded',
      entityType: 'payment',
      entityId: payment._id,
      branchId: document.branchId,
      reason: payment.reason,
      after: { documentId: document._id, amountPaise: amount.toString(), method: payment.method },
    });
    const result = { paymentId: payment._id, number: payment.number, amountPaise: amount.toString() };
    await recordOperation(ctx, { action, key, hash, result });
    return { replayed: false, ...result };
  });
}

export async function reverseReceipt(ctx, paymentId, input = {}) {
  const original = await requireTenantDoc(ctx, 'payments', paymentId, 'receipt');
  if (original.kind !== 'receipt' || original.status !== 'confirmed') throw unprocessable('only a confirmed receipt can be reversed');
  if (!input.reason || String(input.reason).trim().length < 5) throw unprocessable('a reversal reason is required');
  const store = ctx.store;
  const bDate = input.businessDate || businessDate(ctx.now());
  return store.transaction(async () => {
    const earlier = await repo(ctx, 'payments').find({ reversesPaymentId: paymentId, kind: 'receipt_reversal', status: 'confirmed' });
    const already = earlier.reduce((a, p) => a + BigInt(p.amountPaise), 0n);
    const amount = input.amountPaise ? toPaise(input.amountPaise, 'reversal amount') : BigInt(original.amountPaise) - already;
    if (amount <= 0n) throw unprocessable('nothing remains to reverse on this receipt');
    if (already + amount > BigInt(original.amountPaise)) throw unprocessable('reversal exceeds the original receipt');
    if (amount > BigInt(original.amountPaise) - already) throw unprocessable('reversal exceeds the remaining receipt amount');
    const reversal = {
      _id: newId(),
      kind: 'receipt_reversal',
      number: `REV-${newId().slice(0, 8).toUpperCase()}`,
      partyId: original.partyId,
      partyName: original.partyName,
      branchId: original.branchId,
      documentId: original.documentId,
      amountPaise: amount.toString(),
      method: original.method,
      reference: original.reference,
      reason: String(input.reason).slice(0, 300),
      status: 'confirmed',
      reversesPaymentId: paymentId,
      businessDate: bDate,
      at: ctx.now(),
      recordedBy: ctx.userId,
      recordedByName: ctx.actorName || ctx.userName,
    };
    await repo(ctx, 'payments').insertOne(reversal);
    await postReceiptReversal(ctx, { payment: reversal, original, businessDate: bDate, branchId: original.branchId });
    await appendAudit(ctx, {
      action: 'payment.receipt_reversed',
      entityType: 'payment',
      entityId: reversal._id,
      reason: reversal.reason,
      after: { originalPaymentId: paymentId, amountPaise: amount.toString() },
    });
    return { reversalId: reversal._id, amountPaise: amount.toString() };
  });
}

/* ------------------------------------------------- pending attempts (UPI/card) */

export async function createPendingIntent(ctx, input, { idempotencyKey } = {}) {
  const key = requireIdempotencyKey(idempotencyKey);
  const document = await requireTenantDoc(ctx, 'financial_documents', input.documentId, 'invoice');
  const amount = toPaise(input.amountPaise, 'amount');
  if (amount <= 0n) throw unprocessable('amount must be greater than zero');
  if (!PAYMENT_METHODS.includes(input.method)) throw unprocessable('unsupported payment method');
  if (input.method === 'cash') throw unprocessable('cash is recorded as a confirmed receipt, not a pending attempt');
  const store = ctx.store;
  return store.transaction(async () => {
    const existing = await repo(ctx, 'payment_intents').findOne({ idempotencyKey: key });
    if (existing) return { intentId: existing._id, status: existing.status, replayed: true };
    const intent = {
      _id: newId(),
      documentId: document._id,
      partyId: document.partyId || null,
      branchId: document.branchId,
      amountPaise: amount.toString(),
      method: input.method,
      reference: input.reference ? String(input.reference).slice(0, 100) : null,
      status: 'pending',
      idempotencyKey: key,
      createdAt: ctx.now(),
      createdBy: ctx.userId,
      note: 'Pending/unverified attempt — recorded separately and NOT counted as money received.',
    };
    await repo(ctx, 'payment_intents').insertOne(intent);
    await appendAudit(ctx, {
      action: 'payment.pending_created',
      entityType: 'payment_intent',
      entityId: intent._id,
      after: { documentId: document._id, amountPaise: intent.amountPaise, method: intent.method },
    });
    return { intentId: intent._id, status: 'pending' };
  });
}

/**
 * Confirming a pending attempt creates a NEW confirmed receipt. Money must
 * actually have been verified in the provider/bank statement first.
 */
export async function confirmPendingIntent(ctx, intentId, input = {}) {
  const store = ctx.store;
  const intent = await requireTenantDoc(ctx, 'payment_intents', intentId, 'payment intent');
  if (intent.status !== 'pending') throw conflict('this attempt is not pending', 'INTENT_NOT_PENDING');
  if (!input.verifiedReference) throw unprocessable('record the verified external reference before confirming money received');
  return store.transaction(async () => {
    const fresh = await repo(ctx, 'payment_intents').findOne({ _id: intentId });
    if (fresh.status !== 'pending') throw conflict('this attempt was already resolved', 'INTENT_NOT_PENDING');
    await repo(ctx, 'payment_intents').updateOne(
      { _id: intentId, status: 'pending' },
      { $set: { status: 'confirmed', confirmedAt: ctx.now(), confirmedBy: ctx.userId, verifiedReference: input.verifiedReference } }
    );
    const document = await requireTenantDoc(ctx, 'financial_documents', intent.documentId, 'invoice');
    const settlement = await settlementFor(ctx, document);
    const due = BigInt(settlement.duePaise);
    const amount = BigInt(intent.amountPaise) > due ? due : BigInt(intent.amountPaise);
    if (amount <= 0n) throw unprocessable('nothing is outstanding on this invoice');
    const payment = {
      _id: newId(),
      kind: 'receipt',
      number: `RCPT-${newId().slice(0, 8).toUpperCase()}`,
      partyId: intent.partyId,
      partyName: document.partySnapshot?.name || 'Walk-in customer',
      branchId: intent.branchId,
      documentId: document._id,
      amountPaise: amount.toString(),
      method: intent.method,
      reference: input.verifiedReference,
      status: 'confirmed',
      businessDate: businessDate(ctx.now()),
      at: ctx.now(),
      recordedBy: ctx.userId,
      recordedByName: ctx.actorName || ctx.userName,
      fromIntentId: intentId,
      idempotencyKey: `intent:${intentId}`,
    };
    await repo(ctx, 'payments').insertOne(payment);
    await repo(ctx, 'payment_allocations').insertOne({
      _id: newId(),
      paymentId: payment._id,
      documentId: document._id,
      amountPaise: amount.toString(),
      partyId: intent.partyId,
    });
    await postReceipt(ctx, { payment, businessDate: payment.businessDate, branchId: intent.branchId });
    await appendAudit(ctx, {
      action: 'payment.pending_confirmed',
      entityType: 'payment',
      entityId: payment._id,
      meta: { intentId, verifiedReference: input.verifiedReference },
    });
    return { paymentId: payment._id, amountPaise: amount.toString() };
  });
}

/* ----------------------------------------------------------------- cash close */

export async function cashClose(ctx, input) {
  const branchId = input.branchId || ctx.branchId;
  assertBranch(ctx, branchId);
  const date = input.businessDate || businessDate(ctx.now());
  const store = ctx.store;
  return store.transaction(async () => {
    const payments = await repo(ctx, 'payments').find({ branchId, businessDate: date, method: 'cash', status: 'confirmed' });
    const receipts = payments.filter((p) => p.kind === 'receipt');
    const refunds = payments.filter((p) => p.kind === 'refund');
    const reversals = payments.filter((p) => p.kind === 'receipt_reversal');
    const opening = toPaise(input.openingCashPaise || '0', 'opening cash');
    const received = receipts.reduce((a, p) => a + BigInt(p.amountPaise), 0n);
    const refunded = refunds.reduce((a, p) => a + BigInt(p.amountPaise), 0n);
    const reversed = reversals.reduce((a, p) => a + BigInt(p.amountPaise), 0n);
    const expected = opening + received - refunded - reversed;
    const counted = toPaise(input.countedCashPaise, 'counted cash');
    const variance = counted - expected;
    if (variance !== 0n && (!input.varianceReason || String(input.varianceReason).trim().length < 5)) {
      throw unprocessable('a variance reason is required when counted cash differs from expected cash');
    }
    const close = {
      _id: newId(),
      branchId,
      businessDate: date,
      sessionKey: ctx.userId,
      cashierId: ctx.userId,
      cashierName: ctx.actorName || ctx.userName,
      openingCashPaise: opening.toString(),
      cashReceiptsPaise: received.toString(),
      cashRefundsPaise: refunded.toString(),
      cashReversalsPaise: reversed.toString(),
      expectedCashPaise: expected.toString(),
      countedCashPaise: counted.toString(),
      variancePaise: variance.toString(),
      varianceReason: input.varianceReason ? String(input.varianceReason).slice(0, 300) : null,
      status: variance === 0n ? 'balanced' : 'variance_recorded',
      createdAt: ctx.now(),
      approvedBy: variance === 0n ? null : ctx.userId,
    };
    await repo(ctx, 'cash_closes').insertOne(close);
    await appendAudit(ctx, {
      action: 'cash.close_recorded',
      entityType: 'cash_close',
      entityId: close._id,
      branchId,
      reason: close.varianceReason,
      after: {
        businessDate: date,
        expectedCashPaise: close.expectedCashPaise,
        countedCashPaise: close.countedCashPaise,
        variancePaise: close.variancePaise,
      },
    });
    return close;
  });
}

export async function listPayments(ctx, { documentId, from, to, limit = 200 } = {}) {
  const filter = {};
  if (documentId) filter.documentId = documentId;
  if (from || to) {
    filter.at = {};
    if (from) filter.at.$gte = from;
    if (to) filter.at.$lt = to;
  }
  return repo(ctx, 'payments').find(filter, { sort: { at: -1 }, limit: Math.min(Number(limit) || 200, 500) });
}
