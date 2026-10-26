import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoster, makeStore, makeTenant } from './helpers.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createDraft, finalizeDraft } from '../server/domain/sales.js';
import { hashPassword } from '../server/auth/passwords.js';
import { resetRateLimits } from '../server/auth/sessions.js';
import { ROLES } from '../server/auth/permissions.js';
import { newId } from '../server/ids.js';

async function makeServer() {
  const { store, dir, cleanup } = await makeStore();
  const config = loadConfig({
    dataDir: dir,
    env: 'test',
    setupToken: 'test-setup-token-123',
    exposeSetupToken: false,
    secureCookies: false,
  });
  config.cronSecret = 'test-cron-secret';
  const app = createApp({ store, config, webDir: `${dir}/noweb` });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    store,
    base,
    async close() {
      server.close();
      cleanup();
    },
  };
}

function client(base) {
  let cookie = '';
  let csrf = '';
  async function call(method, path, body, extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra.headers };
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (extra.omitCsrf) delete headers['x-csrf-token'];
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json, text };
  }
  return {
    call,
    async login(email, password) {
      const res = await call('POST', '/login', { email, password });
      assert.equal(res.status, 200, `login failed: ${res.text}`);
      const session = await call('GET', '/session');
      csrf = session.json.csrfToken;
      return session.json;
    },
    async setup(payload) {
      const res = await call('POST', '/setup', { setupToken: 'test-setup-token-123', ...payload });
      assert.equal(res.status, 201, `setup failed: ${res.text}`);
      const session = await call('GET', '/session');
      csrf = session.json.csrfToken;
      return session.json;
    },
    get csrf() {
      return csrf;
    },
  };
}

test('setup requires the server token, creates an empty tenant and starts a session', async () => {
  const { base, close, store } = await makeServer();
  try {
    const c = client(base);
    const status = await c.call('GET', '/setup/status');
    assert.equal(status.json.needsSetup, true);
    assert.equal(status.json.setupToken, undefined, 'production-style setup token is never exposed');
    const bad = await c.call('POST', '/setup', {
      setupToken: 'wrong-token',
      legalName: 'Bad Clinic Pvt Ltd',
      stateCode: '09',
      identityEvidence: 'evidence string',
      ownerName: 'Owner',
      ownerEmail: 'bad@example.test',
      ownerPassword: 'Strong-Passw0rd!1',
    });
    assert.equal(bad.status, 403);
    const session = await c.setup({
      legalName: 'API Test Clinic Private Limited',
      tradeName: 'API Test Clinic',
      stateCode: '09',
      profile: 'unregistered',
      identityEvidence: 'Test setup identity evidence',
      eInvoiceStatus: 'reviewed_not_applicable',
      eInvoiceNote: 'Test fixture applicability note',
      ownerName: 'API Owner',
      ownerEmail: 'api-owner@example.test',
      ownerPassword: 'Strong-Passw0rd!1',
    });
    assert.equal(session.authenticated, true);
    assert.equal(session.tenant.legalName, 'API Test Clinic Private Limited');
    assert.equal(session.navigation.find((n) => n.key === 'reports') !== undefined, true);
    assert.equal(await store.collection('products').countDocuments({}), 0);
    assert.equal(await store.collection('financial_documents').countDocuments({}), 0);
    const second = await c.call('POST', '/setup', {
      setupToken: 'test-setup-token-123',
      legalName: 'Another Clinic',
      stateCode: '09',
      identityEvidence: 'evidence string',
      ownerName: 'Owner2',
      ownerEmail: 'owner2@example.test',
      ownerPassword: 'Strong-Passw0rd!1',
    });
    assert.equal(second.status, 409);
  } finally {
    await close();
  }
});

