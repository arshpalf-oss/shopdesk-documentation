/**
 * Masters: products, customers, suppliers and basic pet identifiers.
 *
 * This module deliberately does not model clinical charts, diagnoses or
 * prescription authoring (excluded scope). Pets exist only as billing
 * identifiers. Products cannot be sold until their tax classification has been
 * explicitly reviewed by an authorised person — a regex match is not a
 * classification.
 */

import { unprocessable } from '../errors.js';
import { newId } from '../ids.js';
import { toPaise } from '../money.js';
import { repo, requireTenantDoc } from '../tenancy/repo.js';
import { TREATMENTS } from './tax.js';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const STATE_CODES = new Set([
  '01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20',
  '21','22','23','24','26','27','29','30','31','32','33','34','35','36','37','38','97',
]);

export function validateGstin(gstin) {
  if (!gstin) return null;
  const value = String(gstin).trim().toUpperCase();
  if (!GSTIN_RE.test(value)) throw unprocessable('GSTIN format is invalid (syntactic check only, not official verification)');
  if (!STATE_CODES.has(value.slice(0, 2))) throw unprocessable('GSTIN state code is not recognised');
  return value;
}

export function normaliseCode(value) {
  const text = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  return text.length ? text : null;
}

export const UOMS = ['unit', 'strip', 'tablet', 'bottle', 'ml', 'gm', 'kg', 'ltr', 'vial', 'sachet', 'box', 'pack', 'service'];

export async function createProduct(ctx, input) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw unprocessable('product name is required');
  const kind = input.kind === 'service' ? 'service' : 'goods';
  const quantityScale = input.quantityScale === undefined ? (kind === 'service' ? 0 : 3) : Number(input.quantityScale);
  if (!Number.isInteger(quantityScale) || quantityScale < 0 || quantityScale > 6) {
    throw unprocessable('quantityScale must be an integer 0–6');
  }
  const taxTreatment = TREATMENTS.includes(input.taxTreatment) ? input.taxTreatment : 'taxable';
  const taxRateBps = String(input.taxRateBps ?? '0');
  if (!/^\d+$/.test(taxRateBps) || BigInt(taxRateBps) > 10000n) {
    throw unprocessable('tax rate must be integer basis points between 0 and 10000');
  }
  if (taxTreatment !== 'taxable' && BigInt(taxRateBps) !== 0n) {
    throw unprocessable(`${taxTreatment} products must have a zero GST rate`);
  }
  if (taxTreatment === 'taxable' && BigInt(taxRateBps) === 0n) {
    throw unprocessable('a taxable product needs a rate; use nil_rated/exempt for zero-rated treatments');
  }
  const hsn = input.hsn ? String(input.hsn).trim() : null;
  if (hsn && !/^\d{4}(\d{2})?(\d{2})?$/.test(hsn)) {
    throw unprocessable('HSN/SAC must be 4, 6 or 8 digits');
  }
  const salePrice = toPaise(input.salePricePaise, 'sale price');
  if (salePrice < 0n) throw unprocessable('sale price must not be negative');
  const schedule = input.schedule ? String(input.schedule).toUpperCase() : null;
  if (schedule && !['H', 'H1', 'X', 'NDPS'].includes(schedule)) throw unprocessable('unknown drug schedule');

  const doc = {
    _id: newId(),
    name,
    kind,
    category: input.category ? String(input.category).trim() : 'General',
    sku: input.sku ? String(input.sku).trim() : null,
    skuNormalised: normaliseCode(input.sku),
    barcode: input.barcode ? String(input.barcode).trim() : null,
    barcodeNormalised: normaliseCode(input.barcode),
    uom: UOMS.includes(input.uom) ? input.uom : (kind === 'service' ? 'service' : 'unit'),
    quantityScale,
    salePricePaise: salePrice.toString(),
    priceMode: input.priceMode === 'inclusive' ? 'inclusive' : 'exclusive',
    taxTreatment,
    taxRateBps,
    hsn,
    manufacturer: input.manufacturer ? String(input.manufacturer).trim() : null,
    batchRequired: kind === 'service' ? false : input.batchRequired !== false,
    expiryRequired: kind === 'service' ? false : input.expiryRequired !== false,
    mrpPaise: input.mrpPaise ? toPaise(input.mrpPaise, 'MRP').toString() : null,
    restrictions: {
      prescriptionRequired: Boolean(input.prescriptionRequired),
      schedule,
      blocked: Boolean(input.restrictions?.blocked) || ['H1', 'X', 'NDPS'].includes(schedule),
      blockReason: input.restrictions?.blockReason || (['H1', 'X', 'NDPS'].includes(schedule)
        ? 'Restricted medicine: blocked until a reviewed licence, external prescription and register process is approved.'
        : null),
    },
    classificationReviewed: false,
    classificationEvidence: null,
    status: 'active',
    createdAt: ctx.now ? ctx.now() : new Date(),
    createdBy: ctx.userId,
  };
  await repo(ctx, 'products').insertOne(doc);
  return doc;
}

