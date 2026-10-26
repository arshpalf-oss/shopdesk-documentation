/**
 * Tenant configuration, legal-assumption register and compliance readiness.
 *
 * Readiness issues are produced by the server. A "blocker" disables the affected
 * capability — it is not a dismissible warning and cannot be overridden by an
 * owner merely accepting a dialog.
 */

import { legalGate, unprocessable } from '../errors.js';
import { newId } from '../ids.js';
import { getTenantRecord, repo, updateTenantRecord } from '../tenancy/repo.js';
import { validateSeries, DOC_KINDS } from './numbering.js';
import { financialYear } from '../time.js';

export const PROFILES = {
  regular: 'Regular GST registration',
  composition: 'Composition scheme',
  unregistered: 'Unregistered (no GST collected)',
};

export const E_INVOICE_STATES = {
  unverified: 'Applicability not yet verified (blocks live issue)',
  reviewed_not_applicable: 'Reviewed: e-invoicing not applicable to this registration',
  applicable: 'Applicable — authentic IRP integration required (not implemented; blocks issue)',
};

export const DEFAULT_INVOICE_SETTINGS = {
  templateVersion: 'A4-2026.10',
  thermalTemplateVersion: 'THERMAL-2026.10',
  template: 'corporate',
  terms: 'Goods once sold are not returnable without the original invoice. Returns are subject to approval and condition checks.',
  declaration: 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
  footer: 'Thank you for your visit.',
  bankDetails: '',
};

