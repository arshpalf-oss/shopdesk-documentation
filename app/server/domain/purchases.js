/**
 * Purchases / goods receipt, supplier returns and input-tax review.
 *
 * The receipt records the ACTUAL supplier bill: its own number, date, financial
 * year and real tax components. The app never invents a CGST/SGST split and never
 * marks input tax as claimable automatically — ITC starts "pending review".
 * Posting a duplicate supplier bill cannot add stock twice (unique index on
 * tenant + supplier + FY + supplier invoice number).
 */

import { conflict, forbidden, legalGate, notFound, unprocessable } from '../errors.js';
import { canonicalHash, newId } from '../ids.js';
import { allocateProportional, mulDivRound, toPaise } from '../money.js';
import { businessDate, financialYear } from '../time.js';
import { assertBranch, repo, requireTenantDoc } from '../tenancy/repo.js';
import { appendAudit } from './audit.js';
import { checkOperation, isExpectedIdempotencyConflict, recordOperation, requireIdempotencyKey } from './idempotency.js';
import { postPurchase as postPurchaseJournal, postSupplierReturn, postWriteOff } from './accounting.js';
import { allocateCostFromBatch, applyToBalance, recordMovement, receiveBatch } from './inventory.js';
import { nextNumber } from './numbering.js';
import { enqueue } from './outbox.js';
import { hasPermission } from '../auth/permissions.js';
import { PAYMENT_METHODS } from './chart.js';

function purchaseTaxTotals(lines) {
  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  for (const line of lines) {
    taxable += BigInt(line.taxableValuePaise);
    cgst += BigInt(line.cgstPaise || '0');
    sgst += BigInt(line.sgstPaise || '0');
    igst += BigInt(line.igstPaise || '0');
  }
  return {
    taxableValuePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    taxPaise: cgst + sgst + igst,
    totalPaise: taxable + cgst + sgst + igst,
  };
}