test('CSRF and origin checks protect cookie-authenticated mutations', async () => {
  const { base, close } = await makeServer();
  try {
    const c = client(base);
    await c.setup({
      legalName: 'CSRF Clinic Private Limited',
      tradeName: 'CSRF Clinic',
      stateCode: '09',
      profile: 'unregistered',
      identityEvidence: 'Test setup identity evidence',
      eInvoiceStatus: 'reviewed_not_applicable',
      eInvoiceNote: 'Test fixture applicability note',
      ownerName: 'CSRF Owner',
      ownerEmail: 'csrf-owner@example.test',
      ownerPassword: 'Strong-Passw0rd!1',
    });
    const noCsrf = await c.call('POST', '/customers', { name: 'No CSRF' }, { omitCsrf: true });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.error.code, 'CSRF_FAILED');
    const crossOrigin = await c.call('POST', '/customers', { name: 'Cross Origin' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.json.error.code, 'ORIGIN_REJECTED');
    const ok = await c.call('POST', '/customers', { name: 'Legit Customer', stateCode: '09' });
    assert.equal(ok.status, 201);
  } finally {
    await close();
  }
});

test('two-tenant isolation through the HTTP API', async () => {
  const { base, close, store } = await makeServer();
  try {
    const tenantA = await makeTenant(store);
    const roster = await makeRoster(store, tenantA.ctx);
    const draft = await store.transaction(() =>
      createDraft(tenantA.ctx, { branchId: tenantA.ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '1' }] })
    );
    const invoice = await finalizeDraft(
      tenantA.ctx,
      draft.draft._id,
      { version: draft.draft.version, quoteHash: draft.quoteHash },
      { idempotencyKey: 'api-isolation-sale' }
    );
    const tenantB = await makeTenant(store);

    const clientA = client(base);
    await clientA.login(tenantA.user.emailLower, 'Test-Passw0rd!234');
    const docA = await clientA.call('GET', `/documents/${invoice.documentId}`);
    assert.equal(docA.status, 200);

    const clientB = client(base);
    await clientB.login(tenantB.user.emailLower, 'Test-Passw0rd!234');
    const crossRead = await clientB.call('GET', `/documents/${invoice.documentId}`);
    assert.equal(crossRead.status, 404, 'foreign document must be a non-leaking 404');
    const crossPrint = await clientB.call('GET', `/documents/${invoice.documentId}/print`);
    assert.equal(crossPrint.status, 404);
    const listB = await clientB.call('GET', '/documents');
    assert.equal(listB.json.documents.length, 0);
    const summaryB = await clientB.call('GET', '/reports/summary?preset=all');
    assert.equal(summaryB.json.totals.invoices, 0);
    const crossProduct = await clientB.call('PATCH', `/products/${roster.goods._id}`, { name: 'Hijacked' });
    assert.equal(crossProduct.status, 404);
  } finally {
    await close();
  }
});