export async function updateProduct(ctx, productId, input) {
  const product = await requireTenantDoc(ctx, 'products', productId, 'product');
  const patch = {};
  if (input.name !== undefined) patch.name = String(input.name).trim();
  if (input.category !== undefined) patch.category = String(input.category).trim();
  if (input.sku !== undefined) {
    patch.sku = input.sku ? String(input.sku).trim() : null;
    patch.skuNormalised = normaliseCode(input.sku);
  }
  if (input.barcode !== undefined) {
    patch.barcode = input.barcode ? String(input.barcode).trim() : null;
    patch.barcodeNormalised = normaliseCode(input.barcode);
  }
  if (input.salePricePaise !== undefined) {
    const next = toPaise(input.salePricePaise, 'sale price');
    if (next < 0n) throw unprocessable('sale price must not be negative');
    patch.salePricePaise = next.toString();
  }
  if (input.mrpPaise !== undefined) patch.mrpPaise = input.mrpPaise ? toPaise(input.mrpPaise, 'MRP').toString() : null;
  if (input.priceMode !== undefined) patch.priceMode = input.priceMode === 'inclusive' ? 'inclusive' : 'exclusive';
  if (input.taxRateBps !== undefined) {
    const rate = String(input.taxRateBps);
    if (!/^\d+$/.test(rate) || BigInt(rate) > 10000n) throw unprocessable('invalid tax rate');
    patch.taxRateBps = rate;
  }
  if (input.taxTreatment !== undefined) {
    if (!TREATMENTS.includes(input.taxTreatment)) throw unprocessable('invalid tax treatment');
    patch.taxTreatment = input.taxTreatment;
  }
  if (input.hsn !== undefined) {
    if (input.hsn && !/^\d{4}(\d{2})?(\d{2})?$/.test(String(input.hsn))) throw unprocessable('HSN/SAC must be 4, 6 or 8 digits');
    patch.hsn = input.hsn ? String(input.hsn).trim() : null;
  }
  if (input.batchRequired !== undefined) patch.batchRequired = Boolean(input.batchRequired);
  if (input.expiryRequired !== undefined) patch.expiryRequired = Boolean(input.expiryRequired);
  if (input.description !== undefined) patch.description = String(input.description).slice(0, 2000);
  if (Object.keys(patch).length === 0) throw unprocessable('no supported fields to update');
  if (patch.taxRateBps !== undefined && patch.taxTreatment === undefined) {
    patch.taxTreatment = 'taxable';
    patch.classificationReviewed = false; // a rate change needs re-review
  }
  if (patch.taxRateBps || patch.hsn !== undefined || patch.taxTreatment) {
    patch.classificationReviewed = input.classificationReviewed === true;
    patch.classificationEvidence = input.classificationEvidence || null;
  }
  patch.updatedAt = ctx.now ? ctx.now() : new Date();
  patch.updatedBy = ctx.userId;

  // Effective-dated price/tax history: originals keep their snapshot.
  const changesMoney = ['salePricePaise', 'taxRateBps', 'taxTreatment', 'priceMode', 'hsn'].some((k) => k in patch);
  if (changesMoney) {
    await repo(ctx, 'product_tax_versions').insertOne({
      _id: newId(),
      productId,
      effectiveFrom: ctx.now ? ctx.now() : new Date(),
      previous: {
        salePricePaise: product.salePricePaise,
        taxRateBps: product.taxRateBps,
        taxTreatment: product.taxTreatment,
        priceMode: product.priceMode,
        hsn: product.hsn,
      },
      next: {
        salePricePaise: patch.salePricePaise ?? product.salePricePaise,
        taxRateBps: patch.taxRateBps ?? product.taxRateBps,
        taxTreatment: patch.taxTreatment ?? product.taxTreatment,
        priceMode: patch.priceMode ?? product.priceMode,
        hsn: patch.hsn ?? product.hsn,
      },
      actorId: ctx.userId,
    });
  }
  await repo(ctx, 'products').updateOne({ _id: productId }, { $set: patch });
  return { ...product, ...patch };
}

