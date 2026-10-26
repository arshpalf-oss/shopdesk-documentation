/**
 * Customer returns, credit notes and price-correction debit notes.
 *
 * Entitlement model (engineering pack §8): every component of a line is allocated
 * cumulatively from the ORIGINAL saved amounts:
 *
 *   allocated(cumQty) = round(originalComponent × cumQty / originalQty)
 *   newComponent      = allocated(cumQty) − previouslyAllocatedComponent
 *
 * Current catalogue prices/rates never affect an old return. A full return
 * therefore reconciles exactly to the original line. Restock defaults to false;
 * commercial credit and eligible GST adjustment are separate values.
 */

import { conflict, forbidden, legalGate, notFound, unprocessable } from '../errors.js';
import { canonicalHash, newId } from '../ids.js';
import { allocateProportional, mulDivRound, toPaise, formatINR } from '../money.js';
import { businessDate, financialYear, financialYearRange, istDateStart } from '../time.js';
import { getTenantRecord, repo, requireTenantDoc } from '../tenancy/repo.js';
import { appendAudit } from './audit.js';
import { checkOperation, recordOperation, requireIdempotencyKey } from './idempotency.js';
import { postReturn } from './accounting.js';
import { applyToBalance, recordMovement } from './inventory.js';
import { nextNumber } from './numbering.js';
import { enqueue } from './outbox.js';
import { hasPermission } from '../auth/permissions.js';

function componentKeys() {
  return ['taxableValuePaise', 'cgstPaise', 'sgstPaise', 'igstPaise'];
}

async function priorAllocations(ctx, documentId) {
  return repo(ctx, 'return_allocations').find({ originalDocumentId: documentId });
}

/**
 * Compute remaining entitlement and the credit for requested quantities.
 * Pure calculation against saved original lines — no catalogue reads.
 */
export async function buildReturnPreview(ctx, documentId, requested = []) {
  const document = await requireTenantDoc(ctx, 'financial_documents', documentId, 'invoice');
  if (document.kind !== 'invoice') throw unprocessable('only an issued invoice can be returned');
  const allocations = await repo(ctx, 'invoice_allocations').find({ documentId });
  const prior = await priorAllocations(ctx, documentId);

  const lines = document.lines.map((line, index) => {
    const lineAllocations = allocations.filter((a) => a.documentLineId === line.lineId);
    const priorForLine = prior.filter((p) => p.documentLineId === line.lineId);
    const returnedQty = priorForLine.reduce((a, p) => a + BigInt(p.quantityScaled), 0n);
    const remaining = BigInt(line.quantityScaled) - returnedQty;
    const requirement = requested.find((r) => r.lineId === line.lineId);
    const requestQty = requirement ? BigInt(requirement.quantityScaled || '0') : 0n;
    const prev = {};
    for (const key of componentKeys()) {
      prev[key] = priorForLine.reduce((a, p) => a + BigInt(p[key] || '0'), 0n);
    }
    const cum = returnedQty + requestQty;
    const capped = cum > BigInt(line.quantityScaled) ? BigInt(line.quantityScaled) : cum;
    const credit = {};
    for (const key of componentKeys()) {
      const allocated = mulDivRound(BigInt(line[key]), capped, BigInt(line.quantityScaled));
      credit[key] = allocated - prev[key];
    }
    const commercial = componentKeys().reduce((a, k) => a + credit[k], 0n);
    // Incremental cost base for THIS return: cumulative cost at the new
    // cumulative quantity minus cumulative cost already consumed by earlier
    // returns (restocked or not). This prevents restoring cost twice and makes
    // the sum of all returns reconcile to the original line cost.
    const cumCost = mulDivRound(BigInt(line.costPaise || '0'), capped, BigInt(line.quantityScaled));
    const priorCost = mulDivRound(BigInt(line.costPaise || '0'), returnedQty, BigInt(line.quantityScaled));
    const costEntitlement = cumCost - priorCost;

    return {
      lineId: line.lineId,
      index: index + 1,
      productId: line.productId,
      name: line.product?.name,
      hsn: line.product?.hsn,
      uom: line.uom,
      quantityScale: line.quantityScale,
      originalQuantityScaled: line.quantityScaled,
      returnedQuantityScaled: returnedQty.toString(),
      remainingQuantityScaled: remaining.toString(),
      requestedQuantityScaled: requestQty.toString(),
      original: {
        taxableValuePaise: line.taxableValuePaise,
        cgstPaise: line.cgstPaise,
        sgstPaise: line.sgstPaise,
        igstPaise: line.igstPaise,
        lineTotalPaise: line.lineTotalPaise,
      },
      previouslyCreditedPaise: Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v.toString()])),
      credit: {
        ...Object.fromEntries(Object.entries(credit).map(([k, v]) => [k, v.toString()])),
        commercialCreditPaise: commercial.toString(),
        taxPaise: (credit.cgstPaise + credit.sgstPaise + credit.igstPaise).toString(),
      },
      costEntitlementPaise: costEntitlement.toString(),
      batches: lineAllocations.map((a) => {
        const used = prior.filter((p) => p.originalAllocationId === a._id).reduce((x, p) => x + BigInt(p.quantityScaled), 0n);
        return {
          allocationId: a._id,
          batchId: a.batchId,
          quantityScale: a.quantityScale,
          soldQuantityScaled: a.quantityScaled,
          returnedQuantityScaled: used.toString(),
          remainingQuantityScaled: (BigInt(a.quantityScaled) - used).toString(),
          costPaise: a.costPaise,
        };
      }),
      restockable:
        line.product?.kind !== 'service' &&
        remaining > 0n &&
        lineAllocations.some((a) => BigInt(a.quantityScaled) > prior.filter((p) => p.originalAllocationId === a._id).reduce((x, p) => x + BigInt(p.quantityScaled), 0n)),
    };
  });

  const totalCredit = lines.reduce((a, l) => a + BigInt(l.credit.commercialCreditPaise), 0n);
  const eligible = await gstEligibility(ctx, document);
  return {
    document: {
      id: document._id,
      number: document.number,
      issuedAt: document.issuedAt,
      businessDate: document.businessDate,
      fy: document.fy,
      totals: document.totals,
      party: document.partySnapshot,
    },
    lines,
    previewTotalCreditPaise: totalCredit.toString(),
    gstEligibility: eligible,
    defaults: { restock: false, reason: '', condition: 'unopened' },
  };
}

