/**
 * Double-entry accounting (explicitly approved extension to legal attachment §14).
 *
 * Every posted journal balances exactly in integer paise, references same-tenant
 * accounts, has a unique source-event identity and is immutable. Corrections are
 * linked reversals. Period locks block late postings. No invented balancing
 * revenue/expense is ever inserted to make a trial balance pass.
 */

import { conflict, unprocessable } from '../errors.js';
import { newId } from '../ids.js';
import { formatINR, mulDivRound, sumPaise, toPaise } from '../money.js';
import { repo } from '../tenancy/repo.js';
import { ACC, CHART, moneyAccountForMethod } from './chart.js';

export { ACC };

export async function ensureChartOfAccounts(ctx) {
  const accounts = repo(ctx, 'ledger_accounts');
  const existing = await accounts.count();
  if (existing > 0) return;
  for (const account of CHART) {
    await accounts.insertOne({
      _id: newId(),
      code: account.code,
      name: account.name,
      type: account.type,
      normal: account.normal,
      system: account.system,
      party: account.party || null,
      active: true,
    });
  }
}

export async function accountByCode(ctx, code) {
  const account = await repo(ctx, 'ledger_accounts').findOne({ code });
  if (!account) throw unprocessable(`ledger account ${code} does not exist for this tenant`);
  if (account.active === false) throw unprocessable(`ledger account ${code} is inactive`);
  return account;
}

export async function checkPeriodOpen(ctx, businessDate) {
  const [year, month] = String(businessDate).split('-').map(Number);
  if (!year || !month) throw unprocessable('business date must be YYYY-MM-DD');
  const lock = await repo(ctx, 'period_locks').findOne({ year, month, status: 'locked' });
  if (lock) {
    throw conflict(
      `The accounting period ${businessDate.slice(0, 7)} is locked. Reopen it with approval before posting here.`,
      'PERIOD_LOCKED'
    );
  }
}

/**
 * Post a balanced journal. Callers pass already-exact integer paise.
 */
export async function postJournal(ctx, input) {
  const { sourceEventId, postingKind, businessDate, narration } = input;
  if (!sourceEventId) throw new Error('journal requires a source event id');
  if (!postingKind) throw new Error('journal requires a posting kind');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate))) throw unprocessable('businessDate must be YYYY-MM-DD');
  await checkPeriodOpen(ctx, businessDate);

  const lines = (input.lines || []).filter(
    (l) => (l.debitPaise && BigInt(l.debitPaise) !== 0n) || (l.creditPaise && BigInt(l.creditPaise) !== 0n)
  );
  if (lines.length < 2) throw unprocessable('a journal needs at least two lines with values');
  const prepared = [];
  for (const line of lines) {
    const debit = toPaise(line.debitPaise || '0', 'debit');
    const credit = toPaise(line.creditPaise || '0', 'credit');
    if (debit < 0n || credit < 0n) throw unprocessable('journal amounts must not be negative');
    if (debit > 0n && credit > 0n) throw unprocessable('a journal line cannot have both a debit and a credit');
    if (debit === 0n && credit === 0n) continue;
    const account = await accountByCode(ctx, line.accountCode);
    prepared.push({
      _id: newId(),
      entryId: null,
      accountId: account._id,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      partyId: line.partyId || null,
      partyType: line.partyType || account.party || null,
      debitPaise: debit.toString(),
      creditPaise: credit.toString(),
      memo: line.memo || null,
    });
  }
  const totalDebit = prepared.reduce((a, l) => a + BigInt(l.debitPaise), 0n);
  const totalCredit = prepared.reduce((a, l) => a + BigInt(l.creditPaise), 0n);
  if (totalDebit !== totalCredit) {
    throw unprocessable(
      `journal does not balance: debits ${formatINR(totalDebit)} vs credits ${formatINR(totalCredit)}`,
      'JOURNAL_UNBALANCED'
    );
  }
  if (totalDebit === 0n) throw unprocessable('journal total must not be zero');

  const existing = await repo(ctx, 'journal_entries').findOne({ sourceEventId, postingKind });
  if (existing) {
    throw conflict('a journal was already posted for this source event', 'JOURNAL_DUPLICATE');
  }

  const entryId = newId();
  const entry = {
    _id: entryId,
    sourceEventId,
    postingKind,
    documentId: input.documentId || null,
    branchId: input.branchId || ctx.branchId || null,
    businessDate,
    narration: input.narration || postingKind,
    status: 'posted',
    totalDebitPaise: totalDebit.toString(),
    totalCreditPaise: totalCredit.toString(),
    postedAt: ctx.now ? ctx.now() : new Date(),
    postedBy: ctx.userId,
    reversalOf: input.reversalOf || null,
    metadata: input.metadata || null,
  };
  await repo(ctx, 'journal_entries').insertOne(entry);
  for (const line of prepared) {
    line.entryId = entryId;
    await repo(ctx, 'journal_lines').insertOne(line);
  }
  return { entry, lines: prepared };
}

