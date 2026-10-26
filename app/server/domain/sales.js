/**
 * Billing: versioned drafts, backend-only quotes, atomic idempotent finalization
 * and immutable issued documents.
 *
 * Finalization runs in ONE transaction: idempotency identity, stock allocation,
 * legal number reservation, document snapshot, batch/cost allocations,
 * inventory movements, balanced journals, audit event, outbox job and the
 * durable idempotency result. Any failure leaves no partial committed sale.
 */

import { badRequest, conflict, forbidden, legalGate, notFound, unprocessable } from '../errors.js';
import { canonicalHash, newId } from '../ids.js';
import { formatINR, formatScaled, mulDivRound, toPaise } from '../money.js';
import { businessDate, financialYear } from '../time.js';
import { assertBranch, repo, requireTenantDoc } from '../tenancy/repo.js';
import { assertCanIssue, registrationReadiness } from './settings.js';
import { appendAudit } from './audit.js';
import { checkOperation, isExpectedIdempotencyConflict, recordOperation, requireIdempotencyKey } from './idempotency.js';
import { computeQuote } from './tax.js';
import { allocateCostFromBatch, applyToBalance, planFefo, recordMovement } from './inventory.js';
import { nextNumber } from './numbering.js';
import { postReceipt, postSale } from './accounting.js';
import { enqueue } from './outbox.js';
import { PAYMENT_METHODS } from './chart.js';
import { hasPermission } from '../auth/permissions.js';
import { assertCashLimit } from './payments.js';

const MAX_LINES = 200;

function productSnapshot(product) {
  return {
    name: product.name,
    sku: product.sku,
    hsn: product.hsn,
    uom: product.uom,
    manufacturer: product.manufacturer,
    quantityScale: product.quantityScale,
    taxRateBps: product.taxRateBps,
    taxTreatment: product.taxTreatment,
    priceMode: product.priceMode,
    mrpPaise: product.mrpPaise || null,
    schedule: product.restrictions?.schedule || null,
    prescriptionRequired: Boolean(product.restrictions?.prescriptionRequired),
  };
}

async function loadLines(ctx, lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw unprocessable('add at least one product to the bill');
  if (lines.length > MAX_LINES) throw unprocessable(`a bill may contain at most ${MAX_LINES} lines`);
  const prepared = [];
  for (const [index, line] of lines.entries()) {
    const product = await repo(ctx, 'products').findOne({ _id: line.productId });
    if (!product) throw notFound(`line ${index + 1}: product not found`);
    if (product.status !== 'active') throw unprocessable(`line ${index + 1}: ${product.name} is archived`);
    const quantity = String(line.quantityScaled ?? '');
    if (!/^-?\d+$/.test(quantity)) throw unprocessable(`line ${index + 1}: quantityScaled must be an integer string`);
    prepared.push({
      product,
      quantityScaled: quantity,
      discountPaise: line.discountPaise ? toPaise(line.discountPaise, `line ${index + 1} discount`).toString() : '0',
      unitPricePaise: line.unitPricePaise
        ? toPaise(line.unitPricePaise, `line ${index + 1} price`).toString()
        : product.salePricePaise,
      externalPrescriptionRef: line.externalPrescriptionRef || null,
    });
  }
  return prepared;
}

function quoteInputLines(prepared) {
  return prepared.map(({ product, quantityScaled, discountPaise, unitPricePaise, externalPrescriptionRef }) => ({
    productId: product._id,
    name: product.name,
    sku: product.sku,
    hsn: product.hsn,
    uom: product.uom,
    kind: product.kind,
    category: product.category,
    quantityScale: product.quantityScale,
    quantityScaled,
    priceMode: product.priceMode,
    unitPricePaise,
    discountPaise,
    taxRateBps: product.taxRateBps,
    taxTreatment: product.taxTreatment,
    batchRequired: product.batchRequired,
    expiryRequired: product.expiryRequired,
    externalPrescriptionRef,
    schedule: product.restrictions?.schedule || null,
  }));
}

