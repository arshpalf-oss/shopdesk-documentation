import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateProportional,
  divRoundHalfUp,
  formatINR,
  formatPaise,
  formatScaled,
  mulDivRound,
  parseScaled,
  toPaise,
} from '../server/money.js';
import { computeQuote, decomposeInclusive, resolveSupplyMode, roundTax } from '../server/domain/tax.js';
import { financialYear, resolvePeriod, expiryCutoffExclusive, isExpired, businessDate } from '../server/time.js';

test('money: paise are exact integer strings and reject floats/overflow', () => {
  assert.equal(toPaise('12345'), 12345n);
  assert.equal(formatPaise('12345'), '123.45');
  assert.throws(() => toPaise('12.5'), /integer paise/i);
  assert.throws(() => toPaise(12.5), /integer paise/i);
  assert.throws(() => toPaise('9223372036854775808'), /64-bit/i);
});

test('money: half-up rounding and exact mulDiv', () => {
  assert.equal(divRoundHalfUp(5n, 2n), 3n);
  assert.equal(divRoundHalfUp(-5n, 2n), -3n);
  assert.equal(divRoundHalfUp(4n, 2n), 2n);
  assert.equal(mulDivRound(10000n, 1n, 3n), 3333n);
  assert.equal(mulDivRound(10000n, 2n, 3n), 6667n);
});

test('money: largest-remainder allocation always reconciles', () => {
  const parts = allocateProportional(100n, [1n, 1n, 1n]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 100n);
  assert.deepEqual(parts.map(String), ['34', '33', '33']);
  const cents = allocateProportional(25101n, [12550n, 12551n]);
  assert.equal(cents.reduce((a, b) => a + b, 0n), 25101n);
});

test('money: scaled quantities keep declared precision', () => {
  assert.equal(parseScaled('1.5', 3).toString(), '1500');
  assert.throws(() => parseScaled('1.2345', 3), /decimal place/i);
  assert.equal(parseScaled('1.2345', 3, 'qty', { round: 'half_up' }).toString(), '1235');
  assert.equal(formatScaled(1500n, 3), '1.5');
  assert.equal(formatINR('123456789'), '₹12,34,567.89');
  assert.equal(formatINR('-1'), '-₹0.01');
});

test('tax: exclusive line with intra-state equal halves', () => {
  const quote = computeQuote({
    lines: [{ productId: 'p1', name: 'Item', quantityScale: 0, quantityScaled: '3', unitPricePaise: '10000', taxRateBps: '1200', taxTreatment: 'taxable', uom: 'unit' }],
    registration: { profile: 'regular', stateCode: '09' },
    customer: { stateCode: '09' },
  });
  assert.equal(quote.totals.taxableValuePaise, '30000');
  assert.equal(quote.totals.cgstPaise, '1800');
  assert.equal(quote.totals.sgstPaise, '1800');
  assert.equal(quote.totals.igstPaise, '0');
  assert.equal(quote.totals.totalPaise, '33600');
  assert.equal(quote.docKind, 'tax_invoice');
});

test('tax: inclusive price decomposition is exact and reconciles', () => {
  const quote = computeQuote({
    lines: [{ productId: 'p1', name: 'Item', quantityScale: 0, quantityScaled: '2', unitPricePaise: '12550', priceMode: 'inclusive', taxRateBps: '1200', taxTreatment: 'taxable', uom: 'strip' }],
    registration: { profile: 'regular', stateCode: '09' },
    customer: { stateCode: '09' },
  });
  assert.equal(quote.totals.grossPaise, '25100');
  assert.equal(quote.totals.totalPaise, '25100');
  // taxable + components + explicit round-off = invoice total (exact paise)
  assert.equal(
    BigInt(quote.totals.taxableValuePaise) + BigInt(quote.totals.taxPaise) + BigInt(quote.totals.roundOffPaise),
    25100n
  );
  // The odd paisa is an explicit round-off line, not a one-sided component.
  assert.equal(quote.totals.roundOffPaise, '-1');
  assert.equal(quote.totals.cgstPaise, quote.totals.sgstPaise);
});

