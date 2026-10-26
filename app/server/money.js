/**
 * shop desk — exact monetary arithmetic.
 *
 * RULE (engineering pack §6): monetary amounts are integer paise held as
 * base-10 strings in documents/JSON and BigInt in calculations. Quantities are
 * scaled integers ("Scaled" suffix) with an explicit per-product scale.
 * No binary floating point is ever used for money or quantity.
 */

export const PAISE_MIN = -(2n ** 63n) + 1n;
export const PAISE_MAX = 2n ** 63n - 1n;

const INT_RE = /^-?\d+$/;
const DEC_RE = /^-?\d+(\.\d+)?$/;

export class MoneyError extends Error {
  constructor(message, code = 'MONEY_INVALID') {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
    this.status = 422;
  }
}

function assertBound(n, label = 'amount') {
  if (n < PAISE_MIN || n > PAISE_MAX) {
    throw new MoneyError(`${label} is outside the supported 64-bit paise range`, 'MONEY_OVERFLOW');
  }
  return n;
}

/** Parse an integer-paise value from a string/number-free input. */
export function toPaise(value, label = 'amount') {
  if (typeof value === 'bigint') return assertBound(value, label);
  if (typeof value === 'string' && INT_RE.test(value.trim())) {
    return assertBound(BigInt(value.trim()), label);
  }
  throw new MoneyError(`${label} must be an integer paise string`, 'MONEY_INVALID');
}

/** Serialise paise for storage/transport. */
export function paiseString(value, label = 'amount') {
  return toPaise(value, label).toString();
}

/**
 * Parse a human decimal into scaled integer units.
 * scale = number of decimal places of the unit (e.g. quantity scale 3).
 * Extra precision is rejected unless `round: 'half_up'` is requested.
 */
export function parseScaled(value, scale, label = 'quantity', { round = 'reject' } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new MoneyError(`${label} must be a decimal string`, 'QUANTITY_INVALID');
  }
  const text = String(value).trim();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new MoneyError(`${label} must be finite`, 'QUANTITY_INVALID');
  }
  // A JS number that carries more precision than 2^53 must not be trusted.
  if (typeof value === 'number' && Math.abs(value) > 1e15) {
    throw new MoneyError(`${label} must be supplied as a decimal string`, 'QUANTITY_INVALID');
  }
  if (!DEC_RE.test(text)) {
    throw new MoneyError(`${label} must be a plain decimal value`, 'QUANTITY_INVALID');
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
    throw new MoneyError('scale must be an integer between 0 and 6', 'QUANTITY_INVALID');
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) {
    if (round !== 'half_up') {
      throw new MoneyError(
        `${label} has more than ${scale} decimal place(s); round explicitly before submitting`,
        'QUANTITY_PRECISION'
      );
    }
    const keep = fraction.slice(0, scale);
    const next = fraction.charAt(scale);
    let scaled = BigInt(whole + keep.padEnd(scale, '0'));
    if (Number(next) >= 5) scaled += 1n;
    return assertBound(negative ? -scaled : scaled, label);
  }
  const scaled = BigInt(whole + fraction.padEnd(scale, '0'));
  return assertBound(negative ? -scaled : scaled, label);
}

export function scaledString(value, label = 'quantity') {
  return parseScaled(value, 0, label).toString();
}

/** Render scaled units as a trimmed decimal string. */
export function formatScaled(scaled, scale, { trimZeros = true, minScale = 0 } = {}) {
  const n = typeof scaled === 'bigint' ? scaled : BigInt(String(scaled));
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const base = 10n ** BigInt(scale);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(scale, '0');
  if (trimZeros) fraction = fraction.replace(/0+$/, '');
  while (fraction.length && fraction.length < minScale) fraction += '0';
  const body = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Render integer paise as a plain decimal string ("1234.50"). */
export function formatPaise(value, { trimZeros = false } = {}) {
  return formatScaled(toPaise(value), 2, { trimZeros });
}

/** Indian digit grouping for display only. */
export function groupIndian(intString) {
  const negative = intString.startsWith('-');
  const digits = negative ? intString.slice(1) : intString;
  if (digits.length <= 3) return (negative ? '-' : '') + digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped},${last3}`;
}

export function formatINR(value, { showSymbol = true, trimZeros = false } = {}) {
  const n = toPaise(value);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = groupIndian((abs / 100n).toString());
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const body = trimZeros && fraction === '00' ? whole : `${whole}.${fraction}`;
  return `${negative ? '-' : ''}${showSymbol ? '₹' : ''}${body}`;
}

/** Exact half-up division (away from zero on .5). */
export function divRoundHalfUp(numerator, denominator) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    throw new MoneyError('divRoundHalfUp requires BigInt operands', 'MONEY_INVALID');
  }
  if (denominator <= 0n) throw new MoneyError('divisor must be positive', 'MONEY_INVALID');
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const q = abs / denominator;
  const r = abs % denominator;
  const rounded = r * 2n >= denominator ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** value * multiplier / divisor with exact half-up rounding. */
export function mulDivRound(value, multiplier, divisor) {
  const a = typeof value === 'bigint' ? value : toPaise(value);
  const b = typeof multiplier === 'bigint' ? multiplier : BigInt(multiplier);
  const c = typeof divisor === 'bigint' ? divisor : BigInt(divisor);
  return assertBound(divRoundHalfUp(a * b, c));
}

export function sumPaise(values) {
  let total = 0n;
  for (const v of values) total += toPaise(v);
  return assertBound(total);
}

export function maxBig(a, b) {
  const x = typeof a === 'bigint' ? a : toPaise(a);
  const y = typeof b === 'bigint' ? b : toPaise(b);
  return x > y ? x : y;
}

export function minBig(a, b) {
  const x = typeof a === 'bigint' ? a : toPaise(a);
  const y = typeof b === 'bigint' ? b : toPaise(b);
  return x < y ? x : y;
}

/**
 * Split `total` across integer `weights` using the largest-remainder method.
 * Guarantees sum(result) === total and each part is an integer of the same sign.
 */
export function allocateProportional(total, weights) {
  const totalN = typeof total === 'bigint' ? total : toPaise(total);
  if (!Array.isArray(weights) || weights.length === 0) {
    if (totalN !== 0n) throw new MoneyError('cannot allocate a non-zero amount over no weights');
    return [];
  }
  const ws = weights.map((w) => (typeof w === 'bigint' ? w : BigInt(w)));
  if (ws.some((w) => w < 0n)) throw new MoneyError('allocation weights must be non-negative');
  const weightSum = ws.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) {
    if (totalN === 0n) return ws.map(() => 0n);
    throw new MoneyError('cannot allocate over zero weights');
  }
  const negative = totalN < 0n;
  const abs = negative ? -totalN : totalN;
  const parts = [];
  const remainders = [];
  let assigned = 0n;
  ws.forEach((w, i) => {
    const product = abs * w;
    const base = product / weightSum;
    assigned += base;
    parts.push(base);
    remainders.push({ i, r: product % weightSum });
  });
  let remainder = abs - assigned;
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : (a.r > b.r ? -1 : 1)));
  for (let k = 0; remainder > 0n && k < remainders.length; k += 1) {
    parts[remainders[k].i] += 1n;
    remainder -= 1n;
  }
  return parts.map((p) => (negative ? -p : p));
}