async function lineGates(ctx, prepared, { registration }) {
  const blockers = [];
  for (const [i, { product, externalPrescriptionRef }] of prepared.entries()) {
    const label = `Line ${i + 1} (${product.name})`;
    if (!product.classificationReviewed) {
      blockers.push({
        code: 'CLASSIFICATION_UNREVIEWED',
        line: i + 1,
        message: `${label}: tax classification has not been reviewed. Record HSN/rate evidence in Products before selling.`,
      });
    }
    if (registration?.profile === 'regular' && !product.hsn) {
      blockers.push({ code: 'HSN_MISSING', line: i + 1, message: `${label}: HSN/SAC is required on a GST tax invoice.` });
    }
    if (product.restrictions?.blocked) {
      blockers.push({
        code: 'RESTRICTED_MEDICINE_BLOCKED',
        line: i + 1,
        message: `${label}: ${product.restrictions.blockReason || 'restricted medicine — blocked pending a reviewed licence and register process'}`,
      });
      continue;
    }
    if (product.restrictions?.prescriptionRequired) {
      const licence = registration?.drugLicence;
      const licenceOk =
        licence?.status === 'verified' &&
        licence?.number &&
        (!licence.expiresOn || licence.expiresOn >= businessDate());
      if (!licenceOk) {
        blockers.push({
          code: 'DRUG_LICENCE_REQUIRED',
          line: i + 1,
          message: `${label}: a verified, unexpired drug sale licence must be recorded in Settings before dispensing this product.`,
        });
      }
      if (!externalPrescriptionRef) {
        blockers.push({
          code: 'EXTERNAL_PRESCRIPTION_REF_REQUIRED',
          line: i + 1,
          message: `${label}: record the external prescription/order reference. This product does not author prescriptions.`,
        });
      }
    }
  }
  return blockers;
}

async function buildQuote(ctx, draft) {
  const branch = await requireTenantDoc(ctx, 'branches', draft.branchId, 'branch');
  assertBranch(ctx, draft.branchId);
  const registration = await requireTenantDoc(ctx, 'tax_registrations', draft.registrationId, 'GST registration');
  const customer = draft.customerId ? await requireTenantDoc(ctx, 'customers', draft.customerId, 'customer') : null;
  const prepared = await loadLines(ctx, draft.lines);
  const quote = computeQuote({
    lines: quoteInputLines(prepared),
    registration,
    customer,
    deliveryStateCode: draft.deliveryStateCode || customer?.stateCode || null,
    invoiceDiscountPaise: draft.invoiceDiscountPaise || '0',
    policy: { equalHalvesPolicy: draft.policy?.equalHalvesPolicy },
  });

  const blockers = [];
  const issues = await registrationReadiness(ctx, registration);
  blockers.push(...issues.filter((i) => i.severity === 'blocker'));
  blockers.push(...quote.blocks);
  blockers.push(...(await lineGates(ctx, prepared, { registration })));
  if (!draft.customerId) {
    // Walk-in is allowed for supported counter sales, but a GSTIN/B2B invoice needs a recipient.
    if (quote.totals.totalPaise !== '0' && customer === null) {
      blockers.push({
        code: 'RECIPIENT_NOT_REQUIRED_WALKIN',
        severity: 'info',
        message: 'Walk-in sale: no customer is attached, so the document is recorded as an unregistered counter sale.',
      });
    }
  }

  // Quantity availability (never reserved by a quote).
  const availability = [];
  const availableMap = new Map();
  for (const [i, { product, quantityScaled, discountPaise, unitPricePaise }] of prepared.entries()) {
    if (product.kind === 'service') continue;
    const balances = await repo(ctx, 'stock_balances').find({ branchId: draft.branchId, productId: product._id });
    const eligible = [];
    let totalAvailable = 0n;
    for (const balance of balances) {
      if (BigInt(balance.availableScaled) <= 0n) continue;
      const batch = await repo(ctx, 'batch_lots').findOne({ _id: balance.batchId });
      if (!batch || batch.status !== 'saleable') continue;
      totalAvailable += BigInt(balance.availableScaled);
      eligible.push({ batchId: batch._id, batchNo: batch.batchNo, expiry: batch.expiry, availableScaled: balance.availableScaled });
    }
    availableMap.set(product._id, totalAvailable);
    const needed = BigInt(quantityScaled);
    if (totalAvailable < needed) {
      blockers.push({
        code: 'INSUFFICIENT_STOCK',
        line: i + 1,
        message: `Line ${i + 1} (${product.name}): ${formatScaled(totalAvailable, product.quantityScale)} available in eligible batches, ${formatScaled(needed, product.quantityScale)} requested.`,
      });
    }
    availability.push({
      line: i + 1,
      productId: product._id,
      availableScaled: totalAvailable.toString(),
      quantityScale: product.quantityScale,
      batches: eligible.map((b) => ({
        batchId: b.batchId,
        batchNo: b.batchNo,
        expiry: b.expiry,
        availableScaled: b.availableScaled,
      })),
    });
  }

  const quoteHash = canonicalHash({
    draftId: draft._id,
    version: draft.version,
    lines: quote.lines.map((l) => [l.productId, l.quantityScaled, l.unitPricePaise, l.discountPaise, l.taxRateBps]),
    totals: quote.totals,
    invoiceDiscountPaise: draft.invoiceDiscountPaise || '0',
    registrationId: registration._id,
    customerId: draft.customerId || null,
    deliveryStateCode: draft.deliveryStateCode || null,
    docKind: quote.docKind,
  });

  return { quote, blockers, availability, quoteHash, branch, registration, customer, prepared };
}

