/**
 * MongoDB Atlas driver (approved production target: Node.js API on Vercel +
 * Atlas replica set, native Node driver).
 *
 * IMPORTANT — evidence status: this adapter is implemented but was NOT executed
 * in the environment that produced this build (no Atlas replica set was
 * provisioned and the engineering pack forbids provisioning paid resources
 * without approval). Transaction, index and Long conversions below must be
 * exercised against a real replica set before any production claim. See
 * docs/GAP-ANALYSIS.md item G-01.
 *
 * Conventions:
 *  - `*Paise` and `*Scaled` fields are stored as BSON Long and transported as
 *    base-10 strings, so no money value passes through a JS double.
 *  - `_id` values are application-generated 24-hex strings (portable with the
 *    file driver). This is a documented deviation from ObjectId typing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient, Long } from 'mongodb';
import { INDEXES, indexesFor } from './indexes.js';
import { PAISE_MIN, PAISE_MAX } from '../money.js';

const txStorage = new AsyncLocalStorage();

const MONEY_KEY = /(Paise|Scaled)$/;

function toLong(value, key) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Long.fromBigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const n = BigInt(value);
    if (n < PAISE_MIN || n > PAISE_MAX) throw new Error(`${key} outside 64-bit range`);
    return Long.fromBigInt(n);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return Long.fromNumber(value);
  throw new Error(`${key} must be an integer string, not ${typeof value}`);
}

function fromLong(value) {
  if (value instanceof Long) return value.toString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Walk a document/filter and convert money/quantity fields for storage or transport. */
export function convertValue(value, key, direction) {
  if (Array.isArray(value)) return value.map((v) => convertValue(v, key, direction));
  if (value instanceof Date) return value;
  if (MONEY_KEY.test(key)) {
    return direction === 'toDb' ? toLong(value, key) : fromLong(value);
  }
  if (value && typeof value === 'object' && !(value instanceof Long)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = convertValue(v, k, direction);
    return out;
  }
  if (value instanceof Long) return direction === 'toDb' ? value : fromLong(value);
  return value;
}

function convertDoc(doc, direction) {
  if (!doc || typeof doc !== 'object') return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) out[k] = convertValue(v, k, direction);
  return out;
}

/** Filters need the same conversion when they compare money fields. */
function convertFilter(filter) {
  if (!filter || typeof filter !== 'object') return filter;
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or') out[k] = v.map((f) => convertFilter(f));
    else if (k === '$nor') out[k] = v.map((f) => convertFilter(f));
    else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Long)) {
      const ops = {};
      for (const [op, arg] of Object.entries(v)) {
        if (op === '$in' || op === '$nin') ops[op] = arg.map((x) => convertValue(x, k, 'toDb'));
        else ops[op] = convertValue(arg, k, 'toDb');
      }
      out[k] = ops;
    } else {
      out[k] = convertValue(v, k, 'toDb');
    }
  }
  return out;
}

function convertUpdate(update) {
  const out = {};
  for (const [op, payload] of Object.entries(update)) {
    if (payload && typeof payload === 'object') {
      const fields = {};
      for (const [k, v] of Object.entries(payload)) fields[k] = convertValue(v, k, 'toDb');
      out[op] = fields;
    } else out[op] = payload;
  }
  return out;
}

export class MongoStore {
  constructor({ uri, dbName = 'shopdesk', maxPoolSize = 10, createIndexes = true } = {}) {
    if (!uri) throw new Error('MongoStore requires a connection URI');
    this.uri = uri;
    this.dbName = dbName;
    this.maxPoolSize = maxPoolSize;
    this.createIndexes = createIndexes;
    this.client = null;
    this.database = null;
    this.stats = { transactions: 0, commits: 0, rollbacks: 0 };
  }

  async init() {
    this.client = new MongoClient(this.uri, {
      maxPoolSize: this.maxPoolSize,
      retryWrites: true,
      serverSelectionTimeoutMS: 8000,
    });
    await this.client.connect();
    this.database = this.client.db(this.dbName);
    if (this.createIndexes) await this.ensureIndexes();
    return this;
  }

  async ensureIndexes() {
    const byCollection = new Map();
    for (const ix of INDEXES) {
      if (!byCollection.has(ix.collection)) byCollection.set(ix.collection, []);
      byCollection.get(ix.collection).push(ix);
    }
    for (const [name, defs] of byCollection) {
      const coll = this.database.collection(name);
      await this.database.createCollection(name).catch((err) => {
        if (err.codeName !== 'NamespaceExists' && err.code !== 48) throw err;
      });
      for (const def of defs) {
        const spec = { key: def.keys, name: def.name, unique: Boolean(def.unique) };
        await coll.createIndex(spec.key, spec).catch((err) => {
          if (err.codeName === 'IndexAlreadyExists' || err.code === 85 || err.code === 86) return;
          throw err;
        });
      }
    }
  }

  collection(name) {
    return new MongoCollection(this.database.collection(name));
  }

  async transaction(fn) {
    const existing = txStorage.getStore();
    if (existing && existing.store === this) return fn();
    const session = this.client.startSession();
    this.stats.transactions += 1;
    try {
      let result;
      await session.withTransaction(
        async () => {
          result = await txStorage.run({ store: this, session }, () => fn());
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }
      );
      this.stats.commits += 1;
      return result;
    } catch (err) {
      this.stats.rollbacks += 1;
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async close() {
    if (this.client) await this.client.close();
  }
}

class MongoCollection {
  constructor(coll) {
    this.coll = coll;
    this.session = () => txStorage.getStore()?.session;
  }

  #opts(options = {}) {
    return { ...options, session: this.session() };
  }

  async insertOne(doc, options) {
    const copy = convertDoc(doc, 'toDb');
    if (!copy._id) throw new Error('insertOne requires an _id');
    return this.coll.insertOne(copy, this.#opts(options));
  }

  async insertMany(docs, options) {
    return this.coll.insertMany(docs.map((d) => convertDoc(d, 'toDb')), this.#opts(options));
  }

  async findOne(filter = {}, options = {}) {
    const doc = await this.coll.findOne(convertFilter(filter), this.#opts(options));
    return doc ? convertDoc(doc, 'fromDb') : null;
  }

  async find(filter = {}, options = {}) {
    let cursor = this.coll.find(convertFilter(filter), this.#opts({ projection: options.projection }));
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    const rows = await cursor.toArray();
    return rows.map((d) => convertDoc(d, 'fromDb'));
  }

  async updateOne(filter, update, options = {}) {
    return this.coll.updateOne(convertFilter(filter), convertUpdate(update), this.#opts(options));
  }

  async updateMany(filter, update) {
    return this.coll.updateMany(convertFilter(filter), convertUpdate(update), this.#opts());
  }

  async deleteOne(filter) {
    return this.coll.deleteOne(convertFilter(filter), this.#opts());
  }

  async countDocuments(filter = {}) {
    return this.coll.countDocuments(convertFilter(filter), this.#opts());
  }
}

export { indexesFor };