/** Approved system references seeded for a new tenant (never business data). */
export const LEGAL_RULES = [
  {
    key: 'LEG-01-document-profile',
    title: 'Supplier status and correct document type',
    state: 'unverified',
    source: 'CGST Rules 2017, rules 46 & 49 (tax invoice / bill of supply)',
    sourceUrl: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule49_v1.00.html',
    affectedCapability: 'sales.documentKind',
  },
  {
    key: 'LEG-02-invoice-particulars',
    title: 'Rule 46 invoice particulars and 16-character numbering',
    state: 'unverified',
    source: 'CGST Rules 2017, rule 46',
    sourceUrl: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html',
    affectedCapability: 'sales.numbering',
  },
  {
    key: 'LEG-03-hsn-classification',
    title: 'HSN/SAC classification and effective GST rates',
    state: 'unverified',
    source: 'Notification 78/2020-CT and current rate notifications',
    sourceUrl: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-78-central-tax-english-2020.pdf',
    affectedCapability: 'products.classification',
  },
  {
    key: 'LEG-04-veterinary-exemption',
    title: 'Veterinary healthcare exemption does not cover all goods',
    state: 'unverified',
    source: 'Notification 12/2017-CT(R), entry 46',
    sourceUrl: 'https://cbic-gst.gov.in/hindi/pdf/central-tax-rate/Notification12-CGST.pdf',
    affectedCapability: 'products.classification',
  },
  {
    key: 'LEG-05-place-of-supply',
    title: 'Place of supply and CGST/SGST/IGST components',
    state: 'unverified',
    source: 'IGST Act 2017, section 10; circular 209/03/2024',
    sourceUrl: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_IGST_Act/active/chapterv/section10_v1.00.html',
    affectedCapability: 'sales.tax',
  },
  {
    key: 'LEG-07-credit-notes',
    title: 'Credit-note conditions and GST adjustment cut-off',
    state: 'unverified',
    source: 'CGST Act 2017, section 34',
    sourceUrl: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter7/section34_v1.00.html',
    affectedCapability: 'returns.gst',
  },
  {
    key: 'LEG-08-e-invoice',
    title: 'E-invoicing applicability and authentic IRN',
    state: 'unverified',
    source: 'Notification 10/2023-CT; GSTN advisory 543',
    sourceUrl: 'https://www.gstcouncil.gov.in/node/4365',
    affectedCapability: 'sales.eInvoice',
  },
  {
    key: 'LEG-10-e-way-bill',
    title: 'E-way bill and consignment movement obligations',
    state: 'unverified',
    source: 'CGST Rules 2017, rule 138',
    sourceUrl: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter16/rule138_v1.00.html',
    affectedCapability: 'sales.eWayBill',
  },
  {
    key: 'LEG-11-input-tax-credit',
    title: 'Input tax eligibility review (not automatic)',
    state: 'unverified',
    source: 'CGST Act 2017, section 16',
    sourceUrl: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter5/section16_v1.00.html',
    affectedCapability: 'purchases.itc',
  },
  {
    key: 'LEG-13-gst-retention',
    title: 'GST record retention (72 months from annual-return due date)',
    state: 'unverified',
    source: 'CGST Act 2017, section 36; rule 57',
    sourceUrl: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter8/section36_v1.00.html',
    affectedCapability: 'retention.gst',
  },
  {
    key: 'LEG-14-income-tax-books',
    title: 'Electronic books accessible in India and daily India backups',
    state: 'unverified',
    source: 'Income-tax Rules 2026, rule 46(8)-(9)',
    sourceUrl: 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/En-Notified-IT-Rules-2026-20-03-2026.pdf',
    affectedCapability: 'retention.incomeTax',
  },
  {
    key: 'LEG-15-company-audit-trail',
    title: 'Non-disableable accounting edit history (company tenants)',
    state: 'unverified',
    source: 'Companies Act 2013, section 128; ICAI audit-trail guide',
    sourceUrl: 'https://eirc-icai.org/uploads/background_materials/Revised%202024_Implementation%20Guide%20on%20Reporting%20of%20Audit%20Trail%20(1)_1712114860.pdf',
    affectedCapability: 'audit.immutability',
  },
  {
    key: 'LEG-16-cash-receipts',
    title: 'Cash receipt restrictions (section 186) — ₹2,00,000 event tests',
    state: 'unverified',
    source: 'Income-tax Act 2025, section 186',
    sourceUrl: 'https://www.incometaxindia.gov.in/w/section-186-41',
    affectedCapability: 'payments.cashLimit',
  },
  {
    key: 'LEG-21-dpdp',
    title: 'DPDP Act 2023 / DPDP Rules 2025 phased commencement',
    state: 'unverified',
    source: 'DPDP Rules 2025 (phased commencement)',
    sourceUrl: 'https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf',
    affectedCapability: 'privacy.notices',
  },
  {
    key: 'LEG-22-cert-in',
    title: 'CERT-In directions: 6-hour incident reporting, 180-day logs',
    state: 'unverified',
    source: 'CERT-In Directions 70B, 28 April 2022',
    sourceUrl: 'https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf',
    affectedCapability: 'security.incident',
  },
  {
    key: 'LEG-18-medicine-sale',
    title: 'Drug sale/dispensing licences, registers and restricted medicines',
    state: 'unverified',
    source: 'Drugs Rules 1945, rules 65 and 97 (older compilation; recheck amendments)',
    sourceUrl: 'https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules,%201945%20(1).pdf',
    affectedCapability: 'inventory.restrictedMedicines',
  },
  {
    key: 'LEG-19-mrp-price-control',
    title: 'Tax-inclusive MRP and DPCO/NPPA price controls',
    state: 'unverified',
    source: 'DPCO 2013 and 2026 amendment; NPPA ceilings',
    sourceUrl: 'https://www.nppa.gov.in/',
    affectedCapability: 'products.mrp',
  },
];

export async function seedLegalRules(ctx) {
  const existing = await repo(ctx, 'legal_rules').count();
  if (existing > 0) return;
  for (const rule of LEGAL_RULES) {
    await repo(ctx, 'legal_rules').insertOne({
      _id: newId(),
      key: rule.key,
      title: rule.title,
      state: rule.state,
      source: rule.source,
      sourceUrl: rule.sourceUrl,
      affectedCapability: rule.affectedCapability,
      interpretation: null,
      reviewer: null,
      reviewedAt: null,
      evidence: null,
      effectiveFrom: null,
      effectiveTo: null,
      nextReviewAt: null,
      retrievedAt: '2026-10-26',
      history: [],
    });
  }
}

