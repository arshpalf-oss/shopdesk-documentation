/**
 * Reporting.
 *
 * Preserves the 12 required core tabs (Summary, Day book, Products, Categories,
 * Cashiers, Payments, GST, GSTR-1 working register, GSTR-3B working papers,
 * Stock, Receivables, Stock log) and adds returns/expiry/payables/audit views.
 *
 * Event-date semantics: invoice issue date, receipt date and return date are
 * different measures. Periods are half-open UTC bounds derived from IST business
 * dates, and each report states its metric definitions.
 *
 * GSTR outputs are explicitly labelled working papers — never filed returns,
 * portal JSON or tax-payment proof.
 */

import { forbidden, unprocessable } from '../errors.js';
import { formatINR, formatScaled, mulDivRound } from '../money.js';
import { resolvePeriod, businessDate, expiryLabel, daysUntilExpiry } from '../time.js';
import { repo } from '../tenancy/repo.js';
import { hasPermission } from '../auth/permissions.js';
import { inventoryValuation } from './accounting.js';

export const CORE_TABS = [
  'summary',
  'daybook',
  'products',
  'categories',
  'cashiers',
  'payments',
  'gst',
  'gstr1',
  'gstr3b',
  'stock',
  'receivables',
  'stocklog',
];

export const EXTRA_TABS = ['returns', 'expiry', 'payables', 'audit', 'purchases', 'trial_balance'];

export const TAB_LABELS = {
  summary: 'Summary',
  daybook: 'Day book',
  products: 'Products',
  categories: 'Categories',
  cashiers: 'Cashiers',
  payments: 'Payments',
  gst: 'GST',
  gstr1: 'GSTR-1 (working register)',
  gstr3b: 'GSTR-3B (working papers)',
  stock: 'Stock',
  receivables: 'Receivables',
  stocklog: 'Stock log',
  returns: 'Returns & credit notes',
  expiry: 'Expiry review',
  payables: 'Payables',
  audit: 'Audit trail',
  purchases: 'Purchases',
  trial_balance: 'Trial balance',
};

export const DEFINITIONS = {
  grossBilled: 'Sum of issued invoice gross totals (taxable value + tax) by invoice issue date.',
  discounts: 'Line and invoice discounts recorded on issued invoices in the period.',
  commercialCredits: 'Customer credit notes issued in the period; reduces what the customer owes.',
  gstAdjustments: 'The portion of credit notes where output GST was eligible to be reduced and was reduced.',
  netBilled: 'Gross billed + valid debit notes − commercial credits.',
  confirmedReceipts: 'Confirmed receipts recorded in the period (not pending attempts).',
  refunds: 'Confirmed refunds recorded in the period.',
  due: 'Net billed − net confirmed money received, where positive.',
  refundEntitlement: 'Confirmed money received − net billed, where positive.',
  cost: 'Allocated batch cost from the original receipt (owner/accountant only).',
};

export function inInstantRange(instant, from, to) {
  if (!instant) return false;
  const t = new Date(instant).getTime();
  return t >= from.getTime() && t < to.getTime();
}

export function inBusinessRange(dateString, period) {
  if (!dateString) return false;
  return dateString >= period.fromDate && dateString <= period.toDate;
}

function branchFilter(ctx, branchId) {
  if (!branchId) return {};
  if (ctx.allowedBranchIds?.length && !ctx.allowedBranchIds.includes(branchId)) {
    throw forbidden('This branch is not assigned to your membership');
  }
  return { branchId };
}

function money(value) {
  return formatINR(value);
}

function readPath(row, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), row);
}

function sumField(rows, field) {
  // Dotted paths are supported: totals.totalPaise is the common case and a
  // naive row[field] lookup silently reported zero gross billing.
  return rows.reduce((a, r) => a + BigInt(readPath(r, field) || '0'), 0n);
}