export async function reviewClassification(ctx, productId, { evidence, hsn, taxRateBps, taxTreatment }) {
  if (!evidence || String(evidence).trim().length < 8) {
    throw unprocessable('record the review evidence (who/what approved this classification)');
  }
  const product = await requireTenantDoc(ctx, 'products', productId, 'product');
  const patch = {
    classificationReviewed: true,
    classificationEvidence: String(evidence).trim().slice(0, 1000),
    classificationReviewedBy: ctx.userId,
    classificationReviewedAt: ctx.now ? ctx.now() : new Date(),
  };
  if (hsn !== undefined) {
    if (!/^\d{4}(\d{2})?(\d{2})?$/.test(String(hsn))) throw unprocessable('HSN/SAC must be 4, 6 or 8 digits');
    patch.hsn = String(hsn);
  }
  if (taxRateBps !== undefined) {
    if (!/^\d+$/.test(String(taxRateBps)) || BigInt(taxRateBps) > 10000n) throw unprocessable('invalid rate');
    patch.taxRateBps = String(taxRateBps);
  }
  if (taxTreatment !== undefined) {
    if (!TREATMENTS.includes(taxTreatment)) throw unprocessable('invalid treatment');
    patch.taxTreatment = taxTreatment;
  }
  await repo(ctx, 'product_tax_versions').insertOne({
    _id: newId(),
    productId,
    effectiveFrom: ctx.now ? ctx.now() : new Date(),
    previous: { hsn: product.hsn, taxRateBps: product.taxRateBps, taxTreatment: product.taxTreatment },
    next: { hsn: patch.hsn ?? product.hsn, taxRateBps: patch.taxRateBps ?? product.taxRateBps, taxTreatment: patch.taxTreatment ?? product.taxTreatment },
    actorId: ctx.userId,
    evidence: patch.classificationEvidence,
  });
  await repo(ctx, 'products').updateOne({ _id: productId }, { $set: patch });
  return { ...product, ...patch };
}

export async function archiveProduct(ctx, productId, reason) {
  if (!reason) throw unprocessable('an archive reason is required');
  const product = await requireTenantDoc(ctx, 'products', productId, 'product');
  await repo(ctx, 'products').updateOne(
    { _id: productId },
    { $set: { status: 'archived', archivedAt: ctx.now ? ctx.now() : new Date(), archiveReason: String(reason).slice(0, 500) } }
  );
  return { ...product, status: 'archived' };
}

/* ------------------------------------------------------------------ parties */