test('tax: odd-paisa tax uses equal halves plus explicit round-off (never one half)', () => {
  const quote = computeQuote({
    lines: [{ productId: 'p1', name: 'Item', quantityScale: 0, quantityScaled: '1', unitPricePaise: '10010', taxRateBps: '500', taxTreatment: 'taxable', uom: 'unit' }],
    registration: { profile: 'regular', stateCode: '09' },
    customer: { stateCode: '09' },
  });
  assert.equal(quote.totals.cgstPaise, quote.totals.sgstPaise);
  assert.equal(quote.totals.roundOffPaise, '-1');
  assert.equal(
    BigInt(quote.totals.taxableValuePaise) + BigInt(quote.totals.cgstPaise) + BigInt(quote.totals.sgstPaise) + BigInt(quote.totals.roundOffPaise),
    BigInt(quote.totals.totalPaise)
  );
  assert.throws(
    () =>
      computeQuote({
        lines: [{ productId: 'p1', name: 'Item', quantityScale: 0, quantityScaled: '1', unitPricePaise: '10010', taxRateBps: '500', taxTreatment: 'taxable', uom: 'unit' }],
        registration: { profile: 'regular', stateCode: '09' },
        customer: { stateCode: '09' },
        policy: { equalHalvesPolicy: 'reject_odd' },
      }),
    /odd-paisa/i
  );
});

test('tax: inter-state supply uses IGST only', () => {
  const mode = resolveSupplyMode({ registration: { profile: 'regular', stateCode: '09' }, customer: { stateCode: '27' } });
  assert.equal(mode, 'inter');
  const quote = computeQuote({
    lines: [{ productId: 'p1', name: 'Item', quantityScale: 0, quantityScaled: '1', unitPricePaise: '10000', taxRateBps: '1800', taxTreatment: 'taxable', uom: 'unit' }],
    registration: { profile: 'regular', stateCode: '09' },
    customer: { stateCode: '27' },
  });
  assert.equal(quote.totals.cgstPaise, '0');
  assert.equal(quote.totals.sgstPaise, '0');
  assert.equal(quote.totals.igstPaise, '1800');
});

test('tax: unregistered profile collects no GST and issues a non-tax document', () => {
  const quote = computeQuote({
    lines: [{ productId: 'p1', name: 'Item', quantityScale: 0, quantityScaled: '1', unitPricePaise: '10000', taxRateBps: '1200', taxTreatment: 'taxable', uom: 'unit' }],
    registration: { profile: 'unregistered', stateCode: '09' },
  });
  assert.equal(quote.totals.taxPaise, '0');
  assert.equal(quote.docKind, 'commercial_sale');
});

test('tax: invoice discount is allocated exactly across lines', () => {
  const quote = computeQuote({
    lines: [
      { productId: 'p1', name: 'A', quantityScale: 0, quantityScaled: '1', unitPricePaise: '3333', taxRateBps: '500', taxTreatment: 'taxable', uom: 'unit' },
      { productId: 'p2', name: 'B', quantityScale: 0, quantityScaled: '1', unitPricePaise: '3333', taxRateBps: '500', taxTreatment: 'taxable', uom: 'unit' },
    ],
    registration: { profile: 'regular', stateCode: '09' },
    customer: { stateCode: '09' },
    invoiceDiscountPaise: '100',
  });
  const sumDiscounts = quote.lines.reduce((a, l) => a + BigInt(l.discountPaise), 0n);
  assert.equal(sumDiscounts, 100n);
  assert.equal(quote.totals.discountPaise, '100');
});

test('tax: unknown treatment or bad rate is rejected', () => {
  assert.throws(() => roundTax('100', '10001'), /between 0 and 10000/i);
  assert.throws(
    () =>
      computeQuote({
        lines: [{ productId: 'p1', name: 'A', quantityScale: 0, quantityScaled: '1', unitPricePaise: '100', taxRateBps: '0', taxTreatment: 'nonsense' }],
        registration: { profile: 'regular', stateCode: '09' },
      }),
    /tax treatment/i
  );
  assert.deepEqual(decomposeInclusive(1120n, 1200n), { taxable: 1000n, tax: 120n });
});

test('time: Indian financial year and period bounds', () => {
  assert.equal(financialYear(new Date('2026-03-31T10:00:00Z')), '2025-26');
  assert.equal(financialYear(new Date('2026-04-01T00:00:00Z')), '2026-27');
  const p = resolvePeriod({ preset: 'custom', from: '2026-10-01', to: '2026-10-26', now: new Date('2026-10-26T10:00:00Z') });
  assert.equal(p.from.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(p.to.toISOString(), '2026-10-26T18:30:00.000Z');
  assert.equal(businessDate(new Date('2026-10-26T19:00:00Z')), '2026-10-27');
});

test('time: month-precision expiry is saleable to the end of the month only', () => {
  const cutoff = expiryCutoffExclusive({ precision: 'month', year: 2026, month: 2 });
  assert.equal(cutoff.toISOString(), '2026-02-28T18:30:00.000Z');
  assert.equal(isExpired({ precision: 'month', year: 2026, month: 2 }, new Date('2026-03-01T00:00:00Z')), true);
  assert.equal(isExpired({ precision: 'month', year: 2026, month: 2 }, new Date('2026-02-28T00:00:00Z')), false);
  assert.equal(isExpired({ precision: 'none' }, new Date('2030-01-01T00:00:00Z')), false);
});