/** Reverse a posted entry with a linked, opposite, balanced journal. */
export async function reverseJournal(ctx, { entryId, reason, businessDate }) {
  const entry = await repo(ctx, 'journal_entries').findOne({ _id: entryId });
  if (!entry) throw unprocessable('journal entry not found');
  if (entry.status !== 'posted') throw conflict('only posted entries can be reversed', 'NOT_POSTED');
  const lines = await repo(ctx, 'journal_lines').find({ entryId });
  const reversed = await postJournal(ctx, {
    sourceEventId: `${entry.sourceEventId}:reversal:${entryId}`,
    postingKind: `reversal:${entry.postingKind}`,
    businessDate: businessDate || ctx.businessDate,
    narration: `Reversal of ${entry.narration}${reason ? ` — ${reason}` : ''}`,
    documentId: entry.documentId,
    reversalOf: entryId,
    lines: lines.map((l) => ({
      accountCode: l.accountCode,
      partyId: l.partyId,
      partyType: l.partyType,
      debitPaise: l.creditPaise,
      creditPaise: l.debitPaise,
      memo: `reversal of ${entry.narration}`,
    })),
  });
  await repo(ctx, 'journal_entries').updateOne({ _id: entryId }, { $set: { status: 'reversed', reversedBy: reversed.entry._id } });
  return reversed;
}

/* ---------------------------------------------------------------- mappings */

function roundOffLine(roundOff, extra = {}) {
  const n = BigInt(roundOff || '0');
  if (n === 0n) return null;
  if (n < 0n) return { accountCode: ACC.ROUND_OFF, debitPaise: (-n).toString(), creditPaise: '0', memo: 'invoice round-off', ...extra };
  return { accountCode: ACC.ROUND_OFF, debitPaise: '0', creditPaise: n.toString(), memo: 'invoice round-off', ...extra };
}

