/**
 * Maps Instrument Registry display symbols (EUR/USD, BTC/USD, …) to Deriv WebSocket API
 * symbols for ticks_history / ticks (frx*, cry*). Synthetics (R_10, BOOM500, …) use the registry
 * symbol as-is and are resolved elsewhere via active_symbols.
 * @see https://developers.deriv.com/docs/ticks-history
 */

/** Build map: "EUR/USD", "EURUSD" -> frxEURUSD */
function buildFiatMap(): Record<string, string> {
  const pairs: Array<[string, string]> = [
    ['EUR/USD', 'frxEURUSD'],
    ['USD/JPY', 'frxUSDJPY'],
    ['GBP/USD', 'frxGBPUSD'],
    ['USD/CHF', 'frxUSDCHF'],
    ['AUD/USD', 'frxAUDUSD'],
    ['USD/CAD', 'frxUSDCAD'],
    ['NZD/USD', 'frxNZDUSD'],
    ['EUR/GBP', 'frxEURGBP'],
    ['EUR/JPY', 'frxEURJPY'],
    ['EUR/CHF', 'frxEURCHF'],
    ['EUR/AUD', 'frxEURAUD'],
    ['EUR/CAD', 'frxEURCAD'],
    ['EUR/NZD', 'frxEURNZD'],
    ['GBP/JPY', 'frxGBPJPY'],
    ['GBP/CHF', 'frxGBPCHF'],
    ['GBP/AUD', 'frxGBPAUD'],
    ['GBP/CAD', 'frxGBPCAD'],
    ['GBP/NZD', 'frxGBPNZD'],
    ['AUD/JPY', 'frxAUDJPY'],
    ['AUD/NZD', 'frxAUDNZD'],
    ['AUD/CAD', 'frxAUDCAD'],
    ['AUD/CHF', 'frxAUDCHF'],
    ['NZD/JPY', 'frxNZDJPY'],
    ['NZD/CAD', 'frxNZDCAD'],
    ['NZD/CHF', 'frxNZDCHF'],
    ['CAD/JPY', 'frxCADJPY'],
    ['CAD/CHF', 'frxCADCHF'],
    ['CHF/JPY', 'frxCHFJPY'],
  ];
  const out: Record<string, string> = {};
  for (const [slash, frx] of pairs) {
    out[slash] = frx;
    out[slash.replace(/\//g, '')] = frx;
    out[slash.toUpperCase()] = frx;
    out[slash.replace(/\//g, '').toUpperCase()] = frx;
  }
  return out;
}

const FIAT_CRYPTO_TO_DERIV: Record<string, string> = {
  ...buildFiatMap(),
  'BTC/USD': 'cryBTCUSD',
  BTCUSD: 'cryBTCUSD',
  'ETH/USD': 'cryETHUSD',
  ETHUSD: 'cryETHUSD',
  'SOL/USD': 'crySOLUSD',
  SOLUSD: 'crySOLUSD',
  'XRP/USD': 'cryXRPUSD',
  XRPUSD: 'cryXRPUSD',
  'DOGE/USD': 'cryDOGEUSD',
  DOGEUSD: 'cryDOGEUSD',
};

/**
 * Resolve registry symbol to Deriv ticks_history / ticks symbol.
 * Returns mapped frx… / cry… symbols for fiat/crypto; otherwise returns input unchanged (synthetics / unknown).
 */
export function resolveDerivMarketDataSymbol(registrySymbol: string): string {
  const raw = registrySymbol.trim();
  if (!raw) return registrySymbol;
  const keys = [raw, raw.toUpperCase(), raw.replace(/\//g, ''), raw.replace(/\//g, '').toUpperCase()];
  for (const k of keys) {
    const hit = FIAT_CRYPTO_TO_DERIV[k];
    if (hit) return hit;
  }
  return registrySymbol;
}

/** True if symbol is routed to Deriv frx/cry market data (not synthetic index codes). */
export function isDerivFiatOrCryptoApiSymbol(resolved: string): boolean {
  return resolved.startsWith('frx') || resolved.startsWith('cry');
}
