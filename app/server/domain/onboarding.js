/**
 * Authenticated, owner-verified onboarding for a new tenant.
 *
 * A new tenant starts EMPTY: no sample products, parties, pets, stock, invoices,
 * payments or balances. Only approved system references (chart of accounts,
 * legal-rule register, number series) are initialised.
 */

import { conflict, forbidden, unprocessable } from '../errors.js';
import { newId } from '../ids.js';
import { getTenantRecord, repo } from '../tenancy/repo.js';
import { createUser } from '../auth/sessions.js';
import { ROLES } from '../auth/permissions.js';
import { ensureChartOfAccounts } from './accounting.js';
import { seedLegalRules } from './settings.js';
import { validateSeries } from './numbering.js';
import { financialYear } from '../time.js';
import { appendAudit } from './audit.js';

export const DEFAULT_SERIES = [
  { docKind: 'tax_invoice', series: 'INV', padding: 6 },
  { docKind: 'credit_note', series: 'CN', padding: 6 },
  { docKind: 'debit_note', series: 'DN', padding: 6 },
  { docKind: 'purchase', series: 'PR', padding: 6 },
  { docKind: 'supplier_return', series: 'SR', padding: 6 },
  { docKind: 'receipt', series: 'RC', padding: 6 },
];

function slugify(value) {
  const base = String(value || 'clinic').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base.slice(0, 40) || 'clinic'}-${newId().slice(0, 6)}`;
}

/**
 * Create a tenant with its first branch, GST registration, owner membership,
 * chart of accounts and legal-rule register.
 */
export async function createTenant(store, input) {
  const legalName = String(input.legalName || '').trim();
  if (legalName.length < 3) throw unprocessable('legal name of the business is required');
  const tradeName = String(input.tradeName || legalName).trim();
  const stateCode = String(input.stateCode || '').trim();
  if (!/^\d{2}$/.test(stateCode)) throw unprocessable('two-digit state code is required (e.g. 09 for Uttar Pradesh)');
  if (!input.identityEvidence || String(input.identityEvidence).trim().length < 8) {
    throw unprocessable('record how the business identity was verified (document/reference)');
  }
  const profile = ['regular', 'composition', 'unregistered'].includes(input.profile) ? input.profile : 'regular';
  if (profile === 'regular' && !input.gstin) throw unprocessable('a regular GST registration needs a GSTIN');
  if (!input.ownerEmail) throw unprocessable('owner email is required');

  const eInvoiceStatus = ['unverified', 'reviewed_not_applicable', 'applicable'].includes(input.eInvoiceStatus)
    ? input.eInvoiceStatus
    : 'unverified';
  if (eInvoiceStatus !== 'unverified' && !input.eInvoiceNote) {
    throw unprocessable('record the reviewed e-invoice applicability note');
  }

  const now = new Date();
  let created = null;
  await store.transaction(async () => {
    const ctx = { store, tenantId: null, userId: null, now: () => now };
    const existingUsers = await store.collection('users').countDocuments({ emailLower: String(input.ownerEmail).toLowerCase() });
    if (existingUsers > 0) {
      throw conflict('An account already exists for this email. Sign in and create a workspace, or invite this address.', 'USER_EXISTS');
    }
    const tenant = {
      _id: newId(),
      name: tradeName,
      displayName: tradeName,
      slug: slugify(tradeName),
      brand: 'shop desk',
      legalName,
      tradeName,
      stateCode,
      status: 'active',
      plan: 'trial',
      sample: Boolean(input.sample),
      identityVerified: true,
      identityEvidence: String(input.identityEvidence).slice(0, 500),
      identityVerifiedAt: now,
      createdAt: now,
      createdBy: input.createdBy || null,
      invoiceSettings: {
        templateVersion: 'A4-2026.10',
        thermalTemplateVersion: 'THERMAL-2026.10',
        template: 'corporate',
        terms: 'Returns are subject to approval, condition checks and the original invoice.',
        declaration: 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
        footer: 'Thank you for your visit.',
        bankDetails: '',
      },
    };
    await store.collection('tenants').insertOne(tenant);

    const branch = {
      _id: newId(),
      tenantId: tenant._id,
      code: 'MAIN',
      name: input.branchName ? String(input.branchName).trim() : 'Main branch',
      address: input.address ? String(input.address).slice(0, 500) : null,
      stateCode,
      timezone: 'Asia/Kolkata',
      status: 'active',
      createdAt: now,
    };
    await store.collection('branches').insertOne(branch);

    const fy = financialYear(now);
    for (const s of DEFAULT_SERIES) validateSeries({ series: s.series, fyLabel: fy, padding: s.padding, upTo: 1 });

    const registration = {
      _id: newId(),
      tenantId: tenant._id,
      branchIds: [branch._id],
      code: 'GST-1',
      legalName,
      tradeName,
      gstin: input.gstin ? String(input.gstin).trim().toUpperCase() : null,
      stateCode,
      profile,
      address: input.address ? String(input.address).slice(0, 500) : null,
      status: 'verified',
      verifiedAt: now,
      verificationEvidence: String(input.identityEvidence).slice(0, 500),
      series: input.series || DEFAULT_SERIES,
      eInvoice: {
        status: eInvoiceStatus,
        note: input.eInvoiceNote || null,
        reviewedAt: eInvoiceStatus === 'unverified' ? null : now,
      },
      eWayBill: { status: input.eWayBillStatus || 'unverified', externalProcess: input.eWayBillProcess || null },
      drugLicence: input.drugLicence?.number
        ? {
            number: input.drugLicence.number,
            expiresOn: input.drugLicence.expiresOn || null,
            status: input.drugLicence.status === 'verified' ? 'verified' : 'unverified',
            evidence: input.drugLicence.evidence || null,
          }
        : { number: null, status: 'unverified' },
      createdAt: now,
    };
    await store.collection('tax_registrations').insertOne(registration);

    // Trusted context for seeded references (tenant is now known).
    const tenantCtx = {
      store,
      tenantId: tenant._id,
      userId: null,
      actorName: 'system:onboarding',
      requestId: null,
      now: () => now,
      branchId: branch._id,
    };
    await ensureChartOfAccounts(tenantCtx);
    await seedLegalRules(tenantCtx);

    const ownerCtx = { ...tenantCtx, tenantId: null };
    const user = await createUser(ownerCtx, {
      name: input.ownerName || legalName,
      email: input.ownerEmail,
      password: input.ownerPassword,
    });

    const membership = {
      _id: newId(),
      tenantId: tenant._id,
      userId: user._id,
      role: 'owner',
      permissions: ROLES.owner.permissions,
      branchIds: [branch._id],
      status: 'active',
      createdAt: now,
      createdBy: user._id,
    };
    await store.collection('memberships').insertOne(membership);

    await appendAudit(
      { ...tenantCtx, userId: user._id, actorName: user.name },
      {
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: tenant._id,
        after: { legalName, tradeName, stateCode, profile, emptyTenant: true },
      }
    );

    created = { tenant, branch, registration, user, membership };
  });
  return created;
}

/** Add another branch (and optionally its own registration) to a tenant. */
export async function createBranch(ctx, input) {
  const tenant = await getTenantRecord(ctx);
  if (!tenant) throw unprocessable('tenant not found');
  const name = String(input.name || '').trim();
  if (name.length < 2) throw unprocessable('branch name is required');
  const code = String(input.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,8}$/.test(code)) throw unprocessable('branch code must be 2–8 letters/digits/hyphen');
  const branch = {
    _id: newId(),
    code,
    name,
    address: input.address ? String(input.address).slice(0, 500) : null,
    stateCode: String(input.stateCode || tenant.stateCode).slice(0, 2),
    timezone: 'Asia/Kolkata',
    status: 'active',
    createdAt: ctx.now ? ctx.now() : new Date(),
  };
  await repo(ctx, 'branches').insertOne(branch);
  await appendAudit(ctx, { action: 'branch.created', entityType: 'branch', entityId: branch._id, after: { name, code } });
  return branch;
}