/* ------------------------------------------------------------------ drafts */

export async function createDraft(ctx, input) {
  const branchId = input.branchId || ctx.branchId;
  assertBranch(ctx, branchId);
  const branch = await requireTenantDoc(ctx, 'branches', branchId, 'branch');
  const registration = input.registrationId
    ? await requireTenantDoc(ctx, 'tax_registrations', input.registrationId, 'GST registration')
    : (await repo(ctx, 'tax_registrations').find({}))[0];
  if (!registration) throw unprocessable('configure a GST registration before billing');
  if (Array.isArray(registration.branchIds) && !registration.branchIds.includes(branchId)) {
    throw unprocessable('this registration does not cover the selected branch');
  }
  if (input.customerId) await requireTenantDoc(ctx, 'customers', input.customerId, 'customer');
  if (input.petId) await requireTenantDoc(ctx, 'pets', input.petId, 'pet');
  const prepared = await loadLines(ctx, input.lines);
  const draft = {
    _id: newId(),
    branchId,
    registrationId: registration._id,
    cashierId: ctx.userId,
    cashierName: ctx.actorName || ctx.userName,
    customerId: input.customerId || null,
    petId: input.petId || null,
    deliveryStateCode: input.deliveryStateCode ? String(input.deliveryStateCode).slice(0, 2) : null,
    invoiceDiscountPaise: input.invoiceDiscountPaise ? toPaise(input.invoiceDiscountPaise, 'invoice discount').toString() : '0',
    notes: input.notes ? String(input.notes).slice(0, 500) : null,
    lines: prepared.map(({ product, quantityScaled, discountPaise, unitPricePaise, externalPrescriptionRef }) => ({
      productId: product._id,
      quantityScaled,
      discountPaise,
      unitPricePaise,
      externalPrescriptionRef,
    })),
    status: 'draft',
    version: 1,
    documentId: null,
    createdAt: ctx.now ? ctx.now() : new Date(),
    updatedAt: ctx.now ? ctx.now() : new Date(),
  };
  await repo(ctx, 'sales_drafts').insertOne(draft);
  return { draft, ...(await buildQuote(ctx, draft)) };
}

export async function updateDraft(ctx, draftId, input) {
  const draft = await requireTenantDoc(ctx, 'sales_drafts', draftId, 'draft');
  if (draft.status !== 'draft') throw conflict('only an open draft can be edited', 'DRAFT_NOT_OPEN');
  if (draft.cashierId !== ctx.userId && !hasPermission(ctx.permissions, 'returns.create')) {
    throw forbidden('You can only edit your own drafts');
  }
  if (input.version !== undefined && Number(input.version) !== draft.version) {
    throw conflict('This draft changed in another window. Reload before editing.', 'DRAFT_VERSION_CONFLICT');
  }
  const patch = { version: draft.version + 1, updatedAt: ctx.now ? ctx.now() : new Date() };
  if (input.lines) {
    const prepared = await loadLines(ctx, input.lines);
    patch.lines = prepared.map(({ product, quantityScaled, discountPaise, unitPricePaise, externalPrescriptionRef }) => ({
      productId: product._id,
      quantityScaled,
      discountPaise,
      unitPricePaise,
      externalPrescriptionRef,
    }));
  }
  if (input.customerId !== undefined) {
    if (input.customerId) await requireTenantDoc(ctx, 'customers', input.customerId, 'customer');
    patch.customerId = input.customerId || null;
  }
  if (input.petId !== undefined) {
    if (input.petId) await requireTenantDoc(ctx, 'pets', input.petId, 'pet');
    patch.petId = input.petId || null;
  }
  if (input.invoiceDiscountPaise !== undefined) {
    patch.invoiceDiscountPaise = toPaise(input.invoiceDiscountPaise, 'invoice discount').toString();
  }
  if (input.deliveryStateCode !== undefined) {
    patch.deliveryStateCode = input.deliveryStateCode ? String(input.deliveryStateCode).slice(0, 2) : null;
  }
  if (input.notes !== undefined) patch.notes = String(input.notes).slice(0, 500);
  const updated = await repo(ctx, 'sales_drafts').updateOne({ _id: draftId, version: draft.version }, { $set: patch });
  if (updated.modifiedCount !== 1) throw conflict('This draft changed concurrently; reload and retry.', 'DRAFT_VERSION_CONFLICT');
  const fresh = await repo(ctx, 'sales_drafts').findOne({ _id: draftId });
  return { draft: fresh, ...(await buildQuote(ctx, fresh)) };
}

