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
 * Max positions per instrument based on regime confidence. Higher confidence
 * → more entries allowed. Now also respects the bot's configured
 * ``maxPositions`` (upper bound) so a high-confidence regime can't push a
 * single instrument beyond the bot's portfolio-wide cap.
 */
function getMaxPositionsPerInstrument(
  confidence: number,
  botMaxPositions: number = Number.POSITIVE_INFINITY
): number {
  const cfg = DEFAULT_SCOPE_SELECTOR_CONFIG;
  let cap: number;
  if (confidence >= cfg.confidenceForThirdEntry) cap = Math.min(3, cfg.maxPositionsPerInstrument);
  else if (confidence >= cfg.confidenceForSecondEntry) cap = Math.min(2, cfg.maxPositionsPerInstrument);
  else cap = 1;
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
  | 'order'
  | 'close'
  | 'skipped'
  | 'trade_open'
  | 'trade_close'
  | 'broker';

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

export interface BotExecutionParams {
  bots: BotConfig[];
  instruments: Instrument[];
  brokers: BrokerConfig[];
  executionEnabled: boolean;
  onEmit?: () => void;
  onEvent?: (event: Omit<BotExecutionEvent, 'id' | 'timestamp'>) => void;
  /** Closed trades per bot for dynamic feature blending. */
  closedTradesByBot?: Record<string, ClosedTrade[]>;
  /** Called when a position is closed on prediction (NEUTRAL or opposite). Store records closed trade and removes position. */
  onClosePosition?: (params: { position: Position; exitPrice: number; pnl: number; nnSlPct?: number; nnTpR?: number; nnSizeMult?: number }) => void;
}

/**
 * Run bot execution: for each deployed bot with nnFeatureVector, fetch OHLCV, detect regime,
 * call predict, and open position via addPositionWithRiskCheck if signal is long/short.
 * Integration-only (API/network); scope logic covered by verify-trading-mode.ts
 */
/* v8 ignore start */
const emitEvent = (
  onEvent: BotExecutionParams['onEvent'],
  botId: string,
  symbol: string,
  phase: BotExecutionEvent['phase'],
  outcome: BotExecutionEvent['outcome'],
  message: string,
  details?: BotExecutionEvent['details'],
  cycleId?: string
) => {
  if (!onEvent) return;
  const merged = cycleId ? { ...details, cycleId } : details;
  onEvent({ botId, symbol, phase, outcome, message, details: merged });
};

export async function runBotExecution(params: BotExecutionParams): Promise<void> {
  const { bots, instruments, brokers, executionEnabled, onEmit, onEvent } = params;
  const closedTradesByBot = params.closedTradesByBot ?? {};
  if (!executionEnabled) return;

  const deployedBots = bots.filter((b) => b.status === 'deployed' && b.nnFeatureVector && b.nnFeatureVector.length >= 32 && b.nnFeatureVector.length <= 512);
  if (deployedBots.length === 0) return;

  const portfolio = getPortfolioState();
  if (portfolio.equity <= 0 || portfolio.dataSource === 'none') return;

  const cycleId = `cycle-${Date.now()}`;
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay();

  for (const bot of deployedBots) {
    const inst = instruments.find((i) => i.id === bot.instrumentId);
    if (!inst || inst.status !== 'active') {
      if (onEvent && inst) {
        emitEvent(onEvent, bot.id, inst.symbol ?? inst.id, 'skipped', 'skip', 'Instrument inactive', { reason: 'inactive' }, cycleId);
      }
      continue;
    }

    const symbol = inst.symbol ?? inst.id.replace(/^inst-/, '').toUpperCase().replace(/-/g, '/');
    const instrumentType = inst.type ?? 'fiat';
    const closedTrades = closedTradesByBot[bot.id] ?? [];
    const closedTradesForPredict = closedTrades.slice(-50).map((t) => ({ pnl: t.pnl }));
    const pipelines = buildExecutionPipelines(bot);
    if (pipelines.length === 0) {
      emitEvent(onEvent, bot.id, symbol, 'skipped', 'skip', 'No enabled timeframe/scope pipelines', { reason: 'no_pipelines' }, cycleId);
      continue;
    }

    const ohlcvCache = new Map<string, OHLCVBar[]>();
    const anchorTf = coarsestTimeframeInBot(bot.timeframes);
    let anchorRegimeState: ReturnType<typeof detectRegime> | null = null;
    if (anchorTf) {
      const anchorMeta = bot.nnDetectionModels?.[anchorTf];
      const barWindowSize = anchorMeta?.barWindow ?? bot.nnDetectionBarWindow ?? 60;
      const fetchCount = Math.max(100, barWindowSize + 20);
      try {
        const { bars: anchorBars } = await fetchOHLCV({
          instrumentId: inst.id,
          symbol,
          brokerId: inst.brokerId,
          timeframe: anchorTf,
          brokers,
          activity: 'live',
          count: fetchCount,
        });
        if (anchorBars.length >= 50) {
          ohlcvCache.set(anchorTf, anchorBars);
          anchorRegimeState = detectRegime(anchorBars, REGIME_LOOKBACK);
        }
      } catch {
        /* Anchor is optional; per-pipeline regime is used for scoring if missing. */
      }
    }

    const portfolio0 = getPortfolioState();
    const scopeInputBase: Omit<SelectScopeInput, 'regime' | 'regimeConfidence' | 'volatilityPercent'> = {
      equity: portfolio0.equity,
      drawdownPct: portfolio0.drawdownPct ?? 0,
      utcHour,
      utcDay,
      existingPositionsCount: portfolio0.positions.filter((p) => p.botId === bot.id).length,
    };
    const anchorScopeInput: SelectScopeInput | null = anchorRegimeState
      ? {
          ...scopeInputBase,
          regime: anchorRegimeState.regime,
          regimeConfidence: anchorRegimeState.confidence,
          volatilityPercent: anchorRegimeState.volatilityPercent,
        }
      : null;

    const analyses: PipelineAnalysis[] = [];
    const actionLabels = ['LONG', 'SHORT', 'NEUTRAL'];

    for (const pipeline of pipelines) {
      const pipelineId = `${cycleId}:${bot.id}:${pipeline.id}`;
      const modelMeta = bot.nnDetectionModels?.[pipeline.timeframe];
      const barWindowSize = modelMeta?.barWindow ?? bot.nnDetectionBarWindow ?? 60;
      const fetchCount = Math.max(100, barWindowSize + 20);
      let bars: OHLCVBar[] = ohlcvCache.get(pipeline.timeframe) ?? [];

      try {
        if (bars.length < 50) {
          const { bars: fetched } = await fetchOHLCV({
            instrumentId: inst.id,
            symbol,
            brokerId: inst.brokerId,
            timeframe: pipeline.timeframe,
            brokers,
            activity: 'live',
            count: fetchCount,
          });
          bars = fetched;
          if (fetched.length > 0) ohlcvCache.set(pipeline.timeframe, fetched);
        }
        emitEvent(onEvent, bot.id, symbol, 'fetch_ohlcv', 'success', `Fetched ${bars.length} bars`, {
          barsCount: bars.length,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          fetchTimeframe: pipeline.timeframe,
          pipelineId,
        }, cycleId);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        emitEvent(onEvent, bot.id, symbol, 'fetch_ohlcv', 'fail', `OHLCV fetch failed: ${errMsg}`, {
          reason: errMsg,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          fetchTimeframe: pipeline.timeframe,
          pipelineId,
        }, cycleId);
        continue;
      }

      if (bars.length < 50) {
        emitEvent(onEvent, bot.id, symbol, 'fetch_ohlcv', 'skip', 'Insufficient bars (< 50)', {
          reason: 'insufficient_bars',
          barsCount: bars.length,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          pipelineId,
        }, cycleId);
        continue;
      }

      let signalCtx: SignalContext | undefined;
      const htfTf = getHigherTimeframe(pipeline.timeframe);
      if (htfTf) {
        try {
          const { bars: htfBars } = await fetchOHLCV({
            instrumentId: inst.id,
            symbol,
            brokerId: inst.brokerId,
            timeframe: htfTf,
            brokers,
            activity: 'live',
            count: fetchCount,
          });
          if (htfBars.length >= 2) {
            signalCtx = {
              htfBars,
              htfIndexByLtfBar: buildHtfIndexForEachLtfBar(bars, htfBars),
              htfTimeframe: htfTf,
              ltfTimeframe: pipeline.timeframe,
            };
          }
        } catch {
          emitEvent(onEvent, bot.id, symbol, 'fetch_ohlcv', 'skip', `HTF ${htfTf} unavailable`, {
            reason: 'htf_unavailable',
            scope: pipeline.scope,
            style: pipeline.style,
            timeframe: pipeline.timeframe,
            htfTimeframe: htfTf,
            pipelineId,
          }, cycleId);
        }
      }

      const regimeState = detectRegime(bars, REGIME_LOOKBACK);
      const { regime, confidence, volatilityPercent } = regimeState;
      emitEvent(onEvent, bot.id, symbol, 'detect_regime', 'success', `Regime: ${regime}`, {
        regime,
        regimeConfidence: confidence,
        volatilityPct: volatilityPercent,
        regimeLookback: REGIME_LOOKBACK,
        scope: pipeline.scope,
        style: pipeline.style,
        timeframe: pipeline.timeframe,
        pipelineId,
      }, cycleId);

      const scopeInputForScoring: SelectScopeInput = anchorScopeInput
        ? anchorScopeInput
        : {
            ...scopeInputBase,
            regime,
            regimeConfidence: confidence,
            volatilityPercent,
          };
      const scopeCheck = pipelineAllowedByContext(pipeline, scopeInputForScoring);
      if (!scopeCheck.allowed) {
        emitEvent(onEvent, bot.id, symbol, 'select_scope', 'skip', `Pipeline paused: ${scopeCheck.reason}`, {
          regime,
          regimeConfidence: confidence,
          volatilityPct: volatilityPercent,
          regimeLookback: REGIME_LOOKBACK,
          equity: getPortfolioState().equity,
          drawdownPct: getPortfolioState().drawdownPct ?? 0,
          reason: scopeCheck.reason,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          pipelineId,
        }, cycleId);
        continue;
      }
      pipeline.score = scopeCheck.score ?? 0;
      emitEvent(onEvent, bot.id, symbol, 'select_scope', 'success', `Pipeline: ${pipeline.style}/${pipeline.timeframe}`, {
        regime,
        regimeConfidence: confidence,
        volatilityPct: volatilityPercent,
        regimeLookback: REGIME_LOOKBACK,
        scope: pipeline.scope,
        style: pipeline.style,
        timeframe: pipeline.timeframe,
        pipelineScore: pipeline.score,
        equity: getPortfolioState().equity,
        drawdownPct: getPortfolioState().drawdownPct ?? 0,
        pipelineId,
        regimeAnchorTimeframe: anchorRegimeState && anchorTf ? anchorTf : undefined,
      }, cycleId);

      const barWindow = bars.length >= barWindowSize
        ? bars.slice(-barWindowSize).map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, time: b.time }))
        : undefined;
      let predictRes: PipelineAnalysis['predictRes'] | null = null;
      try {
        predictRes = await postPredict({
          instrument_id: bot.instrumentId,
          feature_vector: bot.nnFeatureVector!,
          instrument_type: instrumentType,
          regime,
          timeframe: pipeline.timeframe,
          scope: pipeline.scope,
          closed_trades: closedTradesForPredict.length >= 3 ? closedTradesForPredict : undefined,
          volatility_pct: volatilityPercent,
          regime_confidence: confidence,
          bar_window: barWindow,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        emitEvent(onEvent, bot.id, symbol, 'predict', 'fail', `Predict API failed: ${errMsg}`, {
          regime,
          reason: errMsg,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          predictTimeframe: pipeline.timeframe,
          pipelineId,
        }, cycleId);
        continue;
      }

      if (!predictRes?.actions?.length) {
        emitEvent(onEvent, bot.id, symbol, 'predict', 'fail', 'Predict returned empty actions[]', {
          regime,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          pipelineId,
        }, cycleId);
        continue;
      }

      let action = predictRes.actions[styleIndexForScope(pipeline.scope)] ?? predictRes.actions[0];
      const nnConf = predictRes.confidence ?? 0;
      const lowConfidenceNeutral = action === 2 && nnConf < 0.35;
      if (lowConfidenceNeutral) {
        const fallback = fallbackActionFromStrategies(bot, inst, symbol, bars, regimeState, signalCtx, nnConf);
        if (fallback) {
          action = fallback.action;
          emitEvent(onEvent, bot.id, symbol, 'predict', 'success', `Low-confidence neutral overridden by ${fallback.strategyId}`, {
            regime,
            regimeConfidence: confidence,
            nnConfidence: predictRes.confidence,
            scope: pipeline.scope,
            style: pipeline.style,
            timeframe: pipeline.timeframe,
            action,
            strategyId: fallback.strategyId,
            strategySignal: fallback.strategySignal,
            agreementCount: fallback.agreementCount,
            reason: 'low_confidence_neutral_strategy_fallback',
            pipelineId,
          }, cycleId);
        } else {
          emitEvent(onEvent, bot.id, symbol, 'predict', 'ignored', 'Weak neutral held — insufficient strategy agreement', {
            regime,
            regimeConfidence: confidence,
            nnConfidence: predictRes.confidence,
            scope: pipeline.scope,
            style: pipeline.style,
            timeframe: pipeline.timeframe,
            action: 2,
            reason: 'weak_neutral_no_strategy_consensus',
            pipelineId,
          }, cycleId);
        }
      }
      const currentPrice = bars[bars.length - 1]?.close ?? 0;
      const confForRank = anchorRegimeState ? anchorRegimeState.confidence : confidence;
      const candidateScore =
        pipeline.score +
        (predictRes.confidence ?? 0.5) +
        confForRank +
        (action === 2 ? -2 : 0);

      emitEvent(onEvent, bot.id, symbol, 'predict', 'success', `Predicted: ${actionLabels[action] ?? action}`, {
        regime,
        regimeConfidence: confidence,
        nnConfidence: predictRes.confidence,
        scope: pipeline.scope,
        style: pipeline.style,
        timeframe: pipeline.timeframe,
        fetchTimeframe: pipeline.timeframe,
        predictTimeframe: pipeline.timeframe,
        volatilityPct: volatilityPercent,
        regimeLookback: REGIME_LOOKBACK,
        action,
        score: candidateScore,
        pipelineId,
      }, cycleId);

      const existingForPipeline = getPortfolioState().positions.filter((p) =>
        p.instrumentId === inst.id && p.botId === bot.id && (p.scope ?? pipeline.scope) === pipeline.scope
      );
      const shouldCloseOnPrediction = (p: Position) =>
        action === 2 || (action === 0 && p.type === 'SHORT') || (action === 1 && p.type === 'LONG');
      for (const pos of existingForPipeline) {
        if (!shouldCloseOnPrediction(pos) || currentPrice <= 0) continue;
        if (inst.brokerId === 'broker-deriv') {
          emitEvent(onEvent, bot.id, symbol, 'close', 'skip', 'Deriv fixed-duration contract: waiting for expiry', {
            positionId: pos.id,
            reason: 'deriv_fixed_duration_no_early_close',
            action,
            scope: pipeline.scope,
            style: pipeline.style,
            timeframe: pipeline.timeframe,
            pipelineId,
          }, cycleId);
          continue;
        }
        const closeRes = await closeBrokerPosition({
          positionId: pos.id,
          instrumentId: pos.instrumentId,
          symbol: pos.instrument ?? symbol,
          type: pos.type,
          size: pos.size,
          brokerId: inst.brokerId,
          brokers,
        });
        if (!closeRes.success) {
          emitEvent(onEvent, bot.id, symbol, 'close', 'fail', closeRes.error ?? 'Close failed', {
            positionId: pos.id,
            reason: closeRes.error,
            action,
            scope: pipeline.scope,
            style: pipeline.style,
            timeframe: pipeline.timeframe,
            pipelineId,
          }, cycleId);
          continue;
        }
        const holdBars = Math.max(0, Math.round(
          (Date.now() - new Date(pos.openedAt).getTime()) / getBarDurationMs(pipeline.timeframe)
        ));
        const net = computeNetLivePnl({
          type: pos.type,
          size: pos.size,
          entryPrice: pos.entryPrice,
          exitPrice: currentPrice,
          holdBars,
          timeframe: pipeline.timeframe,
          instrumentType,
          exitReason: 'signal',
        }, { balanceAtEntry: pos.balanceAtEntry });
        onClosePosition?.({
          position: pos,
          exitPrice: currentPrice,
          pnl: net.netPnl,
          nnSlPct: pos.nnSlPct,
          nnTpR: pos.nnTpR,
          nnSizeMult: pos.nnSizeMult,
        });
        emitEvent(onEvent, bot.id, symbol, 'close', 'success', `Closed ${pos.type} on ${action === 2 ? 'NEUTRAL' : 'opposite'} (net P/L $${net.netPnl.toFixed(2)})`, {
          positionId: pos.id,
          exitPrice: currentPrice,
          pnl: net.netPnl,
          grossPnl: net.grossPnl,
          commission: net.costs.commission,
          swap: net.costs.swap,
          slippage: net.costs.slippage,
          holdBars,
          exitReason: 'signal',
          action,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          pipelineId,
        }, cycleId);
        if (onEmit) onEmit();
      }

      if (action === 2) {
        emitEvent(onEvent, bot.id, symbol, 'predict', 'ignored', 'Neutral signal — no trade', {
          regime,
          regimeConfidence: confidence,
          nnConfidence: predictRes.confidence,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          action: 2,
          pipelineId,
        }, cycleId);
        continue;
      }

      if (confidence < REGIME_CONFIDENCE_ENTRY_MIN) {
        emitEvent(onEvent, bot.id, symbol, 'predict', 'ignored', `Regime confidence too low (${(confidence * 100).toFixed(0)}% < ${REGIME_CONFIDENCE_ENTRY_MIN * 100}%) — skip entry`, {
          regime,
          regimeConfidence: confidence,
          scope: pipeline.scope,
          style: pipeline.style,
          timeframe: pipeline.timeframe,
          action,
          reason: 'low_regime_confidence',
          pipelineId,
        }, cycleId);
        continue;
      }

      const strategyId = predictRes?.strategy_id;
      const [baseStrategyId, ...paramParts] = (strategyId ?? '').split('|');
      const strategyParams: Record<string, number> | undefined =
        paramParts.length > 0
          ? paramParts.reduce<Record<string, number>>((acc, kv) => {
              const [k, v] = kv.split('=');
              const n = Number(v);
              if (k && Number.isFinite(n)) acc[k] = n;
              return acc;
            }, {})
          : undefined;
      const useStrategyConfirm =
        !bot.nnDetectionTimeframe &&
        (predictRes?.confidence ?? 0) >= 0.4 &&
        strategyId &&
        baseStrategyId &&
        bot.strategyIds?.includes(baseStrategyId);
      if (useStrategyConfirm) {
        const signalFn = getSignalFn(baseStrategyId, inst.id, symbol);
        const strategySignal = signalFn(bars, regimeState, bars.length - 1, strategyParams, signalCtx);
        const ens = ensembleDecision({
          nnAction: action,
          nnConfidence: predictRes?.confidence ?? 0.5,
          strategySignal,
          strategyReliability: 0.65,
          regimeConfidence: confidence,
          nnWeight: 0.6,
          minConfidence: 0.4,
        });
        if (ens.action === 'NEUTRAL') {
          emitEvent(onEvent, bot.id, symbol, 'predict', 'ignored', `Ensemble ${ens.reason} (NN→${action}, strategy→${strategySignal}, conf=${ens.confidence.toFixed(2)})`, {
            regime,
            strategyId,
            strategySignal,
            action,
            reason: ens.reason,
            scope: pipeline.scope,
            style: pipeline.style,
            timeframe: pipeline.timeframe,
            pipelineId,
          }, cycleId);
          continue;
        }
      }

      analyses.push({
        pipeline,
        bars,
        signalCtx,
        regimeState,
        predictRes,
        action,
        currentPrice,
        score: candidateScore,
      });
    }

    analyses.sort((a, b) => b.score - a.score);

    const instrumentTypeMap: Record<string, import('./types').InstrumentType> = {};
    for (const instEntry of instruments) {
      instrumentTypeMap[instEntry.id] = instEntry.type ?? 'fiat';
    }

    const openedSides = new Set<'LONG' | 'SHORT'>();

    for (const candidate of analyses) {
      const { pipeline, predictRes, currentPrice } = candidate;
      const { regime, confidence, volatilityPercent } = candidate.regimeState;
      const side = candidate.action === 0 ? ('LONG' as const) : ('SHORT' as const);
      const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
      const freshPortfolio = getPortfolioState();

      if (openedSides.has(opposite) || freshPortfolio.positions.some((p) => p.instrumentId === inst.id && p.botId === bot.id && p.type === opposite)) {
        emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', 'Opposite pipeline conflict', {
          side,
          scope: pipeline.scope,
          timeframe: pipeline.timeframe,
          reason: 'opposite_pipeline_conflict',
          pipelineId: `${cycleId}:${bot.id}:${pipeline.id}`,
        }, cycleId);
        continue;
      }

      const maxPerInstrument = getMaxPositionsPerInstrument(confidence, bot.maxPositions);
      const existingForInstrumentCount = freshPortfolio.positions.filter((p) => p.instrumentId === inst.id).length;
      if (existingForInstrumentCount >= maxPerInstrument) {
        emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', `Max ${maxPerInstrument} position(s) per instrument`, {
          side,
          scope: pipeline.scope,
          timeframe: pipeline.timeframe,
          equity: freshPortfolio.equity,
          reason: 'max_positions_instrument',
          maxPerInstrument,
          confidence,
          pipelineId: `${cycleId}:${bot.id}:${pipeline.id}`,
        }, cycleId);
        continue;
      }

      if (currentPrice <= 0) {
        emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', 'Invalid price', {
          scope: pipeline.scope,
          timeframe: pipeline.timeframe,
          reason: 'invalid_price',
        }, cycleId);
        continue;
      }

      const slPct = (predictRes?.sl_pct != null && predictRes.sl_pct > 0) ? predictRes.sl_pct : (bot.riskParams.defaultStopLossPct ?? 0.02);
      const stopLossPrice = side === 'LONG' ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);
      let pointSize: number;
      try {
        pointSize = inferPointSize(symbol, currentPrice);
      } catch {
        emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', `Unknown symbol for point size: ${symbol}. Use broker pip_size.`, {
          reason: 'unknown_symbol',
          scope: pipeline.scope,
          timeframe: pipeline.timeframe,
        }, cycleId);
        continue;
      }
      const pipValue = instrumentType === 'crypto' ? currentPrice * pointSize : 1;

      const riskResult = tryOpenPosition(
        freshPortfolio,
        bot.riskParams,
        inst.id,
        instrumentType,
        currentPrice,
        stopLossPrice,
        side,
        freshPortfolio.positions,
        {
          pipValuePerUnit: pipValue,
          regime,
          volatilityPct: volatilityPercent,
          warmupScale: getWarmupScaleFactor(bot),
          scope: pipeline.scope,
          utcHour,
          botId: bot.id,
          maxPositionsPerBot: bot.maxPositions,
          maxPositionsPerInstrument: maxPerInstrument,
          sizeMultiplier: predictRes?.size_multiplier,
          tpR: predictRes?.tp_r,
          targetDailyVolPct: 0.01,
          instrumentSymbol: symbol,
          instrumentTypes: instrumentTypeMap,
        }
      );

      if (!riskResult.allowed) {
        const reasonMsg = riskResult.ruleName ? `${riskResult.reason} [${riskResult.ruleName}]` : (riskResult.reason ?? 'Risk check rejected');
        emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', reasonMsg, {
          side,
          scope: pipeline.scope,
          timeframe: pipeline.timeframe,
          equity: freshPortfolio.equity,
          drawdownPct: freshPortfolio.drawdownPct ?? 0,
          reason: riskResult.reason,
          ruleId: riskResult.ruleId,
          ruleName: riskResult.ruleName,
          pipelineId: `${cycleId}:${bot.id}:${pipeline.id}`,
        }, cycleId);
        continue;
      }

      const size = riskResult.size ?? 0;
      if (size <= 0 || !Number.isFinite(size)) {
        emitEvent(onEvent, bot.id, symbol, 'risk_check', 'fail', 'Invalid position size', {
          side,
          scope: pipeline.scope,
          timeframe: pipeline.timeframe,
          reason: 'invalid_size',
        }, cycleId);
        continue;
      }

      const takeProfitPrice = riskResult.takeProfit ?? (side === 'LONG' ? currentPrice * (1 + slPct * 2) : currentPrice * (1 - slPct * 2));
      const orderResult = await placeBrokerOrder({
        instrumentId: inst.id,
        symbol,
        side,
        size,
        entryPrice: currentPrice,
        stopLoss: stopLossPrice,
        takeProfit: takeProfitPrice,
        brokerId: inst.brokerId,
        brokers,
        instrument: inst,
      });

      if (!orderResult.success) {
        emitEvent(onEvent, bot.id, symbol, 'order', 'fail', orderResult.error ?? 'Order failed', {
          side,
          size,
          scope: pipeline.scope,
          timeframe: pipeline.timeframe,
          reason: orderResult.error,
        }, cycleId);
        continue;
      }

      const brokerKey = orderResult.contractId != null
        ? `pos-deriv-${orderResult.contractId}-${Date.now()}`
        : orderResult.ticket != null
          ? `pos-mt5-${orderResult.ticket}`
          : `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const riskAmount = riskResult.riskAmount ?? (riskResult.stopLoss != null ? size * Math.abs(currentPrice - riskResult.stopLoss) : size * currentPrice * 0.02);
      const openedVolume = orderResult.volume ?? size;
      const balanceAtEntry = freshPortfolio.balance > 0 ? freshPortfolio.balance : freshPortfolio.equity;

      addPosition(
        {
          instrumentId: inst.id,
          instrument: symbol,
          type: side,
          size: openedVolume,
          entryPrice: currentPrice,
          currentPrice,
          pnl: 0,
          pnlPercent: 0,
          scope: pipeline.scope,
          style: pipeline.style,
          botId: bot.id,
          stopLoss: riskResult.stopLoss ?? stopLossPrice,
          takeProfit: takeProfitPrice,
          riskAmount,
          openedAt: new Date().toISOString(),
          balanceAtEntry: balanceAtEntry > 0 ? balanceAtEntry : undefined,
          nnSlPct: predictRes?.sl_pct,
          nnTpR: predictRes?.tp_r,
          nnSizeMult: predictRes?.size_multiplier,
        },
        { id: brokerKey }
      );
      openedSides.add(side);

      logTradeEvent({
        kind: 'trade_open',
        positionId: brokerKey,
        brokerKey: orderResult.contractId != null ? String(orderResult.contractId) : orderResult.ticket != null ? String(orderResult.ticket) : undefined,
        instrumentId: inst.id,
        symbol,
        type: side,
        size,
        entryPrice: currentPrice,
        botId: bot.id,
        scope: pipeline.scope,
        timestamp: new Date().toISOString(),
      });

      emitEvent(onEvent, bot.id, symbol, 'order', 'success', `Opened ${side} ${size.toFixed(4)} @ ${currentPrice}`, {
        side,
        size,
        scope: pipeline.scope,
        style: pipeline.style,
        timeframe: pipeline.timeframe,
        entryPrice: currentPrice,
        exitPrice: takeProfitPrice,
        volatilityPct: volatilityPercent,
        regimeLookback: REGIME_LOOKBACK,
        positionId: brokerKey,
        pipelineId: `${cycleId}:${bot.id}:${pipeline.id}`,
        score: candidate.score,
      }, cycleId);
      if (onEmit) onEmit();
    }
  }
  /* v8 ignore stop */
}

/** Interval (ms) for position-only evaluation loop. Runs more frequently than entry tick. */
export const POSITION_EVAL_INTERVAL_MS = 8_000;

export interface PositionEvalParams {
  bots: BotConfig[];
  instruments: Instrument[];
  brokers: BrokerConfig[];
  executionEnabled: boolean;
  closedTradesByBot?: Record<string, ClosedTrade[]>;
  onEmit?: () => void;
  onEvent?: (event: Omit<BotExecutionEvent, 'id' | 'timestamp'>) => void;
  onClosePosition?: (params: { position: Position; exitPrice: number; pnl: number; nnSlPct?: number; nnTpR?: number; nnSizeMult?: number }) => void;
}

/**
 * Position-only evaluation: fetch OHLCV, predict for each open position's instrument,
 * close if NN predicts NEUTRAL or opposite. No entry logic. Runs at POSITION_EVAL_INTERVAL_MS.
 */
export async function runPositionEvaluation(params: PositionEvalParams): Promise<void> {
  const { bots, instruments, brokers, executionEnabled, onEmit, onEvent } = params;
  const closedTradesByBot = params.closedTradesByBot ?? {};
  if (!executionEnabled) return;

  const portfolio = getPortfolioState();
  if (portfolio.positions.length === 0) return;

  const deployedBots = bots.filter((b) => b.status === 'deployed' && b.nnFeatureVector && b.nnFeatureVector.length >= 32 && b.nnFeatureVector.length <= 512);
  if (deployedBots.length === 0) return;

  const cycleId = `pos-eval-${Date.now()}`;

  for (const pos of portfolio.positions) {
    if (!pos.botId) continue;
    const bot = deployedBots.find((b) => b.id === pos.botId);
    if (!bot) continue;
    const inst = instruments.find((i) => i.id === pos.instrumentId);
    if (!inst || inst.status !== 'active') continue;

    const symbol = inst.symbol ?? inst.id.replace(/^inst-/, '').toUpperCase().replace(/-/g, '/');
    const posScope = pos.scope ?? 'day';
    const tf = bot.timeframes.find((t) => (TIMEFRAME_TO_SCOPE[t] ?? 'day') === posScope);
    if (!tf) {
      emitEvent(onEvent, bot.id, symbol, 'skipped', 'Position scope has no selected timeframe', {
        scope: posScope,
        reason: 'position_scope_timeframe_missing',
      }, cycleId);
      continue;
    }

    let bars: OHLCVBar[] = [];
    try {
      const barWindowSize = bot.nnDetectionModels?.[tf]?.barWindow ?? bot.nnDetectionBarWindow ?? 60;
      const fetchCount = Math.max(100, barWindowSize + 20);
      const { bars: fetched } = await fetchOHLCV({
        instrumentId: inst.id,
        symbol,
        brokerId: inst.brokerId,
        timeframe: tf,
        brokers,
        activity: 'live',
        count: fetchCount,
      });
      bars = fetched;
    } catch {
      continue;
    }
    if (bars.length < 50) continue;

    const { regime, confidence, volatilityPercent } = detectRegime(bars, REGIME_LOOKBACK);
    const instrumentType = inst.type ?? 'fiat';

    const closedTrades = closedTradesByBot[bot.id] ?? [];
    const closedTradesForPredict = closedTrades.slice(-50).map((t) => ({ pnl: t.pnl }));
    const barWindowSize = bot.nnDetectionBarWindow ?? 60;
    const barWindow = bars.length >= barWindowSize
      ? bars.slice(-barWindowSize).map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, time: b.time }))
      : undefined;
    let predictRes: { actions?: number[] } | null = null;
    try {
      predictRes = await postPredict({
        instrument_id: bot.instrumentId,
        feature_vector: bot.nnFeatureVector!,
        instrument_type: instrumentType,
        regime,
        timeframe: tf,
        scope: posScope,
        closed_trades: closedTradesForPredict.length >= 3 ? closedTradesForPredict : undefined,
        volatility_pct: volatilityPercent,
        regime_confidence: confidence,
        bar_window: barWindow,
      });
    } catch {
      continue;
    }
    if (predictRes == null) continue;
    if (!predictRes.actions?.length) continue;

    const styleIndex = posScope === 'scalp' ? 0 : posScope === 'day' ? 1 : posScope === 'swing' ? 2 : 3;
    const action = predictRes.actions[styleIndex] ?? predictRes.actions[0];
    const shouldClose = action === 2 || (action === 0 && pos.type === 'SHORT') || (action === 1 && pos.type === 'LONG');
    if (!shouldClose) continue;

    const currentPrice = bars[bars.length - 1]?.close ?? 0;
    if (currentPrice <= 0) continue;

    const closeRes = await closeBrokerPosition({
      positionId: pos.id,
      instrumentId: pos.instrumentId,
      symbol: pos.instrument ?? inst.symbol ?? pos.instrumentId,
      type: pos.type,
      size: pos.size,
      brokerId: inst.brokerId,
      brokers,
    });
    if (!closeRes.success) {
      emitEvent(onEvent, bot.id, symbol, 'close', 'fail', closeRes.error ?? 'Close failed', { positionId: pos.id, reason: closeRes.error, action }, cycleId);
      continue;
    }
    const closeTf = (bot.timeframes[0] ?? 'M5') as Timeframe;
    const holdBars = Math.max(0, Math.round((Date.now() - new Date(pos.openedAt).getTime()) / getBarDurationMs(closeTf)));
    const net = computeNetLivePnl({
      type: pos.type,
      size: pos.size,
      entryPrice: pos.entryPrice,
      exitPrice: currentPrice,
      holdBars,
      timeframe: closeTf,
      instrumentType,
      exitReason: 'signal',
    }, { balanceAtEntry: pos.balanceAtEntry });
    params.onClosePosition?.({
      position: pos,
      exitPrice: currentPrice,
      pnl: net.netPnl,
      nnSlPct: pos.nnSlPct,
      nnTpR: pos.nnTpR,
      nnSizeMult: pos.nnSizeMult,
    });
    emitEvent(onEvent, bot.id, symbol, 'close', 'success', `Closed ${pos.type} on ${action === 2 ? 'NEUTRAL' : 'opposite'} — net $${net.netPnl.toFixed(2)} (gross $${net.grossPnl.toFixed(2)})`, {
      positionId: pos.id,
      exitPrice: currentPrice,
      pnl: net.netPnl,
      grossPnl: net.grossPnl,
      commission: net.costs.commission,
      swap: net.costs.swap,
      slippage: net.costs.slippage,
      holdBars,
      exitReason: 'signal',
      action,
    }, cycleId);
    if (onEmit) onEmit();
  }
}
