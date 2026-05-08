/**
 * Bot execution: evaluate deployed bots, call NN predict, open positions via tryOpenPosition + placeBrokerOrder + addPosition.
 * Runs when execution.enabled; uses risk management for every position open.
 */

import type { BotConfig, BrokerConfig, ClosedTrade, Instrument, Position, TradeScope, TradeStyle, Timeframe } from './types';
import { ensembleDecision } from './ensemble';
import { getBarDurationMs } from './ohlcv';
import type { OHLCVBar } from './ohlcv';
import { DEFAULT_SCOPE_SELECTOR_CONFIG } from './types';
import { detectRegime } from './regimes';
import { postPredict } from './api';
import { addPosition, getPortfolioState, positionPnl } from './portfolio';
import { computeNetLivePnl } from './tradePnl';
import { tryOpenPosition } from './risk';
import { getWarmupScaleFactor } from './bot';
import { logTradeEvent } from './tradeLogger';
import { placeBrokerOrder, closeBrokerPosition } from './brokerExecution';
import { fetchOHLCV } from './ohlcvFeed';
import { buildHtfIndexForEachLtfBar, getHigherTimeframe } from './multiTimeframe';
import type { SignalContext } from './signals';
import { inferPointSize } from './spreadUtils';
import { STYLE_TO_SCOPE } from './scope';
import { TRADE_MODES } from './tradeModes';
import { getSignalFn } from './signals';

/** Regime detection lookback (bars). Used for volatility/trend; must match detectRegime. */
const REGIME_LOOKBACK = 50;

/** Skip new entries when regime confidence below this (avoids trading in ambiguous regimes). */
const REGIME_CONFIDENCE_ENTRY_MIN = 0.35;

/**
 * When NN says NEUTRAL with confidence below `lowConfidenceNeutral`, we may override from rules.
 * If NN confidence is extremely low (< this), one non-opposing strategy is enough; otherwise require 2.
 * Reduces “random” one-rule entries while avoiding a total standstill when the model is uncertain.
 */
const FALLBACK_SINGLE_VOTE_MAX_NN_CONF = 0.25;

/**
 * Max positions per instrument. Stage 1 prefers the per-mode ``maxConcurrent``
 * from ``TRADE_MODES`` when the bot has a resolved style — that is, the
 * SCALPING bot gets 3, SNIPER gets 1, etc. — and falls back to the legacy
 * confidence cascade only when style is unresolved (auto mode without a
 * fixed pick).
 */
function getMaxPositionsPerInstrument(
  confidence: number,
  botMaxPositions: number = Number.POSITIVE_INFINITY,
  resolvedStyle: TradeStyle | null = null
): number {
  let cap: number;
  if (resolvedStyle && TRADE_MODES[resolvedStyle]) {
    cap = TRADE_MODES[resolvedStyle].maxConcurrent;
  } else {
    const cfg = DEFAULT_SCOPE_SELECTOR_CONFIG;
    if (confidence >= cfg.confidenceForThirdEntry) cap = Math.min(3, cfg.maxPositionsPerInstrument);
    else if (confidence >= cfg.confidenceForSecondEntry) cap = Math.min(2, cfg.maxPositionsPerInstrument);
    else cap = 1;
  }
  if (!Number.isFinite(botMaxPositions) || botMaxPositions <= 0) return cap;
  return Math.max(1, Math.min(cap, Math.floor(botMaxPositions)));
}

const TIMEFRAME_TO_SCOPE: Record<string, TradeScope> = {
  M1: 'scalp',
  M5: 'scalp',
  M15: 'day',
  M30: 'day',
  H1: 'day',
  H4: 'swing',
  D1: 'swing',
  W1: 'position',
};

/** Execution interval (ms) per trade scope. Faster for scalp, slower for swing/position. */
export const SCOPE_TO_INTERVAL_MS: Record<TradeScope, number> = {
  scalp: 15_000,
  day: 30_000,
  swing: 60_000,
  position: 120_000,
};