export async function quoteDraft(ctx, draftId) {
  const draft = await requireTenantDoc(ctx, 'sales_drafts', draftId, 'draft');
  return buildQuote(ctx, draft);
}

export async function discardDraft(ctx, draftId, reason) {
  const draft = await requireTenantDoc(ctx, 'sales_drafts', draftId, 'draft');
  if (draft.status !== 'draft') throw conflict('only an open draft can be discarded', 'DRAFT_NOT_OPEN');
  await repo(ctx, 'sales_drafts').updateOne(
    { _id: draftId, status: 'draft' },
    { $set: { status: 'discarded', discardedAt: ctx.now ? ctx.now() : new Date(), discardReason: String(reason || 'not provided').slice(0, 300) } }
  );
  await appendAudit(ctx, {
    action: 'draft.discarded',
    entityType: 'sales_draft',
    entityId: draftId,
    reason: reason || null,
    before: { status: 'draft', version: draft.version },
    after: { status: 'discarded' },
  });
  return { discarded: true };
}

/* --------------------------------------------------------------- finalize */

function validatePayment(payment, totalPaise) {
  if (!payment) return null;
  if (!PAYMENT_METHODS.includes(payment.method)) throw unprocessable('unsupported payment method');
  const amount = toPaise(payment.amountPaise ?? totalPaise, 'payment amount');
  if (amount <= 0n) throw unprocessable('payment amount must be greater than zero');
  if (amount > BigInt(totalPaise)) {
    throw unprocessable('payment exceeds the invoice total. Record a confirmed partial receipt instead of an overpayment.');
  }
  return {
    method: payment.method,
    amountPaise: amount.toString(),
    reference: payment.reference ? String(payment.reference).slice(0, 100) : null,
  };
}

