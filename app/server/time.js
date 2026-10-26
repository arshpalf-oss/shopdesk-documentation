/**
 * shop desk — business time.
 *
 * Event instants are UTC. Business dates are India Standard Time (UTC+05:30,
 * no DST). Report ranges are converted to half-open UTC intervals
 * [from, to) so that a document at 23:59:59.999 IST is still included.
 */

import { badRequest } from './errors.js';

export const BUSINESS_TZ = 'Asia/Kolkata';
export const IST_OFFSET_MINUTES = 330;

const DAY_MS = 86_400_000;

export function istParts(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export function businessDate(date = new Date()) {
  const p = istParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function businessTimeLabel(date = new Date()) {
  const p = istParts(date);
  return `${businessDate(date)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} IST`;
}

/** Parse "YYYY-MM-DD" as the start of that IST business day (UTC instant). */
export function istDateStart(dateString) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!m) throw badRequest(`Invalid business date: ${dateString}. Use YYYY-MM-DD.`, 'INVALID_DATE');
  const [, y, mo, d] = m;
  const utcMidnight = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return new Date(utcMidnight - IST_OFFSET_MINUTES * 60_000);
}

export function istDateEndExclusive(dateString) {
  return new Date(istDateStart(dateString).getTime() + DAY_MS);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Financial year label ("2026-27") for a UTC instant or a dated string. */
export function financialYear(date = new Date()) {
  const d = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? istDateStart(date) : date;
  const p = istParts(d);
  const startYear = p.month >= 4 ? p.year : p.year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function financialYearShort(date = new Date()) {
  return financialYear(date).slice(2);
}

export function financialYearRange(fyLabel) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fyLabel || ''));
  if (!m) throw new Error(`invalid financial year: ${fyLabel}`);
  const startYear = Number(m[1]);
  return {
    from: istDateStart(`${startYear}-04-01`),
    to: istDateStart(`${startYear + 1}-04-01`),
  };
}

export const PRESETS = ['today', '7d', 'month', 'last_month', 'fy', 'all', 'custom'];

/**
 * Resolve a report period into half-open UTC bounds and a human label.
 * `from`/`to` for custom are IST business dates, inclusive of `to`.
 */
export function resolvePeriod({ preset = 'month', from, to, now = new Date() } = {}) {
  const today = businessDate(now);
  const todayStart = istDateStart(today);
  switch (preset) {
    case 'today':
      return {
        preset,
        fromDate: today,
        toDate: today,
        from: todayStart,
        to: istDateEndExclusive(today),
        label: `Today (${today})`,
      };
    case '7d': {
      const start = businessDate(addDays(todayStart, -6));
      return {
        preset,
        fromDate: start,
        toDate: today,
        from: istDateStart(start),
        to: istDateEndExclusive(today),
        label: `Last 7 days (${start} → ${today})`,
      };
    }
    case 'month': {
      const p = istParts(now);
      const start = `${p.year}-${String(p.month).padStart(2, '0')}-01`;
      return {
        preset,
        fromDate: start,
        toDate: today,
        from: istDateStart(start),
        to: istDateEndExclusive(today),
        label: `This month (${start} → ${today})`,
      };
    }
    case 'last_month': {
      const p = istParts(now);
      const month = p.month === 1 ? 12 : p.month - 1;
      const year = p.month === 1 ? p.year - 1 : p.year;
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      return {
        preset,
        fromDate: start,
        toDate: end,
        from: istDateStart(start),
        to: istDateEndExclusive(end),
        label: `Last month (${start} → ${end})`,
      };
    }
    case 'fy': {
      const fy = financialYear(now);
      const range = financialYearRange(fy);
      return {
        preset,
        fy,
        fromDate: businessDate(range.from),
        toDate: today,
        from: range.from,
        to: istDateEndExclusive(today),
        label: `Financial year ${fy}`,
      };
    }
    case 'all':
      return {
        preset,
        fromDate: '2000-01-01',
        toDate: today,
        from: istDateStart('2000-01-01'),
        to: istDateEndExclusive(today),
        label: 'All time',
      };
    case 'custom': {
      if (!from || !to) throw badRequest('A custom period needs both a from and a to date', 'INVALID_PERIOD');
      if (istDateStart(from) > istDateStart(to)) throw badRequest('The from date must be on or before the to date', 'INVALID_PERIOD');
      return {
        preset,
        fromDate: from,
        toDate: to,
        from: istDateStart(from),
        to: istDateEndExclusive(to),
        label: `${from} → ${to}`,
      };
    }
    default:
      throw badRequest(
        `Unknown period preset: ${preset}. Use one of ${PRESETS.join(', ')}.`,
        'INVALID_PERIOD'
      );
  }
}

export function isoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Label a month/year expiry (precision preserved) for display. */
export function expiryLabel(expiry) {
  if (!expiry) return 'Not recorded';
  if (expiry.precision === 'year') return expiry.year ? `Year ${expiry.year}` : 'Not recorded';
  if (expiry.precision === 'month') {
    return expiry.year && expiry.month ? `${expiry.year}-${String(expiry.month).padStart(2, '0')} (month end)` : 'Not recorded';
  }
  return expiry.date || 'Not recorded';
}

/**
 * Reviewed sell-by cutoff: a month-precision label is treated as usable until
 * the last instant of that month (IST). A year label lasts until 31 December.
 * Expired stock is never saleable.
 */
export function expiryCutoffExclusive(expiry) {
  if (!expiry || expiry.precision === 'none') return null;
  if (expiry.precision === 'date') return istDateEndExclusive(expiry.date);
  if (expiry.precision === 'month') {
    const y = Number(expiry.year);
    const m = Number(expiry.month);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return istDateEndExclusive(`${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
  }
  if (expiry.precision === 'year') return istDateEndExclusive(`${Number(expiry.year)}-12-31`);
  return null;
}

export function isExpired(expiry, now = new Date()) {
  const cutoff = expiryCutoffExclusive(expiry);
  if (!cutoff) return false;
  return now.getTime() >= cutoff.getTime();
}

export function daysUntilExpiry(expiry, now = new Date()) {
  const cutoff = expiryCutoffExclusive(expiry);
  if (!cutoff) return null;
  return Math.ceil((cutoff.getTime() - now.getTime()) / DAY_MS);
}
