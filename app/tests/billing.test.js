import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoster, makeStore, makeTenant } from './helpers.js';
import { createDraft, finalizeDraft, getDocument, settlementFor, updateDraft } from '../server/domain/sales.js';
import { buildReturnPreview, createReturn } from '../server/domain/returns.js';
import { recordReceipt, recordRefund, cashClose } from '../server/domain/payments.js';
import { createProduct } from '../server/domain/catalog.js';
import { createStockAdjustmentForTest, receiveBatchRaw } from './test-support.js';
import { trialBalance, reconcile } from '../server/domain/accounting.js';
import { repo } from '../server/tenancy/repo.js';
import { verifyAuditChain } from '../server/domain/audit.js';
import { updateTenantRecord } from '../server/tenancy/repo.js';

async function fixture() {
  const { store, cleanup } = await makeStore();
  const tenant = await makeTenant(store);
  const roster = await makeRoster(store, tenant.ctx);
  return { store, cleanup, tenant, roster, ctx: tenant.ctx };
}

async function issue(ctx, roster, lines, payment = null) {
  const draft = await ctx.store.transaction(() => createDraft(ctx, { branchId: ctx.branchId, customerId: roster.customer._id, lines }));
  return finalizeDraft(
    ctx,
    draft.draft._id,
    { version: draft.draft.version, quoteHash: draft.quoteHash, payment },
    { idempotencyKey: `finalize-${draft.draft._id}` }
  );
}

test('FEFO sells the earliest-expiring eligible batch and skips expired stock', async () => {
  const { store, cleanup, tenant, roster, ctx } = await fixture();
  try {
    const expired = await store.transaction(() =>
      receiveBatchRaw(ctx, {
        productId: roster.goods._id,
        batchNo: 'EXPIRED-BATCH',
        quantityScaled: '5',
        unitCostPaise: '1000',
        expiry: { precision: 'date', date: '2020-01-31' },
      })
    );
    const early = await store.transaction(() =>
      receiveBatchRaw(ctx, {
        productId: roster.goods._id,
        batchNo: 'EARLY-BATCH',
        quantityScaled: '5',
        unitCostPaise: '1000',
        expiry: { precision: 'date', date: '2027-01-31' },
      })
    );
    const late = await store.transaction(() =>
      receiveBatchRaw(ctx, {
        productId: roster.goods._id,
        batchNo: 'LATE-BATCH',
        quantityScaled: '5',
        unitCostPaise: '1000',
        expiry: { precision: 'date', date: '2029-01-31' },
      })
    );
    const result = await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '6' }]);
    const { document } = await getDocument(ctx, result.documentId);
    const batches = document.lines[0].batchAllocations.map((a) => a.batchNo);
    assert.equal(batches[0], 'EARLY-BATCH', 'earliest-expiring eligible batch is sold first');
    assert.ok(!batches.includes('EXPIRED-BATCH'));
    assert.equal(
      document.lines[0].batchAllocations.reduce((a, b) => a + BigInt(b.quantityScaled), 0n),
      6n
    );
    const expiredBalance = await repo(ctx, 'stock_balances').findOne({ batchId: expired.batch._id });
    assert.equal(expiredBalance.availableScaled, '5', 'expired stock was not touched');
    const earlyBalance = await repo(ctx, 'stock_balances').findOne({ batchId: early.batch._id });
    assert.equal(earlyBalance.availableScaled, '0');
    assert.ok(late.batch._id);
  } finally {
    cleanup();
  }
});

test('overselling is blocked and leaves no document, movement or journal', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const before = {
      docs: await repo(ctx, 'financial_documents').count({}),
      movements: await repo(ctx, 'inventory_movements').count({}),
      entries: await repo(ctx, 'journal_entries').count({}),
    };
    const draft = await store.transaction(() =>
      createDraft(ctx, { branchId: ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '51' }] })
    );
    await assert.rejects(
      () =>
        finalizeDraft(
          ctx,
          draft.draft._id,
          { version: draft.draft.version, quoteHash: draft.quoteHash },
          { idempotencyKey: `oversell-${draft.draft._id}` }
        ),
      /cannot be issued/i
    );
    assert.equal(await repo(ctx, 'financial_documents').count({}), before.docs);
    assert.equal(await repo(ctx, 'inventory_movements').count({}), before.movements);
    assert.equal(await repo(ctx, 'journal_entries').count({}), before.entries);
    const balance = await repo(ctx, 'stock_balances').findOne({ productId: roster.goods._id });
    assert.equal(balance.availableScaled, '50');
  } finally {
    cleanup();
  }
});

