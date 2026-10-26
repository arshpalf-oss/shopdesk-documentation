import path from 'node:path';
import { FileStore } from './file-store.js';
import { MongoStore } from './mongo-store.js';

export { FileStore, MongoStore };
export { INDEXES, indexesFor } from './indexes.js';

/**
 * Create the durable store.
 *
 * MONGODB_URI set  -> MongoDB Atlas driver (approved production target).
 * otherwise        -> durable single-writer JSON store (local/preview use).
 *
 * There is deliberately no in-memory-only mode: a restart must not lose books.
 */
export async function createStore({ mongoUri, mongoDbName, dataDir }) {
  if (mongoUri) {
    const store = new MongoStore({ uri: mongoUri, dbName: mongoDbName || 'shopdesk' });
    await store.init();
    return { store, driver: 'mongodb', location: `${mongoDbName || 'shopdesk'} @ Atlas` };
  }
  const dir = dataDir || path.join(process.cwd(), '.data');
  const store = new FileStore({ dir });
  await store.init();
  return { store, driver: 'file', location: path.join(dir, 'shopdesk.json') };
}
