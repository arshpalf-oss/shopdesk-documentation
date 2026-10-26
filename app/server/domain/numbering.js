/**
 * Document numbering.
 *
 * Server-side, transactional, unique per tenant + registration + financial year
 * + series. Never generated in the browser. GST Rule 46: at most 16 characters,
 * only letters, digits, hyphen and slash.
 */

import { conflict, unprocessable } from '../errors.js';
import { newId } from '../ids.js';
import { financialYearShort } from '../time.js';
import { repo } from '../tenancy/repo.js';

const ALLOWED = /^[A-Za-z0-9/-]+$/;

export const DOC_KINDS = {
  tax_invoice: 'Tax invoice',
  bill_of_supply: 'Bill of supply',
  commercial_sale: 'Sale record (non-GST)',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
  receipt: 'Receipt voucher',
  purchase: 'Purchase record',
  supplier_return: 'Supplier return',
  stock_adjustment: 'Stock adjustment',
  journal: 'Journal voucher',
};

export function validateSeries({ series, fyLabel, padding = 6, upTo = 1 }) {
  if (typeof series !== 'string' || !series.trim()) throw unprocessable('series code is required');
  if (!ALLOWED.test(series)) {
    throw unprocessable('series may only contain letters, digits, hyphen and slash (Rule 46)');
  }
  if (!Number.isInteger(padding) || padding < 1 || padding > 8) throw unprocessable('series padding must be 1–8');
  const sampleNumber = Math.max(upTo, 1);
  const candidate = `${series}/${fyShortOf(fyLabel)}/${String(sampleNumber).padStart(padding, '0')}`;
  if (candidate.length > 16) {
    throw unprocessable(
      `series "${series}" would create "${candidate}" (${candidate.length} characters). ` +
        'GST Rule 46 limits the serial number to 16 characters, so shorten the series or padding.'
    );
  }
  return { series, padding, sample: candidate, length: candidate.length };
}

function fyShortOf(fyLabel) {
  return String(fyLabel || '').slice(2);
}

export function formatNumber({ series, fyLabel, padding, counter }) {
  const fyShort = fyShortOf(fyLabel);
  const number = `${series}/${fyShort}/${String(counter).padStart(padding, '0')}`;
  if (!ALLOWED.test(number)) throw unprocessable('generated number contains a disallowed character');
  if (number.length > 16) throw unprocessable(`generated number "${number}" exceeds 16 characters`);
  return number;
}

/**
 * Atomically reserve the next number. MUST run inside the caller's transaction.
 */
export async function nextNumber(ctx, { registrationId, series, padding = 6, businessDate }) {
  const fyLabel = ctx.fyLabel || null;
  if (!fyLabel) throw new Error('financial year is required in context');
  const sequences = repo(ctx, 'sequences');
  const existing = await sequences.findOne({ registrationId, fy: fyLabel, series });
  let counter;
  if (!existing) {
    counter = 1;
    await sequences.insertOne({
      _id: newId(),
      registrationId,
      fy: fyLabel,
      series,
      padding,
      next: 2,
      createdAt: ctx.now ? ctx.now() : new Date(),
    });
  } else {
    const updated = await sequences.updateOne(
      { _id: existing._id, next: existing.next },
      { $inc: { next: 1 } },
      { setIdOnInsert: newId() }
    );
    if (updated.modifiedCount !== 1) {
      throw conflict('concurrent number reservation conflict; retry the operation', 'NUMBER_CONFLICT');
    }
    counter = existing.next;
  }
  const number = formatNumber({ series, fyLabel, padding: existing?.padding ?? padding, counter });
  return { number, fy: fyLabel, series, counter, businessDate };
}