export async function postPurchase(ctx, input, { idempotencyKey } = {}) {
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'purchases.post';
  const hash = canonicalHash(input);
  const store = ctx.store;
  const branchId = input.branchId || ctx.branchId;
  assertBranch(ctx, branchId);
  const supplier = await requireTenantDoc(ctx, 'suppliers', input.supplierId, 'supplier');
  if (!input.supplierInvoiceNo || String(input.supplierInvoiceNo).trim().length < 1) {
    throw unprocessable('the genuine supplier bill number is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.supplierInvoiceDate))) {
    throw unprocessable('supplier invoice date must be YYYY-MM-DD');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw unprocessable('add at least one received line');
  const fy = financialYear(input.supplierInvoiceDate);
  const registration = input.registrationId
    ? await requireTenantDoc(ctx, 'tax_registrations', input.registrationId, 'registration')
    : (await repo(ctx, 'tax_registrations').find({}))[0];
  if (!registration) throw unprocessable('configure a registration before posting purchases');

  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };
    const duplicate = await repo(ctx, 'purchases').findOne({
      supplierId: supplier._id,
      fy,
      supplierInvoiceNo: String(input.supplierInvoiceNo).trim(),
    });
    if (duplicate) {
      throw conflict(
        `Supplier bill ${input.supplierInvoiceNo} for FY ${fy} was already posted (${duplicate.number}). A duplicate would add stock twice.`,
        'DUPLICATE_SUPPLIER_BILL',
        { purchaseId: duplicate._id, number: duplicate.number }
      );
    }

    const lines = [];
    for (const [index, raw] of input.lines.entries()) {
      const product = await repo(ctx, 'products').findOne({ _id: raw.productId });
      if (!product) throw notFound(`line ${index + 1}: product not found`);
      if (product.kind === 'service') throw unprocessable(`line ${index + 1}: services are not received into stock`);
      const qty = String(raw.quantityScaled);
      if (!/^\d+$/.test(qty) || BigInt(qty) <= 0n) throw unprocessable(`line ${index + 1}: received quantity is invalid`);
      const taxable = toPaise(raw.taxableValuePaise, `line ${index + 1} taxable value`);
      const cgst = toPaise(raw.cgstPaise || '0', `line ${index + 1} CGST`);
      const sgst = toPaise(raw.sgstPaise || '0', `line ${index + 1} SGST`);
      const igst = toPaise(raw.igstPaise || '0', `line ${index + 1} IGST`);
      if (taxable < 0n || cgst < 0n || sgst < 0n || igst < 0n) throw unprocessable(`line ${index + 1}: negative amounts are not allowed`);
      if (cgst !== sgst && igst === 0n) {
        throw unprocessable(`line ${index + 1}: copy the ACTUAL supplier components; unequal CGST/SGST is not invented or corrected here`);
      }
      if (igst > 0n && (cgst > 0n || sgst > 0n)) throw unprocessable(`line ${index + 1}: IGST cannot be mixed with CGST/SGST on the same line`);
      const unitCost = raw.unitCostPaise
        ? toPaise(raw.unitCostPaise, `line ${index + 1} unit cost`)
        : mulDivRound(taxable, 10n ** BigInt(product.quantityScale), BigInt(qty));
      lines.push({
        lineId: newId(),
        productId: product._id,
        productSnapshot: {
          name: product.name,
          sku: product.sku,
          hsn: product.hsn,
          uom: product.uom,
          quantityScale: product.quantityScale,
          taxRateBps: product.taxRateBps,
        },
        batchNo: raw.batchNo ? String(raw.batchNo).trim() : null,
        expiry: raw.expiry || null,
        quantityScale: product.quantityScale,
        quantityScaled: qty,
        bonusQuantityScaled: raw.bonusQuantityScaled ? String(raw.bonusQuantityScaled) : '0',
        unitCostPaise: unitCost.toString(),
        taxableValuePaise: taxable.toString(),
        cgstPaise: cgst.toString(),
        sgstPaise: sgst.toString(),
        igstPaise: igst.toString(),
        coldChainVerified: raw.coldChainVerified !== false,
      });
    }
    const totals = purchaseTaxTotals(lines);
    const numberInfoSeries = registration.series?.find((s) => s.docKind === 'purchase');
    ctx.fyLabel = financialYear(ctx.now());
    const numberInfo = numberInfoSeries
      ? await nextNumber(ctx, {
          registrationId: registration._id,
          series: numberInfoSeries.series,
          padding: numberInfoSeries.padding,
          businessDate: businessDate(ctx.now()),
        })
      : { number: `PR-${newId().slice(0, 8).toUpperCase()}`, fy: ctx.fyLabel };

    let payment = null;
    if (input.payment) {
      if (!PAYMENT_METHODS.includes(input.payment.method)) throw unprocessable('unsupported payment method');
      const amount = toPaise(input.payment.amountPaise, 'supplier payment');
      if (amount < 0n || amount > totals.totalPaise) throw unprocessable('immediate payment must not exceed the bill total');
      payment = { amountPaise: amount.toString(), method: input.payment.method, reference: input.payment.reference || null };
    }

    const purchaseId = newId();
    const purchase = {
      _id: purchaseId,
      kind: 'purchase',
      number: numberInfo.number,
      fy: numberInfo.fy,
      supplierId: supplier._id,
      supplierSnapshot: { name: supplier.name, gstin: supplier.gstin, stateCode: supplier.stateCode },
      supplierInvoiceNo: String(input.supplierInvoiceNo).trim(),
      supplierInvoiceDate: String(input.supplierInvoiceDate),
      supplierFy: fy,
      branchId,
      registrationId: registration._id,
      lines,
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])),
      payment,
      status: 'posted',
      itcStatus: 'pending_review',
      postedAt: ctx.now(),
      businessDate: businessDate(ctx.now()),
      postedBy: ctx.userId,
      notes: input.notes ? String(input.notes).slice(0, 500) : null,
    };
    await repo(ctx, 'purchases').insertOne(purchase);

    for (const line of lines) {
      const received = await receiveBatch(ctx, {
        branchId,
        productId: line.productId,
        quantityScaled: line.quantityScaled,
        unitCostPaise: line.unitCostPaise,
        batchNo: line.batchNo || `AUTO-${numberInfo.number}`,
        expiry: line.expiry,
        coldChainVerified: line.coldChainVerified,
        sourceType: 'purchase',
        sourceId: purchaseId,
        movementType: 'purchase',
      });
      line.batchId = received.batch._id;
      if (line.bonusQuantityScaled && BigInt(line.bonusQuantityScaled) > 0n) {
        // Bonus units increase the same batch's quantity at zero extra cost,
        // spreading the actual cost over the received quantity.
        await receiveBatch(ctx, {
          branchId,
          productId: line.productId,
          quantityScaled: line.bonusQuantityScaled,
          totalCostPaise: '0',
          batchNo: line.batchNo || `AUTO-${numberInfo.number}`,
          expiry: line.expiry,
          coldChainVerified: line.coldChainVerified,
          sourceType: 'purchase_bonus',
          sourceId: purchaseId,
          movementType: 'purchase',
          reason: 'bonus units',
        });
      }
    }
    await repo(ctx, 'purchases').updateOne({ _id: purchaseId }, { $set: { lines } });

    await postPurchaseJournal(ctx, { purchase, businessDate: purchase.businessDate, branchId, payment });
    await repo(ctx, 'purchase_tax_reviews').insertOne({
      _id: newId(),
      purchaseId,
      status: 'pending_review',
      components: { cgstPaise: totals.cgstPaise.toString(), sgstPaise: totals.sgstPaise.toString(), igstPaise: totals.igstPaise.toString() },
      note: 'Input tax is pending review. It is NOT automatically claimable.',
      createdAt: ctx.now(),
    });
    await appendAudit(ctx, {
      action: 'purchase.posted',
      entityType: 'purchase',
      entityId: purchaseId,
      branchId,
      after: {
        number: purchase.number,
        supplierInvoiceNo: purchase.supplierInvoiceNo,
        supplierFy: fy,
        totalPaise: purchase.totals.totalPaise,
        lineCount: lines.length,
      },
    });
    await enqueue(ctx, { eventKey: `purchase-artifact:${purchaseId}`, type: 'document.artifact', payload: { documentId: purchaseId }, sourceId: purchaseId });

    const result = { purchaseId, number: purchase.number, totals: purchase.totals, itcStatus: 'pending_review' };
    await recordOperation(ctx, { action, key, hash, result });
    return { replayed: false, ...result };
  }).catch((err) => {
    if (isExpectedIdempotencyConflict(err)) {
      throw conflict('This purchase is already being posted. Check its status before retrying.', 'OPERATION_IN_PROGRESS');
    }
    throw err;
  });
}

