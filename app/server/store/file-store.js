/**
 * Durable JSON file store.
 *
 * This is the local/self-hosted driver for shop desk. It implements the same
 * transactional contract as the MongoDB Atlas driver: every financial action
 * runs inside `store.transaction(fn)`, which is serialised (a real mutual
 * exclusion) and committed atomically (write + fsync + rename). If the callback
 * throws, nothing is written — the equivalent guarantee the Mongo driver gives
 * through a replica-set transaction.
 *
 * Production deployment notes:
 *  - one process / one writable volume; the Mongo driver exists for the
 *    approved Vercel + Atlas target (see README and GAP-ANALYSIS).
 *  - the file is the durable state; back it up and never run two writers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isPresentIndex, indexesFor } from './indexes.js';

const txStorage = new AsyncLocalStorage();

/**
 * JSON has no Date. Persisting dates as plain ISO strings silently broke range
 * queries after a restart (string vs Date comparison), so dates are tagged and
 * revived explicitly. Money stays a validated integer string and is never
 * coerced to a float here.
 */
const DATE_TAG = '__shopdeskDate';

function serialise(value) {
  // Note: Date#toJSON runs BEFORE the replacer, so the original value must be
  // read from the holder (`this[key]`); checking `val` alone silently emits ISO
  // strings and breaks range queries after a restart.
  return JSON.stringify(value, function replacer(key, val) {
    const original = this[key];
    if (original instanceof Date) return { [DATE_TAG]: original.toISOString() };
    return val;
  });
}

function deserialise(raw) {
  return JSON.parse(raw, (key, val) => {
    if (val && typeof val === 'object' && typeof val[DATE_TAG] === 'string') {
      return new Date(val[DATE_TAG]);
    }
    return val;
  });
}

export function duplicateKeyError(collection, index) {
  const err = new Error(`duplicate key on ${collection} (${index.name})`);
  err.code = 'E11000';
  err.collection = collection;
  err.index = index.name;
  return err;
}

function getPath(doc, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function setPath(doc, dotted, value) {
  const parts = dotted.split('.');
  let cursor = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof cursor[parts[i]] !== 'object' || cursor[parts[i]] === null) cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z?)?$/;

function asTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && ISO_DATE.test(value)) return new Date(value).getTime();
  return null;
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const ta = asTime(a);
  const tb = asTime(b);
  if (ta !== null && tb !== null) return ta - tb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
}

