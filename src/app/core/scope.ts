/**
 * Trade scope engine: maps timeframes ↔ scopes (scalp/day/swing/position).
 * Institutional-grade alignment for cross-market, multi-scope trading.
 *
 * Dynamic TF selection: bots trade each selected timeframe according to the analysed trade mode.
 * Given an analysed style/scope (e.g. scalping → scalp, day → day), use getTimeframesForScope(scope)
 * or getTimeframesForStyle(style) to get the TF(s) valid for that mode; filter by bot.timeframes
 * to get the TF(s) the bot will use for that trade.
 */

import type { Timeframe, TradeScope, TradeStyle, BotConfig, Instrument } from './types';

/** All standard timeframes from M1 to weekly (for training and Bot Builder selection). */
export const ALL_TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

/** Primary scope for each timeframe (for backtest and bot config). */
export const TIMEFRAME_TO_SCOPE: Record<Timeframe, TradeScope> = {
  M1: 'scalp',
  M5: 'scalp',
  M15: 'day',
  M30: 'day',
  H1: 'day',
  H4: 'swing',
  D1: 'swing',
  W1: 'position',
};

/** Timeframes that are valid for each scope (for strategy selection).
 *  position = position trading: longest holds (weeks/months), D1/W1. Scope only, not a trade mode. */
export const SCOPE_TO_TIMEFRAMES: Record<TradeScope, Timeframe[]> = {
  scalp: ['M1', 'M5'],
  day: ['M15', 'M30', 'H1'],
  swing: ['H4', 'D1'],
  position: ['D1', 'W1'],
};

/** Typical hold duration in bars (for avgHoldBars and regime stability). */
export const SCOPE_AVG_HOLD_BARS: Record<TradeScope, { min: number; typical: number; max: number }> = {
  scalp: { min: 1, typical: 5, max: 15 },
  day: { min: 4, typical: 12, max: 48 },
  swing: { min: 6, typical: 24, max: 120 },
  position: { min: 20, typical: 60, max: 252 },
};

/** Max hold bars per scope — realistic backtest: scalp exits quickly, swing holds longer. */
export const SCOPE_MAX_HOLD_BARS: Record<TradeScope, number> = {
  scalp: 15,
  day: 48,
  swing: 120,
  position: 252,
};

/** Scope-specific backtest defaults (when no job/instrument override). Realistic per trade mode. */
export const SCOPE_BACKTEST_DEFAULTS: Record<
  TradeScope,
  { stopLossPct: number; takeProfitR: number; riskPerTradePct: number }
> = {
  scalp: { stopLossPct: 0.01, takeProfitR: 1.5, riskPerTradePct: 0.005 },
  day: { stopLossPct: 0.02, takeProfitR: 2, riskPerTradePct: 0.01 },
  swing: { stopLossPct: 0.03, takeProfitR: 2.5, riskPerTradePct: 0.01 },
  position: { stopLossPct: 0.04, takeProfitR: 3, riskPerTradePct: 0.008 },
};

/** Trade modes: scalp, day, med_swing, swing, sniper. (position is a scope, not a mode.) */
export const ALL_TRADE_STYLES: TradeStyle[] = ['scalping', 'day', 'medium_swing', 'swing', 'sniper'];

/** TradeStyle to TradeScope mapping. med_swing + swing → swing; sniper → scalp. */
export const STYLE_TO_SCOPE: Record<TradeStyle, TradeScope> = {
  scalping: 'scalp',
  day: 'day',
  medium_swing: 'swing',
  swing: 'swing',
  sniper: 'scalp',
};

export function getScopeForTimeframe(tf: Timeframe): TradeScope {
  return TIMEFRAME_TO_SCOPE[tf];
}

export function getTimeframesForScope(scope: TradeScope): Timeframe[] {
  return SCOPE_TO_TIMEFRAMES[scope];
}

export function getScopeForStyle(style: TradeStyle): TradeScope {
  return STYLE_TO_SCOPE[style];
}

/** Timeframes valid for a given trade style (for dynamic TF selection by analysed trade mode). */
export function getTimeframesForStyle(style: TradeStyle): Timeframe[] {
  return getTimeframesForScope(getScopeForStyle(style));
}

/** All scopes (for UI and backtest coverage). */
export const ALL_SCOPES: TradeScope[] = ['scalp', 'day', 'swing', 'position'];

/**
 * Scope/style from the bot's configured trade mode for an instrument.
 * Pure trade-mode logic: manual fixedScope, manual fixedStyles, or auto primary timeframe.
 * No broker involvement — this is the analysed/selected trade mode.
 */
export function getScopeStyleFromBotForInstrument(
  instrumentId: string,
  bots: BotConfig[],
  instruments: Instrument[]
): { scope: TradeScope; style: TradeStyle } {
  const bot = bots.find((b) => b.instrumentId === instrumentId);
  const inst = instruments.find((i) => i.id === instrumentId);
  if (bot) {
    if (bot.scopeMode === 'manual' && bot.fixedScope) {
      const scope = bot.fixedScope;
      const style: TradeStyle = scope === 'scalp' ? 'scalping' : scope === 'day' ? 'day' : scope === 'swing' ? 'swing' : 'swing';
      return { scope, style };
    }
    if (bot.scopeMode === 'manual' && bot.fixedStyles?.length) {
      const style = bot.fixedStyles[0] as TradeStyle;
      const scope = STYLE_TO_SCOPE[style] ?? 'day';
      return { scope, style };
    }
    const primaryTf = bot.timeframes[0] ?? 'M5';
    const scope = (TIMEFRAME_TO_SCOPE[primaryTf] ?? 'day') as TradeScope;
    const style: TradeStyle = scope === 'scalp' ? 'scalping' : scope === 'day' ? 'day' : scope === 'swing' ? 'swing' : 'swing';
    return { scope, style };
  }
  const primaryTf = inst?.timeframes?.[0] ?? 'M5';
  const scope = (TIMEFRAME_TO_SCOPE[primaryTf] ?? 'day') as TradeScope;
  const style: TradeStyle = (scope === 'scalp' ? 'scalping' : scope === 'day' ? 'day' : 'swing') as TradeStyle;
  return { scope, style };
}

/** Typical bars per year for Sharpe/Sortino annualization (session-adjusted where relevant). */
export const BARS_PER_YEAR_BY_TIMEFRAME: Record<Timeframe, number> = {
  M1: 105120,   // ~20% session
  M5: 105120,
  M15: 35040,
  M30: 17520,
  H1: 8760,
  H4: 2190,
  D1: 365,
  W1: 52,
};
