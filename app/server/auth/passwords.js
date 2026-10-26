import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** Scrypt password hashing (N=16384, r=8, p=1) with per-password salt. */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    const err = new Error('password must be at least 10 characters');
    err.status = 422;
    throw err;
  }
  if (password.length > 300) throw Object.assign(new Error('password is too long'), { status: 422 });
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function passwordPolicyIssues(password) {
  const issues = [];
  if (typeof password !== 'string') return ['password is required'];
  if (password.length < 10) issues.push('at least 10 characters');
  if (!/[A-Za-z]/.test(password)) issues.push('at least one letter');
  if (!/\d/.test(password)) issues.push('at least one digit');
  if (/^(password|shopdesk|12345678)/i.test(password)) issues.push('not a common default');
  return issues;
}