export function matches(doc, filter = {}) {
  for (const [key, raw] of Object.entries(filter)) {
    if (key === '$and') {
      if (!raw.every((f) => matches(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!raw.some((f) => matches(doc, f))) return false;
      continue;
    }
    const value = getPath(doc, key);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Date)) {
      for (const [op, arg] of Object.entries(raw)) {
        switch (op) {
          case '$eq':
            if (value !== arg) return false;
            break;
          case '$ne':
            if (value === arg) return false;
            break;
          case '$in':
            if (!Array.isArray(arg) || !arg.includes(value)) return false;
            break;
          case '$nin':
            if (Array.isArray(arg) && arg.includes(value)) return false;
            break;
          case '$gt':
            if (!(compareValues(value, arg) > 0)) return false;
            break;
          case '$gte':
            if (!(compareValues(value, arg) >= 0)) return false;
            break;
          case '$lt':
            if (!(compareValues(value, arg) < 0)) return false;
            break;
          case '$lte':
            if (!(compareValues(value, arg) <= 0)) return false;
            break;
          case '$exists':
            if ((value !== undefined) !== Boolean(arg)) return false;
            break;
          case '$nin_op_unknown':
            return false;
          default:
            throw new Error(`unsupported query operator ${op}`);
        }
      }
      continue;
    }
    if (Array.isArray(value) && !Array.isArray(raw)) {
      if (!value.includes(raw)) return false;
      continue;
    }
    if (value !== raw) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  if (!update || typeof update !== 'object') throw new Error('update document required');
  const next = structuredClone(doc);
  for (const [op, payload] of Object.entries(update)) {
    if (op === '$set') {
      for (const [k, v] of Object.entries(payload)) setPath(next, k, v);
    } else if (op === '$unset') {
      for (const k of Object.keys(payload)) setPath(next, k, undefined);
    } else if (op === '$inc') {
      for (const [k, v] of Object.entries(payload)) {
        const current = getPath(next, k) ?? 0;
        setPath(next, k, current + v);
      }
    } else if (op === '$push') {
      for (const [k, v] of Object.entries(payload)) {
        const current = getPath(next, k) ?? [];
        setPath(next, k, [...current, ...(Array.isArray(v?.$each) ? v.$each : [v])]);
      }
    } else {
      throw new Error(`unsupported update operator ${op}`);
    }
  }
  return next;
}

export class FileStore {
  constructor({ dir, fileName = 'shopdesk.json', seed = null } = {}) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.data = { collections: {} };
    this.seed = seed;
    this.lock = Promise.resolve();
    this.stats = { transactions: 0, commits: 0, rollbacks: 0 };
  }

  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = raw.trim() ? deserialise(raw) : { collections: {} };
    } else {
      this.data = this.seed ? this.seed() : { collections: {} };
      this.#persist(this.data);
    }
    for (const name of Object.keys(this.data.collections)) {
      if (!Array.isArray(this.data.collections[name])) this.data.collections[name] = [];
    }
    return this;
  }

  #persist(data) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, serialise(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  #current() {
    const ctx = txStorage.getStore();
    return ctx?.store === this ? ctx.data : this.data;
  }

  rawCollections() {
    return this.#current().collections;
  }

  collection(name) {
    if (!this.data.collections[name]) this.data.collections[name] = [];
    return new FileCollection(this, name);
  }

  async transaction(fn) {
    const existing = txStorage.getStore();
    if (existing && existing.store === this) return fn();
    let release;
    const previous = this.lock;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = structuredClone(this.data);
    if (!snapshot.collections) snapshot.collections = {};
    this.stats.transactions += 1;
    try {
      const result = await txStorage.run({ store: this, data: snapshot }, () => fn());
      this.data = snapshot;
      this.#persist(this.data);
      this.stats.commits += 1;
      return result;
    } catch (err) {
      this.stats.rollbacks += 1;
      throw err;
    } finally {
      release();
    }
  }

  async close() {
    /* nothing to release */
  }

  /** Test/diagnostic helper: verify unique indexes against stored documents. */
  async verifyIndexes() {
    const problems = [];
    const collections = this.data.collections;
    for (const name of Object.keys(collections)) {
      for (const index of indexesFor(name).filter((ix) => ix.unique)) {
        const seen = new Map();
        for (const doc of collections[name]) {
          if (!isPresentIndex(index, doc)) continue;
          const key = JSON.stringify(Object.keys(index.keys).map((k) => getPath(doc, k)));
          if (seen.has(key)) problems.push({ collection: name, index: index.name, key, ids: [seen.get(key), doc._id] });
          else seen.set(key, doc._id);
        }
      }
    }
    return problems;
  }
}

