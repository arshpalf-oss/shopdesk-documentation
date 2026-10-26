import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../server/store/file-store.js';
import { createTenant } from '../server/domain/onboarding.js';
import { createCustomer, createProduct, createSupplier, reviewClassification } from '../server/domain/catalog.js';
import { updateRegistration } from '../server/domain/settings.js';
import { postPurchase } from '../server/domain/purchases.js';

let counter = 0;
function unique(prefix) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopdesk-test-'));
  const store = await new FileStore({ dir }).init();
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export async function makeTenant(store, overrides = {}) {
  const created = await createTenant(store, {
    legalName: overrides.legalName || `Test Clinic ${unique('legal')} Private Limited`,
    tradeName: overrides.tradeName || 'Test Clinic',
    stateCode: overrides.stateCode || '09',
    profile: overrides.profile || 'regular',
    gstin: overrides.gstin || (overrides.profile === 'unregistered' ? undefined : '09ABCDE1234F1Z5'),
    identityEvidence: 'Automated test fixture identity evidence',
    eInvoiceStatus: 'reviewed_not_applicable',
    eInvoiceNote: 'Automated test fixture — synthetic applicability record',
    ownerName: 'Test Owner',
    ownerEmail: overrides.email || `${unique('owner')}@example.test`,
    ownerPassword: overrides.password || 'Test-Passw0rd!234',
    sample: true,
  });
  const ctx = {
    store,
    tenantId: created.tenant._id,
    userId: created.user._id,
    actorName: 'Test Owner',
    userName: 'Test Owner',
    role: 'owner',
    permissions: ['*'],
    branchId: created.branch._id,
    allowedBranchIds: [created.branch._id],
    requestId: unique('req'),
    now: () => new Date(),
  };
  await store.transaction(() =>
    updateRegistration(ctx, created.registration._id, {
      drugLicence: {
        number: 'TEST-LICENCE-1',
        expiresOn: '2030-03-31',
        status: 'verified',
        evidence: 'Automated test fixture licence (synthetic)',
      },
    })
  );
  return { ...created, ctx };
}

export async function makeRoster(store, ctx) {
  const customer = await store.transaction(() =>
    createCustomer(ctx, { name: `Customer ${unique('c')}`, phone: '9000000000', stateCode: '09' })
  );
  const supplier = await store.transaction(() =>
    createSupplier(ctx, { name: `Supplier ${unique('s')}`, stateCode: '09', gstin: '09AABCU9603R1ZM' })
  );
  const goods = await store.transaction(() =>
    createProduct(ctx, {
      name: `Goods ${unique('p')}`,
      kind: 'goods',
      sku: unique('SKU'),
      barcode: unique('890'),
      category: 'Test goods',
      uom: 'strip',
      quantityScale: 0,
      salePricePaise: '12550',
      priceMode: 'inclusive',
      taxTreatment: 'taxable',
      taxRateBps: '1200',
      hsn: '3004',
    })
  );
  await store.transaction(() =>
    reviewClassification(ctx, goods._id, { evidence: 'Automated test classification review', hsn: '3004', taxRateBps: '1200', taxTreatment: 'taxable' })
  );
  const service = await store.transaction(() =>
    createProduct(ctx, {
      name: `Service ${unique('svc')}`,
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
    reviewClassification(ctx, service._id, { evidence: 'Automated test classification review', hsn: '9997', taxRateBps: '0', taxTreatment: 'exempt' })
  );
  const purchase = await postPurchase(
    ctx,
    {
      supplierId: supplier._id,
      supplierInvoiceNo: unique('SUP-INV'),
      supplierInvoiceDate: new Date().toISOString().slice(0, 10),
      lines: [
        {
          productId: goods._id,
          quantityScaled: '50',
          taxableValuePaise: '56000',
          cgstPaise: '3360',
          sgstPaise: '3360',
          batchNo: unique('BATCH'),
          expiry: { precision: 'date', date: '2028-12-31' },
          coldChainVerified: true,
        },
      ],
    },
    { idempotencyKey: unique('purchase-key') }
  );
  return { customer, supplier, goods, service, purchase };
}