export async function finalizeDraft(ctx, draftId, input, { idempotencyKey } = {}) {
  const key = requireIdempotencyKey(idempotencyKey);
  const hash = canonicalHash({
    draftId,
    version: input.version,
    quoteHash: input.quoteHash,
    payment: input.payment || null,
  });
  const action = 'sales.finalize';
  const store = ctx.store;

  try {
    return await store.transaction(async () => {
      const existing = await checkOperation(ctx, { action, key, hash });
      if (existing) return { replayed: true, ...existing.result };

      const draft = await repo(ctx, 'sales_drafts').findOne({ _id: draftId });
      if (!draft) throw notFound('draft not found');
      if (draft.status === 'issued' && draft.documentId) {
        const doc = await repo(ctx, 'financial_documents').findOne({ _id: draft.documentId });
        return {
          replayed: true,
          documentId: doc._id,
          number: doc.number,
          totals: doc.totals,
          warning: 'This draft was already issued; the original document is returned.',
        };
      }
      if (draft.status !== 'draft') throw conflict('this draft is not open for issue', 'DRAFT_NOT_OPEN');
      if (Number(input.version) !== draft.version) {
        throw conflict('This bill changed in another window. Review the updated quote before issuing.', 'DRAFT_VERSION_CONFLICT');
      }
      if (draft.cashierId !== ctx.userId && !hasPermission(ctx.permissions, 'billing.use')) {
        throw forbidden('You are not permitted to issue this draft');
      }

      const { quote, blockers, registration, customer, prepared, branch } = await buildQuote(ctx, draft);
      const hardBlockers = blockers.filter((b) => b.code !== 'RECIPIENT_NOT_REQUIRED_WALKIN');
      if (hardBlockers.length) {
        const code = hardBlockers.some((b) => b.code === 'INSUFFICIENT_STOCK') ? 'INSUFFICIENT_STOCK' : 'BILL_BLOCKED';
        throw legalGate('This bill cannot be issued yet. Resolve the listed issues.', { blockers: hardBlockers, code });
      }
      if (input.quoteHash && input.quoteHash !== canonicalHash({
        draftId: draft._id,
        version: draft.version,
        lines: quote.lines.map((l) => [l.productId, l.quantityScaled, l.unitPricePaise, l.discountPaise, l.taxRateBps]),
        totals: quote.totals,
        invoiceDiscountPaise: draft.invoiceDiscountPaise || '0',
        registrationId: registration._id,
        customerId: draft.customerId || null,
        deliveryStateCode: draft.deliveryStateCode || null,
        docKind: quote.docKind,
      })) {
        throw conflict('Prices, tax or stock changed since the quote was shown. Review the new total before issuing.', 'QUOTE_CHANGED');
      }

      const seriesConfig = await assertCanIssue(ctx, { registration, docKind: quote.docKind, lines: quote.lines });
      const payment = validatePayment(input.payment, quote.totals.totalPaise);
      if (payment) {
        await assertCashLimit(ctx, {
          method: payment.method,
          amountPaise: payment.amountPaise,
          partyId: draft.customerId,
          branchId: draft.branchId,
          businessDate: businessDate(ctx.now()),
        });
      }

      ctx.fyLabel = financialYear(ctx.now());
      const numberInfo = await nextNumber(ctx, {
        registrationId: registration._id,
        series: seriesConfig.series,
        padding: seriesConfig.padding,
        businessDate: businessDate(ctx.now()),
      });

      // FEFO allocation and conditional stock consumption.
      const allocationsForDocument = [];
      const lineCosts = [];
      for (const line of quote.lines) {
        const product = prepared.find((p) => p.product._id === line.productId).product;
        if (product.kind === 'service') {
          lineCosts.push(0n);
          allocationsForDocument.push([]);
          continue;
        }
        const plans = await planFefo(ctx, {
          branchId: draft.branchId,
          product,
          quantityScaled: line.quantityScaled,
          now: ctx.now(),
        });
        const lineAllocations = [];
        let lineCost = 0n;
        for (const plan of plans) {
          const cost = allocateCostFromBatch(plan.batch, plan.quantityScaled);
          await applyToBalance(ctx, {
            balanceId: plan.balance._id,
            field: 'availableScaled',
            deltaScaled: `-${plan.quantityScaled}`,
          });
          const allocationId = newId();
          lineAllocations.push({
            allocationId,
            batchId: plan.batchId,
            batchNo: plan.batchNo,
            expiry: plan.expiry,
            expiryLabel: plan.expiryLabel,
            quantityScaled: plan.quantityScaled,
            costPaise: cost.toString(),
          });
          lineCost += cost;
        }
        lineCosts.push(lineCost);
        allocationsForDocument.push(lineAllocations);
      }

      const documentId = newId();
      const issuedAt = ctx.now();
      const bDate = businessDate(issuedAt);
      const customerSnapshot = customer
        ? {
            id: customer._id,
            name: customer.name,
            gstin: customer.gstin,
            stateCode: customer.stateCode,
            address: customer.address,
            phone: customer.phone,
          }
        : { id: null, name: 'Walk-in customer', gstin: null, stateCode: draft.deliveryStateCode || null, address: null, phone: null };
      const pet = draft.petId ? await repo(ctx, 'pets').findOne({ _id: draft.petId }) : null;
      const lines = quote.lines.map((line, i) => {
        const product = prepared.find((p) => p.product._id === line.productId).product;
        return {
          lineId: newId(),
          productId: line.productId,
          product: productSnapshot(product),
          quantityScale: line.quantityScale,
          quantityScaled: line.quantityScaled,
          quantity: line.quantity,
          uom: line.uom,
          unitPricePaise: line.unitPricePaise,
          priceMode: line.priceMode,
          grossPaise: line.grossPaise,
          discountPaise: line.discountPaise,
          taxableValuePaise: line.taxableValuePaise,
          taxRateBps: line.taxRateBps,
          taxTreatment: line.taxTreatment,
          taxPaise: line.taxPaise,
          cgstPaise: line.cgstPaise,
          sgstPaise: line.sgstPaise,
          igstPaise: line.igstPaise,
          lineTotalPaise: line.lineTotalPaise,
          costPaise: lineCosts[i].toString(),
          externalPrescriptionRef: line.externalPrescriptionRef,
          batchAllocations: allocationsForDocument[i],
        };
      });

      const document = {
        _id: documentId,
        kind: 'invoice',
        docKind: quote.docKind,
        number: numberInfo.number,
        fy: numberInfo.fy,
        series: numberInfo.series,
        registrationId: registration._id,
        branchId: draft.branchId,
        partyId: draft.customerId || null,
        partySnapshot: customerSnapshot,
        petSnapshot: pet ? { id: pet._id, name: pet.name, species: pet.species, breed: pet.breed, sex: pet.sex } : null,
        cashierId: ctx.userId,
        cashierName: ctx.actorName || ctx.userName,
        sourceDraftId: draft._id,
        issuedAt,
        businessDate: bDate,
        placeOfSupplyStateCode: quote.supplyMode === 'intra' ? registration.stateCode : (draft.deliveryStateCode || customer?.stateCode || null),
        supplyMode: quote.supplyMode,
        lines,
        totals: quote.totals,
        rateGroups: quote.rateGroups,
        policy: quote.policy,
        templateVersion: registration.invoiceSettings?.templateVersion || 'A4-2026.10',
        supplierSnapshot: {
          legalName: registration.legalName,
          tradeName: registration.tradeName,
          gstin: registration.gstin,
          stateCode: registration.stateCode,
          address: registration.address,
          profile: registration.profile,
        },
        placeOfSupplyLabel: quote.supplyMode === 'inter' ? 'Inter-state (IGST)' : quote.supplyMode === 'intra' ? 'Intra-state (CGST + SGST)' : 'No GST',
        declaration: registration.invoiceSettings?.declaration || null,
        terms: registration.invoiceSettings?.terms || null,
        notes: draft.notes || null,
        roundOffPaise: quote.totals.roundOffPaise,
        status: 'issued',
        createdBy: ctx.userId,
        requestId: ctx.requestId || null,
      };
      await repo(ctx, 'financial_documents').insertOne(document);

      for (const line of lines) {
        for (const allocation of line.batchAllocations) {
          await repo(ctx, 'invoice_allocations').insertOne({
            _id: allocation.allocationId,
            documentId,
            documentLineId: line.lineId,
            batchId: allocation.batchId,
            productId: line.productId,
            quantityScale: line.quantityScale,
            quantityScaled: allocation.quantityScaled,
            costPaise: allocation.costPaise,
          });
          await recordMovement(ctx, {
            branchId: draft.branchId,
            productId: line.productId,
            batchId: allocation.batchId,
            type: 'sale',
            quantityScaled: `-${allocation.quantityScaled}`,
            quantityScale: line.quantityScale,
            sourceType: 'invoice',
            sourceId: documentId,
            costPaise: allocation.costPaise,
          });
        }
      }

      await postSale(ctx, { document, branchId: draft.branchId, businessDate: bDate });

      let receipt = null;
      if (payment) {
        receipt = {
          _id: newId(),
          kind: 'receipt',
          number: `RC/${numberInfo.fy.slice(2)}/${String(Date.now()).slice(-6)}`,
          partyId: draft.customerId || null,
          partyName: customerSnapshot.name,
          branchId: draft.branchId,
          documentId,
          amountPaise: payment.amountPaise,
          method: payment.method,
          reference: payment.reference,
          status: 'confirmed',
          businessDate: bDate,
          at: issuedAt,
          recordedBy: ctx.userId,
          idempotencyKey: `${key}:receipt`,
        };
        await repo(ctx, 'payments').insertOne(receipt);
        await repo(ctx, 'payment_allocations').insertOne({
          _id: newId(),
          paymentId: receipt._id,
          documentId,
          amountPaise: payment.amountPaise,
          partyId: draft.customerId || null,
        });
        await postReceipt(ctx, { payment: receipt, businessDate: bDate, branchId: draft.branchId });
      }

      await repo(ctx, 'sales_drafts').updateOne(
        { _id: draft._id, version: draft.version },
        { $set: { status: 'issued', documentId, issuedAt, version: draft.version + 1 } }
      );

      await appendAudit(ctx, {
        action: 'invoice.issued',
        entityType: 'invoice',
        entityId: documentId,
        branchId: draft.branchId,
        after: {
          number: document.number,
          docKind: document.docKind,
          totalPaise: document.totals.totalPaise,
          party: customerSnapshot.name,
          lineCount: lines.length,
          batchAllocations: lines.reduce((a, l) => a + l.batchAllocations.length, 0),
        },
        meta: { draftId: draft._id, requestId: ctx.requestId },
      });
      await enqueue(ctx, {
        eventKey: `document-artifact:${documentId}`,
        type: 'document.artifact',
        payload: { documentId },
        sourceId: documentId,
      });

      const result = {
        documentId,
        number: document.number,
        docKind: document.docKind,
        totals: document.totals,
        issuedAt: issuedAt.toISOString(),
        receiptId: receipt?._id || null,
        warnings: [],
      };
      await recordOperation(ctx, { action, key, hash, result });
      return { replayed: false, ...result };
    });
  } catch (err) {
    if (isExpectedIdempotencyConflict(err)) {
      // A concurrent identical request committed first; resolve the same identity.
      const { lookupOperation } = await import('./idempotency.js');
      const rows = await lookupOperation(ctx, { key, action });
      if (rows.length && rows[0].payloadHash === hash) return { replayed: true, ...rows[0].result };
      throw conflict('This operation is already in progress. Check its status before retrying.', 'OPERATION_IN_PROGRESS');
    }
    throw err;
  }
}

