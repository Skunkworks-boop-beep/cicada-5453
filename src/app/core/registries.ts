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

/**
 * Registry is immutable at runtime — it's derived from module-level arrays.
 * Memoising the combined list and its derived views avoids 236-element
 * allocations on every hot-path call (every signal lookup during backtest).
 * Returned arrays are copies so callers cannot mutate the shared cache.
 */
let _allStrategiesCache: readonly AnyStrategyDef[] | null = null;
let _byIdCache: Map<string, AnyStrategyDef> | null = null;
const _byCategoryCache = new Map<AnyStrategyDef['category'], readonly AnyStrategyDef[]>();
const _byRegimeCache = new Map<MarketRegime, readonly AnyStrategyDef[]>();
const _byStyleCache = new Map<TradeStyle, readonly AnyStrategyDef[]>();

function _rebuildIndex(): void {
  _allStrategiesCache = Object.freeze([...CP, ...CSP, ...TRADE_LOGIC_STRATEGIES]);
  _byIdCache = new Map(_allStrategiesCache.map((s) => [s.id, s]));
  _byCategoryCache.clear();
  _byRegimeCache.clear();
  _byStyleCache.clear();
}

export function getAllStrategies(): AnyStrategyDef[] {
  if (!_allStrategiesCache) _rebuildIndex();
  return [...(_allStrategiesCache as readonly AnyStrategyDef[])];
}

/** Look up a strategy by id in O(1). Returns undefined when unknown. */
export function getStrategyById(id: string): AnyStrategyDef | undefined {
  if (!_byIdCache) _rebuildIndex();
  return _byIdCache!.get(id);
}

/** Drop the caches (e.g. after hot-reload inserts new strategies). */
export function invalidateStrategyCache(): void {
  _allStrategiesCache = null;
  _byIdCache = null;
  _byCategoryCache.clear();
  _byRegimeCache.clear();
  _byStyleCache.clear();
}

export function getStrategiesByCategory(category: AnyStrategyDef['category']): AnyStrategyDef[] {
  const cached = _byCategoryCache.get(category);
  if (cached) return [...cached];
  const list = Object.freeze(getAllStrategies().filter((s) => s.category === category));
  _byCategoryCache.set(category, list);
  return [...list];
}

export function getStrategiesForRegime(regime: MarketRegime): AnyStrategyDef[] {
  const cached = _byRegimeCache.get(regime);
  if (cached) return [...cached];
  const list = Object.freeze(
    getAllStrategies().filter((s) => s.regimes.includes(regime) || s.regimes.includes('unknown'))
  );
  _byRegimeCache.set(regime, list);
  return [...list];
}