class FileCollection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }

  #assertWritable() {
    const ctx = txStorage.getStore();
    if (!ctx || ctx.store !== this.store) {
      throw new Error(
        `write to "${this.name}" outside store.transaction(); financial writes must be transactional`
      );
    }
  }

  #docs() {
    const data = this.store.rawCollections();
    if (!data[this.name]) data[this.name] = [];
    return data[this.name];
  }

  #checkUnique(candidate, ignoreId = null) {
    const docs = this.store.rawCollections()[this.name] || [];
    for (const index of indexesFor(this.name).filter((ix) => ix.unique)) {
      if (!isPresentIndex(index, candidate)) continue;
      const keys = Object.keys(index.keys);
      const hit = docs.find(
        (d) => d._id !== ignoreId && isPresentIndex(index, d) && keys.every((k) => getPath(d, k) === getPath(candidate, k))
      );
      if (hit) throw duplicateKeyError(this.name, index);
    }
  }

  async insertOne(doc) {
    this.#assertWritable();
    if (!doc || typeof doc !== 'object') throw new Error('document required');
    const copy = structuredClone(doc);
    if (!copy._id) throw new Error('insertOne requires an _id (ids are generated by the application)');
    this.#checkUnique(copy);
    this.#docs().push(copy);
    return { insertedId: copy._id, acknowledged: true };
  }

  async insertMany(docs) {
    const inserted = [];
    for (const doc of docs) {
      const res = await this.insertOne(doc);
      inserted.push(res.insertedId);
    }
    return { insertedCount: inserted.length, insertedIds: inserted, acknowledged: true };
  }

  async findOne(filter = {}, options = {}) {
    if (options.sort) {
      const rows = await this.find(filter, { sort: options.sort, skip: options.skip, limit: options.limit || 1 });
      return rows[0] || null;
    }
    const found = this.#docs().find((d) => matches(d, filter));
    return found ? structuredClone(found) : null;
  }

  async find(filter = {}, options = {}) {
    let rows = this.#docs().filter((d) => matches(d, filter)).map((d) => structuredClone(d));
    if (options.sort) {
      const entries = Object.entries(options.sort);
      rows.sort((a, b) => {
        for (const [field, dir] of entries) {
          const c = compareValues(getPath(a, field), getPath(b, field));
          if (c !== 0) return dir < 0 ? -c : c;
        }
        return 0;
      });
    }
    if (options.skip) rows = rows.slice(options.skip);
    if (options.limit) rows = rows.slice(0, options.limit);
    if (options.projection) {
      const { projection } = options;
      const include = Object.entries(projection).filter(([, v]) => v === 1 || v === true).map(([k]) => k);
      const exclude = Object.entries(projection).filter(([, v]) => v === 0 || v === false).map(([k]) => k);
      rows = rows.map((row) => {
        if (include.length) {
          const out = { _id: row._id };
          for (const k of include) if (k in row) out[k] = structuredClone(row[k]);
          return out;
        }
        const out = structuredClone(row);
        for (const k of exclude) delete out[k];
        return out;
      });
    }
    return rows;
  }

  async updateOne(filter, update, options = {}) {
    this.#assertWritable();
    const docs = this.#docs();
    const idx = docs.findIndex((d) => matches(d, filter));
    if (idx === -1) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const base = { ...filter, _id: filter._id || options.setIdOnInsert };
      if (!base._id) throw new Error('upsert requires an _id or setIdOnInsert');
      const created = applyUpdate(base, update);
      this.#checkUnique(created);
      docs.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedId: created._id, acknowledged: true };
    }
    const current = docs[idx];
    const next = applyUpdate(current, update);
    next._id = current._id;
    this.#checkUnique(next, current._id);
    docs[idx] = next;
    return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
  }

  async updateMany(filter, update) {
    this.#assertWritable();
    const docs = this.#docs();
    let count = 0;
    for (let i = 0; i < docs.length; i += 1) {
      if (!matches(docs[i], filter)) continue;
      const next = applyUpdate(docs[i], update);
      next._id = docs[i]._id;
      this.#checkUnique(next, docs[i]._id);
      docs[i] = next;
      count += 1;
    }
    return { matchedCount: count, modifiedCount: count, acknowledged: true };
  }

  async deleteOne(filter) {
    this.#assertWritable();
    const docs = this.#docs();
    const idx = docs.findIndex((d) => matches(d, filter));
    if (idx === -1) return { deletedCount: 0 };
    docs.splice(idx, 1);
    return { deletedCount: 1 };
  }

  async countDocuments(filter = {}) {
    return this.#docs().filter((d) => matches(d, filter)).length;
  }
}
