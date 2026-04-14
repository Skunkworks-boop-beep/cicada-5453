/**
 * Market open/closed status by instrument type.
 * Forex/indices: 24/5 (Sun 21:00 UTC – Fri 22:00 UTC).
 * Crypto/synthetic: 24/7.
 */

import type { InstrumentType } from './types';

/**
 * Returns true if the market is open for the given instrument type.
 * Uses UTC for consistency.
 */
export function isMarketOpen(type: InstrumentType): boolean {
  switch (type) {
    case 'crypto':
    case 'synthetic_deriv':
      return true; // 24/7
    case 'fiat':
    case 'indices_exness':
      return isForexMarketOpen();
    default:
      return isForexMarketOpen();
  }
}

/** Forex/indices: closed Fri 22:00 UTC – Sun 21:00 UTC */
function isForexMarketOpen(): boolean {
  const now = new Date();
  const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcMinutes = utcHour * 60 + utcMin;

  // Saturday: closed
  if (utcDay === 6) return false;

  // Sunday: open from 21:00 UTC
  if (utcDay === 0) return utcMinutes >= 21 * 60;

  // Friday: closed from 22:00 UTC
  if (utcDay === 5) return utcMinutes < 22 * 60;

  // Mon–Thu: open
  return true;
}