export async function reviewInputTax(ctx, purchaseId, input) {
  if (!hasPermission(ctx.permissions, 'purchases.review_tax')) throw forbidden('Input-tax review permission is required');
  const purchase = await requireTenantDoc(ctx, 'purchases', purchaseId, 'purchase');
  const review = await repo(ctx, 'purchase_tax_reviews').findOne({ purchaseId });
  if (!review) throw notFound('tax review record not found');
  if (review.status !== 'pending_review' && !hasPermission(ctx.permissions, 'accounts.review')) {
    throw forbidden('A re-review of a decided input-tax position requires the accounting review permission');
  }
  const status = input.status;
  if (!['eligible', 'ineligible', 'pending_review'].includes(status)) throw unprocessable('status must be eligible, ineligible or pending_review');
  if (status !== 'pending_review' && (!input.evidence || String(input.evidence).trim().length < 8)) {
    throw unprocessable('record the evidence supporting the input-tax decision');
  }
  const store = ctx.store;
  if (status === review.status) return review;
  return store.transaction(async () => {
    const current = await repo(ctx, 'purchase_tax_reviews').findOne({ purchaseId });
    if (current.status !== review.status) throw conflict('this review changed concurrently; reload', 'REVIEW_CONFLICT');
    await repo(ctx, 'purchase_tax_reviews').updateOne(
      { _id: current._id, status: current.status },
      {
        $set: {
          status,
          evidence: input.evidence || null,
          reviewer: ctx.userId,
          reviewedAt: ctx.now(),
          previousStatus: current.status,
        },
      }
    );
    // Reclassification moves the tax between pending and eligible/ineligible
    // accounts without touching the supplier bill or the payable.
    const map = {
      eligible: { from: '1300', to: '1310' },
      ineligible: { from: '1300', to: '1320' },
    };
    const components = current.components || {};
    const total = BigInt(components.cgstPaise || '0') + BigInt(components.sgstPaise || '0') + BigInt(components.igstPaise || '0');
    const previousMap = current.previousStatus ? map[current.previousStatus] : null;
    if (map[status] && total > 0n) {
      const { postJournal } = await import('./accounting.js');
      const fromCode = previousMap ? previousMap.to : map[status].from;
      await postJournal(ctx, {
        sourceEventId: purchaseId,
        postingKind: `itc_review:${status}:${(ctx.now()).getTime()}`,
        businessDate: businessDate(ctx.now()),
        narration: `Input-tax review: ${status} for supplier bill ${purchase.supplierInvoiceNo}`,
        documentId: purchaseId,
        branchId: purchase.branchId,
        lines: [
          { accountCode: map[status].to, debitPaise: total.toString(), creditPaise: '0' },
          { accountCode: fromCode, debitPaise: '0', creditPaise: total.toString() },
        ],
      });
    }
    await appendAudit(ctx, {
      action: 'purchase.input_tax_reviewed',
      entityType: 'purchase',
      entityId: purchaseId,
      branchId: purchase.branchId,
      reason: input.evidence || null,
      before: { status: current.status },
      after: { status },
    });
    return { ...current, status, evidence: input.evidence || null };
  });
}