test('parallel checkouts for the last unit cannot oversell', async () => {
  const { store, cleanup, roster, ctx } = await makeStoreFixture();
  async function makeStoreFixture() {
    const f = await fixture();
    return f;
  }
  try {
    // Reduce the batch to a single unit through an approved adjustment.
    const balance = await repo(ctx, 'stock_balances').findOne({ productId: roster.goods._id });
    await store.transaction(async () => {
      const batch = await repo(ctx, 'batch_lots').findOne({ _id: balance.batchId });
      await repo(ctx, 'stock_balances').updateOne({ _id: balance._id }, { $set: { availableScaled: '1' }, $inc: { version: 1 } });
      await repo(ctx, 'inventory_movements').insertOne({
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: roster.goods._id,
        batchId: batch._id,
        type: 'adjustment_decrease',
        quantityScaled: '-49',
        quantityScale: 0,
        sourceType: 'test_adjustment',
        sourceId: 'test',
        at: new Date(),
      });
    });
    const drafts = [];
    for (let i = 0; i < 4; i += 1) {
      drafts.push(
        await store.transaction(() =>
          createDraft(ctx, { branchId: ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '1' }] })
        )
      );
    }
    const outcomes = await Promise.allSettled(
      drafts.map((d, i) =>
        finalizeDraft(ctx, d.draft._id, { version: d.draft.version, quoteHash: d.quoteHash }, { idempotencyKey: `race-key-${i}-${d.draft._id}` })
      )
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 3);
    const finalBalance = await repo(ctx, 'stock_balances').findOne({ productId: roster.goods._id });
    assert.equal(finalBalance.availableScaled, '0');
  } finally {
    cleanup();
  }
});

test('parallel invoices get unique sequential numbers in the legal scope', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const drafts = [];
    for (let i = 0; i < 6; i += 1) {
      drafts.push(
        await store.transaction(() =>
          createDraft(ctx, { branchId: ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '1' }] })
        )
      );
    }
    const results = await Promise.all(
      drafts.map((d, i) =>
        finalizeDraft(ctx, d.draft._id, { version: d.draft.version, quoteHash: d.quoteHash }, { idempotencyKey: `number-key-${i}-${d.draft._id}` })
      )
    );
    const numbers = results.map((r) => r.number);
    assert.equal(new Set(numbers).size, numbers.length);
    for (const number of numbers) {
      assert.match(number, /^[A-Z]+\/\d{2}-\d{2}\/\d{6}$/);
      assert.ok(number.length <= 16, `${number} must be at most 16 characters`);
    }
    const docs = await repo(ctx, 'financial_documents').find({});
    assert.equal(docs.length, 6);
    assert.ok(docs.every((d) => d.fy === docs[0].fy));
  } finally {
    cleanup();
  }
});

test('idempotent replay returns the original document; changed payload is rejected', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const draft = await store.transaction(() =>
      createDraft(ctx, { branchId: ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '2' }] })
    );
    const key = 'idempotent-key-1';
    const first = await finalizeDraft(ctx, draft.draft._id, { version: draft.draft.version, quoteHash: draft.quoteHash }, { idempotencyKey: key });
    const replay = await finalizeDraft(ctx, draft.draft._id, { version: draft.draft.version, quoteHash: draft.quoteHash }, { idempotencyKey: key });
    assert.equal(replay.documentId, first.documentId);
    assert.equal(replay.number, first.number);
    assert.equal(await repo(ctx, 'financial_documents').count({}), 1);
    assert.equal(await repo(ctx, 'journal_entries').count({ postingKind: 'sale' }), 1);
    await assert.rejects(
      () =>
        finalizeDraft(
          ctx,
          draft.draft._id,
          { version: draft.draft.version, quoteHash: 'a-different-hash' },
          { idempotencyKey: key }
        ),
      /different payload/i
    );
  } finally {
    cleanup();
  }
});