export async function updateLegalRule(ctx, key, input) {
  const rules = repo(ctx, 'legal_rules');
  const rule = await rules.findOne({ key });
  if (!rule) throw unprocessable('unknown legal rule');
  const allowed = ['unverified', 'reviewed_applicable', 'reviewed_not_applicable', 'future_not_effective', 'unsupported'];
  if (input.state && !allowed.includes(input.state)) throw unprocessable('unknown rule state');
  if (input.state && input.state !== 'unverified' && (!input.evidence || !input.reviewer)) {
    throw unprocessable('a reviewed rule needs reviewer and evidence recorded');
  }
  const patch = {
    state: input.state ?? rule.state,
    interpretation: input.interpretation ?? rule.interpretation,
    reviewer: input.reviewer ?? rule.reviewer,
    evidence: input.evidence ?? rule.evidence,
    effectiveFrom: input.effectiveFrom ?? rule.effectiveFrom,
    effectiveTo: input.effectiveTo ?? rule.effectiveTo,
    nextReviewAt: input.nextReviewAt ?? rule.nextReviewAt,
    reviewedAt: input.state && input.state !== 'unverified' ? (ctx.now ? ctx.now() : new Date()) : rule.reviewedAt,
    updatedAt: ctx.now ? ctx.now() : new Date(),
  };
  await rules.updateOne(
    { _id: rule._id },
    { $set: patch, $push: { history: { at: ctx.now ? ctx.now() : new Date(), state: patch.state, reviewer: patch.reviewer, by: ctx.userId } } }
  );
  return { ...rule, ...patch };
}

export async function registrationReadiness(ctx, registration) {
  const issues = [];
  if (!registration) {
    issues.push({ code: 'NO_REGISTRATION', severity: 'blocker', message: 'No GST registration is configured for this branch.' });
    return issues;
  }
  if (registration.status !== 'verified') {
    issues.push({
      code: 'REGISTRATION_UNVERIFIED',
      severity: 'blocker',
      message: 'The supplier legal identity and GST registration have not been verified by the owner.',
    });
  }
  if (registration.profile === 'regular' && !registration.gstin) {
    issues.push({ code: 'GSTIN_MISSING', severity: 'blocker', message: 'A regular GST registration needs a GSTIN.' });
  }
  if (!registration.stateCode) {
    issues.push({ code: 'STATE_MISSING', severity: 'blocker', message: 'The registration state code (place of supply of the supplier) is required.' });
  }
  const eInvoice = registration.eInvoice || { status: 'unverified' };
  if (eInvoice.status === 'applicable') {
    issues.push({
      code: 'E_INVOICE_NOT_INTEGRATED',
      severity: 'blocker',
      message: 'E-invoicing is recorded as applicable but no authentic IRP integration exists. Covered documents are blocked.',
    });
  }
  if (eInvoice.status === 'unverified') {
    issues.push({
      code: 'E_INVOICE_UNVERIFIED',
      severity: 'blocker',
      message: 'E-invoice applicability is unverified. Record a reviewed applicability conclusion before issuing live documents.',
    });
  }
  if (registration.profile === 'regular') {
    if (!registration.series?.some((s) => s.docKind === 'tax_invoice')) {
      issues.push({ code: 'SERIES_MISSING', severity: 'blocker', message: 'No tax-invoice series is configured.' });
    }
    if (!registration.series?.some((s) => s.docKind === 'credit_note')) {
      issues.push({ code: 'SERIES_MISSING_CN', severity: 'blocker', message: 'No credit-note series is configured.' });
    }
  }
  if (registration.eWayBill?.status === 'applicable' && !registration.eWayBill?.externalProcess) {
    issues.push({
      code: 'E_WAY_BILL_NOT_INTEGRATED',
      severity: 'warning',
      message: 'E-way bill is marked applicable. Record the approved external process; the app does not generate e-way bills.',
    });
  }
  return issues;
}