export interface SelectScopeInput {
  equity: number;
  drawdownPct: number;
  regime: string;
  regimeConfidence: number;
  volatilityPercent: number;
  utcHour: number;
  utcDay: number;
  existingPositionsCount: number;
}

interface ExecutionPipeline {
  id: string;
  timeframe: Timeframe;
  scope: TradeScope;
  style: TradeStyle;
  score: number;
}

interface PipelineAnalysis {
  pipeline: ExecutionPipeline;
  bars: OHLCVBar[];
  signalCtx?: SignalContext;
  regimeState: ReturnType<typeof detectRegime>;
  predictRes: {
    actions?: number[];
    confidence?: number;
    size_multiplier?: number;
    sl_pct?: number;
    tp_r?: number;
    strategy_id?: string | null;
  };
  action: number;
  currentPrice: number;
  score: number;
}

/**
 * Select trade scope for this tick based on per-bot config.
 * Returns null to pause (no new positions), or the selected scope.
 *
 * Trade mode selection is always respected:
 * - scopeMode === 'manual' + fixedScope: always use fixedScope (no scoring override)
 * - scopeMode === 'manual' + fixedStyles (2–4): scoring only among user-selected scopes
 * - scopeMode === 'auto': parallel scoring across allowed scopes
 */
export function selectScopeForTick(
  bot: BotConfig,
  input: SelectScopeInput
): TradeScope | null {
  let allowed = bot.allowedScopes?.length ? bot.allowedScopes : ['scalp', 'day', 'swing'];

  // Manual single: user chose one scope — always respect it (no scoring, no filters)
  if (bot.scopeMode === 'manual' && bot.fixedScope) {
    const fixed = bot.fixedScope;
    if (allowed.includes(fixed)) return fixed;
    return null;
  }

  // Manual multi: user chose 2–4 scopes — scoring only within their selection
  const fixedStyles = Array.isArray(bot.fixedStyles) ? bot.fixedStyles : [];
  if (bot.scopeMode === 'manual' && fixedStyles.length >= 2 && fixedStyles.length <= 4) {
    allowed = [...new Set(fixedStyles.map((s) => STYLE_TO_SCOPE[s]))];
    if (allowed.length === 0) return null;
  }

  const cfg = DEFAULT_SCOPE_SELECTOR_CONFIG;
  if (input.drawdownPct >= cfg.drawdownPause) return null;

  let candidates: TradeScope[] = [...allowed];

  if (input.equity < cfg.equityScalpOnly) {
    candidates = candidates.filter((s) => s === 'scalp');
    if (candidates.length === 0) return null;
  } else if (input.equity < cfg.equityDayMin) {
    candidates = candidates.filter((s) => s === 'scalp' || s === 'day');
  }

  if (input.drawdownPct >= cfg.drawdownScalpOnly) {
    candidates = candidates.filter((s) => s === 'scalp');
    if (candidates.length === 0) return null;
  }

  if (input.volatilityPercent > cfg.volatilityNoScalp) {
    candidates = candidates.filter((s) => s !== 'scalp');
  }

  if (input.utcDay === 0 || input.utcDay === 6) {
    candidates = candidates.filter((s) => s !== 'scalp');
  }

  if (input.utcHour >= 0 && input.utcHour < 2) {
    candidates = candidates.filter((s) => s !== 'scalp');
  }

  // Parallel scope analysis: score each candidate 0–1, pick highest.
  // No preference cascade; all modes evaluated on regime, volatility, time, confidence.
  if (candidates.length === 1) return candidates[0];

  const scores = candidates.map((scope) => ({
    scope,
    score: scoreScopeForCandidate(scope, input, cfg),
  }));
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  return best && best.score > 0 ? best.scope : candidates[0] ?? null;
}

/**
 * Score a scope 0–1 for parallel mode analysis. Higher = better fit.
 * Uses regime, volatility, session time, and regime confidence.
 */
