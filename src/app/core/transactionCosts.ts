/**
 * Transaction cost model — TS port of python/cicada_nn/transaction_costs.py.
 *
 * Both backtest engines charge the same costs so frontend and backend results
 * stay comparable. Previous versions applied a flat slippage fraction to every
 * fill and ignored swap / commission entirely, which meaningfully overstated
 * scalp-strategy profits and underestimated how damaging overnight holds are
 * for swing bots.
 */
import type { InstrumentType, Timeframe } from './types';

export interface CostConfig {
  /** Round-trip commission as a fraction of notional. */
  commissionRoundtripPct: number;
  /** Daily swap when long (fraction of notional; negative = cost). */
  swapLongDailyPct: number;
  /** Daily swap when short. */
  swapShortDailyPct: number;
  /** Base slippage fraction for signal/max_hold exits. */
  baseSlippagePct: number;
  /** Multiplier applied to base slippage when the fill is a stop/target (thinner book). */
  stopSlippageMult: number;
}

export const DEFAULT_COSTS_BY_TYPE: Record<InstrumentType, CostConfig> = {
  fiat: {
    commissionRoundtripPct: 5e-5,
    swapLongDailyPct: -6e-6,
    swapShortDailyPct: -6e-6,
    baseSlippagePct: 3e-5,
    stopSlippageMult: 2.0,
  },
  crypto: {
    commissionRoundtripPct: 2e-4,
    swapLongDailyPct: -5e-4,
    swapShortDailyPct: -5e-4,
    baseSlippagePct: 1e-4,
    stopSlippageMult: 3.0,
  },
  synthetic_deriv: {
    commissionRoundtripPct: 0,
    swapLongDailyPct: 0,
    swapShortDailyPct: 0,
    baseSlippagePct: 2e-5,
    stopSlippageMult: 1.5,
  },
  indices_exness: {
    commissionRoundtripPct: 8e-5,
    swapLongDailyPct: -4e-5,
    swapShortDailyPct: -2e-5,
    baseSlippagePct: 5e-5,
    stopSlippageMult: 2.5,
  },
};

const BARS_PER_TRADING_DAY: Record<Timeframe, number> = {
  M1: 1440,
  M5: 288,
  M15: 96,
  M30: 48,
  H1: 24,
  H4: 6,
  D1: 1,
  W1: 1 / 5,
};

export function costForType(type: InstrumentType | undefined): CostConfig {
  return DEFAULT_COSTS_BY_TYPE[type ?? 'fiat'];
}

export function commissionCharge(notional: number, type: InstrumentType | undefined): number {
  const cfg = costForType(type);
  return Math.max(0, notional * cfg.commissionRoundtripPct);
}

export function swapAccrual(
  notional: number,
  type: InstrumentType | undefined,
  holdBars: number,
  timeframe: Timeframe,
  side: 1 | -1
): number {
  const cfg = costForType(type);
  const perDay = side === 1 ? cfg.swapLongDailyPct : cfg.swapShortDailyPct;
  const barsPerDay = BARS_PER_TRADING_DAY[timeframe] ?? 24;
  const days = barsPerDay ? holdBars / barsPerDay : 0;
  return notional * perDay * days;
}

export function fillSlippagePct(
  baseSlippage: number,
  type: InstrumentType | undefined,
  exitReason: 'signal' | 'stop' | 'target' | 'max_hold'
): number {
  const cfg = costForType(type);
  const base = Number.isFinite(baseSlippage) ? baseSlippage : cfg.baseSlippagePct;
  const mult = exitReason === 'stop' || exitReason === 'target' ? cfg.stopSlippageMult : 1;
  return Math.max(0, base * mult);
}