/** Sale: receivable vs revenue/output tax, plus COGS vs inventory. */
export async function postSale(ctx, { document, branchId, businessDate, narration }) {
  const totals = document.totals;
  const revenueGoods = document.lines
    .filter((l) => l.kind !== 'service')
    .reduce((a, l) => a + BigInt(l.taxableValuePaise), 0n);
  const revenueServices = document.lines
    .filter((l) => l.kind === 'service')
    .reduce((a, l) => a + BigInt(l.taxableValuePaise), 0n);
  const totalCost = document.lines.reduce((a, l) => a + BigInt(l.costPaise || '0'), 0n);

  const lines = [
    {
      accountCode: ACC.RECEIVABLE,
      partyId: document.partyId,
      partyType: 'customer',
      debitPaise: totals.totalPaise,
      creditPaise: '0',
      memo: `invoice ${document.number}`,
    },
  ];
  if (revenueGoods > 0n) lines.push({ accountCode: ACC.SALES_GOODS, creditPaise: revenueGoods.toString(), debitPaise: '0' });
  if (revenueServices > 0n) lines.push({ accountCode: ACC.SALES_SERVICES, creditPaise: revenueServices.toString(), debitPaise: '0' });
  if (BigInt(totals.cgstPaise) > 0n) lines.push({ accountCode: ACC.OUTPUT_CGST, creditPaise: totals.cgstPaise, debitPaise: '0' });
  if (BigInt(totals.sgstPaise) > 0n) lines.push({ accountCode: ACC.OUTPUT_SGST, creditPaise: totals.sgstPaise, debitPaise: '0' });
  if (BigInt(totals.igstPaise) > 0n) lines.push({ accountCode: ACC.OUTPUT_IGST, creditPaise: totals.igstPaise, debitPaise: '0' });
  const ro = roundOffLine(totals.roundOffPaise);
  if (ro) lines.push(ro);

  const result = await postJournal(ctx, {
    sourceEventId: document._id,
    postingKind: 'sale',
    businessDate,
    narration: narration || `Sale ${document.number}`,
    documentId: document._id,
    branchId,
    lines,
  });
  if (totalCost > 0n) {
    await postJournal(ctx, {
      sourceEventId: document._id,
      postingKind: 'sale_cogs',
      businessDate,
      narration: `Cost of goods sold ${document.number}`,
      documentId: document._id,
      branchId,
      lines: [
        { accountCode: ACC.COGS, debitPaise: totalCost.toString(), creditPaise: '0' },
        { accountCode: ACC.INVENTORY, debitPaise: '0', creditPaise: totalCost.toString() },
      ],
    });
  }
  return result;
}

export async function postPurchase(ctx, { purchase, businessDate, branchId, payment = null }) {
  const lines = [
    { accountCode: ACC.INVENTORY, debitPaise: purchase.totals.taxableValuePaise, creditPaise: '0', memo: `supplier bill ${purchase.supplierInvoiceNo}` },
  ];
  if (BigInt(purchase.totals.cgstPaise) > 0n) {
    lines.push({ accountCode: ACC.INPUT_TAX_PENDING, debitPaise: purchase.totals.cgstPaise, creditPaise: '0', memo: 'CGST pending ITC review' });
  }
  if (BigInt(purchase.totals.sgstPaise) > 0n) {
    lines.push({ accountCode: ACC.INPUT_TAX_PENDING, debitPaise: purchase.totals.sgstPaise, creditPaise: '0', memo: 'SGST pending ITC review' });
  }
  if (BigInt(purchase.totals.igstPaise) > 0n) {
    lines.push({ accountCode: ACC.INPUT_TAX_PENDING, debitPaise: purchase.totals.igstPaise, creditPaise: '0', memo: 'IGST pending ITC review' });
  }
  lines.push({
    accountCode: ACC.SUPPLIER_PAYABLE,
    partyId: purchase.supplierId,
    partyType: 'supplier',
    debitPaise: '0',
    creditPaise: purchase.totals.totalPaise,
    memo: `supplier bill ${purchase.supplierInvoiceNo}`,
  });
  const result = await postJournal(ctx, {
    sourceEventId: purchase._id,
    postingKind: 'purchase',
    businessDate,
    narration: `Goods receipt ${purchase.number} / supplier bill ${purchase.supplierInvoiceNo}`,
    documentId: purchase._id,
    branchId,
    lines,
  });
  if (payment && BigInt(payment.amountPaise) > 0n) {
    await postJournal(ctx, {
      sourceEventId: purchase._id,
      postingKind: 'purchase_payment',
      businessDate,
      narration: `Payment to supplier for ${purchase.number}`,
      documentId: purchase._id,
      branchId,
      lines: [
        { accountCode: ACC.SUPPLIER_PAYABLE, partyId: purchase.supplierId, partyType: 'supplier', debitPaise: payment.amountPaise, creditPaise: '0' },
        { accountCode: moneyAccountForMethod(payment.method), debitPaise: '0', creditPaise: payment.amountPaise },
      ],
    });
  }
  return result;
}