/**
 * Section 34 style cut-off: 30 November following the supply financial year, or
 * the relevant annual return filing date, whichever is earlier. The app only
 * knows a recorded annual-return date; unknown is treated conservatively.
 */
export async function gstEligibility(ctx, document) {
  const registration = await requireTenantDoc(ctx, 'tax_registrations', document.registrationId, 'registration');
  if (registration.profile !== 'regular') {
    return { eligible: false, status: 'not_applicable', reason: 'This registration does not charge GST.' };
  }
  const fy = document.fy;
  const startYear = Number(String(fy).slice(0, 4));
  const cutoff = istDateStart(`${startYear + 2}-11-30`);
  const today = ctx.now();
  const tenant = await getTenantRecord(ctx);
  const annualFiled = tenant?.gstAnnualReturnFiledAt ? new Date(tenant.gstAnnualReturnFiledAt) : null;
  const deadline = annualFiled && annualFiled.getTime() < cutoff.getTime() ? annualFiled : cutoff;
  if (today.getTime() > deadline.getTime()) {
    return {
      eligible: false,
      status: 'ineligible_after_cutoff',
      reason: `The credit-note declaration cut-off for FY ${fy} has passed (${deadline.toISOString().slice(0, 10)}). A commercial customer credit is still recorded, but output GST is not reduced without a reviewed late-note process.`,
    };
  }
  return {
    eligible: true,
    status: 'eligible',
    deadline: deadline.toISOString().slice(0, 10),
    reason: 'Within the recorded section 34 cut-off; output GST reduction is eligible subject to the actual facts and recipient ITC conditions.',
  };
}