/**
 * Supplier return: capped by the original received quantity minus prior returns,
 * with an explicit supplier acknowledgment/credit-note state. A buyer memo is
 * never represented as the supplier's statutory GST debit note.
 */
export async function createSupplierReturn(ctx, input, { idempotencyKey } = {}) {
  if (!hasPermission(ctx.permissions, 'purchases.manage')) throw forbidden('Purchase permission is required');
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'supplier_return.create';
  const hash = canonicalHash(input);
  const store = ctx.store;
  const purchase = await requireTenantDoc(ctx, 'purchases', input.purchaseId, 'purchase');
  if (!input.reason || String(input.reason).trim().length < 5) throw unprocessable('a supplier-return reason is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw unprocessable('select at least one line to return');
  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };
    const prior = await repo(ctx, 'supplier_returns').find({ purchaseId: purchase._id, status: 'posted' });
    let inventoryCredit = 0n;
    let taxCredit = 0n;
    const lines = [];
    for (const raw of input.lines) {
      const original = purchase.lines.find((l) => l.lineId === raw.lineId);
      if (!original) throw notFound('purchase line not found');
      const already = prior
        .flatMap((r) => r.lines.filter((l) => l.lineId === raw.lineId))
        .reduce((a, l) => a + BigInt(l.quantityScaled), 0n);
      const available = BigInt(original.quantityScaled) + BigInt(original.bonusQuantityScaled || '0') - already;
      const qty = BigInt(raw.quantityScaled);
      if (qty <= 0n) throw unprocessable('return quantity must be greater than zero');
      if (qty > available) throw conflict(`return quantity exceeds the remaining received quantity (${available})`, 'SUPPLIER_RETURN_EXCEEDS');
      const allocation = mulDivRound(BigInt(original.taxableValuePaise), qty, BigInt(original.quantityScaled));
      const cgst = mulDivRound(BigInt(original.cgstPaise), qty, BigInt(original.quantityScaled));
      const sgst = mulDivRound(BigInt(original.sgstPaise), qty, BigInt(original.quantityScaled));
      const igst = mulDivRound(BigInt(original.igstPaise), qty, BigInt(original.quantityScaled));
      const batch = await repo(ctx, 'batch_lots').findOne({ _id: original.batchId });
      if (!batch) throw unprocessable('original batch not found for this receipt');
      const balance = await repo(ctx, 'stock_balances').findOne({ batchId: batch._id });
      if (!balance) throw unprocessable('stock balance missing for the original batch');
      if (BigInt(balance.availableScaled) < qty) {
        throw conflict('not enough unreturned saleable stock in the original batch for this supplier return', 'INSUFFICIENT_STOCK');
      }
      const cost = allocateCostFromBatch(batch, qty);
      await applyToBalance(ctx, { balanceId: balance._id, field: 'availableScaled', deltaScaled: `-${qty}` });
      inventoryCredit += allocation;
      taxCredit += cgst + sgst + igst;
      lines.push({
        lineId: original.lineId,
        productId: original.productId,
        batchId: batch._id,
        quantityScale: original.quantityScale,
        quantityScaled: qty.toString(),
        taxableValuePaise: allocation.toString(),
        cgstPaise: cgst.toString(),
        sgstPaise: sgst.toString(),
        igstPaise: igst.toString(),
        costPaise: cost.toString(),
      });
      await recordMovement(ctx, {
        branchId: purchase.branchId,
        productId: original.productId,
        batchId: batch._id,
        type: 'supplier_return',
        quantityScaled: `-${qty}`,
        quantityScale: original.quantityScale,
        sourceType: 'supplier_return',
        sourceId: purchase._id,
        costPaise: cost,
        reason: input.reason,
      });
    }
    const supplierReturn = {
      _id: newId(),
      kind: 'supplier_return',
      number: `SR-${newId().slice(0, 8).toUpperCase()}`,
      purchaseId: purchase._id,
      supplierId: purchase.supplierId,
      branchId: purchase.branchId,
      reason: String(input.reason).slice(0, 300),
      lines,
      inventoryCreditPaise: inventoryCredit.toString(),
      taxCreditPaise: taxCredit.toString(),
      creditPaise: (inventoryCredit + taxCredit).toString(),
      supplierAcknowledgment: input.supplierAcknowledgment || null,
      supplierCreditNoteNo: input.supplierCreditNoteNo || null,
      legalTreatment:
        'Buyer return memo only. The supplier statutory credit/debit note is tracked separately and is not fabricated by this system.',
      status: 'posted',
      postedAt: ctx.now(),
      businessDate: businessDate(ctx.now()),
      postedBy: ctx.userId,
    };
    await repo(ctx, 'supplier_returns').insertOne(supplierReturn);
    await postSupplierReturn(ctx, { supplierReturn, businessDate: supplierReturn.businessDate, branchId: purchase.branchId });
    await appendAudit(ctx, {
      action: 'supplier_return.posted',
      entityType: 'supplier_return',
      entityId: supplierReturn._id,
      branchId: purchase.branchId,
      reason: supplierReturn.reason,
      after: { number: supplierReturn.number, creditPaise: supplierReturn.creditPaise, purchaseId: purchase._id },
    });
    const result = { supplierReturnId: supplierReturn._id, number: supplierReturn.number, creditPaise: supplierReturn.creditPaise };
    await recordOperation(ctx, { action, key, hash, result });
    return { replayed: false, ...result };
  });
}

