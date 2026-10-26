/**
 * Inventory: batches, FEFO, append-only movements, adjustments and quarantine.
 *
 * Rules enforced here:
 *  - never negative available quantity (compare-and-swap on the stored value);
 *  - expired, recalled, quarantined, damaged or cold-chain-unverified stock is
 *    never saleable, even when its calendar expiry is in the future;
 *  - required-but-unknown expiry blocks sale;
 *  - a stock balance is never overwritten from the UI: every change is an
 *    append-only movement with a source document and actor.
 */

import { conflict, legalGate, unprocessable } from '../errors.js';
import { newId } from '../ids.js';
import { formatScaled, mulDivRound, parseScaled, toPaise } from '../money.js';
import { isExpired, expiryLabel } from '../time.js';
import { assertBranch, repo, requireTenantDoc } from '../tenancy/repo.js';

export const BATCH_STATUSES = ['saleable', 'quarantined', 'recalled', 'disposed', 'expired'];
export const MOVEMENT_TYPES = [
  'opening',
  'purchase',
  'sale',
  'sale_return_restock',
  'supplier_return',
  'adjustment_increase',
  'adjustment_decrease',
  'wastage',
  'damage',
  'expiry_writeoff',
  'internal_consumption',
  'quarantine',
  'release_quarantine',
  'disposal',
  'transfer_out',
  'transfer_in',
];

export function expirySortKey(expiry) {
  if (!expiry || expiry.precision === 'none') return '9999-12-31';
  if (expiry.precision === 'year') return `${expiry.year}-12-31`;
  if (expiry.precision === 'month') return `${expiry.year}-${String(expiry.month).padStart(2, '0')}-31`;
  return expiry.date;
}

export async function getOrCreateBalance(ctx, { branchId, batch }) {
  const balances = repo(ctx, 'stock_balances');
  const existing = await balances.findOne({ batchId: batch._id });
  if (existing) return existing;
  const balance = {
    _id: newId(),
    branchId,
    batchId: batch._id,
    productId: batch.productId,
    availableScaled: '0',
    reservedScaled: '0',
    nonSaleableScaled: '0',
    version: 1,
    createdAt: ctx.now ? ctx.now() : new Date(),
  };
  await balances.insertOne(balance);
  return balance;
}

export async function recordMovement(ctx, movement) {
  const doc = {
    _id: newId(),
    branchId: movement.branchId,
    productId: movement.productId,
    batchId: movement.batchId,
    type: movement.type,
    quantityScaled: String(movement.quantityScaled),
    quantityScale: movement.quantityScale,
    sourceType: movement.sourceType,
    sourceId: movement.sourceId,
    reason: movement.reason || null,
    costPaise: movement.costPaise ? String(movement.costPaise) : null,
    actorId: ctx.userId,
    at: ctx.now ? ctx.now() : new Date(),
  };
  await repo(ctx, 'inventory_movements').insertOne(doc);
  return doc;
}

/**
 * Conditional balance change. Optimistic compare-and-swap keeps parallel
 * checkouts from overselling the same last unit.
 */
export async function applyToBalance(ctx, { balanceId, field, deltaScaled, expectVersion }) {
  const balances = repo(ctx, 'stock_balances');
  const current = await balances.findOne({ _id: balanceId });
  if (!current) throw conflict('stock balance disappeared', 'STOCK_CONFLICT');
  if (expectVersion !== undefined && current.version !== expectVersion) {
    throw conflict('stock changed while you were working; reload the item', 'STOCK_CONFLICT');
  }
  const next = BigInt(current[field] || '0') + BigInt(deltaScaled);
  if (next < 0n) {
    throw conflict('insufficient eligible stock for this action', 'INSUFFICIENT_STOCK');
  }
  const updated = await balances.updateOne(
    { _id: balanceId, version: current.version, [field]: current[field] || '0' },
    { $set: { [field]: next.toString(), updatedAt: ctx.now ? ctx.now() : new Date() }, $inc: { version: 1 } }
  );
  if (updated.modifiedCount !== 1) {
    throw conflict('stock changed concurrently; retry the action', 'STOCK_CONFLICT');
  }
  return { ...current, [field]: next.toString(), version: current.version + 1 };
}