export async function tenantReadiness(ctx) {
  const tenant = await getTenantRecord(ctx);
  const branches = await repo(ctx, 'branches').find({});
  const registrations = await repo(ctx, 'tax_registrations').find({});
  const issues = [];
  if (!tenant) issues.push({ code: 'NO_TENANT', severity: 'blocker', message: 'Tenant record missing.' });
  if (tenant && tenant.identityVerified !== true) {
    issues.push({ code: 'IDENTITY_UNVERIFIED', severity: 'blocker', message: 'The business identity has not been verified by the owner.' });
  }
  if (branches.length === 0) issues.push({ code: 'NO_BRANCH', severity: 'blocker', message: 'No branch is configured.' });
  for (const registration of registrations) {
    issues.push(...(await registrationReadiness(ctx, registration)));
  }
  const restricted = await repo(ctx, 'products').find({ 'restrictions.blocked': true, status: 'active' });
  if (restricted.length > 0) {
    const licence = registrations[0]?.drugLicence;
    if (!licence || licence.status !== 'verified') {
      issues.push({
        code: 'DRUG_LICENCE_MISSING',
        severity: 'blocker',
        message: `${restricted.length} restricted product(s) exist but no verified drug licence is recorded. Those products cannot be sold.`,
      });
    }
  }
  const unreviewed = await repo(ctx, 'products').count({ status: 'active', classificationReviewed: false });
  if (unreviewed > 0) {
    issues.push({
      code: 'CLASSIFICATION_UNREVIEWED',
      severity: 'warning',
      message: `${unreviewed} active product(s) have no reviewed tax classification; they cannot be added to a live invoice.`,
    });
  }
  const rules = await repo(ctx, 'legal_rules').find({});
  const unverified = rules.filter((r) => r.state === 'unverified');
  if (unverified.length) {
    issues.push({
      code: 'LEGAL_RULES_UNVERIFIED',
      severity: 'warning',
      message: `${unverified.length} legal-assumption rule(s) remain unverified. Record applicability and reviewer evidence in Settings.`,
    });
  }
  const accounts = await repo(ctx, 'ledger_accounts').count();
  if (accounts === 0) issues.push({ code: 'NO_COA', severity: 'blocker', message: 'Chart of accounts is missing.' });

  // Honest capability/limitation disclosures (not legal gates, no false claims).
  issues.push(
    { code: 'MFA_NOT_ENABLED', severity: 'warning', message: 'MFA is not enabled in this build. Owners should use a strong unique password and a private network until MFA is approved and configured.' },
    { code: 'BACKUP_UNVERIFIED', severity: 'warning', message: 'No verified backup/restore drill has been recorded. Local file storage is not an India-located durable backup.' },
    { code: 'PROFESSIONAL_REVIEW', severity: 'warning', message: 'Invoice formats, tax treatments and the service agreement require CA/GST and legal review before production use.' }
  );
  return {
    tenant,
    branches,
    registrations,
    issues,
    blockers: issues.filter((i) => i.severity === 'blocker'),
  };
}

/** Gate used by sales finalization. */
export async function assertCanIssue(ctx, { registration, docKind, lines }) {
  const issues = await registrationReadiness(ctx, registration);
  const blockers = issues.filter((i) => i.severity === 'blocker');
  const tenant = await getTenantRecord(ctx);
  if (tenant?.identityVerified !== true) {
    blockers.push({ code: 'IDENTITY_UNVERIFIED', severity: 'blocker', message: 'Business identity is not verified.' });
  }
  const series = registration.series?.find((s) => s.docKind === docKind);
  if (!series) {
    blockers.push({ code: 'SERIES_MISSING_FOR_DOC', severity: 'blocker', message: `No number series is configured for ${DOC_KINDS[docKind] || docKind}.` });
  }
  if (registration.profile !== 'regular' && docKind === 'tax_invoice') {
    blockers.push({ code: 'DOC_PROFILE_MISMATCH', severity: 'blocker', message: 'This profile cannot issue a tax invoice.' });
  }
  if (blockers.length) {
    throw legalGate(
      'This sale is blocked by compliance readiness. Fix the listed configuration before issuing documents.',
      { blockers }
    );
  }
  return series;
}