export async function recordSupplierCreditNote(ctx, supplierReturnId, input) {
  const supplierReturn = await requireTenantDoc(ctx, 'supplier_returns', supplierReturnId, 'supplier return');
  if (!input.supplierCreditNoteNo) throw unprocessable('the supplier credit-note number is required');
  if (!input.evidence) throw unprocessable('record the evidence (document/reference) for the supplier credit note');
  await repo(ctx, 'supplier_returns').updateOne(
    { _id: supplierReturnId },
    {
      $set: {
        supplierCreditNoteNo: String(input.supplierCreditNoteNo).slice(0, 100),
        supplierAcknowledgment: input.evidence,
        supplierCreditNoteRecordedAt: ctx.now(),
        supplierCreditNoteRecordedBy: ctx.userId,
      },
    }
  );
  await appendAudit(ctx, {
    action: 'supplier_return.credit_note_recorded',
    entityType: 'supplier_return',
    entityId: supplierReturnId,
    reason: input.evidence,
    after: { supplierCreditNoteNo: input.supplierCreditNoteNo },
  });
  return { recorded: true };
}

export async function listPurchases(ctx, { limit = 100, supplierId } = {}) {
  const filter = {};
  if (supplierId) filter.supplierId = supplierId;
  return repo(ctx, 'purchases').find(filter, { sort: { postedAt: -1 }, limit: Math.min(Number(limit) || 100, 500) });
}