function scoreScopeForCandidate(
  scope: TradeScope,
  input: SelectScopeInput,
  cfg: typeof DEFAULT_SCOPE_SELECTOR_CONFIG
): number {
  const regime = input.regime;
  const conf = input.regimeConfidence ?? 0.5;
  const vol = input.volatilityPercent ?? 0;
  const hour = input.utcHour ?? 12;
  const day = input.utcDay ?? 1;
  const isTrending = regime === 'trending_bull' || regime === 'trending_bear';
  const ranging = regime === 'ranging' || regime === 'consolidation';
  const reversal = regime === 'reversal_bull' || regime === 'reversal_bear';
  const volatile = regime === 'volatile' || vol > cfg.volatilityNoScalp;
  const inSession = hour >= 8 && hour <= 18 && day >= 1 && day <= 5;

  let regimeScore = 0;
  let volScore = 0;
  let timeScore = 0;
  let confScore = 0;

  switch (scope) {
    case 'scalp':
      regimeScore = reversal ? 0.95 : ranging ? 0.6 : isTrending ? 0.4 : volatile ? 0.2 : 0.5;
      volScore = vol <= cfg.volatilityNoScalp * 0.5 ? 1 : vol <= cfg.volatilityNoScalp ? 0.7 : 0;
      timeScore = inSession ? 0.9 : hour >= 0 && hour < 2 ? 0.2 : 0.5;
      confScore = 0.5 + (1 - Math.abs(conf - 0.6)) * 0.5;
      break;
    case 'day':
      regimeScore = ranging ? 0.9 : isTrending ? 0.75 : reversal ? 0.5 : volatile ? 0.6 : 0.7;
      volScore = vol <= cfg.volatilityNoScalp ? 0.9 : vol <= 0.05 ? 0.7 : 0.5;
      timeScore = inSession ? 0.95 : 0.6;
      confScore = 0.5 + (1 - Math.abs(conf - 0.65)) * 0.5;
      break;
    case 'swing':
      regimeScore = isTrending && conf >= cfg.trendConfidenceSwing ? 0.95 : volatile ? 0.85 : ranging ? 0.6 : reversal ? 0.3 : 0.5;
      volScore = volatile ? 0.9 : vol >= 0.01 ? 0.7 : 0.4;
      timeScore = 0.7;
      confScore = conf >= cfg.trendConfidenceSwing ? 0.9 : 0.5 + conf * 0.4;
      break;
    case 'position':
      regimeScore = isTrending && conf >= cfg.trendConfidenceSwing ? 0.95 : volatile ? 0.7 : 0.4;
      volScore = volatile ? 0.8 : vol >= 0.01 ? 0.6 : 0.3;
      timeScore = 0.6;
      confScore = conf >= cfg.trendConfidenceSwing ? 0.95 : 0.4 + conf * 0.4;
      break;
    default:
      return 0.5;
  }

  const w = { regime: 0.4, vol: 0.25, time: 0.2, conf: 0.15 };
  let total = regimeScore * w.regime + volScore * w.vol + timeScore * w.time + confScore * w.conf;
  // Trending + high confidence: swing/position should beat day (regime fit dominates session)
  const trendingHighConf = isTrending && conf >= cfg.trendConfidenceSwing;
  if (trendingHighConf && (scope === 'swing' || scope === 'position')) {
    total += 0.12;
  }
  return total;
}

function styleForScope(scope: TradeScope): TradeStyle {
  if (scope === 'scalp') return 'scalping';
  if (scope === 'day') return 'day';
  return 'swing';
}

function stylesForTimeframe(bot: BotConfig, timeframe: Timeframe): TradeStyle[] {
  const scope = TIMEFRAME_TO_SCOPE[timeframe] ?? 'day';
  const selectedStyles = Array.isArray(bot.fixedStyles) && bot.fixedStyles.length > 0
    ? bot.fixedStyles
    : (bot.scopeMode === 'manual' && bot.fixedStyle ? [bot.fixedStyle] : bot.styles);
  const styles = (selectedStyles?.length ? selectedStyles : bot.styles).filter((style) => STYLE_TO_SCOPE[style] === scope);
  if (styles.length > 0) return [...new Set(styles)];
  return [styleForScope(scope)];
}

