/**
 * Instrument-specific spread and point size utilities.
 * Avoids simplified one-size-fits-all logic (e.g. 1 pip = 1e-4 for all instruments).
 * JPY pairs use 0.01 per pip; indices/synthetics use 0.01; 4-decimal forex uses 0.0001.
 */

/**
 * Return point/pip size for known symbol patterns only. No inference for unknowns.
 * Known: JPY pairs, synthetics (R_, CRASH, BOOM, etc.), indices (US30, AUS200, etc.).
 * Unknown symbols: log error and throw — use broker pip_size instead.
 */
export function inferPointSize(symbol: string, _midPrice: number = 1): number {
  const sym = symbol.toUpperCase().replace(/\s+/g, '');
  // Deriv API symbols for forex (frx*) / crypto (cry*) from ticks_history
  if (/^FRX/i.test(sym)) {
    if (sym.includes('JPY')) return 0.01;
    return 0.0001;
  }
  if (/^CRY/i.test(sym)) return 0.01;
  // Display forex major pairs (EUR/USD, EURUSD)
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(sym)) {
    if (sym.includes('JPY')) return 0.01;
    return 0.0001;
  }
  if (sym.includes('JPY') || /USDJPY|EURJPY|GBPJPY|AUDJPY|NZDJPY|CADJPY|CHFJPY/i.test(sym)) return 0.01;
  if (/^R_|^CRASH|^BOOM|^1HZ|^JUMP_|^RANGE_BREAK|^WLD|^STPRNG/i.test(sym)) return 0.01;
  if (/^(US|AU|EU|UK|DE|JP|CH)\d{2,3}$|^[A-Z]{2,4}\d{2,}$/i.test(sym)) return 0.01;
  if (/^(BTC|ETH|SOL|XRP|DOGE)USD$/i.test(sym)) return 0.01;
  // Six-letter majors without slash (EURUSD, GBPJPY) — exclude symbols with digits (indices)
  if (/^[A-Z]{6}$/.test(sym) && !/\d/.test(sym)) {
    if (sym.includes('JPY')) return 0.01;
    return 0.0001;
  }
  const err = `[spreadUtils] Unknown symbol for point size: ${symbol}. Use broker pip_size; no inference.`;
  if (typeof console !== 'undefined' && console.error) console.error(err);
  throw new Error(err);
}

/**
 * Convert spread from points/pips to price fraction.
 * Uses instrument-specific point size — no generic 1 pip = 1e-4 assumption.
 * @param spreadPoints - Spread in points (e.g. 0.8 for forex, 5 for indices)
 * @param instrumentSymbol - Symbol for point size inference (e.g. R_10, EUR/USD)
 * @param midPrice - Optional mid price; when unknown, 1 is used (forex default)
 */
export function spreadPointsToFraction(
  spreadPoints: number,
  instrumentSymbol: string,
  midPrice: number = 1
): number {
  const pts = Number.isFinite(spreadPoints) ? spreadPoints : 0;
  const pointSize = inferPointSize(instrumentSymbol, midPrice);
  const raw = pts * pointSize;
  const result = Math.min(0.01, Math.max(0, raw));
  return Number.isFinite(result) ? result : 0;
}