export async function getPurchase(ctx, purchaseId) {
  const purchase = await requireTenantDoc(ctx, 'purchases', purchaseId, 'purchase');
  const review = await repo(ctx, 'purchase_tax_reviews').findOne({ purchaseId });
  const supplierReturns = await repo(ctx, 'supplier_returns').find({ purchaseId });
  return { purchase, review, supplierReturns };
}

/* ------------------------------------------------------ expenses & openings */

export async function recordExpense(ctx, input, { idempotencyKey } = {}) {
  if (!hasPermission(ctx.permissions, 'accounts.post')) throw forbidden('Accounting post permission is required');
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'expense.record';
  const hash = canonicalHash(input);
  const amount = toPaise(input.amountPaise, 'expense amount');
  if (amount <= 0n) throw unprocessable('expense amount must be greater than zero');
  if (!input.narration || String(input.narration).trim().length < 4) throw unprocessable('an expense narration is required');
  const account = await repo(ctx, 'ledger_accounts').findOne({ code: String(input.accountCode || '5290') });
  if (!account) throw unprocessable('expense account not found');
  if (account.type !== 'expense') throw unprocessable('the selected account is not an expense account');
  const store = ctx.store;
  const branchId = input.branchId || ctx.branchId;
  assertBranch(ctx, branchId);
  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };
    const expenseId = newId();
    const expense = {
      _id: expenseId,
      kind: 'expense',
      number: `EXP-${newId().slice(0, 8).toUpperCase()}`,
      narration: String(input.narration).slice(0, 300),
      accountCode: account.code,
      amountPaise: amount.toString(),
      method: input.method || 'cash',
      paidFrom: input.paidFrom === 'payable' ? 'payable' : 'money',
      partyId: input.partyId || null,
      branchId,
      businessDate: input.businessDate || businessDate(ctx.now()),
      reference: input.reference || null,
      createdAt: ctx.now(),
      createdBy: ctx.userId,
    };
    await repo(ctx, 'expenses').insertOne(expense);
    await postPurchaseExpense(ctx, expense);
    await appendAudit(ctx, {
      action: 'expense.recorded',
      entityType: 'expense',
      entityId: expenseId,
      branchId,
      after: { amountPaise: expense.amountPaise, accountCode: account.code, narration: expense.narration },
    });
    await recordOperation(ctx, { action, key, hash, result: { expenseId, number: expense.number } });
    return { replayed: false, expenseId, number: expense.number };
  });
}

async function postPurchaseExpense(ctx, expense) {
  const { postExpense } = await import('./accounting.js');
  return postExpense(ctx, { expense, businessDate: expense.businessDate, branchId: expense.branchId });
}

/**
 * Reviewed opening balances: stock (valued, one coordinated voucher) and/or
 * party/ledger openings. Never a silent balance edit.
 */
