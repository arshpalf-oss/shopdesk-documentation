import crypto from 'node:crypto';

/** Ids are opaque 24-hex strings so the file and Mongo drivers share one shape. */
export function newId() {
  return crypto.randomBytes(12).toString('hex');
}

export function isId(value) {
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function idempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    const err = new Error('Idempotency-Key header must be 8–128 characters of letters, digits, dot, colon, underscore or hyphen');
    err.status = 400;
    err.code = 'IDEMPOTENCY_KEY_INVALID';
    throw err;
  }
  return key;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Deterministic JSON: sorted object keys, no undefined, stable for hashing. */
export function canonicalJson(value) {
  const norm = (v) => {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : norm(x)));
    if (v instanceof Date) return v.toISOString();
    const out = {};
    for (const key of Object.keys(v).sort()) {
      const n = norm(v[key]);
      if (n !== undefined) out[key] = n;
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

export function canonicalHash(value) {
  return sha256(canonicalJson(value));
}
