#!/usr/bin/env node
/**
 * Demo seed — explicitly opt-in.
 *
 * New workspaces always start EMPTY. This script is the only thing that creates
 * sample products, parties, batches and bills, and it marks the tenant
 * `sample: true` so the UI can label every screen as demonstration data.
 *
 * Usage:  SHOPDESK_DATA_DIR=./data-demo npm run demo:seed
 *         npm run demo:seed -- --force     (wipes an existing demo database)
 */
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '../server/store/file-store.js';
import { loadConfig } from '../server/config.js';
import { createTenant } from '../server/domain/onboarding.js';
import { createCustomer, createPet, createProduct, createSupplier, reviewClassification } from '../server/domain/catalog.js';
import { updateRegistration } from '../server/domain/settings.js';
import { postPurchase } from '../server/domain/purchases.js';
import { createDraft, finalizeDraft, getDocument } from '../server/domain/sales.js';
import { buildReturnPreview, createReturn } from '../server/domain/returns.js';
import { recordReceipt, cashClose } from '../server/domain/payments.js';
import { hashPassword } from '../server/auth/passwords.js';
import { ROLES } from '../server/auth/permissions.js';
import { newId } from '../server/ids.js';

const force = process.argv.includes('--force');
const config = loadConfig();
const dir = config.dataDir;
const file = path.join(dir, 'shopdesk.json');

if (fs.existsSync(file) && force) {
  fs.rmSync(file);
  console.log(`removed existing demo database at ${file}`);
}

const store = await new FileStore({ dir }).init();
const existing = await store.collection('tenants').countDocuments({});
if (existing > 0) {
  console.error(
    `Data directory ${dir} already contains ${existing} workspace(s). Demo seeding is additive and refuses to touch a real workspace.\n` +
      'Use a separate directory:  SHOPDESK_DATA_DIR=./data-demo npm run demo:seed -- --force'
  );
  process.exit(1);
}

const owner = await createTenant(store, {
  legalName: 'The Good Vets Pet Clinic Private Limited',
  tradeName: 'The Good Vets',
  stateCode: '09',
  gstin: '09AABCG1234H1Z5',
  profile: 'regular',
  identityEvidence: 'DEMONSTRATION DATA — synthetic onboarding record, not a verified legal identity',
  eInvoiceStatus: 'reviewed_not_applicable',
  eInvoiceNote: 'DEMO: applicability reviewed for the sample workspace only',
  invoicePrefix: 'INV',
  ownerName: 'Dr Demo Owner',
  ownerEmail: 'owner@demo.shopdesk.test',
  ownerPassword: 'Demo-Owner-2026!',
  sample: true,
});

const ctx = {
  store,
  tenantId: owner.tenant._id,
  userId: owner.user._id,
  actorName: owner.user.name,
  userName: owner.user.name,
  role: 'owner',
  permissions: ['*'],
  branchId: owner.branch._id,
  allowedBranchIds: [owner.branch._id],
  requestId: 'demo-seed',
  now: () => new Date(),
};

await store.transaction(() =>
  updateRegistration(ctx, owner.registration._id, {
    drugLicence: {
      number: 'DEMO-UP-VET-LICENCE',
      expiresOn: '2030-03-31',
      status: 'verified',
      evidence: 'DEMONSTRATION record — synthetic licence, verify before real use',
    },
  })
);

const staff = [];
for (const person of [
  { name: 'Ravi Cashier', email: 'cashier@demo.shopdesk.test', role: 'cashier' },
  { name: 'Meera Stores', email: 'inventory@demo.shopdesk.test', role: 'inventory' },
  { name: 'Anil Accounts', email: 'accounts@demo.shopdesk.test', role: 'accountant' },
]) {
  const created = await store.transaction(async () => {
    const user = {
      _id: newId(),
      name: person.name,
      email: person.email,
      emailLower: person.email.toLowerCase(),
      passwordHash: await hashPassword('Demo-Staff-2026!'),
      status: 'active',
      createdAt: ctx.now(),
    };
    await store.collection('users').insertOne(user);
    const membership = {
      _id: newId(),
      tenantId: ctx.tenantId,
      userId: user._id,
      role: person.role,
      permissions: ROLES[person.role].permissions,
      branchIds: [ctx.branchId],
      status: 'active',
      createdAt: ctx.now(),
    };
    await store.collection('memberships').insertOne(membership);
    return { user, membership };
  });
  staff.push(created);
}

