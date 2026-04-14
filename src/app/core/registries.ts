/**
 * Strategy and instrument registries.
 * Instruments: forex + crypto use **Deriv** for market data (ticks_history); Deriv synthetic indices (R_*, Crash/Boom, …);
 * **eXness** only for real index CFDs (US30, AUS200, …) via MT5/OHLC API.
 */

import type { AnyStrategyDef, BrokerConfig, Instrument, MarketRegime, TradeStyle } from './types';
import { CHART_PATTERNS as CP } from './strategies/chartPatterns';
import { CANDLESTICK_PATTERNS as CSP } from './strategies/candlestickPatterns';
import { INDICATOR_STRATEGIES } from './strategies/indicatorStrategies';
import { PRICE_ACTION_LOGIC } from './strategies/priceActionLogic';

export const CHART_PATTERNS = CP;
export const CANDLESTICK_PATTERNS = CSP;
export const TRADE_LOGIC_STRATEGIES = [...INDICATOR_STRATEGIES, ...PRICE_ACTION_LOGIC];

export function getAllStrategies(): AnyStrategyDef[] {
  return [
    ...CP,
    ...CSP,
    ...TRADE_LOGIC_STRATEGIES,
  ];
}

export function getStrategiesByCategory(category: AnyStrategyDef['category']): AnyStrategyDef[] {
  return getAllStrategies().filter((s) => s.category === category);
}

export function getStrategiesForRegime(regime: MarketRegime): AnyStrategyDef[] {
  return getAllStrategies().filter((s) => s.regimes.includes(regime) || s.regimes.includes('unknown'));
}

export function getStrategiesForStyle(style: TradeStyle): AnyStrategyDef[] {
  return getAllStrategies().filter((s) => s.styles.includes(style));
}

/** Full range M1 → weekly for training and trading. */
const TF_MAJOR = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'] as const;
const TF_MINOR = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'] as const;
const TF_SYNTH = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'] as const;
const TF_INDICES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;

// ─── Default brokers: Deriv and eXness (standalone); MT5 add-on for live balance/positions ────────────────
export const BROKER_DERIV_ID = 'broker-deriv';
export const BROKER_EXNESS_ID = 'broker-exness'; // MT5 add-on (no registry instruments; count from MT5 after connect)
export const BROKER_EXNESS_API_ID = 'broker-exness-api'; // eXness: index CFDs (MT5 OHLC); fiat/crypto use Deriv in registry

export const DEFAULT_BROKERS: BrokerConfig[] = [
  { id: BROKER_DERIV_ID, name: 'Deriv', type: 'deriv_api', status: 'disconnected', config: {}, order: 0 },
  { id: BROKER_EXNESS_API_ID, name: 'eXness', type: 'exness_api', status: 'disconnected', config: {}, order: 1 },
  { id: BROKER_EXNESS_ID, name: 'MT5 add-on', type: 'mt5', status: 'disconnected', config: {}, order: 2 },
];

// ─── Instrument registry ─────────────────────────────────────────────────────
// Major forex (28) + crypto (5) → **Deriv** (frx*/cry*). Deriv synthetics (all). eXness **indices only** (US30, AUS200, …).
// Spread: empty until live broker fetch (MT5/Deriv/eXness). See docs/SPREAD_VERIFICATION.md.

/**
 * Deriv synthetic instrument symbols — exact underlying_symbol names from Deriv API.
 * Source: developers.deriv.com/docs/data/active-symbols, ticks_history (short symbol pattern).
 * Keep in sync with DERIV_SYNTHETIC_UNDERLYING_SYMBOLS in derivApi.ts.
 * Volatility: R_* ; Crash/Boom: CRASH* BOOM* ; Step: 1HZ*V ; Jump: jump_* ; Range Break: range_break_* ; World: WLD*
 * (Volatility 1s, DEX, Drift removed — not returned by API for this account.)
 */
/** R_10 Volatility Index — used for Fib Retracement flip (buy when sell found, sell when buy found). */
export const R_10_INSTRUMENT_ID = 'inst-deriv-r10';
export const R_10_SYMBOL = 'R_10';

export const DERIV_SYNTHETIC_SYMBOLS: string[] = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  'BOOM50', 'BOOM150N', 'BOOM300N', 'BOOM500', 'BOOM600', 'BOOM900', 'BOOM1000',
  'CRASH50', 'CRASH150N', 'CRASH300N', 'CRASH500', 'CRASH600', 'CRASH900', 'CRASH1000',
  '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V', '1HZ150V', '1HZ200V',
  'jump_10', 'jump_25', 'jump_50', 'jump_75', 'jump_100',
  'range_break_100', 'range_break_200',
  'WLDAUD', 'WLDEUR', 'WLDGBP', 'WLDXAU', 'WLDUSD',
  'stpRNG3', 'stpRNG4', 'stpRNG5',
];

