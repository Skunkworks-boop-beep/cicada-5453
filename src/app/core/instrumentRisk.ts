/**
 * Instrument-specific risk management.
 * Derives stop loss, risk per trade, and take-profit from fetched bar data (ATR, volatility)
 * and from known instrument types (R_10, forex, etc.).
 */

import type { OHLCVBar } from './ohlcv';
import { atr } from './indicators';

export interface InstrumentRiskParams {
  stopLossPct: number;
  riskPerTradePct: number;
  takeProfitR: number;
}

/** Known instrument patterns and suggested risk params (from typical behavior). */
const INSTRUMENT_RISK_DEFAULTS: Array<{ pattern: RegExp; params: InstrumentRiskParams }> = [
  { pattern: /^R_\d+$/i, params: { stopLossPct: 0.04, riskPerTradePct: 0.005, takeProfitR: 1.5 } },
  { pattern: /^CRASH|^BOOM/i, params: { stopLossPct: 0.05, riskPerTradePct: 0.005, takeProfitR: 1.5 } },
  { pattern: /^1HZ|^JUMP_|^RANGE_BREAK/i, params: { stopLossPct: 0.035, riskPerTradePct: 0.006, takeProfitR: 1.5 } },
  { pattern: /^(US|AU|EU|UK|DE|JP|CH)\d{2,3}$|^[A-Z]{2,4}\d{2,}$/i, params: { stopLossPct: 0.025, riskPerTradePct: 0.008, takeProfitR: 2 } },
  { pattern: /\/USD|\/EUR|\/GBP|\/JPY/i, params: { stopLossPct: 0.02, riskPerTradePct: 0.01, takeProfitR: 2 } },
];

/** Get default risk params for a symbol based on known patterns. */
export function getInstrumentDefaultRisk(instrumentSymbol: string): InstrumentRiskParams | null {
  const sym = instrumentSymbol.toUpperCase().replace(/\s+/g, '');
  for (const { pattern, params } of INSTRUMENT_RISK_DEFAULTS) {
    if (pattern.test(sym)) return { ...params };
  }
  return null;
}

/**
 * Derive risk params from bar data using ATR(14) as volatility proxy.
 * stopLossPct ≈ 1.5× ATR% (gives room for noise); risk scaled down when volatile.
 */
export function deriveRiskFromBars(
  bars: OHLCVBar[],
  instrumentSymbol: string,
  options?: { atrPeriod?: number; atrMult?: number; minBars?: number }
): InstrumentRiskParams {
  const atrPeriod = options?.atrPeriod ?? 14;
  const atrMult = options?.atrMult ?? 1.5;
  const minBars = options?.minBars ?? 50;

  const defaults = getInstrumentDefaultRisk(instrumentSymbol);
  const fallback: InstrumentRiskParams = defaults ?? {
    stopLossPct: 0.02,
    riskPerTradePct: 0.01,
    takeProfitR: 2,
  };

  if (!bars || bars.length < minBars) return fallback;

  const closes = bars.map((b) => b.close);
  const price = closes[closes.length - 1];
  if (!Number.isFinite(price) || price <= 0) return fallback;

  const atrSeries = atr(bars, atrPeriod);
  const atrVal = atrSeries[atrSeries.length - 1];
  if (atrVal == null || !Number.isFinite(atrVal)) return fallback;

  const atrPct = atrVal / price;
  const stopLossPct = Math.min(0.08, Math.max(0.01, atrPct * atrMult));
  const riskPerTradePct = atrPct > 0.03 ? 0.005 : atrPct > 0.02 ? 0.007 : 0.01;
  const takeProfitR = atrPct > 0.025 ? 1.5 : 2;

  return {
    stopLossPct,
    riskPerTradePct,
    takeProfitR,
  };
}

/**
 * Analyze bars for each instrument and return overrides.
 * Call with bars keyed by "instrumentId|timeframe" — uses primary timeframe (M5 or first) per instrument.
 */
export function analyzeInstrumentRiskFromBars(
  barsByKey: Record<string, OHLCVBar[]>,
  instrumentIds: string[],
  instrumentSymbols: Record<string, string>
): Record<string, InstrumentRiskParams> {
  const out: Record<string, InstrumentRiskParams> = {};
  const tfOrder = ['M5', 'M15', 'M1', 'M30', 'H1', 'H4', 'D1', 'W1'];

  for (const instId of instrumentIds) {
    const symbol = instrumentSymbols[instId] ?? instId;
    let bestBars: OHLCVBar[] | null = null;
    for (const tf of tfOrder) {
      const key = `${instId}|${tf}`;
      const bars = barsByKey[key];
      if (bars && bars.length >= 50) {
        bestBars = bars;
        break;
      }
    }
    if (bestBars) {
      out[instId] = deriveRiskFromBars(bestBars, symbol);
    } else {
      const def = getInstrumentDefaultRisk(symbol);
      if (def) out[instId] = def;
    }
  }
  return out;
}