export async function createCustomer(ctx, input) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw unprocessable('customer name is required');
  const doc = {
    _id: newId(),
    name,
    nameLower: name.toLowerCase(),
    phone: input.phone ? String(input.phone).trim().slice(0, 20) : null,
    email: input.email ? String(input.email).trim().slice(0, 200) : null,
    gstin: input.gstin ? validateGstin(input.gstin) : null,
    stateCode: input.stateCode ? String(input.stateCode).padStart(2, '0').slice(-2) : null,
    billingStateCode: input.stateCode ? String(input.stateCode).padStart(2, '0').slice(-2) : null,
    address: input.address ? String(input.address).slice(0, 500) : null,
    type: input.type === 'business' ? 'business' : 'individual',
    notes: input.notes ? String(input.notes).slice(0, 500) : null,
    status: 'active',
    createdAt: ctx.now ? ctx.now() : new Date(),
  };
  await repo(ctx, 'customers').insertOne(doc);
  return doc;
}

export async function updateCustomer(ctx, customerId, input) {
  await requireTenantDoc(ctx, 'customers', customerId, 'customer');
  const patch = {};
  for (const field of ['name', 'phone', 'email', 'address', 'notes']) {
    if (input[field] !== undefined) patch[field] = input[field] ? String(input[field]).slice(0, 500) : null;
  }
  if (input.name !== undefined) patch.nameLower = String(input.name).toLowerCase();
  if (input.gstin !== undefined) patch.gstin = input.gstin ? validateGstin(input.gstin) : null;
  if (input.stateCode !== undefined) {
    patch.stateCode = input.stateCode ? String(input.stateCode).padStart(2, '0').slice(-2) : null;
    patch.billingStateCode = patch.stateCode;
  }
  if (Object.keys(patch).length === 0) throw unprocessable('no supported fields to update');
  patch.updatedAt = ctx.now ? ctx.now() : new Date();
  await repo(ctx, 'customers').updateOne({ _id: customerId }, { $set: patch });
  return repo(ctx, 'customers').findOne({ _id: customerId });
}

export async function createSupplier(ctx, input) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw unprocessable('supplier name is required');
  const doc = {
    _id: newId(),
    name,
    nameLower: name.toLowerCase(),
    phone: input.phone ? String(input.phone).slice(0, 20) : null,
    gstin: input.gstin ? validateGstin(input.gstin) : null,
    stateCode: input.stateCode ? String(input.stateCode).padStart(2, '0').slice(-2) : null,
    address: input.address ? String(input.address).slice(0, 500) : null,
    drugLicenceNo: input.drugLicenceNo ? String(input.drugLicenceNo).slice(0, 100) : null,
    status: 'active',
    createdAt: ctx.now ? ctx.now() : new Date(),
  };
  await repo(ctx, 'suppliers').insertOne(doc);
  return doc;
}

export async function createPet(ctx, input) {
  const name = String(input.name || '').trim();
  if (name.length < 1) throw unprocessable('pet name is required');
  if (!input.customerId) throw unprocessable('pet must belong to a customer');
  await requireTenantDoc(ctx, 'customers', input.customerId, 'customer');
  const doc = {
    _id: newId(),
    customerId: input.customerId,
    name,
    species: input.species ? String(input.species).slice(0, 60) : null,
    breed: input.breed ? String(input.breed).slice(0, 60) : null,
    birthYear: input.birthYear ? Number(input.birthYear) : null,
    sex: input.sex ? String(input.sex).slice(0, 20) : null,
    status: 'active',
    createdAt: ctx.now ? ctx.now() : new Date(),
  };
  await repo(ctx, 'pets').insertOne(doc);
  return doc;
}

export function publicProduct(product) {
  return {
    id: product._id,
    name: product.name,
    kind: product.kind,
    category: product.category,
    sku: product.sku,
    barcode: product.barcode,
    uom: product.uom,
    quantityScale: product.quantityScale,
    salePricePaise: product.salePricePaise,
    priceMode: product.priceMode,
    taxTreatment: product.taxTreatment,
    taxRateBps: product.taxRateBps,
    hsn: product.hsn,
    manufacturer: product.manufacturer,
    batchRequired: product.batchRequired,
    expiryRequired: product.expiryRequired,
    mrpPaise: product.mrpPaise,
    restrictions: product.restrictions,
    classificationReviewed: product.classificationReviewed,
    classificationEvidence: product.classificationEvidence,
    status: product.status,
  };
}