function styleIndexForScope(scope: TradeScope): number {
  return scope === 'scalp' ? 0 : scope === 'day' ? 1 : scope === 'swing' ? 2 : 3;
}

/** Highest timeframe in the bot list (W1 > D1 > … > M1) for a single “anchor” market context. */
export function coarsestTimeframeInBot(timeframes: Timeframe[] | undefined): Timeframe | null {
  if (!timeframes?.length) return null;
  let best: Timeframe | null = null;
  let bestMs = -1;
  for (const tf of timeframes) {
    const ms = getBarDurationMs(tf);
    if (ms > bestMs) {
      bestMs = ms;
      best = tf;
    }
  }
  return best;
}

function allowedScopesForBot(bot: BotConfig): TradeScope[] {
  let allowed = bot.allowedScopes?.length ? bot.allowedScopes : ['scalp', 'day', 'swing'];
  if (bot.scopeMode === 'manual' && bot.fixedScope) {
    allowed = allowed.includes(bot.fixedScope) ? [bot.fixedScope] : [];
  } else if (bot.scopeMode === 'manual') {
    const fixedStyles = Array.isArray(bot.fixedStyles) ? bot.fixedStyles : [];
    if (fixedStyles.length >= 1 && fixedStyles.length <= 4) {
      allowed = [...new Set(fixedStyles.map((s) => STYLE_TO_SCOPE[s]).filter(Boolean))];
    }
  }
  return [...new Set(allowed)];
}

function buildExecutionPipelines(bot: BotConfig): ExecutionPipeline[] {
  const allowed = new Set(allowedScopesForBot(bot));
  const seen = new Set<string>();
  const pipelines: ExecutionPipeline[] = [];
  for (const tf of bot.timeframes ?? []) {
    const scope = TIMEFRAME_TO_SCOPE[tf] ?? 'day';
    if (!allowed.has(scope)) continue;
    for (const style of stylesForTimeframe(bot, tf)) {
      const id = `${style}:${scope}:${tf}`;
      if (seen.has(id)) continue;
      seen.add(id);
      pipelines.push({
        id,
        timeframe: tf,
        scope,
        style,
        score: 0,
      });
    }
  }
  return pipelines;
}

function pipelineAllowedByContext(
  pipeline: ExecutionPipeline,
  input: SelectScopeInput
): { allowed: boolean; reason?: string; score?: number } {
  const cfg = DEFAULT_SCOPE_SELECTOR_CONFIG;
  if (input.drawdownPct >= cfg.drawdownPause) return { allowed: false, reason: 'drawdown_pause' };
  // Soft context preferences must not block analysis. The final risk engine
  // still enforces equity, drawdown, exposure, sizing, and compliance caps.
  const score = scoreScopeForCandidate(pipeline.scope, input, cfg);
  return { allowed: true, score: Math.max(0.01, score), reason: undefined };
}

function fallbackActionFromStrategies(
  bot: BotConfig,
  inst: Instrument,
  symbol: string,
  bars: OHLCVBar[],
  regimeState: ReturnType<typeof detectRegime>,
  signalCtx: SignalContext | undefined,
  nnConfidence: number
): { action: number; strategyId?: string; strategySignal?: number; agreementCount: number } | null {
  let longVotes = 0;
  let shortVotes = 0;
  const longIds: string[] = [];
  const shortIds: string[] = [];
  for (const strategyId of bot.strategyIds ?? []) {
    try {
      const signalFn = getSignalFn(strategyId, inst.id, symbol);
      const signal = signalFn(bars, regimeState, bars.length - 1, undefined, signalCtx);
      if (signal === 1) {
        longVotes += 1;
        longIds.push(strategyId);
      }
      if (signal === -1) {
        shortVotes += 1;
        shortIds.push(strategyId);
      }
    } catch {
      /* Try next strategy; individual rule failures should not stop the pipeline. */
    }
  }
  const minVotes = nnConfidence < FALLBACK_SINGLE_VOTE_MAX_NN_CONF ? 1 : 2;
  if (longVotes >= minVotes && shortVotes === 0) {
    return { action: 0, strategyId: longIds.join('+'), strategySignal: 1, agreementCount: longVotes };
  }
  if (shortVotes >= minVotes && longVotes === 0) {
    return { action: 1, strategyId: shortIds.join('+'), strategySignal: -1, agreementCount: shortVotes };
  }
  return null;
}