test('role permissions are enforced in the API and cost fields are withheld', async () => {
  const { base, close, store } = await makeServer();
  try {
    const tenant = await makeTenant(store);
    const roster = await makeRoster(store, tenant.ctx);
    const draft = await store.transaction(() =>
      createDraft(tenant.ctx, { branchId: tenant.ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '1' }] })
    );
    const invoice = await finalizeDraft(
      tenant.ctx,
      draft.draft._id,
      { version: draft.draft.version, quoteHash: draft.quoteHash },
      { idempotencyKey: 'api-role-sale' }
    );

    // A cashier-role staff member.
    const cashierUser = {
      _id: newId(),
      name: 'Cashier One',
      emailLower: 'cashier-one@example.test',
      passwordHash: await hashPassword('Cashier-Passw0rd!1'),
      status: 'active',
      createdAt: new Date(),
    };
    await store.transaction(async () => {
      await store.collection('users').insertOne(cashierUser);
      await store.collection('memberships').insertOne({
        _id: newId(),
        tenantId: tenant.tenant._id,
        userId: cashierUser._id,
        role: 'cashier',
        permissions: ROLES.cashier.permissions,
        branchIds: [tenant.branch._id],
        status: 'active',
        createdAt: new Date(),
      });
    });

    const cashier = client(base);
    const session = await cashier.login('cashier-one@example.test', 'Cashier-Passw0rd!1');
    assert.equal(session.role, 'cashier');
    assert.equal(session.navigation.some((n) => n.key === 'settings'), false);
    assert.equal(session.navigation.some((n) => n.key === 'audit'), false);

    const doc = await cashier.call('GET', `/documents/${invoice.documentId}`);
    assert.equal(doc.status, 200);
    assert.equal(doc.json.canSeeCost, false);
    assert.ok(doc.json.document.lines.every((l) => l.costPaise === undefined), 'cashier must not receive cost fields');
    assert.ok(doc.json.document.lines.every((l) => l.batchAllocations.every((b) => b.costPaise === undefined)));

    const refundAttempt = await cashier.call('POST', '/refunds', {
      documentId: invoice.documentId,
      amountPaise: '100',
      method: 'cash',
      reason: 'should be forbidden',
    });
    assert.equal(refundAttempt.status, 403);

    const returnAttempt = await cashier.call('POST', `/documents/${invoice.documentId}/returns`, {
      reason: 'should be forbidden',
      lines: [{ lineId: 'x', quantityScaled: '1' }],
    });
    assert.equal(returnAttempt.status, 403);

    const settingsAttempt = await cashier.call('GET', '/settings');
    assert.equal(settingsAttempt.status, 403);
    const auditAttempt = await cashier.call('GET', '/audit');
    assert.equal(auditAttempt.status, 403);

    const stock = await cashier.call('GET', '/stock');
    assert.equal(stock.status, 200);
    assert.ok(stock.json.rows.every((r) => r.costPoolPaise === undefined));

    const csvAttempt = await cashier.call('GET', '/reports/stock.csv');
    assert.equal(csvAttempt.status, 403, 'cashiers cannot export unrestricted reports');

    // The owner still sees cost.
    const owner = client(base);
    await owner.login(tenant.user.emailLower, 'Test-Passw0rd!234');
    const ownerDoc = await owner.call('GET', `/documents/${invoice.documentId}`);
    assert.equal(ownerDoc.json.canSeeCost, true);
    assert.ok(ownerDoc.json.document.lines[0].costPaise);
  } finally {
    await close();
  }
});

test('inventory operator receives quantity-only data end to end', async () => {
  const { base, close, store } = await makeServer();
  try {
    const tenant = await makeTenant(store);
    await makeRoster(store, tenant.ctx);
    const operator = {
      _id: newId(),
      name: 'Inventory Op',
      emailLower: 'inventory-op@example.test',
      passwordHash: await hashPassword('Inventory-Passw0rd!1'),
      status: 'active',
      createdAt: new Date(),
    };
    await store.transaction(async () => {
      await store.collection('users').insertOne(operator);
      await store.collection('memberships').insertOne({
        _id: newId(),
        tenantId: tenant.tenant._id,
        userId: operator._id,
        role: 'inventory',
        permissions: ROLES.inventory.permissions,
        branchIds: [tenant.branch._id],
        status: 'active',
        createdAt: new Date(),
      });
    });
    const c = client(base);
    await c.login('inventory-op@example.test', 'Inventory-Passw0rd!1');
    const products = await c.call('GET', '/products');
    assert.equal(products.status, 200);
    assert.equal(products.json.canSeeCost, false);
    const stocks = await c.call('GET', '/stock');
    assert.ok(stocks.json.rows.every((r) => r.costPoolPaise === undefined));
    assert.equal(stocks.json.quantityOnly, true);
    const purchases = await c.call('GET', '/purchases');
    assert.equal(purchases.json.quantityOnly, true);
    assert.ok(purchases.json.purchases.every((p) => p.lines.every((l) => l.unitCostPaise === undefined)));
  } finally {
    await close();
  }
});