test('a stale quote is rejected rather than silently charged', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const draft = await store.transaction(() =>
      createDraft(ctx, { branchId: ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '1' }] })
    );
    const staleHash = draft.quoteHash;
    await store.transaction(() => updateDraft(ctx, draft.draft._id, { lines: [{ productId: roster.goods._id, quantityScaled: '3' }] }));
    await assert.rejects(
      () =>
        finalizeDraft(
          ctx,
          draft.draft._id,
          { version: 2, quoteHash: staleHash },
          { idempotencyKey: `stale-${draft.draft._id}` }
        ),
      /changed since the quote|review the updated quote/i
    );
  } finally {
    cleanup();
  }
});

test('draft cannot reference another tenant product', async () => {
  const { store, cleanup, ctx } = await fixture();
  try {
    const otherTenant = await makeTenant(store);
    const foreign = await store.transaction(() =>
      createProduct(otherTenant.ctx, {
        name: 'Foreign product',
        kind: 'goods',
        salePricePaise: '100',
        taxRateBps: '1200',
        taxTreatment: 'taxable',
        hsn: '3004',
        quantityScale: 0,
      })
    );
    await assert.rejects(
      () => store.transaction(() => createDraft(ctx, { branchId: ctx.branchId, lines: [{ productId: foreign._id, quantityScaled: '1' }] })),
      /product not found/i
    );
  } finally {
    cleanup();
  }
});

test('returns: no-restock by default, cumulative exact credit, entitlement cap', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const invoice = await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '4' }]);
    const before = await repo(ctx, 'stock_balances').findOne({ productId: roster.goods._id });
    const preview = await buildReturnPreview(ctx, invoice.documentId, []);
    const line = preview.lines[0];
    assert.equal(line.remainingQuantityScaled, '4');

    const first = await createReturn(
      ctx,
      invoice.documentId,
      { reason: 'Return one unit, damaged packaging', condition: 'damaged', lines: [{ lineId: line.lineId, quantityScaled: '1', restock: false }] },
      { idempotencyKey: 'return-a' }
    );
    const afterFirst = await repo(ctx, 'stock_balances').findOne({ productId: roster.goods._id });
    assert.equal(afterFirst.availableScaled, before.availableScaled, 'no-restock must not add saleable stock');

    const second = await createReturn(
      ctx,
      invoice.documentId,
      { reason: 'Return two units, resaleable', condition: 'resaleable', lines: [{ lineId: line.lineId, quantityScaled: '2', restock: true }] },
      { idempotencyKey: 'return-b' }
    );
    const afterSecond = await repo(ctx, 'stock_balances').findOne({ productId: roster.goods._id });
    assert.equal(BigInt(afterSecond.availableScaled), BigInt(before.availableScaled) + 2n);

    const third = await createReturn(
      ctx,
      invoice.documentId,
      { reason: 'Return last unit', condition: 'unopened', lines: [{ lineId: line.lineId, quantityScaled: '1', restock: false }] },
      { idempotencyKey: 'return-c' }
    );
    const finalPreview = await buildReturnPreview(ctx, invoice.documentId, []);
    assert.equal(finalPreview.lines[0].remainingQuantityScaled, '0');
    const creditTotal = [first, second, third].reduce((a, r) => a + BigInt(r.commercialCreditPaise), 0n);
    const { document } = await getDocument(ctx, invoice.documentId);
    assert.equal(creditTotal.toString(), document.lines[0].lineTotalPaise);
    assert.equal(
      BigInt(finalPreview.lines[0].previouslyCreditedPaise.taxableValuePaise),
      BigInt(document.lines[0].taxableValuePaise)
    );
    await assert.rejects(
      () =>
        createReturn(
          ctx,
          invoice.documentId,
          { reason: 'over-return attempt', lines: [{ lineId: line.lineId, quantityScaled: '1' }] },
          { idempotencyKey: 'return-d' }
        ),
      /zero|exceeds/i
    );
  } finally {
    cleanup();
  }
});

