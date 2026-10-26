import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '../server/store/file-store.js';
import { makeStore } from './helpers.js';
import { createCustomer } from '../server/domain/catalog.js';
import { repo } from '../server/tenancy/repo.js';

test('dates survive a process restart (range queries keep working)', async () => {
  const { dir, cleanup } = await makeStore();
  try {
    const first = await new FileStore({ dir }).init();
    await first.transaction(() =>
      first.collection('things').insertOne({ _id: 'a1', tenantId: 't1', at: new Date('2026-10-26T04:00:00.000Z') })
    );
    const raw = fs.readFileSync(path.join(dir, 'shopdesk.json'), 'utf8');
    assert.ok(raw.includes('__shopdeskDate'), 'dates are tagged, not flattened to bare ISO strings');

    const second = await new FileStore({ dir }).init();
    const doc = await second.collection('things').findOne({ _id: 'a1' });
    assert.ok(doc.at instanceof Date, 'revived as a Date');
    const inRange = await second.collection('things').find({ at: { $gte: new Date('2026-10-01'), $lt: new Date('2026-11-01') } });
    assert.equal(inRange.length, 1);
    const outside = await second.collection('things').find({ at: { $gte: new Date('2026-11-01') } });
    assert.equal(outside.length, 0);
  } finally {
    cleanup();
  }
});

test('unique indexes are enforced by the store, not only by service code', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.transaction(() =>
      store.collection('users').insertOne({ _id: 'u1', emailLower: 'dup@example.test', name: 'One' })
    );
    await assert.rejects(
      () => store.transaction(() => store.collection('users').insertOne({ _id: 'u2', emailLower: 'dup@example.test', name: 'Two' })),
      (err) => err.code === 'E11000'
    );
    assert.equal((await store.collection('users').find({})).length, 1, 'failed transaction leaves no partial write');
  } finally {
    cleanup();
  }
});

test('a failed transaction rolls back every write in it', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await assert.rejects(() =>
      store.transaction(async () => {
        await store.collection('audit_events').insertOne({ _id: 'e1', tenantId: 't1', sequence: 1 });
        await store.collection('audit_events').insertOne({ _id: 'e2', tenantId: 't1', sequence: 1 });
      })
    );
    assert.equal((await store.collection('audit_events').find({})).length, 0);
  } finally {
    cleanup();
  }
});

test('tenant repository refuses an unscoped context', async () => {
  const { store, cleanup } = await makeStore();
  try {
    assert.throws(() => repo({ store }, 'customers'), /tenant context/i);
    const ctx = { store, tenantId: 'tenant-a', userId: 'u1' };
    const created = await store.transaction(() => createCustomer(ctx, { name: 'Scoped Customer', stateCode: '09' }));
    const other = { store, tenantId: 'tenant-b', userId: 'u2' };
    assert.equal(await repo(other, 'customers').findOne({ _id: created._id }), null);
  } finally {
    cleanup();
  }
});