function allocateReturnQuantity(line, previewLine, allocations) {
  const need = BigInt(previewLine.requestedQuantityScaled);
  const distribution = [];
  let remaining = need;
  for (const allocation of allocations) {
    if (remaining <= 0n) break;
    const used = previewLine.batches.find((b) => b.allocationId === allocation._id)?.returnedQuantityScaled || '0';
    const capacity = BigInt(allocation.quantityScaled) - BigInt(used);
    if (capacity <= 0n) continue;
    const take = capacity < remaining ? capacity : remaining;
    distribution.push({ allocation, quantityScaled: take });
    remaining -= take;
  }
  if (remaining > 0n) throw unprocessable('return quantity exceeds the original batch allocations');
  return distribution;
}

export async function createReturn(ctx, documentId, input, { idempotencyKey } = {}) {
  if (!hasPermission(ctx.permissions, 'returns.create')) throw forbidden('Return/credit-note permission is required');
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'returns.create';
  const hash = canonicalHash({ documentId, ...input });
  const store = ctx.store;
  const document = await requireTenantDoc(ctx, 'financial_documents', documentId, 'invoice');
  if (!input.reason || String(input.reason).trim().length < 5) throw unprocessable('a return reason is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw unprocessable('select at least one line to return');

  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };
    const fresh = await repo(ctx, 'financial_documents').findOne({ _id: documentId });
    if (!fresh) throw notFound('invoice not found');

    const preview = await buildReturnPreview(ctx, documentId, input.lines);
    const selected = preview.lines.filter((l) => BigInt(l.requestedQuantityScaled) > 0n);
    if (selected.length === 0) throw unprocessable('selected return quantities are zero');
    let anyRestock = false;
    let restockCost = 0n;

    for (const line of selected) {
      const request = input.lines.find((r) => r.lineId === line.lineId);
      if (!request) continue;
      if (BigInt(line.requestedQuantityScaled) > BigInt(line.remainingQuantityScaled)) {
        throw conflict(
          `return quantity for ${line.name} exceeds the remaining entitlement (${line.remainingQuantityScaled} scaled units)`,
          'RETURN_EXCEEDS_ENTITLEMENT'
        );
      }
      if (request.restock) {
        anyRestock = true;
        if (!hasPermission(ctx.permissions, 'returns.restock')) {
          throw forbidden('Restock permission is required to return goods to saleable stock');
        }
        if (!line.restockable) throw unprocessable(`${line.name} cannot be restocked (service or no eligible original batch)`);
        if (String(request.condition || input.condition || '').toLowerCase() !== 'resaleable') {
          throw legalGate(
            `Restock for ${line.name} requires condition "resaleable". Damaged, opened, expired, cold-chain-unverified or recalled goods cannot become saleable stock.`,
            { code: 'RESTOCK_CONDITION' }
          );
        }
      }
      const allocations = await repo(ctx, 'invoice_allocations').find({ documentId, documentLineId: line.lineId });
      line._distribution = allocateReturnQuantity(line, line, allocations);
      line._restore = Boolean(request.restock);
    }

    // Decide GST adjustment vs commercial-only credit.
    const eligibility = await gstEligibility(ctx, fresh);
    let gstAdjustmentStatus = eligibility.status;
    let gstEligible = eligibility.eligible;
    if (input.gstAdjustment === false && gstEligible) {
      gstEligible = false;
      gstAdjustmentStatus = 'commercial_only';
    }
    if (input.gstOverride?.reason && hasPermission(ctx.permissions, 'returns.gst.override')) {
      if (!input.gstOverride.evidence) throw unprocessable('a GST-adjustment override needs evidence recorded');
      gstEligible = true;
      gstAdjustmentStatus = 'overridden';
    }

    const credit = {
      taxableValuePaise: selected.reduce((a, l) => a + BigInt(l.credit.taxableValuePaise), 0n),
      cgstPaise: gstEligible ? selected.reduce((a, l) => a + BigInt(l.credit.cgstPaise), 0n) : 0n,
      sgstPaise: gstEligible ? selected.reduce((a, l) => a + BigInt(l.credit.sgstPaise), 0n) : 0n,
      igstPaise: gstEligible ? selected.reduce((a, l) => a + BigInt(l.credit.igstPaise), 0n) : 0n,
    };
    const commercialCredit =
      gstEligible
        ? credit.taxableValuePaise + credit.cgstPaise + credit.sgstPaise + credit.igstPaise
        : selected.reduce((a, l) => a + BigInt(l.credit.commercialCreditPaise), 0n);
    const gstAdjustment = gstEligible ? credit.cgstPaise + credit.sgstPaise + credit.igstPaise : 0n;

    const registration = await requireTenantDoc(ctx, 'tax_registrations', fresh.registrationId, 'registration');
    const seriesConfig = registration.series?.find((s) => s.docKind === 'credit_note');
    ctx.fyLabel = financialYear(ctx.now());
    const numberInfo = seriesConfig
      ? await nextNumber(ctx, {
          registrationId: registration._id,
          series: seriesConfig.series,
          padding: seriesConfig.padding,
          businessDate: businessDate(ctx.now()),
        })
      : { number: `CN-${newId().slice(0, 8).toUpperCase()}`, fy: ctx.fyLabel };

    const returnId = newId();
    const returnDoc = {
      _id: returnId,
      kind: 'credit_note',
      docKind: 'credit_note',
      number: numberInfo.number,
      fy: numberInfo.fy,
      registrationId: registration._id,
      branchId: fresh.branchId,
      sourceDocumentId: fresh._id,
      sourceNumber: fresh.number,
      partyId: fresh.partyId,
      partySnapshot: fresh.partySnapshot,
      reason: String(input.reason).slice(0, 300),
      condition: input.condition || 'unopened',
      disposition: anyRestock ? 'restocked' : (input.disposition || 'returned_to_customer'),
      restock: anyRestock,
      restoredCostPaise: restockCost.toString(),
      credit: {
        ...Object.fromEntries(Object.entries(credit).map(([k, v]) => [k, v.toString()])),
        commercialCreditPaise: commercialCredit.toString(),
        gstAdjustmentPaise: gstAdjustment.toString(),
        gstAdjustmentStatus,
        gstAdjustmentEvidence: input.gstOverride?.evidence || eligibility.reason,
        originalTaxReferencePaise: selected.reduce((a, l) => a + BigInt(l.credit.taxPaise), 0n).toString(),
        lines: selected.map((l) => ({
          lineId: l.lineId,
          quantityScaled: l.requestedQuantityScaled,
          quantityScale: l.quantityScale,
          originalQuantityScaled: l.originalQuantityScaled,
          credit: l.credit,
          restock: Boolean(input.lines.find((r) => r.lineId === l.lineId)?.restock),
        })),
      },
      issuedAt: ctx.now(),
      businessDate: businessDate(ctx.now()),
      issuedBy: ctx.userId,
      issuedByName: ctx.actorName || ctx.userName,
      status: 'issued',
      policy: 'cumulative-original-component-allocation',
    };
    await repo(ctx, 'returns').insertOne(returnDoc);

    for (const line of selected) {
      const weights = line._distribution.map((d) => BigInt(d.quantityScaled));
      const shareTaxable = allocateProportional(BigInt(line.credit.taxableValuePaise), weights);
      const shareCgst = allocateProportional(BigInt(line.credit.cgstPaise), weights);
      const shareSgst = allocateProportional(BigInt(line.credit.sgstPaise), weights);
      const shareIgst = allocateProportional(BigInt(line.credit.igstPaise), weights);
      const shareCommercial = allocateProportional(BigInt(line.credit.commercialCreditPaise), weights);
      const shareCost = line._restore
        ? allocateProportional(BigInt(line.costEntitlementPaise), weights)
        : weights.map(() => 0n);
      for (const [i, dist] of line._distribution.entries()) {
        const restoredCost = shareCost[i];
        restockCost += restoredCost;
        await repo(ctx, 'return_allocations').insertOne({
          _id: newId(),
          returnId,
          originalDocumentId: fresh._id,
          originalDocumentLineId: line.lineId,
          originalAllocationId: dist.allocation._id,
          documentLineId: line.lineId,
          batchId: dist.allocation.batchId,
          quantityScale: line.quantityScale,
          quantityScaled: dist.quantityScaled.toString(),
          taxableValuePaise: shareTaxable[i].toString(),
          cgstPaise: shareCgst[i].toString(),
          sgstPaise: shareSgst[i].toString(),
          igstPaise: shareIgst[i].toString(),
          commercialCreditPaise: shareCommercial[i].toString(),
          restoredCostPaise: restoredCost.toString(),
          restock: line._restore,
        });
        if (line._restore) {
          const balance = await repo(ctx, 'stock_balances').findOne({ batchId: dist.allocation.batchId });
          if (!balance) throw unprocessable('original batch balance no longer exists');
          const batch = await repo(ctx, 'batch_lots').findOne({ _id: dist.allocation.batchId });
          if (!batch || batch.status !== 'saleable') {
            throw legalGate(
              'The original batch is not saleable (quarantined/recalled/expired). Record custody differently — do not restock it.',
              { code: 'BATCH_NOT_SALEABLE' }
            );
          }
          await applyToBalance(ctx, {
            balanceId: balance._id,
            field: 'availableScaled',
            deltaScaled: dist.quantityScaled.toString(),
          });
          await recordMovement(ctx, {
            branchId: fresh.branchId,
            productId: dist.allocation.productId,
            batchId: dist.allocation.batchId,
            type: 'sale_return_restock',
            quantityScaled: dist.quantityScaled.toString(),
            quantityScale: line.quantityScale,
            sourceType: 'credit_note',
            sourceId: returnId,
            costPaise: restoredCost,
            reason: returnDoc.reason,
          });
        } else {
          await repo(ctx, 'return_dispositions').insertOne({
            _id: newId(),
            returnId,
            allocationId: dist.allocation._id,
            productId: dist.allocation.productId,
            quantityScaled: dist.quantityScaled.toString(),
            quantityScale: line.quantityScale,
            custody: input.disposition || 'quarantine',
            reason: returnDoc.reason,
            at: ctx.now(),
            by: ctx.userId,
          });
        }
      }
    }

    if (restockCost !== BigInt(returnDoc.restoredCostPaise || '0')) {
      await repo(ctx, 'returns').updateOne({ _id: returnId }, { $set: { restoredCostPaise: restockCost.toString() } });
      returnDoc.restoredCostPaise = restockCost.toString();
    }
    await postReturn(ctx, { ret: { ...returnDoc, restoredCostPaise: restockCost.toString() }, businessDate: returnDoc.businessDate, branchId: fresh.branchId });
    await appendAudit(ctx, {
      action: 'credit_note.issued',
      entityType: 'credit_note',
      entityId: returnId,
      branchId: fresh.branchId,
      reason: returnDoc.reason,
      after: {
        number: returnDoc.number,
        sourceNumber: fresh.number,
        commercialCreditPaise: commercialCredit.toString(),
        gstAdjustmentPaise: gstAdjustment.toString(),
        gstAdjustmentStatus,
        restock: anyRestock,
      },
    });
    await enqueue(ctx, { eventKey: `document-artifact:${returnId}`, type: 'document.artifact', payload: { documentId: returnId }, sourceId: returnId });

    const result = {
      returnId,
      number: returnDoc.number,
      commercialCreditPaise: commercialCredit.toString(),
      gstAdjustmentPaise: gstAdjustment.toString(),
      gstAdjustmentStatus,
      restocked: anyRestock,
    };
    await recordOperation(ctx, { action, key, hash, result });
    return { replayed: false, ...result };
  });
}