export async function updateTenantSettings(ctx, input) {
  const tenant = await getTenantRecord(ctx);
  if (!tenant) throw unprocessable('tenant not found');
  const patch = {};
  const allowed = ['legalName', 'tradeName', 'displayName', 'phone', 'email', 'address', 'stateCode', 'invoiceSettings'];
  for (const key of allowed) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.identityVerified === true) {
    if (!input.identityEvidence || String(input.identityEvidence).trim().length < 8) {
      throw unprocessable('record the identity verification evidence (document/reference) before marking verified');
    }
    patch.identityVerified = true;
    patch.identityVerifiedAt = ctx.now ? ctx.now() : new Date();
    patch.identityVerifiedBy = ctx.userId;
    patch.identityEvidence = String(input.identityEvidence).slice(0, 500);
  }
  if (Object.keys(patch).length === 0) throw unprocessable('no supported settings to update');
  await updateTenantRecord(ctx, patch);
  return { ...tenant, ...patch };
}

export async function updateRegistration(ctx, registrationId, input) {
  const registrations = repo(ctx, 'tax_registrations');
  const registration = await registrations.findOne({ _id: registrationId });
  if (!registration) throw unprocessable('registration not found');
  const patch = {};
  for (const key of ['legalName', 'tradeName', 'gstin', 'stateCode', 'address', 'invoiceSettings']) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.profile !== undefined) {
    if (!PROFILES[input.profile]) throw unprocessable('unknown GST profile');
    patch.profile = input.profile;
  }
  if (input.series !== undefined) {
    if (!Array.isArray(input.series) || input.series.length === 0) throw unprocessable('series list is required');
    const fy = financialYear();
    patch.series = input.series.map((s) => {
      if (!DOC_KINDS[s.docKind]) throw unprocessable(`unknown document kind ${s.docKind}`);
      const padding = Number(s.padding || 6);
      validateSeries({ series: s.series, fyLabel: fy, padding, upTo: 1 });
      return { docKind: s.docKind, series: String(s.series), padding };
    });
  }
  if (input.eInvoice !== undefined) {
    if (!E_INVOICE_STATES[input.eInvoice.status]) throw unprocessable('unknown e-invoice status');
    if (input.eInvoice.status !== 'unverified' && !input.eInvoice.note) {
      throw unprocessable('record the reviewed applicability note for e-invoicing');
    }
    patch.eInvoice = {
      status: input.eInvoice.status,
      note: input.eInvoice.note || null,
      reviewedBy: ctx.userId,
      reviewedAt: ctx.now ? ctx.now() : new Date(),
    };
  }
  if (input.drugLicence !== undefined) {
    patch.drugLicence = {
      number: input.drugLicence.number || null,
      expiresOn: input.drugLicence.expiresOn || null,
      status: input.drugLicence.status === 'verified' ? 'verified' : 'unverified',
      evidence: input.drugLicence.evidence || null,
      verifiedBy: ctx.userId,
      verifiedAt: ctx.now ? ctx.now() : new Date(),
    };
  }
  if (input.eWayBill !== undefined) {
    patch.eWayBill = {
      status: input.eWayBill.status || 'unverified',
      externalProcess: input.eWayBill.externalProcess || null,
    };
  }
  if (input.verified === true) {
    if (!input.verificationEvidence || String(input.verificationEvidence).trim().length < 8) {
      throw unprocessable('record the evidence used to verify this registration');
    }
    patch.status = 'verified';
    patch.verifiedAt = ctx.now ? ctx.now() : new Date();
    patch.verifiedBy = ctx.userId;
    patch.verificationEvidence = String(input.verificationEvidence).slice(0, 500);
  }
  if (Object.keys(patch).length === 0) throw unprocessable('no supported registration fields to update');
  await registrations.updateOne({ _id: registrationId }, { $set: patch });
  return { ...registration, ...patch };
}

export async function getSettingsBundle(ctx) {
  const tenant = await getTenantRecord(ctx);
  const branches = await repo(ctx, 'branches').find({});
  const registrations = await repo(ctx, 'tax_registrations').find({});
  const readiness = await tenantReadiness(ctx);
  const rules = await repo(ctx, 'legal_rules').find({}, { sort: { key: 1 } });
  const locks = await repo(ctx, 'period_locks').find({}, { sort: { year: -1, month: -1 } });
  return {
    tenant,
    branches,
    registrations,
    readiness: readiness.issues,
    legalRules: rules,
    periodLocks: locks,
    profiles: PROFILES,
    eInvoiceStates: E_INVOICE_STATES,
  };
}