export async function postReceipt(ctx, { payment, businessDate, branchId, narration }) {
  return postJournal(ctx, {
    sourceEventId: payment._id,
    postingKind: payment.kind === 'refund' ? 'refund' : 'receipt',
    businessDate,
    narration: narration || `${payment.kind} ${formatINR(payment.amountPaise)} (${payment.method})`,
    documentId: payment.documentId || null,
    branchId,
    lines:
      payment.kind === 'refund'
        ? [
            { accountCode: ACC.RECEIVABLE, partyId: payment.partyId, partyType: 'customer', debitPaise: payment.amountPaise, creditPaise: '0' },
            { accountCode: moneyAccountForMethod(payment.method), debitPaise: '0', creditPaise: payment.amountPaise },
          ]
        : [
            { accountCode: moneyAccountForMethod(payment.method), debitPaise: payment.amountPaise, creditPaise: '0' },
            { accountCode: ACC.RECEIVABLE, partyId: payment.partyId, partyType: 'customer', debitPaise: '0', creditPaise: payment.amountPaise },
          ],
  });
}

export async function postSupplierPayment(ctx, { payment, businessDate, branchId }) {
  return postJournal(ctx, {
    sourceEventId: payment._id,
    postingKind: 'supplier_payment',
    businessDate,
    narration: `Supplier payment ${formatINR(payment.amountPaise)} (${payment.method})`,
    branchId,
    lines: [
      { accountCode: ACC.SUPPLIER_PAYABLE, partyId: payment.partyId, partyType: 'supplier', debitPaise: payment.amountPaise, creditPaise: '0' },
      { accountCode: moneyAccountForMethod(payment.method), debitPaise: '0', creditPaise: payment.amountPaise },
    ],
  });
}

export async function postReceiptReversal(ctx, { payment, original, businessDate, branchId }) {
  return postJournal(ctx, {
    sourceEventId: payment._id,
    postingKind: 'receipt_reversal',
    businessDate,
    narration: `Reversal of receipt ${original.number}`,
    branchId,
    lines: [
      { accountCode: ACC.RECEIVABLE, partyId: original.partyId, partyType: 'customer', debitPaise: original.amountPaise, creditPaise: '0' },
      { accountCode: moneyAccountForMethod(original.method), debitPaise: '0', creditPaise: original.amountPaise },
    ],
  });
}

/**
 * Customer return / credit note.
 *  - commercial credit always reduces the customer's obligation;
 *  - output GST is debited only for the eligible adjustment amount;
 *  - restock (explicitly approved) restores inventory at original allocated cost
 *    and reverses COGS; a no-restock return makes no such entry.
 */
export async function postReturn(ctx, { ret, businessDate, branchId }) {
  const rev = BigInt(ret.credit.taxableValuePaise);
  const gst = BigInt(ret.credit.cgstPaise) + BigInt(ret.credit.sgstPaise) + BigInt(ret.credit.igstPaise);
  const commercial = BigInt(ret.credit.commercialCreditPaise);
  const gstEligible = BigInt(ret.credit.gstAdjustmentPaise);
  const lines = [];
  const contraRevenue = commercial - gstEligible;
  if (contraRevenue > 0n) {
    lines.push({ accountCode: ACC.SALES_RETURNS, debitPaise: contraRevenue.toString(), creditPaise: '0', memo: `credit note ${ret.number}` });
  }
  if (gstEligible > 0n) {
    if (BigInt(ret.credit.cgstPaise) > 0n) lines.push({ accountCode: ACC.OUTPUT_CGST, debitPaise: ret.credit.cgstPaise, creditPaise: '0' });
    if (BigInt(ret.credit.sgstPaise) > 0n) lines.push({ accountCode: ACC.OUTPUT_SGST, debitPaise: ret.credit.sgstPaise, creditPaise: '0' });
    if (BigInt(ret.credit.igstPaise) > 0n) lines.push({ accountCode: ACC.OUTPUT_IGST, debitPaise: ret.credit.igstPaise, creditPaise: '0' });
  }
  lines.push({
    accountCode: ACC.RECEIVABLE,
    partyId: ret.partyId,
    partyType: 'customer',
    debitPaise: '0',
    creditPaise: commercial.toString(),
    memo: `credit note ${ret.number}`,
  });
  const result = await postJournal(ctx, {
    sourceEventId: ret._id,
    postingKind: 'return',
    businessDate,
    narration: `Credit note ${ret.number} against ${ret.sourceNumber}`,
    documentId: ret.sourceDocumentId,
    branchId,
    lines,
    metadata: {
      originalTaxReferencePaise: rev.toString(),
      gstAdjustmentStatus: ret.credit.gstAdjustmentStatus,
      commercialCreditPaise: commercial.toString(),
    },
  });
  if (BigInt(ret.restoredCostPaise || '0') > 0n) {
    await postJournal(ctx, {
      sourceEventId: ret._id,
      postingKind: 'return_restock',
      businessDate,
      narration: `Restock against credit note ${ret.number}`,
      documentId: ret.sourceDocumentId,
      branchId,
      lines: [
        { accountCode: ACC.INVENTORY, debitPaise: ret.restoredCostPaise, creditPaise: '0' },
        { accountCode: ACC.COGS, debitPaise: '0', creditPaise: ret.restoredCostPaise },
      ],
    });
  }
  return result;
}