test('printing uses the saved snapshot, escapes text and never adds script or a fake QR', async () => {
  const { base, close, store } = await makeServer();
  try {
    const tenant = await makeTenant(store);
    const roster = await makeRoster(store, tenant.ctx);
    const draft = await store.transaction(() =>
      createDraft(tenant.ctx, {
        branchId: tenant.ctx.branchId,
        customerId: roster.customer._id,
        lines: [{ productId: roster.goods._id, quantityScaled: '1' }],
        notes: '<script>window.hacked=true</script>',
      })
    );
    const invoice = await finalizeDraft(
      tenant.ctx,
      draft.draft._id,
      { version: draft.draft.version, quoteHash: draft.quoteHash },
      { idempotencyKey: 'api-print-sale' }
    );
    const c = client(base);
    await c.login(tenant.user.emailLower, 'Test-Passw0rd!234');
    for (const template of ['corporate', 'classic', 'compact', 'thermal58', 'thermal80']) {
      const res = await c.call('GET', `/documents/${invoice.documentId}/print?template=${template}`);
      assert.equal(res.status, 200, template);
      assert.ok(res.text.includes(invoice.number));
      assert.ok(!res.text.includes('<script'), `${template} must not emit script`);
      assert.ok(!res.text.includes('window.hacked'), `${template} must escape tenant text`);
      assert.ok(!/IRN|Signed QR/i.test(res.text.replace(/No statutory QR\/IRN is printed/g, '')), `${template} must not fabricate statutory fields`);
    }
    const audit = await c.call('GET', '/audit');
    assert.ok(audit.json.events.some((e) => e.action === 'document.printed'));
  } finally {
    await close();
  }
});

test('cron endpoint requires its secret; operational status resolves an unknown outcome', async () => {
  const { base, close, store } = await makeServer();
  try {
    const c = client(base);
    await c.setup({
      legalName: 'Cron Clinic Private Limited',
      tradeName: 'Cron Clinic',
      stateCode: '09',
      profile: 'unregistered',
      identityEvidence: 'Test setup identity evidence',
      eInvoiceStatus: 'reviewed_not_applicable',
      eInvoiceNote: 'Test fixture applicability note',
      ownerName: 'Cron Owner',
      ownerEmail: 'cron-owner@example.test',
      ownerPassword: 'Strong-Passw0rd!1',
    });
    const denied = await c.call('POST', '/cron/jobs', {});
    assert.equal(denied.status, 403, 'a browser session must not act as cron');
    const wrongSecret = await c.call('POST', '/cron/jobs', {}, { headers: { 'x-cron-secret': 'nope' } });
    assert.equal(wrongSecret.status, 403);
    const allowed = await c.call('POST', '/cron/jobs', {}, { headers: { 'x-cron-secret': 'test-cron-secret' } });
    assert.equal(allowed.status, 200);
    const op = await c.call('GET', '/operations/does-not-exist-key');
    assert.equal(op.status, 200);
    assert.equal(op.json.operations.length, 0);
    assert.ok(op.json.note.includes('ORIGINAL key'));
    assert.ok(await store.collection('tenants').countDocuments({}) === 1);
  } finally {
    await close();
  }
});

test('login is rate limited and disabled staff lose access immediately', async () => {
  const { base, close, store } = await makeServer();
  try {
    const tenant = await makeTenant(store);
    const c = client(base);
    for (let i = 0; i < 10; i += 1) {
      const res = await c.call('POST', '/login', { email: tenant.user.emailLower, password: 'wrong-password' });
      assert.equal(res.status, 401);
    }
    const limited = await c.call('POST', '/login', { email: tenant.user.emailLower, password: 'wrong-password' });
    assert.equal(limited.status, 429);
    resetRateLimits();

    const staffClient = client(base);
    await staffClient.login(tenant.user.emailLower, 'Test-Passw0rd!234');
    const membership = await store.collection('memberships').findOne({ tenantId: tenant.tenant._id, userId: tenant.user._id });
    await store.transaction(async () => {
      await store.collection('memberships').updateOne({ _id: membership._id }, { $set: { status: 'disabled' } });
    });
    const afterDisable = await staffClient.call('GET', '/session');
    assert.equal(afterDisable.status, 200);
    assert.equal(afterDisable.json.authenticated, false, 'disabled staff must lose the session immediately');
  } finally {
    await close();
  }
});
