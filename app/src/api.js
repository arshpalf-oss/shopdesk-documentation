/** Browser API client: same-origin only, CSRF header, no secret in the bundle. */

let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token || null;
}

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.code || 'REQUEST_FAILED';
    this.details = payload?.details || null;
    this.requestId = payload?.requestId || null;
    this.blockers = payload?.details?.blockers || [];
  }
}

export async function api(path, { method = 'GET', body, idempotencyKey, headers = {} } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken) options.headers['X-CSRF-Token'] = csrfToken;
  if (idempotencyKey) options.headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`/api/v1${path}`, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(data?.error || { message: text?.slice(0, 200) }, res.status);
  return data;
}

export function newIdempotencyKey(prefix = 'ui') {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex}`;
}

/** Paise string → ₹ with Indian digit grouping. Never parses to a float. */
export function inr(paise, { sign = false } = {}) {
  if (paise === null || paise === undefined || paise === '') return '—';
  let value;
  try {
    value = BigInt(paise);
  } catch {
    return '—';
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = abs / 100n;
  const fraction = abs % 100n;
  const digits = rupees.toString();
  let grouped = digits;
  if (digits.length > 3) {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  const text = `₹${grouped}.${fraction.toString().padStart(2, '0')}`;
  if (negative) return `−${text}`;
  return sign && value > 0n ? `+${text}` : text;
}

export function paiseToInput(paise) {
  if (paise === null || paise === undefined) return '';
  const value = BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** "123.45" → "12345" paise without any floating point arithmetic. */
export function inputToPaise(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '0';
  const match = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new Error('Enter an amount like 1250 or 1250.50');
  const [, sign, rupees, fraction] = match;
  const value = BigInt(rupees) * 100n + BigInt((fraction || '').padEnd(2, '0') || '0');
  return `${sign ? '-' : ''}${value.toString()}`;
}

export function scaledToInput(scaled, scale = 0) {
  if (scaled === null || scaled === undefined) return '';
  const value = BigInt(scaled);
  if (scale === 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function inputToScaled(text, scale = 0) {
  const raw = String(text ?? '').trim();
  if (!raw) return '0';
  const match = /^(-)?(\d{1,12})(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) throw new Error('Enter a quantity like 2 or 2.5');
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) throw new Error(`This product allows at most ${scale} decimal place(s)`);
  const padded = fraction.padEnd(scale, '0');
  const value = BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || '0');
  return `${sign ? '-' : ''}${value.toString()}`;
}

export function labelText(permission) {
  return String(permission || '')
    .replace(/\./g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isoDay(date = new Date()) {
  // Browser local date is not the business date; the server returns it. This is
  // only used for date inputs the user explicitly edits.
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