/**
 * Authorised undercharge / price-correction debit note.
 * No stock movement, separate number, linked to the original document.
 */
export async function createDebitNote(ctx, documentId, input, { idempotencyKey } = {}) {
  if (!hasPermission(ctx.permissions, 'accounts.post')) throw forbidden('Debit-note posting requires the accounting permission');
  const key = requireIdempotencyKey(idempotencyKey);
  const action = 'debit_note.create';
  const hash = canonicalHash({ documentId, ...input });
  const store = ctx.store;
  const document = await requireTenantDoc(ctx, 'financial_documents', documentId, 'invoice');
  if (!input.reason || String(input.reason).trim().length < 8) throw unprocessable('a specific reason is required for a debit note');
  const taxable = toPaise(input.taxableValuePaise, 'taxable value');
  const cgst = toPaise(input.cgstPaise || '0', 'CGST');
  const sgst = toPaise(input.sgstPaise || '0', 'SGST');
  const igst = toPaise(input.igstPaise || '0', 'IGST');
  if (taxable <= 0n) throw unprocessable('debit-note taxable value must be greater than zero');
  if (cgst !== sgst && igst === 0n) throw unprocessable('intra-state CGST and SGST must be equal');
  if (igst > 0n && (cgst > 0n || sgst > 0n)) throw unprocessable('IGST cannot be combined with CGST/SGST');

  return store.transaction(async () => {
    const existing = await checkOperation(ctx, { action, key, hash });
    if (existing) return { replayed: true, ...existing.result };
    const registration = await requireTenantDoc(ctx, 'tax_registrations', document.registrationId, 'registration');
    const seriesConfig = registration.series?.find((s) => s.docKind === 'debit_note');
    ctx.fyLabel = financialYear(ctx.now());
    const numberInfo = seriesConfig
      ? await nextNumber(ctx, {
          registrationId: registration._id,
          series: seriesConfig.series,
          padding: seriesConfig.padding,
          businessDate: businessDate(ctx.now()),
        })
      : { number: `DN-${newId().slice(0, 8).toUpperCase()}`, fy: ctx.fyLabel };
    const total = taxable + cgst + sgst + igst;
    const debitId = newId();
    const debitNote = {
      _id: debitId,
      kind: 'debit_note',
      docKind: 'debit_note',
      number: numberInfo.number,
      fy: numberInfo.fy,
      registrationId: document.registrationId,
      branchId: document.branchId,
      sourceDocumentId: document._id,
      sourceNumber: document.number,
      partyId: document.partyId,
      partySnapshot: document.partySnapshot,
      reason: String(input.reason).slice(0, 300),
      taxableValuePaise: taxable.toString(),
      cgstPaise: cgst.toString(),
      sgstPaise: sgst.toString(),
      igstPaise: igst.toString(),
      amountPaise: total.toString(),
      issuedAt: ctx.now(),
      businessDate: businessDate(ctx.now()),
      issuedBy: ctx.userId,
      status: 'issued',
      stockEffect: 'none',
    };
    await repo(ctx, 'debit_notes').insertOne(debitNote);
    const { postJournal } = await import('./accounting.js');
    const { ACC } = await import('./chart.js');
    await postJournal(ctx, {
      sourceEventId: debitId,
      postingKind: 'debit_note',
      businessDate: debitNote.businessDate,
      narration: `Debit note ${debitNote.number} — ${debitNote.reason}`,
      documentId: document._id,
      branchId: document.branchId,
      lines: [
        { accountCode: ACC.RECEIVABLE, partyId: document.partyId, partyType: 'customer', debitPaise: total.toString(), creditPaise: '0' },
        { accountCode: ACC.SALES_GOODS, debitPaise: '0', creditPaise: taxable.toString() },
        ...(cgst > 0n ? [{ accountCode: ACC.OUTPUT_CGST, debitPaise: '0', creditPaise: cgst.toString() }] : []),
        ...(sgst > 0n ? [{ accountCode: ACC.OUTPUT_SGST, debitPaise: '0', creditPaise: sgst.toString() }] : []),
        ...(igst > 0n ? [{ accountCode: ACC.OUTPUT_IGST, debitPaise: '0', creditPaise: igst.toString() }] : []),
      ],
    });
    await appendAudit(ctx, {
      action: 'debit_note.issued',
      entityType: 'debit_note',
      entityId: debitId,
      branchId: document.branchId,
      reason: debitNote.reason,
      after: { number: debitNote.number, amountPaise: total.toString() },
    });
    const result = { debitNoteId: debitId, number: debitNote.number, amountPaise: total.toString() };
    await recordOperation(ctx, { action, key, hash, result });
    return { replayed: false, ...result };
  });
}

export async function listReturns(ctx, { limit = 100 } = {}) {
  return repo(ctx, 'returns').find({}, { sort: { issuedAt: -1 }, limit: Math.min(Number(limit) || 100, 500) });
}

export async function getReturn(ctx, returnId) {
  const ret = await repo(ctx, 'returns').findOne({ _id: returnId });
  if (!ret) throw notFound('credit note not found');
  const allocations = await repo(ctx, 'return_allocations').find({ returnId });
  const dispositions = await repo(ctx, 'return_dispositions').find({ returnId });
  return { return: ret, allocations, dispositions };
}

export { financialYearRange, formatINR };