const customer = await store.transaction(() =>
  createCustomer(ctx, {
    name: 'Asha Sharma',
    phone: '9812345670',
    email: 'asha@example.test',
    stateCode: '09',
    address: '12 Civil Lines, Moradabad',
  })
);
const walkIn = await store.transaction(() =>
  createCustomer(ctx, { name: 'Walk-in customer', stateCode: '09', walkIn: true })
);
const pet = await store.transaction(() =>
  createPet(ctx, { customerId: customer._id, name: 'Bruno', species: 'dog', breed: 'Labrador', sex: 'male' })
);
const supplier = await store.transaction(() =>
  createSupplier(ctx, {
    name: 'North India Veterinary Supplies',
    stateCode: '09',
    gstin: '09AAACN1234B1Z3',
    phone: '9876500011',
  })
);

const catalog = [
  { name: 'Veterinary consultation', kind: 'service', category: 'Clinical services', uom: 'service', quantityScale: 0, salePricePaise: '50000', priceMode: 'exclusive', taxTreatment: 'exempt', taxRateBps: '0', hsn: '9997' },
  { name: 'Grooming — bath & trim', kind: 'service', category: 'Grooming', uom: 'service', quantityScale: 0, salePricePaise: '90000', priceMode: 'inclusive', taxTreatment: 'taxable', taxRateBps: '1800', hsn: '9997' },
  { name: 'Anti-rabies vaccine (1 ml vial)', kind: 'goods', category: 'Vaccines', uom: 'vial', quantityScale: 0, salePricePaise: '35000', priceMode: 'inclusive', taxTreatment: 'taxable', taxRateBps: '500', hsn: '3002', manufacturer: 'BioVet Labs' },
  { name: 'Deworming tablets (strip of 6)', kind: 'goods', category: 'Medicines', uom: 'strip', quantityScale: 0, salePricePaise: '18500', priceMode: 'inclusive', taxTreatment: 'taxable', taxRateBps: '1200', hsn: '3004', manufacturer: 'PetCare' },
  { name: 'Surgical dressing pad', kind: 'goods', category: 'Consumables', uom: 'pack', quantityScale: 0, salePricePaise: '24000', priceMode: 'inclusive', taxTreatment: 'taxable', taxRateBps: '1200', hsn: '3005' },
  { name: 'Adult dog food 3 kg', kind: 'goods', category: 'Nutrition', uom: 'pack', quantityScale: 0, salePricePaise: '129000', priceMode: 'inclusive', taxTreatment: 'taxable', taxRateBps: '1800', hsn: '2309' },
  { name: 'Flea & tick spot-on', kind: 'goods', category: 'Medicines', uom: 'bottle', quantityScale: 0, salePricePaise: '62000', priceMode: 'inclusive', taxTreatment: 'taxable', taxRateBps: '1200', hsn: '3004' },
];

const products = {};
for (const item of catalog) {
  const product = await store.transaction(() => createProduct(ctx, item));
  await store.transaction(() =>
    reviewClassification(ctx, product._id, {
      evidence: 'DEMO classification review (synthetic)',
      hsn: item.hsn,
      taxRateBps: item.taxRateBps,
      taxTreatment: item.taxTreatment,
    })
  );
  products[item.name] = { ...product, ...item };
}

const purchaseLines = [
  { key: 'Anti-rabies vaccine (1 ml vial)', batchNo: 'ARV-2611A', expiry: { precision: 'date', date: '2027-06-30' }, quantityScaled: '40', taxableValuePaise: '1200000', cgstPaise: '30000', sgstPaise: '30000' },
  { key: 'Deworming tablets (strip of 6)', batchNo: 'DW-2609B', expiry: { precision: 'date', date: '2028-02-29' }, quantityScaled: '120', taxableValuePaise: '1440000', cgstPaise: '86400', sgstPaise: '86400' },
  { key: 'Surgical dressing pad', batchNo: 'SD-2605C', expiry: { precision: 'date', date: '2029-01-31' }, quantityScaled: '80', taxableValuePaise: '800000', cgstPaise: '48000', sgstPaise: '48000' },
  { key: 'Adult dog food 3 kg', batchNo: 'FD-2610D', expiry: { precision: 'month', year: 2027, month: 5 }, quantityScaled: '30', taxableValuePaise: '2700000', cgstPaise: '243000', sgstPaise: '243000' },
  { key: 'Flea & tick spot-on', batchNo: 'FT-2608E', expiry: { precision: 'date', date: '2027-11-30' }, quantityScaled: '60', taxableValuePaise: '2400000', cgstPaise: '144000', sgstPaise: '144000' },
];