export async function postWriteOff(ctx, { adjustment, businessDate, branchId }) {
  return postJournal(ctx, {
    sourceEventId: adjustment._id,
    postingKind: 'stock_writeoff',
    businessDate,
    narration: `${adjustment.type} — ${adjustment.reason}`,
    branchId,
    lines: [
      { accountCode: adjustment.accountCode || ACC.WRITE_OFF, debitPaise: adjustment.costPaise, creditPaise: '0' },
      { accountCode: ACC.INVENTORY, debitPaise: '0', creditPaise: adjustment.costPaise },
    ],
  });
}

export async function postSupplierReturn(ctx, { supplierReturn, businessDate, branchId }) {
  return postJournal(ctx, {
    sourceEventId: supplierReturn._id,
    postingKind: 'supplier_return',
    businessDate,
    narration: `Supplier return ${supplierReturn.number}`,
    branchId,
    lines: [
      { accountCode: ACC.SUPPLIER_PAYABLE, partyId: supplierReturn.supplierId, partyType: 'supplier', debitPaise: supplierReturn.creditPaise, creditPaise: '0' },
      { accountCode: ACC.INVENTORY, debitPaise: '0', creditPaise: supplierReturn.inventoryCreditPaise },
      ...(BigInt(supplierReturn.taxCreditPaise) > 0n
        ? [{ accountCode: ACC.INPUT_TAX_PENDING, debitPaise: '0', creditPaise: supplierReturn.taxCreditPaise }]
        : []),
    ],
  });
}

export async function postExpense(ctx, { expense, businessDate, branchId }) {
  const creditAccount = expense.paidFrom === 'payable' ? ACC.SUPPLIER_PAYABLE : moneyAccountForMethod(expense.method || 'cash');
  return postJournal(ctx, {
    sourceEventId: expense._id,
    postingKind: 'expense',
    businessDate,
    narration: expense.narration,
    branchId,
    lines: [
      { accountCode: expense.accountCode, debitPaise: expense.amountPaise, creditPaise: '0' },
      {
        accountCode: creditAccount,
        debitPaise: '0',
        creditPaise: expense.amountPaise,
        partyId: expense.partyId || null,
        partyType: expense.paidFrom === 'payable' ? 'supplier' : null,
      },
    ],
  });
}

/* ------------------------------------------------------------- reporting */