export async function postOpening(ctx, input, { idempotencyKey } = {}) {
  if (!hasPermission(ctx.permissions, 'accounts.post')) throw forbidden('Accounting post permission is required');
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'opening.post';
  const hash = canonicalHash(input);
  const store = ctx.store;
  const branchId = input.branchId || ctx.branchId;
  assertBranch(ctx, branchId);
  if (!input.evidence || String(input.evidence).trim().length < 8) throw unprocessable('record the source evidence for the opening balances');
  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };
    if (await repo(ctx, 'opening_entries').count({ kind: 'posting' }) > 0) {
      throw conflict('Opening balances were already posted for this tenant; use journals for corrections.', 'OPENING_EXISTS');
    }
    const openingId = newId();
    const lines = [];
    let stockCost = 0n;
    for (const [index, raw] of (input.stock || []).entries()) {
      const product = await requireTenantDoc(ctx, 'products', raw.productId, 'product');
      const received = await receiveBatch(ctx, {
        branchId,
        productId: raw.productId,
        quantityScaled: String(raw.quantityScaled),
        unitCostPaise: toPaise(raw.unitCostPaise, `stock line ${index + 1} cost`).toString(),
        batchNo: raw.batchNo || 'OPENING',
        expiry: raw.expiry || { precision: 'none' },
        sourceType: 'opening',
        sourceId: openingId,
        movementType: 'opening',
        reason: 'opening stock',
      });
      const value = mulDivRound(toPaise(raw.unitCostPaise, 'cost'), BigInt(raw.quantityScaled), 10n ** BigInt(product.quantityScale));
      stockCost += value;
      await repo(ctx, 'opening_entries').insertOne({
        _id: newId(),
        kind: 'stock',
        batchId: received.batch._id,
        productId: product._id,
        quantityScaled: String(raw.quantityScaled),
        unitCostPaise: String(raw.unitCostPaise),
        valuePaise: value.toString(),
        sourceId: openingId,
        evidence: input.evidence,
        at: ctx.now(),
      });
    }
    if (stockCost > 0n) {
      lines.push({ accountCode: '1200', debitPaise: stockCost.toString(), creditPaise: '0', memo: 'opening stock' });
    }
    for (const entry of input.ledgers || []) {
      const amount = toPaise(entry.amountPaise, 'opening amount');
      const account = await repo(ctx, 'ledger_accounts').findOne({ code: entry.accountCode });
      if (!account) throw unprocessable(`opening account ${entry.accountCode} not found`);
      if (entry.partyId) await requireTenantDoc(ctx, entry.partyType === 'supplier' ? 'suppliers' : 'customers', entry.partyId, 'party');
      lines.push({
        accountCode: entry.accountCode,
        debitPaise: entry.side === 'debit' ? amount.toString() : '0',
        creditPaise: entry.side === 'credit' ? amount.toString() : '0',
        partyId: entry.partyId || null,
        partyType: entry.partyType || null,
      });
      await repo(ctx, 'opening_entries').insertOne({
        _id: newId(),
        kind: 'ledger',
        accountCode: entry.accountCode,
        amountPaise: amount.toString(),
        side: entry.side,
        partyId: entry.partyId || null,
        sourceId: openingId,
        evidence: input.evidence,
        at: ctx.now(),
      });
    }
    const debit = lines.reduce((a, l) => a + BigInt(l.debitPaise), 0n);
    const credit = lines.reduce((a, l) => a + BigInt(l.creditPaise), 0n);
    if (debit !== credit) {
      const diff = debit - credit;
      lines.push({
        accountCode: '3100',
        debitPaise: diff < 0n ? (-diff).toString() : '0',
        creditPaise: diff > 0n ? diff.toString() : '0',
        memo: 'opening balance equity (reconciliation)',
      });
    }
    const { postJournal } = await import('./accounting.js');
    await postJournal(ctx, {
      sourceEventId: openingId,
      postingKind: 'opening',
      businessDate: input.businessDate || businessDate(ctx.now()),
      narration: `Opening balances — ${input.evidence}`,
      branchId,
      lines,
    });
    await repo(ctx, 'opening_entries').insertOne({
      _id: newId(),
      kind: 'posting',
      sourceId: openingId,
      evidence: input.evidence,
      stockCostPaise: stockCost.toString(),
      at: ctx.now(),
      by: ctx.userId,
    });
    await appendAudit(ctx, {
      action: 'opening.posted',
      entityType: 'opening',
      entityId: openingId,
      branchId,
      reason: input.evidence,
      after: { stockCostPaise: stockCost.toString(), ledgerLines: lines.length },
    });
    await recordOperation(ctx, { action, key, hash, result: { openingId } });
    return { replayed: false, openingId };
  });
}