const purchase = await postPurchase(
  ctx,
  {
    supplierId: supplier._id,
    supplierInvoiceNo: 'NIVS/2026/0417',
    supplierInvoiceDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
    lines: purchaseLines.map((line) => ({
      productId: products[line.key]._id,
      quantityScaled: line.quantityScaled,
      taxableValuePaise: line.taxableValuePaise,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      batchNo: line.batchNo,
      expiry: line.expiry,
      coldChainVerified: true,
    })),
  },
  { idempotencyKey: `demo-purchase-${Date.now()}` }
);

const issued = [];
async function issue(lines, { customerId = customer._id, petId = null, daysAgo = 0, method = 'upi', amountPaise = null } = {}) {
  const draft = await store.transaction(() =>
    createDraft(ctx, {
      branchId: ctx.branchId,
      customerId,
      petId,
      cashierName: owner.user.name,
      lines,
    })
  );
  const doc = await finalizeDraft(
    ctx,
    draft.draft._id,
    {
      version: draft.draft.version,
      quoteHash: draft.quoteHash,
      payment: method ? { method, amountPaise: amountPaise ?? draft.quote.totals.totalPaise } : null,
    },
    { idempotencyKey: `demo-invoice-${draft.draft._id}` }
  );
  issued.push(doc);
  return doc;
}

const bill1 = await issue(
  [
    { productId: products['Veterinary consultation']._id, quantityScaled: '1' },
    { productId: products['Anti-rabies vaccine (1 ml vial)']._id, quantityScaled: '1' },
    { productId: products['Deworming tablets (strip of 6)']._id, quantityScaled: '1' },
  ],
  { petId: pet._id, method: 'upi' }
);

const bill2 = await issue(
  [
    { productId: products['Grooming — bath & trim']._id, quantityScaled: '1' },
    { productId: products['Adult dog food 3 kg']._id, quantityScaled: '1' },
  ],
  { petId: pet._id, method: null }
);

const bill3 = await issue(
  [{ productId: products['Surgical dressing pad']._id, quantityScaled: '2' }],
  { customerId: walkIn._id, method: 'cash' }
);

// Partial return with restock on the consultation + vaccine bill.
const invoice = await store.transaction(() => getDocument(ctx, bill1.documentId));
const returnedLine = invoice.document.lines[2];
const preview = await store.transaction(() =>
  buildReturnPreview(ctx, bill1.documentId, [{ lineId: returnedLine.lineId, quantityScaled: '1' }])
);
const credit = await store.transaction(() =>
  createReturn(
    ctx,
    bill1.documentId,
    {
      reason: 'Tablet strip returned unopened',
      lines: [{ lineId: returnedLine.lineId, quantityScaled: '1', restock: true, condition: 'resaleable' }],
      version: preview.version,
    },
    { idempotencyKey: `demo-return-${bill1.documentId}` }
  )
);

await store.transaction(() =>
  recordReceipt(
    ctx,
    { documentId: bill2.documentId, amountPaise: '80000', method: 'cash', reference: 'Part payment at counter' },
    { idempotencyKey: `demo-receipt-${bill2.documentId}` }
  )
);

await store.transaction(() =>
  cashClose(ctx, {
    branchId: ctx.branchId,
    businessDate: new Date().toISOString().slice(0, 10),
    openingCashPaise: '500000',
    countedCashPaise: '627500',
    varianceReason: 'DEMO: ₹5 short at the counter, recounted in the presence of the cashier',
  })
);

console.log(`
shop desk demo workspace ready
  data directory : ${dir}
  workspace      : ${owner.tenant.tradeName} (sample data)
  branch         : ${owner.branch.name}
  owner login    : owner@demo.shopdesk.test / Demo-Owner-2026!
  cashier        : cashier@demo.shopdesk.test / Demo-Staff-2026!
  inventory      : inventory@demo.shopdesk.test / Demo-Staff-2026!
  accountant     : accounts@demo.shopdesk.test / Demo-Staff-2026!
  products       : ${Object.keys(products).length}
  purchases      : 1 (${purchase.number})
  invoices       : ${issued.map((d) => d.number).join(', ')}
  credit note    : ${credit.number}
`);