export async function trialBalance(ctx, { from, to }) {
  const entries = await repo(ctx, 'journal_entries').find({ status: 'posted' }, {});
  const filtered = entries.filter((e) => withinRange(e.businessDate, from, to));
  const ids = new Set(filtered.map((e) => e._id));
  const lines = (await repo(ctx, 'journal_lines').find({})).filter((l) => ids.has(l.entryId));
  const accounts = await repo(ctx, 'ledger_accounts').find({});
  const map = new Map();
  for (const account of accounts) {
    map.set(account._id, { account, debitPaise: 0n, creditPaise: 0n });
  }
  for (const line of lines) {
    const row = map.get(line.accountId);
    if (!row) continue;
    row.debitPaise += BigInt(line.debitPaise);
    row.creditPaise += BigInt(line.creditPaise);
  }
  const rows = [...map.values()]
    .map(({ account, debitPaise, creditPaise }) => {
      const net = debitPaise - creditPaise;
      return {
        accountId: account._id,
        code: account.code,
        name: account.name,
        type: account.type,
        normal: account.normal,
        debitTotalPaise: debitPaise.toString(),
        creditTotalPaise: creditPaise.toString(),
        balancePaise: (net < 0n ? -net : net).toString(),
        balanceSide: net === 0n ? 'nil' : net > 0n ? 'debit' : 'credit',
      };
    })
    .filter((r) => r.balanceSide !== 'nil' || r.debitTotalPaise !== '0' || r.creditTotalPaise !== '0')
    .sort((a, b) => (a.code < b.code ? -1 : 1));
  const totalDebit = rows.reduce((a, r) => a + (r.balanceSide === 'debit' ? BigInt(r.balancePaise) : 0n), 0n);
  const totalCredit = rows.reduce((a, r) => a + (r.balanceSide === 'credit' ? BigInt(r.balancePaise) : 0n), 0n);
  return {
    rows,
    totalDebitPaise: totalDebit.toString(),
    totalCreditPaise: totalCredit.toString(),
    balanced: totalDebit === totalCredit,
    entryCount: filtered.length,
  };
}

function withinRange(dateString, from, to) {
  if (from && dateString < from) return false;
  if (to && dateString > to) return false;
  return true;
}

export async function profitAndLoss(ctx, { from, to }) {
  const tb = await trialBalance(ctx, { from, to });
  const revenue = tb.rows.filter((r) => r.type === 'revenue');
  const expenses = tb.rows.filter((r) => r.type === 'expense');
  const signed = (r) => (r.balanceSide === 'debit' ? BigInt(r.balancePaise) : -BigInt(r.balancePaise));
  const revenueNet = -revenue.reduce((a, r) => a + signed(r), 0n);
  const expenseNet = expenses.reduce((a, r) => a + signed(r), 0n);
  return {
    revenue,
    expenses,
    revenueTotalPaise: revenueNet.toString(),
    expenseTotalPaise: expenseNet.toString(),
    profitPaise: (revenueNet - expenseNet).toString(),
    label: 'Management working statement — not an audited statutory statement',
  };
}

export async function balanceSheet(ctx, { from, to }) {
  const tb = await trialBalance(ctx, { from, to });
  const assets = tb.rows.filter((r) => r.type === 'asset');
  const liabilities = tb.rows.filter((r) => r.type === 'liability');
  const equity = tb.rows.filter((r) => r.type === 'equity');
  const signed = (r) => (r.balanceSide === 'debit' ? BigInt(r.balancePaise) : -BigInt(r.balancePaise));
  const assetTotal = assets.reduce((a, r) => a + signed(r), 0n);
  const liabilityTotal = -liabilities.reduce((a, r) => a + signed(r), 0n);
  const equityTotal = -equity.reduce((a, r) => a + signed(r), 0n);
  const pl = await profitAndLoss(ctx, { from, to });
  const profit = BigInt(pl.profitPaise);
  return {
    assets,
    liabilities,
    equity,
    assetTotalPaise: assetTotal.toString(),
    liabilityTotalPaise: liabilityTotal.toString(),
    equityTotalPaise: equityTotal.toString(),
    retainedResultPaise: profit.toString(),
    checkPaise: (assetTotal - (liabilityTotal + equityTotal + profit)).toString(),
    balanced: assetTotal === liabilityTotal + equityTotal + profit,
    label: 'Management working statement — not an audited statutory balance sheet',
  };
}

