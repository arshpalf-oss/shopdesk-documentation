/**
 * Test-only helpers that use approved domain paths (never direct balance edits
 * in production code). Kept separate so services cannot import them.
 */
import { postStockAdjustment, receiveBatch } from '../server/domain/inventory.js';
import { postWriteOff } from '../server/domain/accounting.js';
import { businessDate } from '../server/time.js';
import { repo } from '../server/tenancy/repo.js';

export async function receiveBatchRaw(ctx, input) {
  return ctx.store.transaction(() =>
    receiveBatch(ctx, {
      branchId: ctx.branchId,
      sourceType: 'test_receipt',
      sourceId: `test-${input.batchNo}`,
      ...input,
    })
  );
}

export async function createStockAdjustmentForTest(ctx, productId, quantityScaled) {
  return ctx.store.transaction(async () => {
  const balance = await repo(ctx, 'stock_balances').findOne({ productId });
  const adjustmentId = `test-adjustment-${Date.now()}`;
  const adjustment = await postStockAdjustment(ctx, {
    branchId: ctx.branchId,
    productId,
    batchId: balance.batchId,
    quantityScaled,
    type: 'wastage',
    reason: 'Automated test wastage write-off',
    adjustmentId,
  });
  await postWriteOff(ctx, {
    adjustment: { _id: adjustmentId, type: 'wastage', reason: 'Automated test wastage write-off', costPaise: adjustment.costPaise.toString() },
    businessDate: businessDate(),
    branchId: ctx.branchId,
  });
  return adjustment;
  });
}