/** Eligible batches for a product, earliest expiry first (FEFO). */
export async function eligibleBatches(ctx, { branchId, product, now = new Date(), includeExpired = false }) {
  assertBranch(ctx, branchId);
  const balances = await repo(ctx, 'stock_balances').find({ branchId, productId: product._id });
  const eligible = [];
  for (const balance of balances) {
    if (BigInt(balance.availableScaled) <= 0n) continue;
    const batch = await repo(ctx, 'batch_lots').findOne({ _id: balance.batchId });
    if (!batch) continue;
    if (batch.status !== 'saleable' || batch.recalled) continue;
    if (!includeExpired && isExpired(batch.expiry, now)) continue;
    if (product.expiryRequired && (!batch.expiry || batch.expiry.precision === 'none')) continue;
    eligible.push({ ...batch, balance });
  }
  eligible.sort((a, b) => {
    const ka = expirySortKey(a.expiry);
    const kb = expirySortKey(b.expiry);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return String(a.receivedAt || '') < String(b.receivedAt || '') ? -1 : 1;
  });
  return eligible;
}

/** Plan FEFO allocations for a required quantity. */
export async function planFefo(ctx, { branchId, product, quantityScaled, now = new Date(), allowBatchId = null }) {
  const quantity = BigInt(quantityScaled);
  if (quantity <= 0n) throw unprocessable('quantity must be greater than zero');
  const batches = await eligibleBatches(ctx, { branchId, product, now });
  const candidates = allowBatchId ? batches.filter((b) => b._id === allowBatchId) : batches;
  let remaining = quantity;
  const allocations = [];
  for (const batch of candidates) {
    if (remaining === 0n) break;
    const available = BigInt(batch.balance.availableScaled);
    const take = available < remaining ? available : remaining;
    if (take <= 0n) continue;
    allocations.push({
      batchId: batch._id,
      batchNo: batch.batchNo,
      expiry: batch.expiry,
      expiryLabel: expiryLabel(batch.expiry),
      quantityScaled: take.toString(),
      balance: batch.balance,
      batch,
    });
    remaining -= take;
  }
  if (remaining > 0n) {
    throw conflict(
      `insufficient eligible stock for ${product.name} (${formatScaled(remaining, product.quantityScale)} short)`,
      'INSUFFICIENT_STOCK',
      { shortScaled: remaining.toString(), productId: product._id }
    );
  }
  return allocations;
}

/** Allocate the exact cost of `quantity` out of a receipt's cost pool. */
export function allocateCostFromBatch(batch, quantityScaled) {
  const receivedScaled = BigInt(batch.receivedScaled || '0');
  const costPool = toPaise(batch.receivedCostPaise || '0');
  if (receivedScaled === 0n) return 0n;
  return mulDivRound(costPool, BigInt(quantityScaled), receivedScaled);
}

/** Amount still available to sell for a product at a branch (quantity only). */
export async function availabilityFor(ctx, { branchId, productIds }) {
  const balances = await repo(ctx, 'stock_balances').find({ branchId, productId: { $in: productIds } });
  const map = new Map();
  for (const b of balances) {
    const prev = map.get(b.productId) || 0n;
    map.set(b.productId, prev + BigInt(b.availableScaled));
  }
  return map;
}

export async function availableQuantity(ctx, { branchId, productId }) {
  const balances = await repo(ctx, 'stock_balances').find({ branchId, productId });
  return balances.reduce((a, b) => a + BigInt(b.availableScaled), 0n);
}

/**
 * Receive a batch through an approved receipt (purchase or opening).
 * Same batch number at the same branch is topped up; its cost pool is
 * increased by the actual receipt cost.
 */