/** Party subledger balances derived from journal lines (not manually edited). */
export async function partyBalances(ctx) {
  const accounts = await repo(ctx, 'ledger_accounts').find({ party: { $exists: true } });
  const byCode = new Map(accounts.map((a) => [a._id, a]));
  const lines = await repo(ctx, 'journal_lines').find({});
  const customers = new Map();
  const suppliers = new Map();
  let unassignedReceivable = 0n;
  for (const line of lines) {
    const account = byCode.get(line.accountId);
    if (!account) continue;
    if (!line.partyId) {
      if (account.code === ACC.RECEIVABLE) {
        unassignedReceivable += BigInt(line.debitPaise) - BigInt(line.creditPaise);
      }
      continue;
    }
    const target = account.code === ACC.RECEIVABLE ? customers : suppliers;
    const current = target.get(line.partyId) || 0n;
    // receivable is debit-positive, payable is credit-positive
    const delta = account.code === ACC.RECEIVABLE
      ? BigInt(line.debitPaise) - BigInt(line.creditPaise)
      : BigInt(line.creditPaise) - BigInt(line.debitPaise);
    target.set(line.partyId, current + delta);
  }
  return { customers, suppliers, unassignedReceivablePaise: unassignedReceivable.toString() };
}

export async function reconcile(ctx) {
  const tb = await trialBalance(ctx, { from: null, to: null });
  const findings = [];
  if (!tb.balanced) {
    findings.push({ code: 'TRIAL_BALANCE', severity: 'critical', message: 'Trial balance is not balanced.' });
  }
  // Inventory carrying value vs GL
  const glInventory = BigInt(tb.rows.find((r) => r.code === ACC.INVENTORY)?.balancePaise || '0');
  const valuation = await inventoryValuation(ctx);
  if (glInventory !== BigInt(valuation.totalPaise)) {
    findings.push({
      code: 'INVENTORY_VS_GL',
      severity: 'warning',
      message: `Inventory GL ${formatINR(glInventory)} differs from batch valuation ${formatINR(valuation.totalPaise)} (rounding residual or unposted movement).`,
      glPaise: glInventory.toString(),
      valuationPaise: valuation.totalPaise.toString(),
    });
  }
  const parties = await partyBalances(ctx);
  const receivableGl = BigInt(tb.rows.find((r) => r.code === ACC.RECEIVABLE)?.balancePaise || '0');
  const customerTotal = [...parties.customers.values()].reduce((a, b) => a + b, 0n);
  const unassigned = BigInt(parties.unassignedReceivablePaise || '0');
  if (receivableGl !== customerTotal + unassigned) {
    findings.push({
      code: 'RECEIVABLE_SUBLEDGER',
      severity: 'warning',
      message: 'Receivable GL differs from the customer subledger total plus unassigned (walk-in) balances.',
    });
  }
  return {
    checkedAt: new Date().toISOString(),
    journalBalanced: tb.balanced,
    inventoryGlPaise: glInventory.toString(),
    inventoryValuationPaise: valuation.totalPaise.toString(),
    receivableGlPaise: receivableGl.toString(),
    customerSubledgerPaise: customerTotal.toString(),
    unassignedReceivablePaise: unassigned.toString(),
    findings,
    ok: findings.filter((f) => f.severity === 'critical').length === 0,
  };
}

export async function inventoryValuation(ctx) {
  const balances = await repo(ctx, 'stock_balances').find({});
  let total = 0n;
  const rows = [];
  for (const balance of balances) {
    const batch = await repo(ctx, 'batch_lots').findOne({ _id: balance.batchId });
    if (!batch) continue;
    const unit = BigInt(batch.receivedScaled || '0');
    if (unit === 0n) continue;
    const qty = BigInt(balance.availableScaled) + BigInt(balance.nonSaleableScaled || '0');
    const value = mulDivRound(BigInt(batch.receivedCostPaise), qty, unit);
    total += value;
    rows.push({
      batchId: batch._id,
      batchNo: batch.batchNo,
      productId: batch.productId,
      quantityScaled: qty.toString(),
      valuePaise: value.toString(),
    });
  }
  return { totalPaise: total.toString(), rows };
}

export { sumPaise };
