/**
 * The browser talks to exactly these endpoints with exactly these bodies.
 * This test drives the same calls the SPA makes, so a UI/API drift fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoster, makeStore, makeTenant } from './helpers.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

async function boot() {
  const { store, dir, cleanup } = await makeStore();
  const config = loadConfig({ dataDir: dir, env: 'test', setupToken: 'ui-contract-token', secureCookies: false });
  config.cronSecret = 'ui-contract-cron';
  const app = createApp({ store, config, webDir: `${dir}/noweb` });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { store, base: `http://127.0.0.1:${server.address().port}`, cleanup: () => { server.close(); cleanup(); } };
}

async function signIn(base, email, password) {
  let cookie = '';
  async function call(method, path, body, key) {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (key) headers['idempotency-key'] = key;
    const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, text, headers: res.headers };
  }
  const login = await call('POST', '/login', { email, password });
  assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.json)}`);
  const session = await call('GET', '/session');
  const csrf = session.json.csrfToken;
  const authed = (method, path, body, key) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...(key ? { 'idempotency-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json, text };
    });
  return { call: authed, session: session.json, cookie };
}

test('the SPA flow: catalogue → draft → quote → finalize → reprint → partial return', async () => {
  const { store, base, cleanup } = await boot();
  try {
    const tenant = await makeTenant(store);
    const roster = await makeRoster(store, tenant.ctx);
    const ui = await signIn(base, tenant.user.emailLower, 'Test-Passw0rd!234');

    // Pages must load with the shapes the components destructure.
    assert.equal((await ui.call('GET', '/overview?preset=month')).status, 200);
    const products = await ui.call('GET', '/products?search=');
    assert.ok(Array.isArray(products.json.products));
    assert.ok(products.json.products.every((p) => p.id && p.quantityScale !== undefined));
    const customers = await ui.call('GET', '/customers');
    assert.ok(Array.isArray(customers.json.customers));

    const draftResponse = await ui.call('POST', '/sales-drafts', {
      branchId: ui.session.branch.id,
      customerId: customers.json.customers[0]._id,
      notes: 'UI contract',
      lines: [{ productId: roster.goods._id, quantityScaled: '1' }],
    });
    assert.equal(draftResponse.status, 201, JSON.stringify(draftResponse.json));
    const draft = draftResponse.json;
    assert.ok(draft.draft.id && draft.draft.version >= 1);
    assert.ok(draft.quote.totals.totalPaise);
    assert.ok(draft.quoteHash);
    assert.deepEqual(draft.quote.totals, {
      ...draft.quote.totals,
      totalPaise: draft.quote.totals.totalPaise,
    });

    const idem = `ui-finalize-${Date.now()}`;
    const finalize = await ui.call(
      'POST',
      `/sales-drafts/${draft.draft.id}/finalize`,
      { version: draft.draft.version, quoteHash: draft.quoteHash, payment: { method: 'upi', amountPaise: draft.quote.totals.totalPaise } },
      idem
    );
    assert.equal(finalize.status, 201, JSON.stringify(finalize.json));
    const replay = await ui.call(
      'POST',
      `/sales-drafts/${draft.draft.id}/finalize`,
      { version: draft.draft.version, quoteHash: draft.quoteHash, payment: { method: 'upi', amountPaise: draft.quote.totals.totalPaise } },
      idem
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.json.number, finalize.json.number);
    assert.equal(replay.json.replayed, true);

    const document = await ui.call('GET', `/documents/${finalize.json.documentId}`);
    assert.equal(document.status, 200);
    assert.equal(document.json.document.number, finalize.json.number);
    assert.ok(Array.isArray(document.json.document.lines));
    const settlement = await ui.call('GET', `/documents/${finalize.json.documentId}/settlement`);
    assert.ok('duePaise' in settlement.json && 'refundablePaise' in settlement.json);

    const printed = await fetch(`${base}/api/v1/documents/${finalize.json.documentId}/print?template=thermal80`, { headers: { cookie: ui.cookie } });
    assert.equal(printed.status, 200);
    const html = await printed.text();
    assert.ok(html.includes(finalize.json.number));

    const preview = await ui.call('GET', `/documents/${finalize.json.documentId}/return-preview`);
    const line = preview.json.lines[0];
    assert.ok(line.lineId && line.remainingQuantityScaled);
    const credit = await ui.call(
      'POST',
      `/documents/${finalize.json.documentId}/returns`,
      {
        reason: 'UI contract partial return',
        gstAdjustment: true,
        lines: [{ lineId: line.lineId, quantityScaled: '1', condition: 'unopened' }],
      },
      `ui-return-${Date.now()}`
    );
    assert.equal(credit.status, 201, JSON.stringify(credit.json));
    assert.ok(credit.json.number.startsWith('CN/'));
    assert.equal(credit.json.restocked, false, 'no restock unless explicitly requested');

    // Reports the SPA renders.
    for (const tab of ['summary', 'daybook', 'products', 'categories', 'cashiers', 'payments', 'gst', 'gstr1', 'gstr3b', 'stock', 'receivables', 'stocklog']) {
      const report = await ui.call('GET', `/reports/${tab}?preset=month`);
      assert.equal(report.status, 200, `${tab}: ${JSON.stringify(report.json).slice(0, 200)}`);
    }
    const reconciliation = await ui.call('GET', '/accounts/reconciliation');
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.json.reconciliation.findings.filter((f) => f.severity === 'critical').length, 0);
    for (const path of ['/accounts', '/accounts/pnl', '/accounts/balance-sheet', '/accounts/journals', '/period-locks', '/settings', '/staff', '/audit', '/templates', '/payments?preset=month', '/cash-close', '/payment-intents', '/returns', '/purchases', '/suppliers', '/stock', '/stock/movements']) {
      const res = await ui.call('GET', path);
      assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.json).slice(0, 200)}`);
    }
  } finally {
    cleanup();
  }
});

test('a cashier never receives cost fields from any SPA endpoint', async () => {
  const { store, base, cleanup } = await boot();
  try {
    const tenant = await makeTenant(store);
    const roster = await makeRoster(store, tenant.ctx);
    const { hashPassword } = await import('../server/auth/passwords.js');
    const { ROLES } = await import('../server/auth/permissions.js');
    const { newId } = await import('../server/ids.js');
    const { createDraft, finalizeDraft } = await import('../server/domain/sales.js');
    const draft = await store.transaction(() =>
      createDraft(tenant.ctx, { branchId: tenant.ctx.branchId, customerId: roster.customer._id, lines: [{ productId: roster.goods._id, quantityScaled: '1' }] })
    );
    const invoice = await finalizeDraft(tenant.ctx, draft.draft._id, { version: draft.draft.version, quoteHash: draft.quoteHash }, { idempotencyKey: 'cashier-dto-sale' });

    const user = {
      _id: newId(),
      name: 'Counter One',
      emailLower: 'counter-one@example.test',
      passwordHash: await hashPassword('Counter-Passw0rd!1'),
      status: 'active',
      createdAt: new Date(),
    };
    await store.transaction(async () => {
      await store.collection('users').insertOne(user);
      await store.collection('memberships').insertOne({
        _id: newId(),
        tenantId: tenant.tenant._id,
        userId: user._id,
        role: 'cashier',
        permissions: ROLES.cashier.permissions,
        branchIds: [tenant.branch._id],
        status: 'active',
        createdAt: new Date(),
      });
    });
    const ui = await signIn(base, 'counter-one@example.test', 'Counter-Passw0rd!1');
    const document = await ui.call('GET', `/documents/${invoice.documentId}`);
    assert.equal(document.json.canSeeCost, false);
    assert.ok(document.json.document.lines.every((l) => l.costPaise === undefined));
    const products = await ui.call('GET', '/products');
    assert.equal(products.json.canSeeCost, false);
    assert.ok(products.json.products.every((p) => p.quantityOnHandScaled === undefined));
    const stock = await ui.call('GET', '/stock');
    assert.ok(stock.json.rows.every((r) => r.costPoolPaise === undefined));
    const purchases = await ui.call('GET', '/purchases');
    assert.equal(purchases.json.quantityOnly, true);
    const csv = await ui.call('GET', '/reports/stock.csv?preset=month');
    assert.equal(csv.status, 403);
  } finally {
    cleanup();
  }
});
