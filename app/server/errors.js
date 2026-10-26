/**
 * Application errors. The constructor is message-first:
 *   new AppError('Setup is already complete', { status: 409, code: 'SETUP_COMPLETE' })
 * Route handlers map these to sanitised JSON bodies.
 */

export class AppError extends Error {
  constructor(message, { status = 400, code = 'REQUEST_FAILED', details = null, retryable = false } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details) body.details = this.details;
    return body;
  }
}

export const badRequest = (message, code = 'BAD_REQUEST', details) =>
  new AppError(message, { status: 400, code, details });
export const validation = (message, details) =>
  new AppError(message, { status: 422, code: 'VALIDATION_FAILED', details });
export const unauthenticated = (message = 'Sign in to continue') =>
  new AppError(message, { status: 401, code: 'UNAUTHENTICATED' });
export const unauthorized = unauthenticated;
export const forbidden = (message = 'Not permitted', details) =>
  new AppError(message, { status: 403, code: 'FORBIDDEN', details });
export const notFound = (message = 'Not found') =>
  new AppError(message, { status: 404, code: 'NOT_FOUND' });
export const conflict = (message, code = 'CONFLICT', details) =>
  new AppError(message, { status: 409, code, details });
export const unprocessable = (message, code = 'UNPROCESSABLE', details) =>
  new AppError(message, { status: 422, code, details });
export const tooMany = (message = 'Too many attempts. Try again later.') =>
  new AppError(message, { status: 429, code: 'RATE_LIMITED' });

/** A legal gate is never a warning: it blocks issuance and is surfaced verbatim. */
export const legalGate = (message, blockers = []) =>
  new AppError(message || 'This document cannot be issued yet: compliance readiness is incomplete', {
    status: 422,
    code: 'LEGAL_GATE_BLOCKED',
    details: { blockers },
  });