export const DEFAULT_INSTRUMENTS: Instrument[] = [
  // ─── Major currency pairs (28) ───
  // Fiat + crypto → Deriv (ticks_history). indices_exness → eXness. synthetic_deriv → Deriv.
  { id: 'inst-eurusd', symbol: 'EUR/USD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MAJOR], rebuildIntervalHours: 168 },
  { id: 'inst-usdjpy', symbol: 'USD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MAJOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpusd', symbol: 'GBP/USD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MAJOR], rebuildIntervalHours: 168 },
  { id: 'inst-usdchf', symbol: 'USD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audusd', symbol: 'AUD/USD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-usdcad', symbol: 'USD/CAD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdusd', symbol: 'NZD/USD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurgbp', symbol: 'EUR/GBP', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurjpy', symbol: 'EUR/JPY', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurchf', symbol: 'EUR/CHF', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-euraud', symbol: 'EUR/AUD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurcad', symbol: 'EUR/CAD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurnzd', symbol: 'EUR/NZD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpjpy', symbol: 'GBP/JPY', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpchf', symbol: 'GBP/CHF', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpaud', symbol: 'GBP/AUD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpcad', symbol: 'GBP/CAD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpnzd', symbol: 'GBP/NZD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audjpy', symbol: 'AUD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audnzd', symbol: 'AUD/NZD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audcad', symbol: 'AUD/CAD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audchf', symbol: 'AUD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdjpy', symbol: 'NZD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdcad', symbol: 'NZD/CAD', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdchf', symbol: 'NZD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-cadjpy', symbol: 'CAD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-cadchf', symbol: 'CAD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-chfjpy', symbol: 'CHF/JPY', type: 'fiat', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  // Crypto → Deriv
  { id: 'inst-btcusd', symbol: 'BTC/USD', type: 'crypto', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'], rebuildIntervalHours: 168 },
  { id: 'inst-ethusd', symbol: 'ETH/USD', type: 'crypto', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  { id: 'inst-solusd', symbol: 'SOL/USD', type: 'crypto', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  { id: 'inst-xrpusd', symbol: 'XRP/USD', type: 'crypto', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  { id: 'inst-dogeusd', symbol: 'DOGE/USD', type: 'crypto', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  // ─── Deriv synthetic indices: names = Deriv underlying_symbol (active_symbols / ticks_history) ───
  // See: developers.deriv.com/docs/data/active-symbols
  // Volatility: R_10, R_25, R_50, R_75, R_100
  { id: 'inst-deriv-r10', symbol: 'R_10', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r25', symbol: 'R_25', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r50', symbol: 'R_50', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r75', symbol: 'R_75', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r100', symbol: 'R_100', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  // Crash/Boom (exact): BOOM50, BOOM150N, BOOM300N, BOOM500, BOOM600, BOOM900, BOOM1000, CRASH50, CRASH150N, CRASH300N, CRASH500, CRASH600, CRASH900, CRASH1000
  { id: 'inst-deriv-boom50', symbol: 'BOOM50', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom150n', symbol: 'BOOM150N', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom300n', symbol: 'BOOM300N', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom500', symbol: 'BOOM500', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom600', symbol: 'BOOM600', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom900', symbol: 'BOOM900', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom1000', symbol: 'BOOM1000', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash50', symbol: 'CRASH50', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash150n', symbol: 'CRASH150N', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash300n', symbol: 'CRASH300N', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash500', symbol: 'CRASH500', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash600', symbol: 'CRASH600', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash900', symbol: 'CRASH900', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash1000', symbol: 'CRASH1000', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  // Jump: jump_<index> (keep in registry if API returns later)
  { id: 'inst-deriv-jump10', symbol: 'jump_10', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump25', symbol: 'jump_25', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump50', symbol: 'jump_50', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump75', symbol: 'jump_75', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump100', symbol: 'jump_100', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  // Step: 1HZ10V … 1HZ100V, 1HZ150V, 1HZ200V (full set when available on API)
  { id: 'inst-deriv-step10', symbol: '1HZ10V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step15', symbol: '1HZ15V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step25', symbol: '1HZ25V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step30', symbol: '1HZ30V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step50', symbol: '1HZ50V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step75', symbol: '1HZ75V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step90', symbol: '1HZ90V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step100', symbol: '1HZ100V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step150', symbol: '1HZ150V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-step200', symbol: '1HZ200V', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  // Range Break: range_break_<index>
  { id: 'inst-deriv-rb100', symbol: 'range_break_100', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-rb200', symbol: 'range_break_200', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  // World indices (API: WLDAUD, WLDEUR, WLDGBP, WLDXAU, WLDUSD)
  { id: 'inst-deriv-wldaud', symbol: 'WLDAUD', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-wldeur', symbol: 'WLDEUR', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-wldgbp', symbol: 'WLDGBP', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-wldxau', symbol: 'WLDXAU', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-wldusd', symbol: 'WLDUSD', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  // Step (API codes stpRNG3, stpRNG4, stpRNG5)
  { id: 'inst-deriv-stprng3', symbol: 'stpRNG3', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-stprng4', symbol: 'stpRNG4', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-stprng5', symbol: 'stpRNG5', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_DERIV_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  // eXness indices (real index CFDs — no synthetics; full list per Exness Help)
  // volumeMin 0.5, step 0.01: open 0.51 when min, so partial close can leave 0.01
  { id: 'inst-exness-aus200', symbol: 'AUS200', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-us30', symbol: 'US30', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-us500', symbol: 'US500', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-ustec', symbol: 'USTEC', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-uk100', symbol: 'UK100', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-de30', symbol: 'DE30', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-fr40', symbol: 'FR40', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-jp225', symbol: 'JP225', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-hk50', symbol: 'HK50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-stoxx50', symbol: 'STOXX50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  // Additional eXness index CFDs (when available on account)
  { id: 'inst-exness-chi50', symbol: 'CHI50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-swi20', symbol: 'SWI20', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-eu50', symbol: 'EU50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-nas100', symbol: 'NAS100', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_API_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
];