test('returns: commercial credit can be recorded without reducing GST', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const invoice = await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '2' }]);
    const preview = await buildReturnPreview(ctx, invoice.documentId, []);
    const ret = await createReturn(
      ctx,
      invoice.documentId,
      {
        reason: 'Goodwill credit outside GST adjustment',
        gstAdjustment: false,
        lines: [{ lineId: preview.lines[0].lineId, quantityScaled: '1' }],
      },
      { idempotencyKey: 'return-commercial' }
    );
    assert.equal(ret.gstAdjustmentPaise, '0');
    assert.equal(ret.gstAdjustmentStatus, 'commercial_only');
    assert.ok(BigInt(ret.commercialCreditPaise) > 0n);
    const tb = await trialBalance(ctx, {});
    const cgst = tb.rows.find((r) => r.code === '2100');
    const invoiceDoc = (await getDocument(ctx, invoice.documentId)).document;
    assert.equal(cgst.balancePaise, invoiceDoc.totals.cgstPaise, 'output CGST was not reduced');
  } finally {
    cleanup();
  }
});

test('returns: after the section 34 cut-off only a commercial credit is allowed', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const invoice = await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '2' }]);
    await store.transaction(() =>
      updateTenantRecord(ctx, { gstAnnualReturnFiledAt: new Date(Date.now() - 86_400_000).toISOString() })
    );
    const preview = await buildReturnPreview(ctx, invoice.documentId, []);
    const ret = await createReturn(
      ctx,
      invoice.documentId,
      { reason: 'Late return after annual return filed', lines: [{ lineId: preview.lines[0].lineId, quantityScaled: '1' }] },
      { idempotencyKey: 'return-late' }
    );
    assert.equal(ret.gstAdjustmentStatus, 'ineligible_after_cutoff');
    assert.equal(ret.gstAdjustmentPaise, '0');
  } finally {
    cleanup();
  }
});

test('refunds are separate, permissioned and capped by real entitlement', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const invoice = await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '2' }], {
      method: 'cash',
      amountPaise: '25100',
    });
    const { document } = await getDocument(ctx, invoice.documentId);
    let settlement = await settlementFor(ctx, document);
    assert.equal(settlement.duePaise, '0');

    await assert.rejects(
      () =>
        recordRefund(
          { ...ctx, permissions: ['payments.record'] },
          { documentId: invoice.documentId, amountPaise: '100', method: 'cash', reason: 'not permitted' },
          { idempotencyKey: 'refund-perm' }
        ),
      /permission/i
    );

    const preview = await buildReturnPreview(ctx, invoice.documentId, []);
    await createReturn(
      ctx,
      invoice.documentId,
      { reason: 'Return one unit after payment', lines: [{ lineId: preview.lines[0].lineId, quantityScaled: '1' }] },
      { idempotencyKey: 'return-paid' }
    );
    settlement = await settlementFor(ctx, document);
    assert.ok(BigInt(settlement.refundablePaise) > 0n);
    await assert.rejects(
      () =>
        recordRefund(
          ctx,
          { documentId: invoice.documentId, amountPaise: (BigInt(settlement.refundablePaise) + 1n).toString(), method: 'cash', reason: 'over-refund' },
          { idempotencyKey: 'refund-over' }
        ),
      /exceeds/i
    );
    const refund = await recordRefund(
      ctx,
      { documentId: invoice.documentId, amountPaise: settlement.refundablePaise, method: 'upi', reference: 'UPI-REFUND-1', reason: 'Refund for returned goods' },
      { idempotencyKey: 'refund-ok' }
    );
    assert.equal(refund.amountPaise, settlement.refundablePaise);
    const after = await settlementFor(ctx, document);
    assert.equal(after.refundablePaise, '0');
  } finally {
    cleanup();
  }
});

