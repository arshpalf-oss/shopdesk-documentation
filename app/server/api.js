/**
 * REST API (same-origin /api/v1).
 *
 * Controllers authenticate, validate and authorise; all business logic lives in
 * domain services. Tenant scope always comes from the trusted server context.
 */

import express from 'express';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, unprocessable } from './errors.js';
import { hasPermission, NAV_ITEMS, PERMISSION_LABELS, ROLES, ROLE_KEYS } from './auth/permissions.js';
import {
  assertCsrf,
  clearCookieHeader,
  cookieHeader,
  createUser,
  findUserByEmail,
  loadContext,
  rateLimit,
  resetRateLimits,
  requireSession,
  requireTenantContext,
  startSession,
  visibleNavigation as navFor,
  permissionSnapshot,
} from './auth/sessions.js';
import { verifyPassword } from './auth/passwords.js';
import { businessDate } from './time.js';
import { getTenantRecord, repo } from './tenancy/repo.js';
import { createTenant, createBranch } from './domain/onboarding.js';
import {
  archiveProduct,
  createCustomer,
  createPet,
  createProduct,
  createSupplier,
  publicProduct,
  reviewClassification,
  updateCustomer,
  updateProduct,
} from './domain/catalog.js';
import {
  availabilityFor,
  eligibleBatches,
  postStockAdjustment,
  setBatchStatus,
} from './domain/inventory.js';
import {
  createDebitNote,
  createReturn,
  buildReturnPreview,
  getReturn,
  listReturns,
} from './domain/returns.js';
import {
  createDraft,
  discardDraft,
  finalizeDraft,
  getDocument,
  listDocuments,
  quoteDraft,
  settlementFor,
  updateDraft,
} from './domain/sales.js';
import {
  cashClose,
  confirmPendingIntent,
  createPendingIntent,
  listPayments,
  recordReceipt,
  recordRefund,
  reverseReceipt,
} from './domain/payments.js';
import {
  createSupplierReturn,
  getPurchase,
  listPurchases,
  postOpening,
  postPurchase,
  recordExpense,
  recordSupplierCreditNote,
  reviewInputTax,
} from './domain/purchases.js';
import {
  balanceSheet,
  ensureChartOfAccounts,
  inventoryValuation,
  partyBalances,
  postJournal,
  profitAndLoss,
  reconcile,
  reverseJournal,
  trialBalance,
} from './domain/accounting.js';
import {
  getSettingsBundle,
  tenantReadiness,
  updateLegalRule,
  updateRegistration,
  updateTenantSettings,
} from './domain/settings.js';
import { CORE_TABS, EXTRA_TABS, TAB_LABELS, runReport, toCsv } from './domain/reports.js';
import { appendAudit, verifyAuditChain } from './domain/audit.js';
import { lookupOperation } from './domain/idempotency.js';
import { runBatch } from './domain/outbox.js';
import { renderDocumentHtml, templateChoices } from './domain/print.js';
import { newId, sha256 } from './ids.js';
import { formatINR, formatPaise, formatScaled } from './money.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const IDEMPOTENCY_HEADER = 'idempotency-key';
const CSRF_HEADER = 'x-csrf-token';

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.userId) return next(new AppError('Authentication required', { status: 401, code: 'UNAUTHENTICATED' }));
    if (!hasPermission(req.ctx.permissions, permission)) {
      return next(forbidden(`permission "${permission}" is required`));
    }
    return next();
  };
}

function tenant(req) {
  requireTenantContext(req.ctx);
  return req.ctx;
}

function idempotency(req) {
  const key = req.get(IDEMPOTENCY_HEADER) || req.body?.idempotencyKey;
  if (!key) throw unprocessable('Idempotency-Key header is required for this financial action', 'IDEMPOTENCY_KEY_REQUIRED');
  return key;
}

function paging(req) {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  return { limit };
}

function periodQuery(req) {
  return {
    preset: req.query.preset || 'month',
    from: req.query.from,
    to: req.query.to,
    branchId: req.query.branchId,
    quantityOnly: req.query.quantityOnly === 'true',
  };
}