/** Get the execution interval for deployed bots. Uses the fastest scope among them. */
export function getBotExecutionIntervalMs(deployedBots: BotConfig[]): number {
  if (deployedBots.length === 0) return SCOPE_TO_INTERVAL_MS.day;
  let fastest = SCOPE_TO_INTERVAL_MS.position;
  for (const bot of deployedBots) {
    const primaryTf = bot.timeframes[0] ?? 'M5';
    const scope = TIMEFRAME_TO_SCOPE[primaryTf] ?? 'day';
    const ms = SCOPE_TO_INTERVAL_MS[scope];
    if (ms < fastest) fastest = ms;
  }
  return fastest;
}

export type BotExecutionEventPhase =
  | 'fetch_ohlcv'
  | 'detect_regime'
  | 'select_scope'
  | 'predict'
  | 'risk_check'
  | 'validate'
  | 'order'
  | 'close'
  | 'skipped'
  | 'trade_open'
  | 'trade_close'
  | 'broker'
  | 'sl_modify'
  | 'tp_partial';

export type BotExecutionEventOutcome = 'success' | 'fail' | 'skip' | 'ignored' | 'disconnect';

export interface BotExecutionEventDetails {
  /** Unique id for this execution run; events from the same tick share this. */
  cycleId?: string;
  regime?: string;
  regimeConfidence?: number;
  nnConfidence?: number;
  scope?: string;
  style?: string;
  timeframe?: string;
  volatilityPct?: number;
  regimeLookback?: number;
  action?: number;
  side?: string;
  size?: number;
  /** Entry price when order placed. */
  entryPrice?: number;
  /** Exit target (take profit) when order placed. */
  exitPrice?: number;
  reason?: string;
  /** Risk library rule that blocked (when risk_check skip). */
  ruleId?: string;
  ruleName?: string;
  barsCount?: number;
  equity?: number;
  drawdownPct?: number;
  score?: number;
  pipelineScore?: number;
  pipelineId?: string;
  fetchTimeframe?: string;
  predictTimeframe?: string;
  htfTimeframe?: string;
  /** Coarsest TF used for cross-pipeline scope scoring (when anchor fetch succeeded). */
  regimeAnchorTimeframe?: string;
  strategyId?: string;
  strategySignal?: number;
  agreementCount?: number;
}

export interface BotExecutionEvent {
  id: string;
  timestamp: string;
  botId: string;
  symbol: string;
  phase: BotExecutionEventPhase;
  outcome: BotExecutionEventOutcome;
  message: string;
  details?: BotExecutionEventDetails;
}

// Stage 2B: runBotExecution / runPositionEvaluation and their parameter
// interfaces have been deleted (~930 lines). The backend ExecutionDaemon
// (python/cicada_nn/execution_daemon.py) is now the canonical owner of
// the live trade loop — it does NN predict, ensemble decision, per-mode
// validate_order, sl_tp_manager lifecycle, latency-gate checks, and
// append-only order_records emission server-side via the MT5 bridge.
//
// What remains in this file is the small set of pure helpers the UI still
// needs to display state: scope selection, timeframe ordering, interval
// math, and event-shape types for the SSE-driven log viewer.