/* ---------------------------------------------------- documents/settlement */

export async function getDocument(ctx, documentId) {
  const document = await requireTenantDoc(ctx, 'financial_documents', documentId, 'document');
  const settlement = await settlementFor(ctx, document);
  return { document, settlement };
}

export async function settlementFor(ctx, document) {
  const receipts = await repo(ctx, 'payments').find({ documentId: document._id, kind: 'receipt', status: 'confirmed' });
  const refunds = await repo(ctx, 'payments').find({ documentId: document._id, kind: 'refund', status: 'confirmed' });
  const reversals = await repo(ctx, 'payments').find({ documentId: document._id, kind: 'receipt_reversal', status: 'confirmed' });
  const returns = await repo(ctx, 'returns').find({ sourceDocumentId: document._id, status: 'issued' });
  const debitNotes = await repo(ctx, 'debit_notes').find({ sourceDocumentId: document._id, status: 'issued' });
  const credit = returns.reduce((a, r) => a + BigInt(r.credit.commercialCreditPaise), 0n);
  const debits = debitNotes.reduce((a, d) => a + BigInt(d.amountPaise), 0n);
  const received = receipts.reduce((a, r) => a + BigInt(r.amountPaise), 0n);
  const refunded = refunds.reduce((a, r) => a + BigInt(r.amountPaise), 0n);
  const reversalTotal = reversals.reduce((a, r) => a + BigInt(r.amountPaise), 0n);
  const netBilled = BigInt(document.totals.totalPaise) + debits - credit;
  const netReceived = received - refunded - reversalTotal;
  const due = netBilled > netReceived ? netBilled - netReceived : 0n;
  const refundable = netReceived > netBilled ? netReceived - netBilled : 0n;
  return {
    netBilledPaise: netBilled.toString(),
    creditPaise: credit.toString(),
    debitNotesPaise: debits.toString(),
    confirmedReceiptsPaise: received.toString(),
    refundsPaise: refunded.toString(),
    receiptReversalsPaise: reversalTotal.toString(),
    netReceivedPaise: netReceived.toString(),
    duePaise: due.toString(),
    refundablePaise: refundable.toString(),
    asOf: (ctx.now ? ctx.now() : new Date()).toISOString(),
  };
}

export async function listDocuments(ctx, { kind = 'invoice', from, to, partyId, limit = 100 } = {}) {
  const filter = { kind };
  if (partyId) filter.partyId = partyId;
  if (from || to) {
    filter.issuedAt = {};
    if (from) filter.issuedAt.$gte = from;
    if (to) filter.issuedAt.$lt = to;
  }
  const docs = await repo(ctx, 'financial_documents').find(filter, { sort: { issuedAt: -1 }, limit: Math.min(Number(limit) || 100, 500) });
  return docs;
}