export function createApiRouter({ store, config }) {
  const router = express.Router();

  /* ---------------------------------------------------------------- session */

  router.get('/health', (req, res) => {
    res.json({ status: 'ok', driver: config.mongoUri ? 'mongodb' : 'file', time: new Date().toISOString() });
  });

  router.get('/setup/status', wrap(async (req, res) => {
    const tenants = await store.collection('tenants').countDocuments({});
    res.json({
      needsSetup: tenants === 0,
      setupTokenRequired: true,
      devTokenExposed: Boolean(config.exposeSetupToken && tenants === 0),
      setupToken: config.exposeSetupToken && tenants === 0 ? config.setupToken : undefined,
      note: 'Onboarding is authenticated by a server-side setup token. New tenants start completely empty.',
    });
  }));

  const setupSchema = z.object({
    setupToken: z.string().min(8),
    legalName: z.string().min(3).max(200),
    tradeName: z.string().max(200).optional(),
    branchName: z.string().max(200).optional(),
    address: z.string().max(500).optional(),
    stateCode: z.string().regex(/^\d{2}$/),
    profile: z.enum(['regular', 'composition', 'unregistered']).optional(),
    gstin: z.string().max(20).optional(),
    identityEvidence: z.string().min(8).max(500),
    eInvoiceStatus: z.enum(['unverified', 'reviewed_not_applicable', 'applicable']).optional(),
    eInvoiceNote: z.string().max(500).optional(),
    ownerName: z.string().min(2).max(120),
    ownerEmail: z.string().email().max(200),
    ownerPassword: z.string().min(10).max(300),
  });

  router.post('/setup', wrap(async (req, res) => {
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Setup details are invalid', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    if (parsed.data.setupToken !== config.setupToken) {
      throw forbidden('The setup token is invalid. Use the token printed by the server (or set SHOPDESK_SETUP_TOKEN).');
    }
    const tenants = await store.collection('tenants').countDocuments({});
    if (tenants > 0) throw new AppError('Setup has already been completed for this installation', { status: 409, code: 'SETUP_COMPLETE' });
    const created = await createTenant(store, parsed.data);
    const { token } = await store.transaction(async () =>
      startSession(store, created.user, {
        tenantId: created.tenant._id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      })
    );
    res.setHeader('Set-Cookie', cookieHeader(token, { secure: config.secureCookies, maxAgeSeconds: config.sessionHours * 3600 }));
    res.status(201).json({ ok: true, tenantId: created.tenant._id, branchId: created.branch._id, emptyTenant: true });
  }));

  router.post('/login', wrap(async (req, res) => {
    const schema = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(300) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Email and password are required');
    const { email, password } = parsed.data;
    rateLimit(`login:${req.ip}:${String(email).toLowerCase()}`, { max: 10 });
    const user = await findUserByEmail(store, email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!ok || !user || user.status !== 'active') {
      throw new AppError('Email or password is incorrect', { status: 401, code: 'INVALID_CREDENTIALS' });
    }
    const memberships = await store.collection('memberships').find({ userId: user._id, status: 'active' });
    if (memberships.length === 0) throw forbidden('This account has no active clinic membership');
    const { token } = await store.transaction(async () =>
      startSession(store, user, {
        tenantId: memberships[0].tenantId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      })
    );
    res.setHeader('Set-Cookie', cookieHeader(token, { secure: config.secureCookies, maxAgeSeconds: config.sessionHours * 3600 }));
    res.json({ ok: true, userId: user._id });
  }));

  router.post('/logout', wrap(async (req, res) => {
    if (req.ctx) {
      await store.transaction(async () => {
        await store.collection('sessions').updateOne(
          { _id: req.ctx.sessionId },
          { $set: { revokedAt: new Date(), revokedReason: 'logout' } }
        );
      });
    }
    res.setHeader('Set-Cookie', clearCookieHeader({ secure: config.secureCookies }));
    res.json({ ok: true });
  }));

  router.get('/session', wrap(async (req, res) => {
    if (!req.ctx) {
      res.json({ authenticated: false, setup: await store.collection('tenants').countDocuments({}) === 0 });
      return;
    }
    const ctx = req.ctx;
    let tenantDoc = null;
    let branch = null;
    let membershipsInfo = [];
    if (ctx.tenantId) {
      tenantDoc = await store.collection('tenants').findOne({ _id: ctx.tenantId });
      branch = ctx.branchId ? await store.collection('branches').findOne({ _id: ctx.branchId, tenantId: ctx.tenantId }) : null;
      const branches = await store.collection('branches').find({ tenantId: ctx.tenantId });
      membershipsInfo = await Promise.all(
        ctx.memberships.map(async (m) => {
          const t = await store.collection('tenants').findOne({ _id: m.tenantId });
          return { tenantId: m.tenantId, tenantName: t?.tradeName || t?.name, role: m.role };
        })
      );
      res.json({
        authenticated: true,
        user: { id: ctx.userId, name: ctx.userName, email: ctx.userEmail },
        tenant: tenantDoc
          ? {
              id: tenantDoc._id,
              name: tenantDoc.tradeName || tenantDoc.name,
              legalName: tenantDoc.legalName,
              sample: Boolean(tenantDoc.sample),
              identityVerified: tenantDoc.identityVerified === true,
              stateCode: tenantDoc.stateCode,
            }
          : null,
        branch: branch ? { id: branch._id, name: branch.name, code: branch.code } : null,
        branches: branches.map((b) => ({ id: b._id, name: b.name, code: b.code })),
        role: ctx.role,
        roleLabel: ROLES[ctx.role]?.label || ctx.role,
        permissions: permissionSnapshot(ctx),
        navigation: navFor(ctx),
        memberships: membershipsInfo,
        csrfToken: ctx.csrfToken,
        permissionLabels: PERMISSION_LABELS,
        roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
        driver: config.mongoUri ? 'mongodb' : 'file',
        serverTime: new Date().toISOString(),
        businessDate: businessDate(),
        disclaimer:
          'shop desk is billing/inventory/accounting software. It is not a tax opinion, GST filing service, e-invoice provider or audited-statements generator.',
      });
      return;
    }
    res.json({ authenticated: true, user: { id: ctx.userId, name: ctx.userName, email: ctx.userEmail }, tenant: null });
  }));

  router.post('/tenant-switch', wrap(async (req, res) => {
    const ctx = requireSession(req.ctx);
    const tenantId = String(req.body?.tenantId || '');
    const membership = ctx.memberships.find((m) => m.tenantId === tenantId);
    if (!membership) throw forbidden('You are not a member of that workspace');
    await store.transaction(async () => {
      await store.collection('sessions').updateOne({ _id: ctx.sessionId }, { $set: { activeTenantId: tenantId } });
      await appendAudit(
        { ...ctx, tenantId, membershipId: membership._id, role: membership.role, permissions: membership.permissions, allowedBranchIds: membership.branchIds, branchId: membership.branchIds?.[0] },
        { action: 'session.tenant_switched', entityType: 'session', entityId: ctx.sessionId, after: { tenantId } }
      );
    });
    res.json({ ok: true, tenantId });
  }));

  router.get('/permissions', wrap(async (req, res) => {
    const ctx = requireSession(req.ctx);
    res.json({
      roles: ROLES,
      roleKeys: ROLE_KEYS,
      permissionLabels: PERMISSION_LABELS,
      navigation: NAV_ITEMS,
      current: permissionSnapshot(ctx),
    });
  }));

  /* -------------------------------------------------------------- workspace */

  router.get('/overview', wrap(async (req, res) => {
    const ctx = tenant(req);
    const canAll = hasPermission(ctx.permissions, 'overview.all') || hasPermission(ctx.permissions, 'reports.read');
    const { runReport: rr } = await import('./domain/reports.js');
    const summary = await rr(ctx, 'summary', { preset: req.query.preset || 'month' });
    const stockRows = (await rr(ctx, 'stock', { preset: 'all' })).rows;
    const expiry = (await rr(ctx, 'expiry', { preset: 'all' })).rows;
    const lowStock = stockRows.filter((r) => BigInt(r.availableScaled) <= 0n).slice(0, 10);
    const readiness = await tenantReadiness(ctx);
    const result = {
      period: summary.period,
      cards: canAll ? summary.cards : summary.cards.filter((c) => c.key !== 'cost' && c.key !== 'margin'),
      alerts: {
        lowStock,
        nearExpiry: expiry.filter((e) => e.daysToExpiry <= 60).slice(0, 10),
        readinessBlockers: readiness.blockers,
      },
      definitions: summary.definitions,
      scope: canAll ? 'whole clinic' : 'your own authorised work',
      businessDate: businessDate(),
    };
    if (!canAll) {
      // Cashier scope: only their own issued documents/receipts in the period.
      const { resolvePeriod } = await import('./time.js');
      const period = resolvePeriod({ preset: req.query.preset || 'month' });
      const invoices = (await repo(ctx, 'financial_documents').find({ cashierId: ctx.userId })).filter(
        (d) => new Date(d.issuedAt) >= period.from && new Date(d.issuedAt) < period.to
      );
      const receipts = (await repo(ctx, 'payments').find({ recordedBy: ctx.userId, kind: 'receipt', status: 'confirmed' })).filter(
        (p) => new Date(p.at) >= period.from && new Date(p.at) < period.to
      );
      result.self = {
        invoices: invoices.length,
        grossBilledPaise: invoices.reduce((a, d) => a + BigInt(d.totals.totalPaise), 0n).toString(),
        confirmedReceiptsPaise: receipts.reduce((a, p) => a + BigInt(p.amountPaise), 0n).toString(),
      };
      result.cards = [];
    }
    res.json(result);
  }));

  /* --------------------------------------------------------------- products */

  router.get('/products', requirePermission('products.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const { limit } = paging(req);
    const search = String(req.query.search || '').trim();
    const productFilter = req.query.includeArchived === 'true' ? {} : { status: 'active' };
    const rows = await repo(ctx, 'products').find(productFilter, { sort: { name: 1 } });
    const filtered = search
      ? rows.filter((p) =>
          [p.name, p.sku, p.barcode, p.category, p.hsn]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(search.toLowerCase()))
        )
      : rows;
    const branchId = req.query.branchId || ctx.branchId;
    const availability = branchId ? await availabilityFor(ctx, { branchId, productIds: filtered.map((p) => p._id) }) : new Map();
    const canCost = hasPermission(ctx.permissions, 'inventory.cost');
    const stock = await repo(ctx, 'stock_balances').find({ branchId });
    const valueMap = new Map();
    for (const balance of stock) valueMap.set(balance.productId, (valueMap.get(balance.productId) || 0n) + BigInt(balance.availableScaled));
    res.json({
      products: filtered.slice(0, limit).map((p) => {
        const out = publicProduct(p);
        out.availableScaled = (availability.get(p._id) || 0n).toString();
        if (canCost) {
          out.quantityOnHandScaled = (valueMap.get(p._id) || 0n).toString();
        }
        return out;
      }),
      canSeeCost: canCost,
    });
  }));

  router.post('/products', requirePermission('products.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const product = await store.transaction(async () => {
      const created = await createProduct(ctx, req.body || {});
      await appendAudit(ctx, { action: 'product.created', entityType: 'product', entityId: created._id, after: { name: created.name, hsn: created.hsn, taxRateBps: created.taxRateBps } });
      return created;
    });
    res.status(201).json({ product: publicProduct(product) });
  }));

  router.patch('/products/:id', requirePermission('products.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const product = await store.transaction(async () => {
      const updated = await updateProduct(ctx, req.params.id, req.body || {});
      await appendAudit(ctx, { action: 'product.updated', entityType: 'product', entityId: req.params.id, after: req.body });
      return updated;
    });
    res.json({ product: publicProduct(product) });
  }));

  router.post('/products/:id/classification-review', requirePermission('products.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const product = await store.transaction(async () => {
      const updated = await reviewClassification(ctx, req.params.id, req.body || {});
      await appendAudit(ctx, {
        action: 'product.classification_reviewed',
        entityType: 'product',
        entityId: req.params.id,
        reason: updated.classificationEvidence,
        after: { hsn: updated.hsn, taxRateBps: updated.taxRateBps, taxTreatment: updated.taxTreatment },
      });
      return updated;
    });
    res.json({ product: publicProduct(product) });
  }));

  router.post('/products/:id/archive', requirePermission('products.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const product = await store.transaction(async () => {
      const archived = await archiveProduct(ctx, req.params.id, req.body?.reason);
      await appendAudit(ctx, { action: 'product.archived', entityType: 'product', entityId: req.params.id, reason: req.body?.reason });
      return archived;
    });
    res.json({ product: publicProduct(product) });
  }));

  /* ---------------------------------------------------------- parties/pets */

  router.get('/customers', requirePermission('customers.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const search = String(req.query.search || '').trim().toLowerCase();
    const rows = await repo(ctx, 'customers').find({ status: 'active' }, { sort: { name: 1 } });
    res.json({ customers: search ? rows.filter((c) => c.nameLower.includes(search) || (c.phone || '').includes(search)) : rows });
  }));

  router.post('/customers', requirePermission('customers.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const customer = await store.transaction(async () => {
      const created = await createCustomer(ctx, req.body || {});
      await appendAudit(ctx, { action: 'customer.created', entityType: 'customer', entityId: created._id, after: { name: created.name } });
      return created;
    });
    res.status(201).json({ customer });
  }));

  router.patch('/customers/:id', requirePermission('customers.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const customer = await store.transaction(async () => {
      const updated = await updateCustomer(ctx, req.params.id, req.body || {});
      await appendAudit(ctx, { action: 'customer.updated', entityType: 'customer', entityId: req.params.id, after: req.body });
      return updated;
    });
    res.json({ customer });
  }));

  router.get('/customers/:id/statement', requirePermission('payments.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const invoices = await repo(ctx, 'financial_documents').find({ kind: 'invoice', partyId: req.params.id });
    const payments = await repo(ctx, 'payments').find({ partyId: req.params.id });
    const returns = await repo(ctx, 'returns').find({ partyId: req.params.id });
    res.json({ invoices, payments, returns });
  }));

  router.get('/pets', requirePermission('pets.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const filter = req.query.customerId ? { customerId: String(req.query.customerId) } : {};
    res.json({ pets: await repo(ctx, 'pets').find(filter, { sort: { name: 1 } }) });
  }));

  router.post('/pets', requirePermission('pets.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const pet = await store.transaction(() => createPet(ctx, req.body || {}));
    res.status(201).json({ pet });
  }));

  router.get('/suppliers', requirePermission('suppliers.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json({ suppliers: await repo(ctx, 'suppliers').find({ status: 'active' }, { sort: { name: 1 } }) });
  }));

  router.post('/suppliers', requirePermission('suppliers.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const supplier = await store.transaction(async () => {
      const created = await createSupplier(ctx, req.body || {});
      await appendAudit(ctx, { action: 'supplier.created', entityType: 'supplier', entityId: created._id, after: { name: created.name } });
      return created;
    });
    res.status(201).json({ supplier });
  }));

  /* ----------------------------------------------------------------- stock */

  router.get('/stock', requirePermission('inventory.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const branchId = req.query.branchId || ctx.branchId;
    const balances = await repo(ctx, 'stock_balances').find({ branchId });
    const batches = await repo(ctx, 'batch_lots').find({ branchId });
    const products = await repo(ctx, 'products').find({});
    const canCost = hasPermission(ctx.permissions, 'inventory.cost');
    const rows = balances.map((b) => {
      const batch = batches.find((x) => x._id === b.batchId);
      const product = products.find((p) => p._id === b.productId);
      const row = {
        batchId: b.batchId,
        productId: b.productId,
        product: product?.name,
        sku: product?.sku,
        uom: product?.uom,
        quantityScale: product?.quantityScale ?? 3,
        batchNo: batch?.batchNo,
        expiry: batch?.expiry,
        status: batch?.status,
        availableScaled: b.availableScaled,
        nonSaleableScaled: b.nonSaleableScaled,
        reservedScaled: b.reservedScaled,
        available: formatScaled(BigInt(b.availableScaled), product?.quantityScale ?? 3),
        nonSaleable: formatScaled(BigInt(b.nonSaleableScaled || '0'), product?.quantityScale ?? 3),
      };
      if (canCost) row.costPoolPaise = batch?.receivedCostPaise;
      return row;
    });
    res.json({ rows, quantityOnly: !canCost });
  }));

  router.get('/stock/batches', requirePermission('inventory.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const product = await repo(ctx, 'products').findOne({ _id: req.query.productId });
    if (!product) throw notFound('product not found');
    const batches = await eligibleBatches(ctx, {
      branchId: req.query.branchId || ctx.branchId,
      product,
      now: new Date(),
    });
    res.json({
      batches: batches.map((b) => ({
        batchId: b._id,
        batchNo: b.batchNo,
        expiry: b.expiry,
        availableScaled: b.balance.availableScaled,
        status: b.status,
      })),
    });
  }));

  router.get('/stock/movements', requirePermission('inventory.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const filter = { branchId: req.query.branchId || ctx.branchId };
    if (req.query.productId) filter.productId = req.query.productId;
    res.json({ movements: await repo(ctx, 'inventory_movements').find(filter, { sort: { at: -1 }, limit: 200 }) });
  }));

  router.post('/stock/adjustments', requirePermission('inventory.adjust'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const body = req.body || {};
    const result = await store.transaction(async () => {
      const adjustmentId = newId();
      const adjustment = await postStockAdjustment(ctx, { ...body, adjustmentId });
      if (!adjustment.isIncrease) {
        const { postWriteOff } = await import('./domain/accounting.js');
        await postWriteOff(ctx, {
          adjustment: { _id: adjustmentId, type: adjustment.type, reason: body.reason, costPaise: adjustment.costPaise.toString(), accountCode: '5100' },
          businessDate: body.businessDate || businessDate(),
          branchId: body.branchId || ctx.branchId,
        });
      }
      await appendAudit(ctx, {
        action: 'stock.adjusted',
        entityType: 'stock_adjustment',
        entityId: adjustmentId,
        branchId: body.branchId || ctx.branchId,
        reason: body.reason,
        after: { type: adjustment.type, quantityScaled: adjustment.quantity.toString(), costPaise: adjustment.costPaise.toString() },
      });
      return { adjustmentId, type: adjustment.type, quantity: adjustment.quantity.toString() };
    });
    res.status(201).json(result);
  }));

  router.post('/batches/:id/status', requirePermission('inventory.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const batch = await store.transaction(async () => {
      const updated = await setBatchStatus(ctx, { batchId: req.params.id, status: req.body?.status, reason: req.body?.reason });
      await appendAudit(ctx, {
        action: 'batch.status_changed',
        entityType: 'batch',
        entityId: req.params.id,
        reason: req.body?.reason,
        after: { status: updated.status },
      });
      return updated;
    });
    res.json({ batch });
  }));

  /* ------------------------------------------------------------- purchases */

  router.get('/purchases', requirePermission('inventory.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const rows = await listPurchases(ctx, { ...paging(req), supplierId: req.query.supplierId });
    const canCost = hasPermission(ctx.permissions, 'inventory.cost');
    res.json({
      purchases: rows.map((p) =>
        canCost
          ? p
          : {
              ...p,
              totals: { taxableValuePaise: p.totals.taxableValuePaise, taxPaise: p.totals.taxPaise, totalPaise: p.totals.totalPaise },
              lines: p.lines.map((l) => ({ ...l, unitCostPaise: undefined, costPaise: undefined })),
            }
      ),
      quantityOnly: !canCost,
    });
  }));

  router.get('/purchases/:id', requirePermission('inventory.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const data = await getPurchase(ctx, req.params.id);
    if (!hasPermission(ctx.permissions, 'inventory.cost')) {
      data.purchase.lines = data.purchase.lines.map((l) => ({ ...l, unitCostPaise: undefined }));
    }
    res.json(data);
  }));

  router.post('/purchases', requirePermission('purchases.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await postPurchase(ctx, req.body || {}, { idempotencyKey: idempotency(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  router.post('/purchases/:id/itc-review', requirePermission('purchases.review_tax'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await reviewInputTax(ctx, req.params.id, req.body || {}));
  }));

  router.post('/supplier-returns', requirePermission('purchases.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await createSupplierReturn(ctx, req.body || {}, { idempotencyKey: idempotency(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  router.post('/supplier-returns/:id/credit-note', requirePermission('purchases.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await store.transaction(() => recordSupplierCreditNote(ctx, req.params.id, req.body || {})));
  }));

  /* ----------------------------------------------------------------- sales */

  router.get('/sales-drafts', requirePermission('billing.use'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const filter = { status: req.query.status || 'draft' };
    if (!hasPermission(ctx.permissions, 'returns.create')) filter.cashierId = ctx.userId;
    res.json({ drafts: await repo(ctx, 'sales_drafts').find(filter, { sort: { updatedAt: -1 }, limit: 50 }) });
  }));

  router.post('/sales-drafts', requirePermission('billing.use'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await store.transaction(() => createDraft(ctx, req.body || {}));
    res.status(201).json(toDraftResponse(result));
  }));

  router.get('/sales-drafts/:id', requirePermission('billing.use'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await quoteDraft(ctx, req.params.id);
    res.json(toDraftResponse(result));
  }));

  router.put('/sales-drafts/:id', requirePermission('billing.use'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await updateDraft(ctx, req.params.id, req.body || {});
    res.json(toDraftResponse(result));
  }));

  router.post('/sales-drafts/:id/quote', requirePermission('billing.use'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(toDraftResponse(await quoteDraft(ctx, req.params.id)));
  }));

  router.post('/sales-drafts/:id/discard', requirePermission('billing.use'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await discardDraft(ctx, req.params.id, req.body?.reason));
  }));

  router.post('/sales-drafts/:id/finalize', requirePermission('billing.use'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await finalizeDraft(ctx, req.params.id, req.body || {}, { idempotencyKey: idempotency(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  function toDraftResponse(result) {
    const { quote, blockers, availability, quoteHash, draft, branch, customer } = result;
    const canCost = result.canCost;
    return {
      draft: {
        id: draft._id,
        version: draft.version,
        status: draft.status,
        branchId: draft.branchId,
        registrationId: draft.registrationId,
        customerId: draft.customerId,
        petId: draft.petId,
        lines: draft.lines,
        invoiceDiscountPaise: draft.invoiceDiscountPaise,
        notes: draft.notes,
        cashierName: draft.cashierName,
      },
      quote: {
        lines: quote.lines,
        rateGroups: quote.rateGroups,
        totals: quote.totals,
        docKind: quote.docKind,
        supplyMode: quote.supplyMode,
        policy: quote.policy,
      },
      quoteHash,
      blockers,
      availability,
      branch: { id: branch._id, name: branch.name },
      customer: customer ? { id: customer._id, name: customer.name, gstin: customer.gstin } : null,
    };
  }

  /* ------------------------------------------------------------- documents */

  router.get('/documents', requirePermission('documents.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const { resolvePeriod } = await import('./time.js');
    const period = resolvePeriod({ preset: req.query.preset || 'all', from: req.query.from, to: req.query.to });
    const rows = await listDocuments(ctx, {
      kind: req.query.kind || 'invoice',
      from: period.from,
      to: period.to,
      partyId: req.query.partyId,
      limit: req.query.limit,
    });
    const canCost = hasPermission(ctx.permissions, 'documents.read.cost');
    const visible = rows.map((d) => {
      const copy = { ...d };
      if (!canCost) copy.lines = d.lines.map((l) => ({ ...l, costPaise: undefined }));
      return copy;
    });
    res.json({ documents: visible, canSeeCost: canCost, templates: templateChoices() });
  }));

  router.get('/documents/:id', requirePermission('documents.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const data = await getDocument(ctx, req.params.id);
    const canCost = hasPermission(ctx.permissions, 'documents.read.cost');
    if (!canCost) {
      data.document.lines = data.document.lines.map((l) => ({ ...l, costPaise: undefined, batchAllocations: l.batchAllocations.map((b) => ({ ...b, costPaise: undefined })) }));
    }
    res.json({ ...data, canSeeCost: canCost, templates: templateChoices() });
  }));

  router.get('/documents/:id/print', requirePermission('documents.print'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const { document } = await getDocument(ctx, req.params.id);
    const tenantDoc = await getTenantRecord(ctx);
    const html = renderDocumentHtml({
      document,
      template: req.query.template || 'corporate',
      tenant: tenantDoc,
      asOf: new Date().toISOString(),
    });
    await store.transaction(async () => {
      await appendAudit(ctx, {
        action: 'document.printed',
        entityType: 'document',
        entityId: req.params.id,
        meta: { template: req.query.template || 'corporate', reprint: true },
      });
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.send(html);
  }));

  router.get('/documents/:id/return-preview', requirePermission('documents.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await buildReturnPreview(ctx, req.params.id));
  }));

  router.post('/documents/:id/returns', requirePermission('returns.create'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await createReturn(ctx, req.params.id, req.body || {}, { idempotencyKey: idempotency(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  router.post('/documents/:id/debit-notes', requirePermission('accounts.post'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await createDebitNote(ctx, req.params.id, req.body || {}, { idempotencyKey: idempotency(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  router.get('/documents/:id/settlement', requirePermission('documents.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const document = await repo(ctx, 'financial_documents').findOne({ _id: req.params.id });
    if (!document) throw notFound('document not found');
    res.json(await settlementFor(ctx, document));
  }));

  router.get('/returns', requirePermission('documents.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json({ returns: await listReturns(ctx, paging(req)) });
  }));

  router.get('/returns/:id', requirePermission('documents.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await getReturn(ctx, req.params.id));
  }));

  router.get('/returns/:id/print', requirePermission('documents.print'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const { return: ret } = await getReturn(ctx, req.params.id);
    const tenantDoc = await getTenantRecord(ctx);
    const html = renderDocumentHtml({ document: ret, template: req.query.template || 'corporate', tenant: tenantDoc });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(html);
  }));

  /* -------------------------------------------------------------- payments */

  router.get('/payments', requirePermission('payments.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const { resolvePeriod } = await import('./time.js');
    const period = resolvePeriod({ preset: req.query.preset || 'month', from: req.query.from, to: req.query.to });
    const rows = await listPayments(ctx, { from: period.from, to: period.to, limit: req.query.limit });
    res.json({ payments: rows, period: { fromDate: period.fromDate, toDate: period.toDate, label: period.label } });
  }));

  router.post('/payments', requirePermission('payments.record'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await recordReceipt(ctx, req.body || {}, { idempotencyKey: idempotency(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  router.post('/refunds', requirePermission('payments.refund'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await recordRefund(ctx, req.body || {}, { idempotencyKey: idempotency(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  router.post('/payments/:id/reverse', requirePermission('payments.record'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await reverseReceipt(ctx, req.params.id, req.body || {}));
  }));

  router.post('/payment-intents', requirePermission('payments.record'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.status(201).json(await createPendingIntent(ctx, req.body || {}, { idempotencyKey: idempotency(req) }));
  }));

  router.post('/payment-intents/:id/confirm', requirePermission('payments.pending.confirm'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await confirmPendingIntent(ctx, req.params.id, req.body || {}));
  }));

  router.get('/payment-intents', requirePermission('payments.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json({ intents: await repo(ctx, 'payment_intents').find({}, { sort: { createdAt: -1 }, limit: 100 }) });
  }));

  router.post('/cash-close', requirePermission('cash.close'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.status(201).json(await cashClose(ctx, req.body || {}));
  }));

  router.get('/cash-close', requirePermission('payments.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json({ closes: await repo(ctx, 'cash_closes').find({}, { sort: { createdAt: -1 }, limit: 60 }) });
  }));

  /* -------------------------------------------------------------- accounts */

  router.get('/accounts', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const accounts = await repo(ctx, 'ledger_accounts').find({}, { sort: { code: 1 } });
    const tb = await trialBalance(ctx, { from: req.query.from, to: req.query.to });
    res.json({ accounts, trialBalance: tb });
  }));

  router.get('/accounts/trial-balance', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await trialBalance(ctx, { from: req.query.from, to: req.query.to }));
  }));

  router.get('/accounts/pnl', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await profitAndLoss(ctx, { from: req.query.from, to: req.query.to }));
  }));

  router.get('/accounts/balance-sheet', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await balanceSheet(ctx, { from: req.query.from, to: req.query.to }));
  }));

  router.get('/accounts/reconciliation', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json({ reconciliation: await reconcile(ctx), valuation: await inventoryValuation(ctx) });
  }));

  router.get('/accounts/parties', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const balances = await partyBalances(ctx);
    res.json({
      customers: [...balances.customers.entries()].map(([id, balance]) => ({ partyId: id, balancePaise: balance.toString() })),
      suppliers: [...balances.suppliers.entries()].map(([id, balance]) => ({ partyId: id, balancePaise: balance.toString() })),
      unassignedReceivablePaise: balances.unassignedReceivablePaise,
    });
  }));

  router.get('/accounts/journals', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const entries = await repo(ctx, 'journal_entries').find({}, { sort: { postedAt: -1 }, limit: 100 });
    const lines = await repo(ctx, 'journal_lines').find({});
    res.json({
      entries: entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entryId === e._id) })),
    });
  }));

  router.post('/accounts/journals', requirePermission('accounts.post'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const body = req.body || {};
    if (!Array.isArray(body.lines) || body.lines.length < 2) throw badRequest('a journal needs at least two lines');
    const result = await store.transaction(async () => {
      const sourceEventId = body.sourceEventId || newId();
      const entry = await postJournal(ctx, {
        sourceEventId,
        postingKind: body.postingKind || 'manual',
        businessDate: body.businessDate || businessDate(),
        narration: body.narration || 'Manual journal',
        branchId: body.branchId || ctx.branchId,
        lines: body.lines,
      });
      await appendAudit(ctx, {
        action: 'journal.posted',
        entityType: 'journal_entry',
        entityId: entry.entry._id,
        reason: body.narration,
        after: { totalDebitPaise: entry.entry.totalDebitPaise, lines: body.lines.length },
      });
      return entry;
    });
    res.status(201).json({ entry: result.entry, lines: result.lines });
  }));

  router.post('/accounts/journals/:id/reverse', requirePermission('accounts.review'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const result = await store.transaction(async () => {
      const reversed = await reverseJournal(ctx, {
        entryId: req.params.id,
        reason: req.body?.reason,
        businessDate: req.body?.businessDate || businessDate(),
      });
      await appendAudit(ctx, {
        action: 'journal.reversed',
        entityType: 'journal_entry',
        entityId: req.params.id,
        reason: req.body?.reason,
        after: { reversalId: reversed.entry._id },
      });
      return reversed;
    });
    res.status(201).json(result);
  }));

  router.post('/expenses', requirePermission('accounts.post'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.status(201).json(await recordExpense(ctx, req.body || {}, { idempotencyKey: idempotency(req) }));
  }));

  router.post('/openings', requirePermission('accounts.post'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.status(201).json(await postOpening(ctx, req.body || {}, { idempotencyKey: idempotency(req) }));
  }));

  router.get('/period-locks', requirePermission('accounts.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json({ locks: await repo(ctx, 'period_locks').find({}, { sort: { year: -1, month: -1 } }) });
  }));

  router.post('/period-locks', requirePermission('accounts.period'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const year = Number(req.body?.year);
    const month = Number(req.body?.month);
    if (!year || !month || month < 1 || month > 12) throw badRequest('year and month (1–12) are required');
    if (!req.body?.reason) throw badRequest('a reason is required to lock an accounting period');
    const lock = await store.transaction(async () => {
      const existing = await repo(ctx, 'period_locks').findOne({ year, month });
      if (existing) {
        await repo(ctx, 'period_locks').updateOne({ _id: existing._id }, { $set: { status: 'locked', lockedBy: ctx.userId, lockedAt: new Date(), reason: req.body.reason } });
        return { ...existing, status: 'locked' };
      }
      const doc = { _id: newId(), year, month, status: 'locked', reason: String(req.body.reason).slice(0, 300), lockedBy: ctx.userId, lockedAt: new Date() };
      await repo(ctx, 'period_locks').insertOne(doc);
      await appendAudit(ctx, { action: 'period.locked', entityType: 'period_lock', entityId: doc._id, reason: doc.reason, after: { year, month } });
      return doc;
    });
    res.status(201).json({ lock });
  }));

  router.delete('/period-locks/:id', requirePermission('accounts.period'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const lock = await repo(ctx, 'period_locks').findOne({ _id: req.params.id });
    if (!lock) throw notFound('period lock not found');
    await store.transaction(async () => {
      await repo(ctx, 'period_locks').updateOne(
        { _id: lock._id },
        { $set: { status: 'open', reopenedBy: ctx.userId, reopenedAt: new Date(), reopenReason: req.body?.reason || null } }
      );
      await appendAudit(ctx, {
        action: 'period.reopened',
        entityType: 'period_lock',
        entityId: lock._id,
        reason: req.body?.reason || null,
        before: { status: 'locked' },
        after: { status: 'open' },
      });
    });
    res.json({ ok: true });
  }));

  /* --------------------------------------------------------------- reports */

  router.get('/reports', wrap(async (req, res) => {
    res.json({
      coreTabs: CORE_TABS.map((key) => ({ key, label: TAB_LABELS[key] })),
      extraTabs: EXTRA_TABS.map((key) => ({ key, label: TAB_LABELS[key] })),
      presets: ['today', '7d', 'month', 'last_month', 'fy', 'all', 'custom'],
    });
  }));

  router.get('/reports/:tab', requirePermission('reports.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const report = await runReport(ctx, req.params.tab, periodQuery(req));
    res.json(report);
  }));

  router.get('/reports/:tab.csv', requirePermission('reports.export'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const report = await runReport(ctx, req.params.tab, periodQuery(req));
    const csv = toCsv(report);
    await store.transaction(async () => {
      await appendAudit(ctx, {
        action: 'report.exported',
        entityType: 'report',
        entityId: req.params.tab,
        meta: { format: 'csv', period: report.period, quantityOnly: report.quantityOnly },
      });
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shopdesk-${req.params.tab}-${report.period.fromDate}-to-${report.period.toDate}.csv"`);
    res.send(csv);
  }));

  /* -------------------------------------------------------------- settings */

  router.get('/settings', requirePermission('settings.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await getSettingsBundle(ctx));
  }));

  router.get('/readiness', requirePermission('reports.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await tenantReadiness(ctx));
  }));

  router.patch('/settings/tenant', requirePermission('settings.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const tenantDoc = await store.transaction(async () => {
      const updated = await updateTenantSettings(ctx, req.body || {});
      await appendAudit(ctx, { action: 'settings.tenant_updated', entityType: 'tenant', entityId: ctx.tenantId, after: req.body });
      return updated;
    });
    res.json({ tenant: tenantDoc });
  }));

  router.patch('/settings/registrations/:id', requirePermission('settings.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const registration = await store.transaction(async () => {
      const updated = await updateRegistration(ctx, req.params.id, req.body || {});
      await appendAudit(ctx, {
        action: 'settings.registration_updated',
        entityType: 'registration',
        entityId: req.params.id,
        after: { profile: updated.profile, series: updated.series, eInvoice: updated.eInvoice?.status, verified: updated.status },
      });
      return updated;
    });
    res.json({ registration });
  }));

  router.patch('/settings/rules/:key', requirePermission('settings.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const rule = await store.transaction(async () => {
      const updated = await updateLegalRule(ctx, req.params.key, req.body || {});
      await appendAudit(ctx, {
        action: 'settings.legal_rule_updated',
        entityType: 'legal_rule',
        entityId: rule_id(ctx, req.params.key),
        after: { key: req.params.key, state: updated.state, reviewer: updated.reviewer },
      });
      return updated;
    });
    res.json({ rule });
  }));

  function rule_id(ctx, key) {
    return sha256(`${ctx.tenantId}:${key}`).slice(0, 24);
  }

  router.post('/branches', requirePermission('settings.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const branch = await store.transaction(() => createBranch(ctx, req.body || {}));
    res.status(201).json({ branch });
  }));

  /* ----------------------------------------------------------------- staff */

  router.get('/staff', requirePermission('staff.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const memberships = await repo(ctx, 'memberships').find({});
    const users = await Promise.all(memberships.map((m) => store.collection('users').findOne({ _id: m.userId })));
    res.json({
      staff: memberships.map((m, i) => ({
        membershipId: m._id,
        userId: m.userId,
        name: users[i]?.name,
        email: users[i]?.emailLower,
        role: m.role,
        branchIds: m.branchIds,
        status: m.status,
        permissions: m.permissions,
        createdAt: m.createdAt,
      })),
      roles: ROLES,
      invitations: await repo(ctx, 'invitations').find({ usedAt: null }, { sort: { createdAt: -1 } }),
    });
  }));

  router.post('/staff/invite', requirePermission('staff.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const schema = z.object({
      email: z.string().email().max(200),
      role: z.enum(ROLE_KEYS.filter((r) => r !== 'owner' && r !== 'platform_operator')),
      branchIds: z.array(z.string()).optional(),
      permissions: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invitation details are invalid', parsed.error.issues);
    const { randomBytes, createHash } = await import('node:crypto');
    const token = randomBytes(24).toString('base64url');
    const allowed = parsed.data.permissions?.filter((p) => PERMISSION_LABELS[p]) || [];
    const invitation = await store.transaction(async () => {
      const doc = {
        _id: newId(),
        emailLower: parsed.data.email.toLowerCase(),
        role: parsed.data.role,
        permissions: allowed.length ? [...ROLES[parsed.data.role].permissions.filter((p) => p !== '*'), ...allowed] : ROLES[parsed.data.role].permissions,
        branchIds: parsed.data.branchIds || [ctx.branchId],
        tokenHash: createHash('sha256').update(token).digest('hex'),
        invitedBy: ctx.userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        usedAt: null,
      };
      await repo(ctx, 'invitations').insertOne(doc);
      await appendAudit(ctx, {
        action: 'staff.invited',
        entityType: 'invitation',
        entityId: doc._id,
        after: { email: doc.emailLower, role: doc.role, branchIds: doc.branchIds },
      });
      return doc;
    });
    res.status(201).json({
      invitationId: invitation._id,
      inviteToken: token,
      expiresAt: invitation.expiresAt,
      delivery: 'No email provider is configured. Share this one-time token through an approved channel.',
    });
  }));

  router.post('/invitations/accept', wrap(async (req, res) => {
    const schema = z.object({
      token: z.string().min(10),
      name: z.string().min(2).max(120),
      password: z.string().min(10).max(300),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invitation acceptance details are invalid', parsed.error.issues);
    const tokenHash = sha256(parsed.data.token);
    const invitation = await store.collection('invitations').findOne({ tokenHash });
    if (!invitation || invitation.usedAt) throw unprocessable('This invitation is invalid or already used');
    if (new Date(invitation.expiresAt).getTime() < Date.now()) throw unprocessable('This invitation has expired');
    const result = await store.transaction(async () => {
      let user = await findUserByEmail(store, invitation.emailLower);
      if (!user) {
        const ctx = { store, tenantId: invitation.tenantId, userId: null, now: () => new Date() };
        user = await createUser(ctx, {
          name: parsed.data.name,
          email: invitation.emailLower,
          password: parsed.data.password,
        });
      } else {
        const ok = await verifyPassword(parsed.data.password, user.passwordHash);
        if (!ok) throw forbidden('An account already exists for this email; sign in instead of accepting the invitation');
      }
      const existing = await store.collection('memberships').findOne({ tenantId: invitation.tenantId, userId: user._id });
      if (!existing) {
        await store.collection('memberships').insertOne({
          _id: newId(),
          tenantId: invitation.tenantId,
          userId: user._id,
          role: invitation.role,
          permissions: invitation.permissions,
          branchIds: invitation.branchIds,
          status: 'active',
          createdAt: new Date(),
          createdBy: invitation.invitedBy,
        });
      }
      await store.collection('invitations').updateOne({ _id: invitation._id }, { $set: { usedAt: new Date(), usedBy: user._id } });
      const auditCtx = {
        store,
        tenantId: invitation.tenantId,
        userId: user._id,
        actorName: user.name,
        allowedBranchIds: invitation.branchIds,
        branchId: invitation.branchIds?.[0],
        now: () => new Date(),
      };
      await appendAudit(auditCtx, { action: 'staff.invitation_accepted', entityType: 'membership', entityId: user._id, after: { role: invitation.role } });
      const { token } = await startSession(store, user, { tenantId: invitation.tenantId, ip: req.ip, userAgent: req.get('user-agent') });
      return { token, userId: user._id };
    });
    res.setHeader('Set-Cookie', cookieHeader(result.token, { secure: config.secureCookies, maxAgeSeconds: config.sessionHours * 3600 }));
    res.status(201).json({ ok: true, userId: result.userId });
  }));

  router.patch('/staff/:membershipId', requirePermission('staff.manage'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const membership = await repo(ctx, 'memberships').findOne({ _id: req.params.membershipId });
    if (!membership) throw notFound('membership not found');
    if (membership.role === 'owner' && req.body?.role && req.body.role !== 'owner') {
      const owners = await repo(ctx, 'memberships').count({ role: 'owner', status: 'active' });
      if (owners <= 1) throw unprocessable('The last owner cannot be demoted. Transfer ownership explicitly first.');
    }
    if (req.body?.role && req.body.role === 'owner' && membership.role !== 'owner') {
      throw unprocessable('Ownership transfer requires the dedicated owner-transfer process and the current owner’s approval.');
    }
    const patch = {};
    if (req.body?.role) {
      if (!ROLES[req.body.role]) throw unprocessable('unknown role');
      patch.role = req.body.role;
      patch.permissions = ROLES[req.body.role].permissions;
    }
    if (req.body?.permissions) patch.permissions = req.body.permissions.filter((p) => PERMISSION_LABELS[p]);
    if (req.body?.branchIds) patch.branchIds = req.body.branchIds;
    if (req.body?.status) patch.status = req.body.status === 'disabled' ? 'disabled' : 'active';
    if (Object.keys(patch).length === 0) throw unprocessable('no supported staff fields to update');
    await store.transaction(async () => {
      await repo(ctx, 'memberships').updateOne({ _id: membership._id }, { $set: patch });
      if (patch.status === 'disabled') {
        const sessions = await store.collection('sessions').find({ userId: membership.userId });
        for (const session of sessions) {
          await store.collection('sessions').updateOne({ _id: session._id }, { $set: { revokedAt: new Date(), revokedReason: 'staff_disabled' } });
        }
      }
      await appendAudit(ctx, {
        action: 'staff.updated',
        entityType: 'membership',
        entityId: membership._id,
        before: { role: membership.role, status: membership.status, branchIds: membership.branchIds },
        after: patch,
      });
    });
    res.json({ ok: true });
  }));

  /* ----------------------------------------------------------------- audit */

  router.get('/audit', requirePermission('audit.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const rows = await repo(ctx, 'audit_events').find({}, { sort: { at: -1 }, limit: Math.min(Number(req.query.limit) || 200, 500) });
    res.json({ events: rows, chain: await verifyAuditChain(ctx) });
  }));

  router.get('/audit/verify', requirePermission('audit.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    res.json(await verifyAuditChain(ctx));
  }));

  router.get('/operations/:key', wrap(async (req, res) => {
    const ctx = requireTenantContext(req.ctx);
    const rows = await lookupOperation(ctx, { key: req.params.key, action: req.query.action });
    res.json({ operations: rows, note: 'Resolve an unknown outcome with the ORIGINAL key. Never replay a financial action under a new key.' });
  }));

  /* ------------------------------------------------------------------ cron */

  router.post('/cron/jobs', wrap(async (req, res) => {
    // Separately authenticated operational endpoint: browser sessions never
    // qualify, even for an owner, and the secret must be configured.
    const header = req.get('x-cron-secret');
    const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const secret = header || bearer;
    if (!config.cronSecret || secret !== config.cronSecret) {
      throw forbidden('This operational endpoint requires a valid cron secret');
    }
    const result = await runBatch(async (fn) => {
      if (!req.ctx?.tenantId) throw forbidden('cron jobs require a tenant session in this build');
      return store.transaction(() => fn(req.ctx));
    }, { limit: 10 });
    res.json(result);
  }));

  /* --------------------------------------------------------------- support */

  router.get('/templates', requirePermission('documents.print'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const registration = (await repo(ctx, 'tax_registrations').find({}))[0];
    res.json({
      templates: templateChoices(),
      invoiceSettings: registration?.invoiceSettings || {},
      policy: {
        roundOffAccount: '4110 Invoice round-off',
        equalHalves: 'CGST = SGST in paise; at most 1 paisa round-off line.',
        historicalImmutability: 'Issued documents are never recalculated from current prices or rates.',
      },
      samplePreview: '/api/v1/documents/:id/print?template=corporate',
    });
  }));

  router.get('/exports/audit.csv', requirePermission('audit.read'), wrap(async (req, res) => {
    const ctx = tenant(req);
    const rows = await repo(ctx, 'audit_events').find({}, { sort: { sequence: 1 } });
    const header = 'sequence,at,action,actor,entityType,entityId,reason,hash';
    const body = rows
      .map((r) => [r.sequence, r.at, r.action, r.actorName, r.entityType, r.entityId, `"${String(r.reason || '').replace(/"/g, '""')}"`, r.hash].join(','))
      .join('\n');
    await store.transaction(async () => {
      await appendAudit(ctx, { action: 'audit.exported', entityType: 'audit', meta: { rows: rows.length } });
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="shopdesk-audit.csv"');
    res.send(`${header}\n${body}\n`);
  }));

  return router;
}

export { requirePermission };
