/**
 * Tenant-scoped repository helpers.
 *
 * Every business collection is shared across tenants, so *every* query and
 * write is filtered by the server-derived tenantId from the session context.
 * Route handlers never accept a tenantId from the client.
 */

import { forbidden, notFound } from '../errors.js';

/** Collections that live above a tenant boundary (platform identity). */
const GLOBAL_COLLECTIONS = new Set(['tenants', 'users']);

function requireStore(ctx) {
  if (!ctx?.store) throw forbidden('No data store is bound to this request');
  return ctx.store;
}

export function repo(ctx, name) {
  const store = requireStore(ctx);
  const base = store.collection(name);
  const scoped = !GLOBAL_COLLECTIONS.has(name);

  if (scoped && !ctx.tenantId) {
    throw forbidden('A tenant context is required for this operation');
  }

  /** Add tenant scope to any filter/update selector. */
  const scope = (filter = {}) => (scoped ? { ...filter, tenantId: ctx.tenantId } : filter);

  return {
    async insertOne(doc) {
      const row = scoped ? { ...doc, tenantId: ctx.tenantId } : { ...doc };
      await base.insertOne(row);
      return row;
    },
    async insertMany(docs) {
      const rows = docs.map((doc) => (scoped ? { ...doc, tenantId: ctx.tenantId } : { ...doc }));
      if (rows.length) await base.insertMany(rows);
      return rows;
    },
    async findOne(filter = {}, options = {}) {
      return base.findOne(scope(filter), options);
    },
    async find(filter = {}, options = {}) {
      return base.find(scope(filter), options);
    },
    async updateOne(filter, update, options = {}) {
      const result = await base.updateOne(scope(filter), update, options);
      if (!result.matchedCount && options.require === true) {
        throw notFound('record not found in this workspace');
      }
      return result;
    },
    async updateMany(filter, update) {
      return base.updateMany(scope(filter), update);
    },
    async deleteOne(filter) {
      return base.deleteOne(scope(filter));
    },
    async deleteMany(filter = {}) {
      return base.deleteMany(scope(filter));
    },
    async count(filter = {}) {
      return base.countDocuments(scope(filter));
    },
    async countDocuments(filter = {}) {
      return base.countDocuments(scope(filter));
    },
  };
}

/** Tenant document (global collection) read using only the session's tenantId. */
export async function getTenantRecord(ctx) {
  if (!ctx?.tenantId) throw forbidden('A tenant context is required');
  const tenant = await ctx.store.collection('tenants').findOne({ _id: ctx.tenantId });
  if (!tenant) throw notFound('workspace not found');
  return tenant;
}

export async function updateTenantRecord(ctx, patch) {
  if (!ctx?.tenantId) throw forbidden('A tenant context is required');
  const tenant = await getTenantRecord(ctx);
  await ctx.store.collection('tenants').updateOne({ _id: tenant._id }, { $set: patch });
  return { ...tenant, ...patch };
}

export function assertBranch(ctx, branchId) {
  // Callers that omit a branch act on the membership's active branch; the value
  // never comes from an untrusted body field.
  const effective = branchId || ctx.branchId;
  if (!effective) throw forbidden('A branch is required for this operation');
  const allowed = ctx.allowedBranchIds;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(effective)) {
    throw forbidden('Your membership is not authorised for that branch');
  }
  return effective;
}

export async function requireTenantDoc(ctx, collection, id, label = 'record') {
  if (!id) throw notFound(`${label} not found`);
  const doc = await repo(ctx, collection).findOne({ _id: String(id) });
  if (!doc) throw notFound(`${label} not found in this workspace`);
  return doc;
}