export function getStrategiesForStyle(style: TradeStyle): AnyStrategyDef[] {
  const cached = _byStyleCache.get(style);
  if (cached) return [...cached];
  const list = Object.freeze(getAllStrategies().filter((s) => s.styles.includes(style)));
  _byStyleCache.set(style, list);
  return [...list];
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
  // Stage 4: MT5 bridge is the only execution path.
  { id: BROKER_EXNESS_ID, name: 'MT5', type: 'mt5', status: 'disconnected', config: {}, order: 0 },
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
  { id: 'inst-eurusd', symbol: 'EUR/USD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MAJOR], rebuildIntervalHours: 168 },
  { id: 'inst-usdjpy', symbol: 'USD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MAJOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpusd', symbol: 'GBP/USD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MAJOR], rebuildIntervalHours: 168 },
  { id: 'inst-usdchf', symbol: 'USD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audusd', symbol: 'AUD/USD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-usdcad', symbol: 'USD/CAD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdusd', symbol: 'NZD/USD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurgbp', symbol: 'EUR/GBP', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurjpy', symbol: 'EUR/JPY', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurchf', symbol: 'EUR/CHF', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-euraud', symbol: 'EUR/AUD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurcad', symbol: 'EUR/CAD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-eurnzd', symbol: 'EUR/NZD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpjpy', symbol: 'GBP/JPY', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpchf', symbol: 'GBP/CHF', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpaud', symbol: 'GBP/AUD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpcad', symbol: 'GBP/CAD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-gbpnzd', symbol: 'GBP/NZD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audjpy', symbol: 'AUD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audnzd', symbol: 'AUD/NZD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audcad', symbol: 'AUD/CAD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-audchf', symbol: 'AUD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdjpy', symbol: 'NZD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdcad', symbol: 'NZD/CAD', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-nzdchf', symbol: 'NZD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-cadjpy', symbol: 'CAD/JPY', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-cadchf', symbol: 'CAD/CHF', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  { id: 'inst-chfjpy', symbol: 'CHF/JPY', type: 'fiat', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_MINOR], rebuildIntervalHours: 168 },
  // Crypto → Deriv
  { id: 'inst-btcusd', symbol: 'BTC/USD', type: 'crypto', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'], rebuildIntervalHours: 168 },
  { id: 'inst-ethusd', symbol: 'ETH/USD', type: 'crypto', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  { id: 'inst-solusd', symbol: 'SOL/USD', type: 'crypto', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  { id: 'inst-xrpusd', symbol: 'XRP/USD', type: 'crypto', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  { id: 'inst-dogeusd', symbol: 'DOGE/USD', type: 'crypto', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M5', 'M15', 'H1', 'H4', 'D1'], rebuildIntervalHours: 168 },
  // ─── Deriv synthetic indices (Stage 8 reintroduction) ─────────────────────
  // Re-added with Deriv's MT5-server symbol naming. These trade through the
  // bridge when the operator's Windows VM has MT5 logged into a Deriv MT5
  // account; for non-Deriv MT5 brokers the symbols won't resolve and the
  // bridge will return "symbol not found" — operators on other brokers can
  // edit the symbol field or remove the instrument.
  // Volatility (continuous) — R_10..R_100 via MT5
  { id: 'inst-deriv-r10', symbol: 'Volatility 10 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r25', symbol: 'Volatility 25 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r50', symbol: 'Volatility 50 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r75', symbol: 'Volatility 75 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r100', symbol: 'Volatility 100 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  // Volatility (1-second tick) — 1HZ*V
  { id: 'inst-deriv-r10s', symbol: 'Volatility 10 (1s) Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r25s', symbol: 'Volatility 25 (1s) Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r50s', symbol: 'Volatility 50 (1s) Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r75s', symbol: 'Volatility 75 (1s) Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-r100s', symbol: 'Volatility 100 (1s) Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  // Boom — spike up
  { id: 'inst-deriv-boom300', symbol: 'Boom 300 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom500', symbol: 'Boom 500 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom600', symbol: 'Boom 600 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom900', symbol: 'Boom 900 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-boom1000', symbol: 'Boom 1000 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  // Crash — spike down
  { id: 'inst-deriv-crash300', symbol: 'Crash 300 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash500', symbol: 'Crash 500 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash600', symbol: 'Crash 600 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash900', symbol: 'Crash 900 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-crash1000', symbol: 'Crash 1000 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5'], rebuildIntervalHours: 168 },
  // Jump — discrete jumps
  { id: 'inst-deriv-jump10', symbol: 'Jump 10 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump25', symbol: 'Jump 25 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump50', symbol: 'Jump 50 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump75', symbol: 'Jump 75 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-jump100', symbol: 'Jump 100 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  // Step + Range Break
  { id: 'inst-deriv-step', symbol: 'Step Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_SYNTH], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-rb100', symbol: 'Range Break 100 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },
  { id: 'inst-deriv-rb200', symbol: 'Range Break 200 Index', type: 'synthetic_deriv', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: ['M1', 'M5', 'M15'], rebuildIntervalHours: 168 },

  // eXness indices (real index CFDs — no synthetics; full list per Exness Help)
  // volumeMin 0.5, step 0.01: open 0.51 when min, so partial close can leave 0.01
  { id: 'inst-exness-aus200', symbol: 'AUS200', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-us30', symbol: 'US30', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-us500', symbol: 'US500', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-ustec', symbol: 'USTEC', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-uk100', symbol: 'UK100', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-de30', symbol: 'DE30', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-fr40', symbol: 'FR40', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-jp225', symbol: 'JP225', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-hk50', symbol: 'HK50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-stoxx50', symbol: 'STOXX50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  // Additional eXness index CFDs (when available on account)
  { id: 'inst-exness-chi50', symbol: 'CHI50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-swi20', symbol: 'SWI20', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-eu50', symbol: 'EU50', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
  { id: 'inst-exness-nas100', symbol: 'NAS100', type: 'indices_exness', status: 'active', brokerId: BROKER_EXNESS_ID, timeframes: [...TF_INDICES], rebuildIntervalHours: 168, volumeMin: 0.5, volumeStep: 0.01 },
];
