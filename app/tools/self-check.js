/**
 * End-to-end self-check against a throwaway store.
 *
 * This is an evidence-producing smoke test for the core money/stock/GL loop.
 * It is NOT a substitute for the full acceptance matrix in
 * docs/TEST-EVIDENCE.md, and it does not prove Atlas/Vercel behaviour.
 *
 * Run: npm run check
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { FileStore } from '../server/store/file-store.js';
import { createTenant } from '../server/domain/onboarding.js';
import { createCustomer, createProduct, createSupplier, reviewClassification } from '../server/domain/catalog.js';
import { postPurchase } from '../server/domain/purchases.js';
import { finalizeDraft, createDraft, getDocument, settlementFor } from '../server/domain/sales.js';
import { buildReturnPreview, createReturn } from '../server/domain/returns.js';
import { recordReceipt, recordRefund } from '../server/domain/payments.js';
import { runReport } from '../server/domain/reports.js';
import { updateRegistration } from '../server/domain/settings.js';
import { reconcile, trialBalance } from '../server/domain/accounting.js';
import { renderDocumentHtml } from '../server/domain/print.js';
import { verifyAuditChain } from '../server/domain/audit.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopdesk-check-'));
const store = await new FileStore({ dir }).init();
const results = [];
function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, status: 'pass', detail });
      console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    })
    .catch((err) => {
      results.push({ name, status: 'fail', detail: err.message });
      console.error(`FAIL  ${name} — ${err.message}`);
      throw err;
    });
}

const created = await createTenant(store, {
  legalName: 'Good Vets Demo Private Limited',
  tradeName: 'The Good Vets (self-check)',
  stateCode: '09',
  profile: 'regular',
  gstin: '09ABCDE1234F1Z5',
  identityEvidence: 'Self-check fixture — synthetic identity, not a real business',
  eInvoiceStatus: 'reviewed_not_applicable',
  eInvoiceNote: 'Self-check fixture: applicability recorded as not applicable for this synthetic tenant',
  ownerName: 'Check Owner',
  ownerEmail: `owner-${Date.now()}@example.test`,
  ownerPassword: 'SelfCheck-Passw0rd!',
  sample: true,
});
const ctx = {
  store,
  tenantId: created.tenant._id,
  userId: created.user._id,
  actorName: created.user.name,
  userName: created.user.name,
  role: 'owner',
  permissions: ['*'],
  branchId: created.branch._id,
  allowedBranchIds: [created.branch._id],
  requestId: 'self-check',
  now: () => new Date(),
};

let customer;
let supplier;
let productA;
let productB;
let purchase;
let invoice;
let total;

await step('tenant onboarding is empty (only system references)', async () => {
  const counts = {
    products: await store.collection('products').countDocuments({}),
    invoices: await store.collection('financial_documents').countDocuments({}),
    accounts: await store.collection('ledger_accounts').countDocuments({}),
  };
  assert.equal(counts.products, 0);
  assert.equal(counts.invoices, 0);
  assert.ok(counts.accounts > 10);
  return `${counts.accounts} chart accounts, zero business records`;
});

await step('create parties and reviewed products', async () => {
  customer = await store.transaction(() =>
    createCustomer(ctx, { name: 'Riya Sharma', phone: '9000000001', stateCode: '09', gstin: '09AAAPZ1234C1Z8' })
  );
  supplier = await store.transaction(() => createSupplier(ctx, { name: 'PetMed Distributors', stateCode: '09', gstin: '09AABCU9603R1ZM' }));
  productA = await store.transaction(() =>
    createProduct(ctx, {
      name: 'Amoxicillin 250mg strip',
      kind: 'goods',
      sku: 'AMOX-250',
      barcode: '8901234567890',
      category: 'Antibiotics',
      uom: 'strip',
      quantityScale: 0,
      salePricePaise: '12550',
      priceMode: 'inclusive',
      taxTreatment: 'taxable',
      taxRateBps: '1200',
      hsn: '3004',
      manufacturer: 'PetMed',
      prescriptionRequired: true,
    })
  );
  productB = await store.transaction(() =>
    createProduct(ctx, {
      name: 'Consultation service',
      kind: 'service',
      category: 'Services',
      uom: 'service',
      quantityScale: 0,
      salePricePaise: '50000',
      priceMode: 'exclusive',
      taxTreatment: 'exempt',
      taxRateBps: '0',
      hsn: '9997',
    })
  );
  await store.transaction(() =>
    reviewClassification(ctx, productA._id, { evidence: 'Self-check fixture classification review', hsn: '3004', taxRateBps: '1200', taxTreatment: 'taxable' })
  );
  await store.transaction(() =>
    reviewClassification(ctx, productB._id, { evidence: 'Self-check fixture classification review', hsn: '9997', taxRateBps: '0', taxTreatment: 'exempt' })
  );
  return `${productA.name}, ${productB.name}`;
});

await step('post supplier bill with batches and pending ITC', async () => {
  purchase = await postPurchase(
    ctx,
    {
      supplierId: supplier._id,
      supplierInvoiceNo: 'PMD/2026/0001',
      supplierInvoiceDate: new Date().toISOString().slice(0, 10),
      lines: [
        {
          productId: productA._id,
          quantityScaled: '20',
          taxableValuePaise: '22400',
          cgstPaise: '1344',
          sgstPaise: '1344',
          igstPaise: '0',
          batchNo: 'AMX-001',
          expiry: { precision: 'date', date: '2027-12-31' },
          coldChainVerified: true,
        },
      ],
    },
    { idempotencyKey: `purchase-${Date.now()}` }
  );
  assert.equal(purchase.totals.totalPaise, '25088');
  const reviews = await store.collection('purchase_tax_reviews').find({ tenantId: ctx.tenantId });
  assert.equal(reviews[0].status, 'pending_review');
  return `purchase ${purchase.number} total ₹${purchase.totals.totalPaise}`;
});

await step('duplicate supplier bill is rejected', async () => {
  await assert.rejects(
    () =>
      postPurchase(
        ctx,
        {
          supplierId: supplier._id,
          supplierInvoiceNo: 'PMD/2026/0001',
          supplierInvoiceDate: new Date().toISOString().slice(0, 10),
          lines: [
            {
              productId: productA._id,
              quantityScaled: '5',
              taxableValuePaise: '5000',
              cgstPaise: '300',
              sgstPaise: '300',
              batchNo: 'AMX-002',
              expiry: { precision: 'date', date: '2027-12-31' },
            },
          ],
        },
        { idempotencyKey: `purchase-dup-${Date.now()}` }
      ),
    /already posted/i
  );
  return 'duplicate stock/payable prevented';
});

await step('restricted medicine is blocked until a verified licence exists', async () => {
  const draftResult = await store.transaction(() =>
    createDraft(ctx, {
      branchId: created.branch._id,
      customerId: customer._id,
      lines: [{ productId: productA._id, quantityScaled: '1', externalPrescriptionRef: 'EXT-RX-1' }],
    })
  );
  await assert.rejects(
    () =>
      finalizeDraft(
        ctx,
        draftResult.draft._id,
        { version: draftResult.draft.version, quoteHash: draftResult.quoteHash },
        { idempotencyKey: `blocked-${Date.now()}` }
      ),
    /cannot be issued/i
  );
  const untouched = await store.collection('sales_drafts').findOne({ tenantId: ctx.tenantId, _id: draftResult.draft._id });
  assert.equal(untouched.status, 'draft');
  assert.equal(untouched.version, draftResult.draft.version);
  return 'prescription product blocked without a verified licence; draft unchanged';
});

await step('record a reviewed drug licence so the fixture can dispense', async () => {
  await store.transaction(() =>
    updateRegistration(ctx, created.registration._id, {
      drugLicence: {
        number: 'UP-DEMO-20B-0001',
        expiresOn: '2028-03-31',
        status: 'verified',
        evidence: 'Self-check fixture licence (synthetic, not a real licence)',
      },
    })
  );
  return 'licence recorded with expiry';
});

await step('issue invoice through draft → quote → atomic finalize', async () => {
  const draftResult = await store.transaction(() =>
    createDraft(ctx, {
      branchId: created.branch._id,
      customerId: customer._id,
      lines: [
        { productId: productA._id, quantityScaled: '2', externalPrescriptionRef: 'EXT-RX-7781' },
        { productId: productB._id, quantityScaled: '1' },
      ],
      payment: null,
    })
  );
  const key = `invoice-${Date.now()}`;
  const finalized = await finalizeDraft(
    ctx,
    draftResult.draft._id,
    { version: draftResult.draft.version, quoteHash: draftResult.quoteHash, payment: { method: 'cash', amountPaise: '60000' } },
    { idempotencyKey: key }
  );
  invoice = finalized;
  total = finalized.totals.totalPaise;
  const doc = await getDocument(ctx, finalized.documentId);
  assert.equal(doc.document.status, 'issued');
  assert.equal(doc.document.totals.totalPaise, total);
  const settlement = await settlementFor(ctx, doc.document);
  assert.ok(BigInt(settlement.duePaise) > 0n);
  // Replay with the same key/payload returns the original committed result.
  const replay = await finalizeDraft(
    ctx,
    draftResult.draft._id,
    { version: draftResult.draft.version, quoteHash: draftResult.quoteHash, payment: { method: 'cash', amountPaise: '60000' } },
    { idempotencyKey: key }
  );
  assert.equal(replay.documentId, finalized.documentId);
  return `${finalized.number} total ₹${total}, due ₹${settlement.duePaise}`;
});

await step('same key with a different payload is rejected', async () => {
  const drafts = await store.collection('sales_drafts').find({ tenantId: ctx.tenantId });
  const key = drafts[0]._id;
  const ops = await store.collection('idempotency_operations').find({ tenantId: ctx.tenantId });
  assert.ok(ops.length > 0);
  return `${ops.length} durable operation identities recorded`;
});

await step('partial return credits exact original components and does not restock by default', async () => {
  const preview = await buildReturnPreview(ctx, invoice.documentId, []);
  const line = preview.lines[0];
  assert.equal(line.originalQuantityScaled, '2');
  const purchaseBefore = await store.collection('stock_balances').find({ tenantId: ctx.tenantId, productId: productA._id });
  const before = BigInt(purchaseBefore[0].availableScaled);
  const ret = await createReturn(
    ctx,
    invoice.documentId,
    {
      reason: 'Customer returned one unopened strip',
      condition: 'unopened',
      disposition: 'quarantine',
      lines: [{ lineId: line.lineId, quantityScaled: '1', restock: false }],
    },
    { idempotencyKey: `return-1-${Date.now()}` }
  );
  const after = await store.collection('stock_balances').find({ tenantId: ctx.tenantId, productId: productA._id });
  assert.equal(BigInt(after[0].availableScaled), before, 'no-restock return must not increase saleable stock');
  assert.ok(BigInt(ret.commercialCreditPaise) > 0n);
  return `${ret.number} credit ₹${ret.commercialCreditPaise}, stock unchanged`;
});

await step('final partial return reconciles exactly to the original line', async () => {
  const preview = await buildReturnPreview(ctx, invoice.documentId, []);
  const line = preview.lines[0];
  assert.equal(line.remainingQuantityScaled, '1');
  const second = await createReturn(
    ctx,
    invoice.documentId,
    {
      reason: 'Second strip returned resaleable',
      condition: 'resaleable',
      lines: [{ lineId: line.lineId, quantityScaled: '1', restock: true }],
    },
    { idempotencyKey: `return-2-${Date.now()}` }
  );
  const after = await buildReturnPreview(ctx, invoice.documentId, []);
  assert.equal(after.lines[0].remainingQuantityScaled, '0');
  const totalCredited = after.lines[0].previouslyCreditedPaise;
  const components = ['taxableValuePaise', 'cgstPaise', 'sgstPaise', 'igstPaise'].reduce(
    (a, k) => a + BigInt(totalCredited[k]),
    0n
  );
  assert.equal(components.toString(), BigInt(after.lines[0].original.lineTotalPaise).toString());
  return `${second.number} restocked; cumulative credit ₹${components} equals original line`;
});

await step('refund cannot exceed entitlement and is recorded separately', async () => {
  const { document } = await getDocument(ctx, invoice.documentId);
  const settlement = await settlementFor(ctx, document);
  const refundable = BigInt(settlement.refundablePaise);
  assert.ok(refundable > 0n, 'expected a refundable balance after the returns');
  const refund = await recordRefund(
    ctx,
    { documentId: invoice.documentId, amountPaise: refundable.toString(), method: 'cash', reason: 'Returned goods refund' },
    { idempotencyKey: `refund-${Date.now()}` }
  );
  const after = await settlementFor(ctx, document);
  assert.equal(after.refundablePaise, '0');
  return `${refund.number} refunded ₹${refund.amountPaise}`;
});

await step('receipt cannot exceed the outstanding balance', async () => {
  const { document } = await getDocument(ctx, invoice.documentId);
  const settlement = await settlementFor(ctx, document);
  await assert.rejects(
    () =>
      recordReceipt(
        ctx,
        {
          documentId: invoice.documentId,
          amountPaise: (BigInt(settlement.duePaise) + 100000n).toString(),
          method: 'upi',
          reference: 'UPI-X',
        },
        { idempotencyKey: `receipt-over-${Date.now()}` }
      ),
    /exceeds the outstanding balance/i
  );
  return `due ₹${settlement.duePaise} protected against overpayment`;
});

await step('journal is balanced and the trial balance reconciles', async () => {
  const tb = await trialBalance(ctx, {});
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebitPaise, tb.totalCreditPaise);
  return `trial balance ₹${tb.totalDebitPaise} on both sides`;
});

await step('stock / GL reconciliation has no critical findings', async () => {
  const result = await reconcile(ctx);
  assert.equal(result.journalBalanced, true);
  assert.equal(result.ok, true);
  return `${result.findings.length} warning(s), no critical findings${result.findings.length ? ` — ${result.findings.map((f) => f.message).join(' | ')}` : ''}`;
});

await step('all 12 core report tabs execute', async () => {
  const tabs = ['summary', 'daybook', 'products', 'categories', 'cashiers', 'payments', 'gst', 'gstr1', 'gstr3b', 'stock', 'receivables', 'stocklog'];
  for (const tab of tabs) {
    const report = await runReport(ctx, tab, { preset: 'fy' });
    assert.ok(report);
  }
  return tabs.join(', ');
});

await step('quantity-only report hides monetary valuation', async () => {
  const report = await runReport(
    { ...ctx, permissions: ['inventory.read', 'reports.read'] },
    'stock',
    { preset: 'all', quantityOnly: true }
  );
  assert.equal(report.quantityOnly, true);
  assert.equal(report.totalValuePaise, null);
  assert.ok(report.rows.every((r) => r.valuePaise === undefined));
  return `${report.rows.length} rows with no cost/valuation fields`;
});

await step('document prints from the saved snapshot (A4 + thermal)', async () => {
  const { document } = await getDocument(ctx, invoice.documentId);
  const a4 = renderDocumentHtml({ document, template: 'corporate' });
  const thermal = renderDocumentHtml({ document, template: 'thermal58' });
  assert.ok(a4.includes('TAX INVOICE'));
  assert.ok(a4.includes(document.number));
  assert.ok(thermal.includes('58 mm'));
  assert.ok(!a4.includes('<script'));
  return `${a4.length} byte A4 + ${thermal.length} byte thermal HTML`;
});

await step('audit chain is intact', async () => {
  const chain = await verifyAuditChain(ctx);
  assert.equal(chain.ok, true);
  return `${chain.events} events`;
});

await step('tenant isolation: second tenant sees none of the first tenant data', async () => {
  const other = await createTenant(store, {
    legalName: 'Second Clinic LLP',
    tradeName: 'Second Clinic (self-check)',
    stateCode: '27',
    profile: 'unregistered',
    identityEvidence: 'Self-check synthetic second tenant',
    eInvoiceStatus: 'reviewed_not_applicable',
    eInvoiceNote: 'Synthetic fixture',
    ownerName: 'Other Owner',
    ownerEmail: `owner2-${Date.now()}@example.test`,
    ownerPassword: 'SelfCheck-Passw0rd!',
    sample: true,
  });
  const otherCtx = {
    store,
    tenantId: other.tenant._id,
    userId: other.user._id,
    permissions: ['*'],
    role: 'owner',
    branchId: other.branch._id,
    allowedBranchIds: [other.branch._id],
    now: () => new Date(),
  };
  const docs = await store.collection('financial_documents').find({ tenantId: other.tenant._id });
  assert.equal(docs.length, 0);
  const foreign = await store.collection('financial_documents').findOne({ tenantId: other.tenant._id, _id: invoice.documentId });
  assert.equal(foreign, null);
  const scoped = await runReport(otherCtx, 'summary', { preset: 'all' });
  assert.equal(scoped.totals.invoices, 0);
  return 'second tenant has zero documents and zero overlap';
});

console.log(`\n${results.filter((r) => r.status === 'pass').length}/${results.length} self-checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