test('cash receipts at the ₹2,00,000 threshold are blocked without a reviewed override', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const { assertCashLimit } = await import('../server/domain/payments.js');
    await assert.rejects(
      () =>
        assertCashLimit(ctx, {
          method: 'cash',
          amountPaise: '20000000',
          partyId: roster.customer._id,
          businessDate: '2026-10-26',
        }),
      /₹2,00,000/i
    );
    const belowThreshold = await assertCashLimit(ctx, {
      method: 'cash',
      amountPaise: '15000000',
      partyId: roster.customer._id,
      businessDate: '2026-10-26',
    });
    assert.equal(belowThreshold.checked, true);
    assert.equal(belowThreshold.aggregatePaise, '15000000');
    const override = await store.transaction(() =>
      assertCashLimit(ctx, {
        method: 'cash',
        amountPaise: '20000000',
        partyId: roster.customer._id,
        businessDate: '2026-10-26',
        override: { reason: 'Verified exemption evidence recorded by owner', evidence: 'CA note ref 2026-10-26' },
      })
    );
    assert.equal(override.overridden, true);
    // Non-cash methods are unaffected by the cash-receipt gate.
    const upi = await assertCashLimit(ctx, { method: 'upi', amountPaise: '50000000', partyId: roster.customer._id, businessDate: '2026-10-26' });
    assert.equal(upi.checked, false);

    const invoice = await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '2' }]);
    const small = await recordReceipt(
      ctx,
      { documentId: invoice.documentId, amountPaise: '1000', method: 'cash' },
      { idempotencyKey: 'cash-small' }
    );
    assert.equal(small.amountPaise, '1000');
  } finally {
    cleanup();
  }
});

test('cash close computes expected cash, variance and requires a reason', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const invoice = await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '1' }], {
      method: 'cash',
      amountPaise: '12550',
    });
    const close = await cashClose(ctx, { openingCashPaise: '10000', countedCashPaise: '22550' });
    assert.equal(close.expectedCashPaise, '22550');
    assert.equal(close.variancePaise, '0');
    await assert.rejects(() => cashClose(ctx, { openingCashPaise: '0', countedCashPaise: '100' }), /variance reason/i);
    assert.ok(invoice.documentId);
  } finally {
    cleanup();
  }
});

test('sales, returns, refunds keep the GL balanced and reconciled', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    const invoice = await issue(ctx, roster, [
      { productId: roster.goods._id, quantityScaled: '3' },
      { productId: roster.service._id, quantityScaled: '1' },
    ], { method: 'upi', amountPaise: '60000' });
    const preview = await buildReturnPreview(ctx, invoice.documentId, []);
    await createReturn(
      ctx,
      invoice.documentId,
      { reason: 'Partial return', condition: 'resaleable', lines: [{ lineId: preview.lines[0].lineId, quantityScaled: '1', restock: true }] },
      { idempotencyKey: 'gl-return' }
    );
    await createStockAdjustmentForTest(ctx, roster.goods._id, '1');
    const tb = await trialBalance(ctx, {});
    assert.equal(tb.balanced, true);
    const result = await reconcile(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.inventoryGlPaise, result.inventoryValuationPaise);
    const chain = await verifyAuditChain(ctx);
    assert.equal(chain.ok, true);
    assert.ok(chain.events >= 3);
  } finally {
    cleanup();
  }
});

test('tampering with an audit event breaks the chain (tamper-evident evidence)', async () => {
  const { store, cleanup, roster, ctx } = await fixture();
  try {
    await issue(ctx, roster, [{ productId: roster.goods._id, quantityScaled: '1' }]);
    const events = await repo(ctx, 'audit_events').find({}, { sort: { sequence: 1 } });
    await store.transaction(() =>
      repo(ctx, 'audit_events').updateOne({ _id: events[0]._id }, { $set: { action: 'tampered.action' } })
    );
    const chain = await verifyAuditChain(ctx);
    assert.equal(chain.ok, false);
    assert.ok(chain.problems.some((p) => p.issue === 'hash mismatch'));
  } finally {
    cleanup();
  }
});