export async function receiveBatch(ctx, input) {
  assertBranch(ctx, input.branchId);
  const product = await requireTenantDoc(ctx, 'products', input.productId, 'product');
  if (product.kind === 'service') throw unprocessable('services are not stocked');
  const quantity = parseScaled(String(input.quantityScaled), product.quantityScale, 'received quantity');
  if (quantity <= 0n) throw unprocessable('received quantity must be greater than zero');
  const unitCost = toPaise(input.unitCostPaise || '0', 'unit cost');
  if (unitCost < 0n) throw unprocessable('unit cost must not be negative');
  const costPaise = unitCost > 0n
    ? mulDivRound(unitCost, quantity, 10n ** BigInt(product.quantityScale))
    : toPaise(input.totalCostPaise || '0', 'total cost');

  if (product.expiryRequired && (!input.expiry || input.expiry.precision === 'none')) {
    throw unprocessable(`expiry is required for ${product.name}; sales of unknown-expiry stock are blocked`);
  }
  if (product.batchRequired && !input.batchNo) {
    throw unprocessable(`a manufacturer batch number is required for ${product.name}`);
  }
  if (input.expiry && input.expiry.precision === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiry.date || '')) {
    throw unprocessable('expiry date must be YYYY-MM-DD');
  }

  const batchNo = input.batchNo || 'N/A';
  const batchNoNormalised = String(batchNo).trim().toUpperCase();
  const batches = repo(ctx, 'batch_lots');
  let batch = await batches.findOne({ branchId: input.branchId, productId: product._id, batchNoNormalised });
  if (batch) {
    if (batch.status !== 'saleable') {
      throw legalGate(
        `batch ${batchNo} is ${batch.status}; receive a new batch instead of adding to an ineligible lot`
      );
    }
    await batches.updateOne(
      { _id: batch._id, version: batch.version },
      {
        $set: {
          receivedScaled: (BigInt(batch.receivedScaled) + quantity).toString(),
          receivedCostPaise: (BigInt(batch.receivedCostPaise) + costPaise).toString(),
          updatedAt: ctx.now ? ctx.now() : new Date(),
        },
        $inc: { version: 1 },
      }
    );
    batch = await batches.findOne({ _id: batch._id });
  } else {
    batch = {
      _id: newId(),
      branchId: input.branchId,
      productId: product._id,
      batchNo,
      batchNoNormalised,
      expiry: input.expiry || { precision: 'none' },
      expirySortKey: expirySortKey(input.expiry),
      receivedScaled: quantity.toString(),
      receivedCostPaise: costPaise.toString(),
      manufacturer: input.manufacturer || product.manufacturer || null,
      status: 'saleable',
      recalled: false,
      coldChainVerified: input.coldChainVerified !== false,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      receivedAt: ctx.now ? ctx.now() : new Date(),
      version: 1,
    };
    await batches.insertOne(batch);
  }

  const balance = await getOrCreateBalance(ctx, { branchId: input.branchId, batch });
  const updated = await applyToBalance(ctx, {
    balanceId: balance._id,
    field: 'availableScaled',
    deltaScaled: quantity.toString(),
  });
  await recordMovement(ctx, {
    branchId: input.branchId,
    productId: product._id,
    batchId: batch._id,
    type: input.movementType || 'purchase',
    quantityScaled: quantity.toString(),
    quantityScale: product.quantityScale,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    costPaise,
    reason: input.reason || null,
  });
  return { batch, balance: updated, quantity, costPaise, product };
}

const ADJUSTMENT_ACCOUNTS = {
  wastage: '5100',
  damage: '5100',
  expiry_writeoff: '5100',
  internal_consumption: '5100',
  adjustment_decrease: '5100',
};

/**
 * Approved stock adjustment. Decreases post a loss/expense and reduce inventory
 * at the batch's allocated cost; increases require an explicit valuation.
 */