export async function runReport(ctx, tab, options = {}) {
  if (!CORE_TABS.includes(tab) && !EXTRA_TABS.includes(tab)) throw unprocessable(`unknown report tab "${tab}"`);
  const period = resolvePeriod({
    preset: options.preset || 'month',
    from: options.from,
    to: options.to,
    now: ctx.now(),
  });
  const branch = branchFilter(ctx, options.branchId);
  const canSeeCost = hasPermission(ctx.permissions, 'reports.cost') || hasPermission(ctx.permissions, 'documents.read.cost');
  const quantityOnly = options.quantityOnly === true && !hasPermission(ctx.permissions, 'reports.cost');
  const base = {
    tab,
    label: TAB_LABELS[tab],
    period: {
      preset: period.preset,
      label: period.label,
      fromDate: period.fromDate,
      toDate: period.toDate,
      fromUtc: period.from.toISOString(),
      toUtc: period.to.toISOString(),
    },
    definitions: DEFINITIONS,
    quantityOnly,
    canSeeCost: canSeeCost && !quantityOnly,
    generatedAt: ctx.now().toISOString(),
    branchId: options.branchId || null,
  };

  const invoices = (await repo(ctx, 'financial_documents').find({ kind: 'invoice', ...branch })).filter((d) =>
    inInstantRange(d.issuedAt, period.from, period.to)
  );
  const returns = (await repo(ctx, 'returns').find({ ...branch })).filter((r) => inInstantRange(r.issuedAt, period.from, period.to));
  const debitNotes = (await repo(ctx, 'debit_notes').find({ ...branch })).filter((r) => inInstantRange(r.issuedAt, period.from, period.to));
  const payments = (await repo(ctx, 'payments').find({ ...branch })).filter(
    (p) => p.status === 'confirmed' && inInstantRange(p.at, period.from, period.to)
  );
  const purchases = (await repo(ctx, 'purchases').find({ ...branch })).filter((p) =>
    inInstantRange(p.postedAt, period.from, period.to)
  );

  const receipts = payments.filter((p) => p.kind === 'receipt');
  const refunds = payments.filter((p) => p.kind === 'refund');
  const reversals = payments.filter((p) => p.kind === 'receipt_reversal');

  const grossBilled = sumField(invoices, 'totals.totalPaise');
  const commercialCredits = returns.reduce((a, r) => a + BigInt(r.credit.commercialCreditPaise), 0n);
  const gstAdjustments = returns.reduce((a, r) => a + BigInt(r.credit.gstAdjustmentPaise), 0n);
  const debitTotal = sumField(debitNotes, 'amountPaise');
  const confirmedReceipts = sumField(receipts, 'amountPaise');
  const refundTotal = sumField(refunds, 'amountPaise');
  const reversalTotal = sumField(reversals, 'amountPaise');
  const netBilled = grossBilled + debitTotal - commercialCredits;
  const netReceived = confirmedReceipts - refundTotal - reversalTotal;

  switch (tab) {
    case 'summary': {
      const tax = invoices.reduce(
        (acc, d) => {
          acc.taxable += BigInt(d.totals.taxableValuePaise);
          acc.cgst += BigInt(d.totals.cgstPaise);
          acc.sgst += BigInt(d.totals.sgstPaise);
          acc.igst += BigInt(d.totals.igstPaise);
          acc.discount += BigInt(d.totals.discountPaise);
          acc.cost += d.lines.reduce((a, l) => a + BigInt(l.costPaise || '0'), 0n);
          return acc;
        },
        { taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n, discount: 0n, cost: 0n }
      );
      const cards = [
        { key: 'grossBilled', label: 'Gross billed', valuePaise: grossBilled.toString(), definition: DEFINITIONS.grossBilled },
        { key: 'discounts', label: 'Discounts', valuePaise: tax.discount.toString(), definition: DEFINITIONS.discounts },
        { key: 'commercialCredits', label: 'Customer credits', valuePaise: commercialCredits.toString(), definition: DEFINITIONS.commercialCredits },
        { key: 'gstAdjustments', label: 'GST adjustments', valuePaise: gstAdjustments.toString(), definition: DEFINITIONS.gstAdjustments },
        { key: 'netBilled', label: 'Net billed', valuePaise: netBilled.toString(), definition: DEFINITIONS.netBilled },
        { key: 'confirmedReceipts', label: 'Confirmed receipts', valuePaise: confirmedReceipts.toString(), definition: DEFINITIONS.confirmedReceipts },
        { key: 'refunds', label: 'Refunds', valuePaise: refundTotal.toString(), definition: DEFINITIONS.refunds },
      ];
      if (canSeeCost && !quantityOnly) {
        cards.push({ key: 'cost', label: 'Allocated cost (sold)', valuePaise: tax.cost.toString(), definition: DEFINITIONS.cost });
        cards.push({ key: 'margin', label: 'Gross margin (billed − cost)', valuePaise: (netBilled - tax.cost).toString(), definition: 'Net billed − allocated batch cost of goods sold in the period.' });
      }
      if (hasPermission(ctx.permissions, 'overview.self')) {
        // Cashier dashboard is limited to their own authorised work.
      }
      return {
        ...base,
        cards: canSeeCost && !quantityOnly ? cards : cards.filter((c) => c.key !== 'cost' && c.key !== 'margin'),
        totals: {
          invoices: invoices.length,
          credits: returns.length,
          debitNotes: debitNotes.length,
          receipts: receipts.length,
          refunds: refunds.length,
          taxableValuePaise: tax.taxable.toString(),
          cgstPaise: tax.cgst.toString(),
          sgstPaise: tax.sgst.toString(),
          igstPaise: tax.igst.toString(),
        },
        drillDown: {
          invoices: invoices.map((d) => ({ id: d._id, number: d.number, date: d.businessDate, party: d.partySnapshot?.name, totalPaise: d.totals.totalPaise })),
          credits: returns.map((r) => ({ id: r._id, number: r.number, date: r.businessDate, source: r.sourceNumber, amountPaise: r.credit.commercialCreditPaise })),
        },
      };
    }
    case 'daybook': {
      const events = [
        ...invoices.map((d) => ({ at: d.issuedAt, date: d.businessDate, type: 'Invoice', number: d.number, party: d.partySnapshot?.name, debitPaise: d.totals.totalPaise, creditPaise: '0', id: d._id })),
        ...returns.map((r) => ({ at: r.issuedAt, date: r.businessDate, type: 'Credit note', number: r.number, party: r.partySnapshot?.name, debitPaise: '0', creditPaise: r.credit.commercialCreditPaise, id: r._id })),
        ...debitNotes.map((d) => ({ at: d.issuedAt, date: d.businessDate, type: 'Debit note', number: d.number, party: d.partySnapshot?.name, debitPaise: d.amountPaise, creditPaise: '0', id: d._id })),
        ...payments.map((p) => ({
          at: p.at,
          date: p.businessDate,
          type: p.kind === 'receipt' ? 'Receipt' : p.kind === 'refund' ? 'Refund' : 'Receipt reversal',
          number: p.number,
          party: p.partyName,
          debitPaise: p.kind === 'receipt' ? p.amountPaise : '0',
          creditPaise: p.kind === 'receipt' ? '0' : p.amountPaise,
          method: p.method,
          id: p._id,
        })),
        ...purchases.map((p) => ({ at: p.postedAt, date: p.businessDate, type: 'Purchase', number: p.number, party: p.supplierSnapshot?.name, debitPaise: '0', creditPaise: p.totals.totalPaise, id: p._id })),
      ].sort((a, b) => new Date(a.at) - new Date(b.at));
      return { ...base, rows: events };
    }
    case 'products':
    case 'categories': {
      const map = new Map();
      for (const doc of invoices) {
        for (const line of doc.lines) {
          const key = tab === 'products' ? line.productId : (line.product?.category || 'General');
          const name = tab === 'products' ? line.product?.name : key;
          const row = map.get(key) || {
            key,
            name,
            quantityScaled: 0n,
            quantityScale: line.quantityScale,
            taxableValuePaise: 0n,
            taxPaise: 0n,
            grossPaise: 0n,
            costPaise: 0n,
            invoices: new Set(),
          };
          row.quantityScaled += BigInt(line.quantityScaled);
          row.taxableValuePaise += BigInt(line.taxableValuePaise);
          row.taxPaise += BigInt(line.taxPaise);
          row.grossPaise += BigInt(line.lineTotalPaise);
          row.costPaise += BigInt(line.costPaise || '0');
          row.invoices.add(doc._id);
          map.set(key, row);
        }
      }
      const rows = [...map.values()].map((r) => {
        const out = {
          key: r.key,
          name: r.name,
          quantity: formatScaled(r.quantityScaled, r.quantityScale),
          taxableValuePaise: r.taxableValuePaise.toString(),
          taxPaise: r.taxPaise.toString(),
          grossPaise: r.grossPaise.toString(),
          invoiceCount: r.invoices.size,
        };
        if (canSeeCost && !quantityOnly) {
          out.costPaise = r.costPaise.toString();
          out.marginPaise = (r.taxableValuePaise - r.costPaise).toString();
        }
        return out;
      });
      return { ...base, rows: rows.sort((a, b) => Number(BigInt(b.taxableValuePaise) - BigInt(a.taxableValuePaise))) };
    }
    case 'cashiers': {
      const map = new Map();
      for (const doc of invoices) {
        const key = doc.cashierId;
        const row = map.get(key) || { cashierId: key, name: doc.cashierName, invoices: 0, grossPaise: 0n, receiptsPaise: 0n, refundsPaise: 0n };
        row.invoices += 1;
        row.grossPaise += BigInt(doc.totals.totalPaise);
        map.set(key, row);
      }
      for (const payment of payments) {
        const key = payment.recordedBy;
        const row = map.get(key) || { cashierId: key, name: payment.recordedByName, invoices: 0, grossPaise: 0n, receiptsPaise: 0n, refundsPaise: 0n };
        if (payment.kind === 'receipt') row.receiptsPaise += BigInt(payment.amountPaise);
        if (payment.kind === 'refund') row.refundsPaise += BigInt(payment.amountPaise);
        map.set(key, row);
      }
      return {
        ...base,
        rows: [...map.values()].map((r) => ({
          cashierId: r.cashierId,
          name: r.name || 'Unknown',
          invoiceCount: r.invoices,
          grossBilledPaise: r.grossPaise.toString(),
          confirmedReceiptsPaise: r.receiptsPaise.toString(),
          refundsPaise: r.refundsPaise.toString(),
        })),
      };
    }
    case 'payments': {
      const byMethod = new Map();
      for (const p of payments) {
        const row = byMethod.get(p.method) || { method: p.method, receiptsPaise: 0n, refundsPaise: 0n, reversalsPaise: 0n, count: 0 };
        row.count += 1;
        if (p.kind === 'receipt') row.receiptsPaise += BigInt(p.amountPaise);
        if (p.kind === 'refund') row.refundsPaise += BigInt(p.amountPaise);
        if (p.kind === 'receipt_reversal') row.reversalsPaise += BigInt(p.amountPaise);
        byMethod.set(p.method, row);
      }
      const pending = (await repo(ctx, 'payment_intents').find({ status: 'pending' })).filter((i) => inInstantRange(i.createdAt, period.from, period.to));
      return {
        ...base,
        rows: [...byMethod.values()].map((r) => ({
          method: r.method,
          count: r.count,
          receiptsPaise: r.receiptsPaise.toString(),
          refundsPaise: r.refundsPaise.toString(),
          reversalsPaise: r.reversalsPaise.toString(),
          netPaise: (r.receiptsPaise - r.refundsPaise - r.reversalsPaise).toString(),
        })),
        pendingAttempts: pending.map((i) => ({ id: i._id, amountPaise: i.amountPaise, method: i.method, reference: i.reference, note: 'Pending — not counted as money received' })),
        totals: {
          confirmedReceiptsPaise: confirmedReceipts.toString(),
          refundsPaise: refundTotal.toString(),
          reversalsPaise: reversalTotal.toString(),
          netReceivedPaise: netReceived.toString(),
        },
      };
    }
    case 'gst':
    case 'gstr1': {
      const groups = new Map();
      for (const doc of invoices) {
        for (const g of doc.rateGroups) {
          const key = `${g.taxRateBps}|${doc.supplyMode}`;
          const row = groups.get(key) || { taxRateBps: g.taxRateBps, supplyMode: doc.supplyMode, taxableValuePaise: 0n, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 0n };
          row.taxableValuePaise += BigInt(g.taxableValuePaise);
          row.cgstPaise += BigInt(g.cgstPaise);
          row.sgstPaise += BigInt(g.sgstPaise);
          row.igstPaise += BigInt(g.igstPaise);
          groups.set(key, row);
        }
      }
      const rateRows = [...groups.values()].map((r) => ({
        taxRateBps: r.taxRateBps,
        supplyMode: r.supplyMode,
        taxableValuePaise: r.taxableValuePaise.toString(),
        cgstPaise: r.cgstPaise.toString(),
        sgstPaise: r.sgstPaise.toString(),
        igstPaise: r.igstPaise.toString(),
        taxPaise: (r.cgstPaise + r.sgstPaise + r.igstPaise).toString(),
      }));
      const register = invoices.map((d) => ({
        id: d._id,
        number: d.number,
        date: d.businessDate,
        docKind: d.docKind,
        party: d.partySnapshot?.name,
        gstin: d.partySnapshot?.gstin || null,
        placeOfSupply: d.placeOfSupplyStateCode,
        supplyMode: d.supplyMode,
        taxableValuePaise: d.totals.taxableValuePaise,
        cgstPaise: d.totals.cgstPaise,
        sgstPaise: d.totals.sgstPaise,
        igstPaise: d.totals.igstPaise,
        totalPaise: d.totals.totalPaise,
        b2b: Boolean(d.partySnapshot?.gstin),
      }));
      const adjustment = returns.map((r) => ({
        id: r._id,
        number: r.number,
        date: r.businessDate,
        source: r.sourceNumber,
        commercialCreditPaise: r.credit.commercialCreditPaise,
        gstAdjustmentPaise: r.credit.gstAdjustmentPaise,
        status: r.credit.gstAdjustmentStatus,
      }));
      return {
        ...base,
        label: tab === 'gstr1' ? TAB_LABELS.gstr1 : TAB_LABELS.gst,
        rateGroups: rateRows,
        register,
        creditNotes: adjustment,
        warning:
          'Working register / working papers only. Not a filed return, not portal JSON, and not proof of tax payment. Commercial credits and eligible GST adjustments are shown separately.',
        totals: {
          taxableValuePaise: invoices.reduce((a, d) => a + BigInt(d.totals.taxableValuePaise), 0n).toString(),
          cgstPaise: invoices.reduce((a, d) => a + BigInt(d.totals.cgstPaise), 0n).toString(),
          sgstPaise: invoices.reduce((a, d) => a + BigInt(d.totals.sgstPaise), 0n).toString(),
          igstPaise: invoices.reduce((a, d) => a + BigInt(d.totals.igstPaise), 0n).toString(),
          gstAdjustmentPaise: gstAdjustments.toString(),
        },
        b2bCount: register.filter((r) => r.b2b).length,
        b2cCount: register.filter((r) => !r.b2b).length,
      };
    }
    case 'gstr3b': {
      const outputTaxable = invoices.reduce((a, d) => a + BigInt(d.totals.taxableValuePaise), 0n);
      const outputTax = invoices.reduce((a, d) => a + BigInt(d.totals.cgstPaise) + BigInt(d.totals.sgstPaise) + BigInt(d.totals.igstPaise), 0n);
      const reviews = await repo(ctx, 'purchase_tax_reviews').find({});
      const purchaseIds = new Set(purchases.map((p) => p._id));
      const relevant = reviews.filter((r) => purchaseIds.has(r.purchaseId));
      const itc = relevant.reduce(
        (acc, r) => {
          const total = BigInt(r.components?.cgstPaise || '0') + BigInt(r.components?.sgstPaise || '0') + BigInt(r.components?.igstPaise || '0');
          if (r.status === 'eligible') acc.eligible += total;
          else if (r.status === 'ineligible') acc.ineligible += total;
          else acc.pending += total;
          return acc;
        },
        { eligible: 0n, ineligible: 0n, pending: 0n }
      );
      return {
        ...base,
        warning: 'Working papers only — not a filed GSTR-3B, not a tax computation, and not evidence of payment.',
        outward: {
          taxableValuePaise: outputTaxable.toString(),
          taxPaise: outputTax.toString(),
          creditsCommercialOnlyPaise: returns.filter((r) => r.credit.gstAdjustmentPaise === '0').reduce((a, r) => a + BigInt(r.credit.commercialCreditPaise), 0n).toString(),
          eligibleGstAdjustmentPaise: gstAdjustments.toString(),
        },
        inputTax: {
          eligiblePaise: itc.eligible.toString(),
          pendingReviewPaise: itc.pending.toString(),
          ineligiblePaise: itc.ineligible.toString(),
          note: 'Input tax starts pending review and is never auto-claimed.',
        },
      };
    }
    case 'stock': {
      const products = await repo(ctx, 'products').find({});
      const balances = await repo(ctx, 'stock_balances').find(branch);
      const batches = await repo(ctx, 'batch_lots').find({});
      const rows = [];
      for (const balance of balances) {
        const product = products.find((p) => p._id === balance.productId);
        const batch = batches.find((b) => b._id === balance.batchId);
        if (!product || !batch) continue;
        if (BigInt(balance.availableScaled) === 0n && BigInt(balance.nonSaleableScaled) === 0n) continue;
        const row = {
          productId: product._id,
          product: product.name,
          sku: product.sku,
          batchNo: batch.batchNo,
          expiry: expiryLabel(batch.expiry),
          daysToExpiry: daysUntilExpiry(batch.expiry, ctx.now()),
          status: batch.status,
          quantity: formatScaled(BigInt(balance.availableScaled), product.quantityScale),
          availableScaled: balance.availableScaled,
          nonSaleableScaled: balance.nonSaleableScaled,
          quantityScale: product.quantityScale,
          uom: product.uom,
        };
        if (canSeeCost && !quantityOnly) {
          const qty = BigInt(balance.availableScaled) + BigInt(balance.nonSaleableScaled || '0');
          row.valuePaise = mulDivRound(BigInt(batch.receivedCostPaise), qty, BigInt(batch.receivedScaled)).toString();
        }
        rows.push(row);
      }
      let totalValue = null;
      if (canSeeCost && !quantityOnly) {
        const valuation = await inventoryValuation(ctx);
        totalValue = valuation.totalPaise.toString();
      }
      return { ...base, rows, totalValuePaise: totalValue };
    }
    case 'receivables': {
      if (quantityOnly) throw forbidden('Receivables are a financial report and are not available in quantity-only mode');
      const docs = await repo(ctx, 'financial_documents').find({ kind: 'invoice' });
      const map = new Map();
      for (const doc of docs) {
        const key = doc.partyId || 'walk-in';
        const row = map.get(key) || {
          partyId: doc.partyId,
          party: doc.partySnapshot?.name || 'Walk-in customer',
          billedPaise: 0n,
          creditedPaise: 0n,
          receivedPaise: 0n,
          refundedPaise: 0n,
          debitNotesPaise: 0n,
        };
        row.billedPaise += BigInt(doc.totals.totalPaise);
        map.set(key, row);
      }
      const allReturns = await repo(ctx, 'returns').find({ status: 'issued' });
      for (const r of allReturns) {
        const key = r.partyId || 'walk-in';
        const row = map.get(key);
        if (row) row.creditedPaise += BigInt(r.credit.commercialCreditPaise);
      }
      const allDebits = await repo(ctx, 'debit_notes').find({ status: 'issued' });
      for (const d of allDebits) {
        const key = d.partyId || 'walk-in';
        const row = map.get(key);
        if (row) row.debitNotesPaise += BigInt(d.amountPaise);
      }
      const allPayments = await repo(ctx, 'payments').find({ status: 'confirmed' });
      for (const p of allPayments) {
        const key = p.partyId || 'walk-in';
        const row = map.get(key);
        if (!row) continue;
        if (p.kind === 'receipt') row.receivedPaise += BigInt(p.amountPaise);
        if (p.kind === 'refund') row.refundedPaise += BigInt(p.amountPaise);
        if (p.kind === 'receipt_reversal') row.receivedPaise -= BigInt(p.amountPaise);
      }
      const rows = [...map.values()].map((r) => {
        const net = r.billedPaise + r.debitNotesPaise - r.creditedPaise - r.receivedPaise + r.refundedPaise;
        return {
          partyId: r.partyId,
          party: r.party,
          billedPaise: r.billedPaise.toString(),
          creditedPaise: r.creditedPaise.toString(),
          receivedPaise: r.receivedPaise.toString(),
          refundedPaise: r.refundedPaise.toString(),
          duePaise: net > 0n ? net.toString() : '0',
          advancePaise: net < 0n ? (-net).toString() : '0',
        };
      });
      return { ...base, rows: rows.sort((a, b) => Number(BigInt(b.duePaise) - BigInt(a.duePaise))) };
    }
    case 'stocklog': {
      const movements = (await repo(ctx, 'inventory_movements').find({ ...branch })).filter((m) =>
        inInstantRange(m.at, period.from, period.to)
      );
      const products = await repo(ctx, 'products').find({});
      const batches = await repo(ctx, 'batch_lots').find({});
      const rows = movements
        .map((m) => {
          const product = products.find((p) => p._id === m.productId);
          const batch = batches.find((b) => b._id === m.batchId);
          const out = {
            at: m.at,
            type: m.type,
            product: product?.name || m.productId,
            batchNo: batch?.batchNo,
            quantity: formatScaled(BigInt(m.quantityScaled), m.quantityScale ?? product?.quantityScale ?? 3),
            sourceType: m.sourceType,
            sourceId: m.sourceId,
            reason: m.reason,
          };
          if (canSeeCost && !quantityOnly && m.costPaise) out.costPaise = m.costPaise;
          return out;
        })
        .sort((a, b) => new Date(b.at) - new Date(a.at));
      return { ...base, rows };
    }
    case 'returns': {
      return {
        ...base,
        rows: returns.map((r) => ({
          id: r._id,
          number: r.number,
          date: r.businessDate,
          source: r.sourceNumber,
          commercialCreditPaise: r.credit.commercialCreditPaise,
          gstAdjustmentPaise: r.credit.gstAdjustmentPaise,
          gstAdjustmentStatus: r.credit.gstAdjustmentStatus,
          restock: r.restock,
          reason: r.reason,
        })),
      };
    }
    case 'expiry': {
      const products = await repo(ctx, 'products').find({});
      const balances = await repo(ctx, 'stock_balances').find(branch);
      const batches = await repo(ctx, 'batch_lots').find({});
      const rows = [];
      for (const balance of balances) {
        if (BigInt(balance.availableScaled) + BigInt(balance.nonSaleableScaled || '0') === 0n) continue;
        const batch = batches.find((b) => b._id === balance.batchId);
        const product = products.find((p) => p._id === balance.productId);
        if (!batch || !product) continue;
        const days = daysUntilExpiry(batch.expiry, ctx.now());
        if (days === null || days > 90) continue;
        rows.push({
          product: product.name,
          batchNo: batch.batchNo,
          expiry: expiryLabel(batch.expiry),
          daysToExpiry: days,
          status: batch.status,
          quantity: formatScaled(BigInt(balance.availableScaled), product.quantityScale),
          uom: product.uom,
          expired: days < 0,
        });
      }
      return { ...base, rows: rows.sort((a, b) => a.daysToExpiry - b.daysToExpiry) };
    }
    case 'payables': {
      if (quantityOnly) throw forbidden('Payables is a financial report');
      const allPurchases = await repo(ctx, 'purchases').find({});
      const supplierReturns = await repo(ctx, 'supplier_returns').find({ status: 'posted' });
      const map = new Map();
      for (const p of allPurchases) {
        const row = map.get(p.supplierId) || { supplierId: p.supplierId, supplier: p.supplierSnapshot?.name, billedPaise: 0n, returnedPaise: 0n, paidPaise: 0n };
        row.billedPaise += BigInt(p.totals.totalPaise);
        if (p.payment?.amountPaise) row.paidPaise += BigInt(p.payment.amountPaise);
        map.set(p.supplierId, row);
      }
      for (const r of supplierReturns) {
        const row = map.get(r.supplierId);
        if (row) row.returnedPaise += BigInt(r.creditPaise);
      }
      const supplierPayments = await repo(ctx, 'payments').find({ kind: 'supplier_payment', status: 'confirmed' });
      for (const p of supplierPayments) {
        const row = map.get(p.partyId);
        if (row) row.paidPaise += BigInt(p.amountPaise);
      }
      return {
        ...base,
        rows: [...map.values()].map((r) => {
          const due = r.billedPaise - r.returnedPaise - r.paidPaise;
          return {
            supplierId: r.supplierId,
            supplier: r.supplier,
            billedPaise: r.billedPaise.toString(),
            returnedPaise: r.returnedPaise.toString(),
            paidPaise: r.paidPaise.toString(),
            duePaise: due > 0n ? due.toString() : '0',
          };
        }),
      };
    }
    case 'purchases': {
      return {
        ...base,
        rows: purchases.map((p) => ({
          id: p._id,
          number: p.number,
          supplierInvoiceNo: p.supplierInvoiceNo,
          supplierInvoiceDate: p.supplierInvoiceDate,
          supplierFy: p.supplierFy,
          supplier: p.supplierSnapshot?.name,
          taxableValuePaise: p.totals.taxableValuePaise,
          cgstPaise: p.totals.cgstPaise,
          sgstPaise: p.totals.sgstPaise,
          igstPaise: p.totals.igstPaise,
          totalPaise: p.totals.totalPaise,
          itcStatus: p.itcStatus,
        })),
        totals: {
          taxableValuePaise: purchases.reduce((a, p) => a + BigInt(p.totals.taxableValuePaise), 0n).toString(),
          totalPaise: purchases.reduce((a, p) => a + BigInt(p.totals.totalPaise), 0n).toString(),
        },
      };
    }
    case 'audit': {
      const events = await repo(ctx, 'audit_events').find({}, { sort: { at: -1 }, limit: 500 });
      return {
        ...base,
        rows: events.map((e) => ({
          at: e.at,
          sequence: e.sequence,
          action: e.action,
          actor: e.actorName,
          entityType: e.entityType,
          entityId: e.entityId,
          reason: e.reason,
        })),
      };
    }
    case 'trial_balance': {
      const { trialBalance } = await import('./accounting.js');
      const tb = await trialBalance(ctx, { from: period.fromDate, to: period.toDate });
      return { ...base, rows: tb.rows, totals: { debitPaise: tb.totalDebitPaise, creditPaise: tb.totalCreditPaise, balanced: tb.balanced } };
    }
    default:
      throw unprocessable('unsupported report');
  }
}

/** Permission-scoped CSV. Quantity-only roles never receive money columns. */
export function toCsv(report) {
  const moneyColumns = new Set([
    'taxableValuePaise', 'taxPaise', 'grossPaise', 'costPaise', 'marginPaise', 'valuePaise', 'totalValuePaise',
    'cgstPaise', 'sgstPaise', 'igstPaise', 'commercialCreditPaise', 'gstAdjustmentPaise', 'receiptsPaise',
    'refundsPaise', 'reversalsPaise', 'netPaise', 'confirmedReceiptsPaise', 'grossBilledPaise', 'billedPaise',
    'creditedPaise', 'receivedPaise', 'refundedPaise', 'duePaise', 'advancePaise', 'amountPaise',
  ]);
  const rows = report.rows || report.register || [];
  if (!rows.length) return 'no rows\n';
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    .filter((c) => !(report.quantityOnly && moneyColumns.has(c)))
    .filter((c) => !/Paise$/.test(c) || !report.quantityOnly);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