export async function postStockAdjustment(ctx, input) {
  assertBranch(ctx, input.branchId);
  const product = await requireTenantDoc(ctx, 'products', input.productId, 'product');
  const batch = await requireTenantDoc(ctx, 'batch_lots', input.batchId, 'batch');
  if (batch.productId !== product._id) throw unprocessable('batch does not belong to the selected product');
  if (!input.reason || String(input.reason).trim().length < 5) {
    throw unprocessable('a reason of at least 5 characters is required for a stock adjustment');
  }
  const quantity = parseScaled(String(input.quantityScaled), product.quantityScale, 'adjustment quantity');
  if (quantity <= 0n) throw unprocessable('adjustment quantity must be greater than zero');
  const type = input.type;
  const allowed = ['adjustment_increase', 'adjustment_decrease', 'wastage', 'damage', 'expiry_writeoff', 'internal_consumption'];
  if (!allowed.includes(type)) throw unprocessable(`unsupported adjustment type ${type}`);
  const balance = await repo(ctx, 'stock_balances').findOne({ batchId: batch._id });
  if (!balance) throw unprocessable('this batch has no stock balance');

  const isIncrease = type === 'adjustment_increase';
  const unitCost = isIncrease
    ? toPaise(input.unitCostPaise || '0', 'valuation unit cost')
    : allocateCostFromBatch(batch, quantity);
  const quantityScale = product.quantityScale;
  const costPaise = isIncrease
    ? mulDivRound(unitCost, quantity, 10n ** BigInt(quantityScale))
    : unitCost;

  const updatedBalance = await applyToBalance(ctx, {
    balanceId: balance._id,
    field: 'availableScaled',
    deltaScaled: isIncrease ? quantity.toString() : `-${quantity.toString()}`,
  });
  await recordMovement(ctx, {
    branchId: input.branchId,
    productId: product._id,
    batchId: batch._id,
    type,
    quantityScaled: quantity.toString(),
    quantityScale,
    sourceType: 'stock_adjustment',
    sourceId: input.adjustmentId,
    costPaise,
    reason: input.reason,
  });
  return { product, batch, balance: updatedBalance, quantity, costPaise, type, isIncrease, accountCode: ADJUSTMENT_ACCOUNTS[type] || '5100' };
}

/** Move stock between saleable and non-saleable without changing ownership. */
export async function setBatchStatus(ctx, { batchId, status, reason }) {
  const batch = await requireTenantDoc(ctx, 'batch_lots', batchId, 'batch');
  if (!BATCH_STATUSES.includes(status)) throw unprocessable('unknown batch status');
  if (!reason) throw unprocessable('a reason is required to change a batch status');
  if (batch.status === status) return batch;
  const balances = await repo(ctx, 'stock_balances').find({ batchId });
  for (const balance of balances) {
    const available = BigInt(balance.availableScaled);
    if (available <= 0n) continue;
    if (status === 'saleable') {
      await applyToBalance(ctx, { balanceId: balance._id, field: 'nonSaleableScaled', deltaScaled: `-${available}` });
      await applyToBalance(ctx, { balanceId: balance._id, field: 'availableScaled', deltaScaled: available.toString() });
    } else {
      await applyToBalance(ctx, { balanceId: balance._id, field: 'availableScaled', deltaScaled: `-${available}` });
      await applyToBalance(ctx, { balanceId: balance._id, field: 'nonSaleableScaled', deltaScaled: available.toString() });
    }
    await recordMovement(ctx, {
      branchId: balance.branchId,
      productId: batch.productId,
      batchId,
      type: status === 'saleable' ? 'release_quarantine' : 'quarantine',
      quantityScaled: available.toString(),
      quantityScale: 0,
      sourceType: 'batch_status',
      sourceId: batchId,
      reason,
    });
  }
  const nextStatus = status === 'saleable' ? 'saleable' : status;
  await repo(ctx, 'batch_lots').updateOne({ _id: batchId }, { $set: { status: nextStatus }, $inc: { version: 1 } });
  return { ...batch, status: nextStatus };
}
