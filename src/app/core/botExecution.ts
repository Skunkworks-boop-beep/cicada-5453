/**
 * Bot execution: evaluate deployed bots, call NN predict, open positions via tryOpenPosition + placeBrokerOrder + addPosition.
 * Runs when execution.enabled; uses risk management for every position open.
 */

import type { BotConfig, BrokerConfig, ClosedTrade, Instrument, Position, TradeScope, TradeStyle, Timeframe } from './types';
import type { OHLCVBar } from './ohlcv';
import { DEFAULT_SCOPE_SELECTOR_CONFIG } from './types';
import { detectRegime } from './regimes';
import { postPredict } from './api';
import { addPosition, getPortfolioState, positionPnl } from './portfolio';
import { tryOpenPosition } from './risk';
import { getWarmupScaleFactor } from './bot';
import { logTradeEvent } from './tradeLogger';
import { placeBrokerOrder, closeBrokerPosition } from './brokerExecution';
import { fetchOHLCV } from './ohlcvFeed';
import { buildHtfIndexForEachLtfBar, getHigherTimeframe } from './multiTimeframe';
import type { SignalContext } from './signals';
import { inferPointSize } from './spreadUtils';
import { getTimeframesForScope, STYLE_TO_SCOPE } from './scope';
import { getSignalFn } from './signals';

/** Regime detection lookback (bars). Used for volatility/trend; must match detectRegime. */
const REGIME_LOOKBACK = 50;

/** Skip new entries when regime confidence below this (avoids trading in ambiguous regimes). */
const REGIME_CONFIDENCE_ENTRY_MIN = 0.35;

/** Max positions per instrument based on regime confidence. Higher confidence → more entries allowed. */
function getMaxPositionsPerInstrument(confidence: number): number {
  const cfg = DEFAULT_SCOPE_SELECTOR_CONFIG;
  if (confidence >= cfg.confidenceForThirdEntry) return Math.min(3, cfg.maxPositionsPerInstrument);
  if (confidence >= cfg.confidenceForSecondEntry) return Math.min(2, cfg.maxPositionsPerInstrument);
  return 1;
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
  | 'skipped';

export type BotExecutionEventOutcome = 'success' | 'fail' | 'skip' | 'ignored';

export interface BotExecutionEventDetails {
  /** Unique id for this execution run; events from the same tick share this. */
  cycleId?: string;
  regime?: string;
  regimeConfidence?: number;
  scope?: string;
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
    const primaryTf = bot.timeframes[0] ?? 'M5';
    const tfForFetch = bot.nnDetectionTimeframe ?? primaryTf;

    let bars: OHLCVBar[] = [];
    try {
      const barWindowSize = bot.nnDetectionBarWindow ?? 60;
      const fetchCount = Math.max(100, barWindowSize + 20);
      const { bars: fetched } = await fetchOHLCV({
        instrumentId: inst.id,
        symbol,
        brokerId: inst.brokerId,
        timeframe: tfForFetch,
        brokers,
        activity: 'live',
        count: fetchCount,
      });
      bars = fetched;
      emitEvent(onEvent, bot.id, symbol, 'fetch_ohlcv', 'success', `Fetched ${bars.length} bars`, { barsCount: bars.length }, cycleId);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      emitEvent(onEvent, bot.id, symbol, 'fetch_ohlcv', 'fail', `OHLCV fetch failed: ${errMsg}`, { reason: errMsg });
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[botExecution] OHLCV fetch failed for bot ${bot.id} (${inst.symbol}):`, e);
      }
      continue;
    }

    if (bars.length < 50) {
      emitEvent(onEvent, bot.id, symbol, 'fetch_ohlcv', 'skip', 'Insufficient bars (< 50)', { reason: 'insufficient_bars' }, cycleId);
      continue;
    }

    const barWindowSizeForHtf = bot.nnDetectionBarWindow ?? 60;
    const fetchCountHtf = Math.max(100, barWindowSizeForHtf + 20);
    let signalCtx: SignalContext | undefined;
    const htfTf = getHigherTimeframe(tfForFetch as Timeframe);
    if (htfTf) {
      try {
        const { bars: htfBars } = await fetchOHLCV({
          instrumentId: inst.id,
          symbol,
          brokerId: inst.brokerId,
          timeframe: htfTf,
          brokers,
          activity: 'live',
          count: fetchCountHtf,
        });
        if (htfBars.length >= 2) {
          signalCtx = {
            htfBars,
            htfIndexByLtfBar: buildHtfIndexForEachLtfBar(bars, htfBars),
            htfTimeframe: htfTf,
            ltfTimeframe: tfForFetch as Timeframe,
          };
        }
      } catch {
        /* HTF optional — strategy signals fall back to single-series proxy */
      }
    }

    const regimeState = detectRegime(bars, REGIME_LOOKBACK);
    const { regime, confidence, volatilityPercent } = regimeState;
    const instrumentType = inst.type ?? 'fiat';

    const scope = selectScopeForTick(bot, {
      equity: portfolio.equity,
      drawdownPct: portfolio.drawdownPct ?? 0,
      regime,
      regimeConfidence: confidence,
      volatilityPercent,
      utcHour,
      utcDay,
      existingPositionsCount: portfolio.positions.filter((p) => p.botId === bot.id).length,
    });

    if (scope == null) {
      emitEvent(onEvent, bot.id, symbol, 'select_scope', 'skip', 'Scope paused (drawdown, time, or config)', {
        regime,
        regimeConfidence: confidence,
        volatilityPct: volatilityPercent,
        regimeLookback: REGIME_LOOKBACK,
        equity: portfolio.equity,
        drawdownPct: portfolio.drawdownPct ?? 0,
        reason: 'scope_paused',
      }, cycleId);
      continue;
    }

    emitEvent(onEvent, bot.id, symbol, 'select_scope', 'success', `Scope: ${scope}`, {
      regime,
      regimeConfidence: confidence,
      volatilityPct: volatilityPercent,
      regimeLookback: REGIME_LOOKBACK,
      scope,
      equity: portfolio.equity,
      drawdownPct: portfolio.drawdownPct ?? 0,
    }, cycleId);

    const scopeTfs = getTimeframesForScope(scope);
    const tf = scopeTfs.find((t) => bot.timeframes.includes(t)) ?? scopeTfs[0] ?? primaryTf;

    const closedTrades = closedTradesByBot[bot.id] ?? [];
    const closedTradesForPredict = closedTrades.slice(-50).map((t) => ({ pnl: t.pnl }));
    const barWindowSize = bot.nnDetectionBarWindow ?? 60;
    const barWindow = bars.length >= barWindowSize
      ? bars.slice(-barWindowSize).map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, time: b.time }))
      : undefined;
    let predictRes: { actions?: number[]; confidence?: number; size_multiplier?: number; sl_pct?: number; tp_r?: number } | null = null;
    try {
      predictRes = await postPredict({
        instrument_id: bot.instrumentId,
        feature_vector: bot.nnFeatureVector!,
        instrument_type: instrumentType,
        regime,
        timeframe: tf,
        scope,
        closed_trades: closedTradesForPredict.length >= 3 ? closedTradesForPredict : undefined,
        volatility_pct: volatilityPercent,
        regime_confidence: confidence,
        bar_window: barWindow,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      emitEvent(onEvent, bot.id, symbol, 'predict', 'fail', `Predict API failed: ${errMsg}`, { regime, reason: errMsg }, cycleId);
      continue;
    }

    if (predictRes == null) {
      emitEvent(
        onEvent,
        bot.id,
        symbol,
        'predict',
        'fail',
        'POST /predict failed (see console [api] postPredict). Common: HTTP 400 if detection model needs more bars (bar_window < nnDetectionBarWindow), or 503 if no checkpoint for this instrument.',
        { regime, barWindowLen: barWindow?.length ?? 0, nnDetectionBarWindow: bot.nnDetectionBarWindow ?? 60 },
        cycleId
      );
      continue;
    }

    if (!predictRes.actions?.length) {
      emitEvent(onEvent, bot.id, symbol, 'predict', 'fail', 'Predict returned empty actions[]', { regime }, cycleId);
      continue;
    }

    const styleIndex = scope === 'scalp' ? 0 : scope === 'day' ? 1 : scope === 'swing' ? 2 : 3;
    const action = predictRes.actions[styleIndex] ?? predictRes.actions[0];
    const actionLabels = ['LONG', 'SHORT', 'NEUTRAL'];
    emitEvent(onEvent, bot.id, symbol, 'predict', 'success', `Predicted: ${actionLabels[action] ?? action}`, {
      regime,
      regimeConfidence: confidence,
      scope,
      timeframe: tf,
      volatilityPct: volatilityPercent,
      regimeLookback: REGIME_LOOKBACK,
      action,
    }, cycleId);

    const currentPrice = bars[bars.length - 1]?.close ?? 0;
    const existingForInstrument = portfolio.positions.filter((p) => p.instrumentId === inst.id && p.botId === bot.id);
    const shouldCloseOnPrediction = (p: Position) =>
      action === 2 || (action === 0 && p.type === 'SHORT') || (action === 1 && p.type === 'LONG');

    for (const pos of existingForInstrument) {
      if (!shouldCloseOnPrediction(pos)) continue;
      if (currentPrice <= 0) continue;
      const instForPos = instruments.find((i) => i.id === pos.instrumentId);
      if (!instForPos) continue;
      const closeRes = await closeBrokerPosition({
        positionId: pos.id,
        instrumentId: pos.instrumentId,
        symbol: pos.instrument ?? instForPos.symbol ?? pos.instrumentId,
        type: pos.type,
        size: pos.size,
        brokerId: instForPos.brokerId,
        brokers,
      });
      if (!closeRes.success) {
        emitEvent(onEvent, bot.id, symbol, 'close', 'fail', closeRes.error ?? 'Close failed', {
          positionId: pos.id,
          reason: closeRes.error,
          action,
        }, cycleId);
        continue;
      }
      const { pnl } = positionPnl(pos.type, pos.size, pos.entryPrice, currentPrice);
      onClosePosition?.({
        position: pos,
        exitPrice: currentPrice,
        pnl,
        nnSlPct: pos.nnSlPct,
        nnTpR: pos.nnTpR,
        nnSizeMult: pos.nnSizeMult,
      });
      emitEvent(onEvent, bot.id, symbol, 'close', 'success', `Closed ${pos.type} on ${action === 2 ? 'NEUTRAL' : 'opposite'} prediction`, {
        positionId: pos.id,
        exitPrice: currentPrice,
        pnl,
        action,
      }, cycleId);
      if (onEmit) onEmit();
    }

    if (action === 2) {
      emitEvent(onEvent, bot.id, symbol, 'predict', 'ignored', 'Neutral signal — no trade', {
        regime,
        regimeConfidence: confidence,
        scope,
        timeframe: tf,
        action: 2,
      }, cycleId);
      continue;
    }

    if (confidence < REGIME_CONFIDENCE_ENTRY_MIN) {
      emitEvent(onEvent, bot.id, symbol, 'predict', 'ignored', `Regime confidence too low (${(confidence * 100).toFixed(0)}% < ${REGIME_CONFIDENCE_ENTRY_MIN * 100}%) — skip entry`, {
        regime,
        regimeConfidence: confidence,
        scope,
        timeframe: tf,
        action,
        reason: 'low_regime_confidence',
      }, cycleId);
      continue;
    }

    // Strategy selection: when NN returns strategy_id with sufficient confidence, require strategy signal to confirm.
    // Skip for detection models (nnDetectionTimeframe): NN already recognizes the strategy from bars.
    const STRATEGY_CONFIDENCE_MIN = 0.4;
    const strategyId = predictRes?.strategy_id;
    const baseStrategyId = strategyId?.split('|')[0];
    const useStrategyConfirm =
      !bot.nnDetectionTimeframe &&
      (predictRes?.confidence ?? 0) >= STRATEGY_CONFIDENCE_MIN &&
      strategyId &&
      baseStrategyId &&
      bot.strategyIds?.includes(baseStrategyId);
    if (useStrategyConfirm) {
      const signalFn = getSignalFn(baseStrategyId, inst.id, symbol);
      const lastIdx = bars.length - 1;
      const strategySignal = signalFn(bars, regimeState, lastIdx, undefined, signalCtx);
      const expectedSignal = action === 0 ? 1 : -1;
      if (strategySignal !== expectedSignal) {
        emitEvent(onEvent, bot.id, symbol, 'predict', 'ignored', `Strategy ${strategyId} signal ${strategySignal} does not confirm ${action === 0 ? 'LONG' : 'SHORT'}`, {
          regime,
          strategyId,
          strategySignal,
          expectedSignal,
          action,
        }, cycleId);
        continue;
      }
    }

    const style: TradeStyle = scope === 'scalp' ? 'scalping' : scope === 'day' ? 'day' : scope === 'swing' ? 'swing' : 'position';
    const side = action === 0 ? ('LONG' as const) : ('SHORT' as const);
    const maxPerInstrument = getMaxPositionsPerInstrument(confidence);
    const existingForInstrumentCount = portfolio.positions.filter((p) => p.instrumentId === inst.id).length;
    if (existingForInstrumentCount >= maxPerInstrument) {
      emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', `Max ${maxPerInstrument} position(s) per instrument (confidence ${(confidence * 100).toFixed(0)}%)`, {
        side,
        scope,
        equity: portfolio.equity,
        reason: 'max_positions_instrument',
        maxPerInstrument,
        confidence,
      }, cycleId);
      continue;
    }

    if (currentPrice <= 0) {
      emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', 'Invalid price', { scope, reason: 'invalid_price' }, cycleId);
      continue;
    }

    const slPct = (predictRes?.sl_pct != null && predictRes.sl_pct > 0) ? predictRes.sl_pct : (bot.riskParams.defaultStopLossPct ?? 0.02);
    const stopLossPrice =
      side === 'LONG' ? currentPrice * (1 - slPct) : currentPrice * (1 + slPct);

    let pointSize: number;
    try {
      pointSize = inferPointSize(symbol, currentPrice);
    } catch (e) {
      emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', `Unknown symbol for point size: ${symbol}. Use broker pip_size.`, { reason: 'unknown_symbol' }, cycleId);
      continue;
    }
    const pipValue = instrumentType === 'crypto' ? currentPrice * pointSize : 1;

    const riskResult = tryOpenPosition(
      portfolio,
      bot.riskParams,
      inst.id,
      instrumentType,
      currentPrice,
      stopLossPrice,
      side,
      portfolio.positions,
      {
        pipValuePerUnit: pipValue,
        regime,
        volatilityPct: volatilityPercent,
        warmupScale: getWarmupScaleFactor(bot),
        scope,
        utcHour,
        botId: bot.id,
        maxPositionsPerBot: bot.maxPositions,
        maxPositionsPerInstrument: maxPerInstrument,
        sizeMultiplier: predictRes?.size_multiplier,
        tpR: predictRes?.tp_r,
      }
    );

    if (!riskResult.allowed) {
      const reasonMsg = riskResult.ruleName
        ? `${riskResult.reason} [${riskResult.ruleName}]`
        : (riskResult.reason ?? 'Risk check rejected');
      emitEvent(onEvent, bot.id, symbol, 'risk_check', 'skip', reasonMsg, {
        side,
        scope,
        equity: portfolio.equity,
        drawdownPct: portfolio.drawdownPct ?? 0,
        reason: riskResult.reason,
        ruleId: riskResult.ruleId,
        ruleName: riskResult.ruleName,
      }, cycleId);
      continue;
    }

    const size = riskResult.size ?? 0;
    if (size <= 0 || !Number.isFinite(size)) {
      emitEvent(onEvent, bot.id, symbol, 'risk_check', 'fail', 'Invalid position size', { side, scope, reason: 'invalid_size' }, cycleId);
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
      emitEvent(onEvent, bot.id, symbol, 'order', 'fail', orderResult.error ?? 'Order failed', { side, size, scope, reason: orderResult.error }, cycleId);
      continue;
    }

    const brokerKey = orderResult.contractId != null
      ? `pos-deriv-${orderResult.contractId}-${Date.now()}`
      : orderResult.ticket != null
        ? `pos-mt5-${orderResult.ticket}`
        : `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const riskAmount = riskResult.riskAmount ?? (riskResult.stopLoss != null ? size * Math.abs(currentPrice - riskResult.stopLoss) : size * currentPrice * 0.02);

    const openedVolume = orderResult.volume ?? size;
    const balanceAtEntry = portfolio.balance > 0 ? portfolio.balance : portfolio.equity;
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
        scope,
        style,
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
      scope,
      timestamp: new Date().toISOString(),
    });

    emitEvent(onEvent, bot.id, symbol, 'order', 'success', `Opened ${side} ${size.toFixed(4)} @ ${currentPrice}`, {
      side,
      size,
      scope,
      entryPrice: currentPrice,
      exitPrice: takeProfitPrice,
      volatilityPct: volatilityPercent,
      regimeLookback: REGIME_LOOKBACK,
      positionId: brokerKey,
    }, cycleId);
    if (onEmit) onEmit();
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
    const primaryTf = bot.timeframes[0] ?? 'M5';
    const tfForFetch = bot.nnDetectionTimeframe ?? primaryTf;

    let bars: OHLCVBar[] = [];
    try {
      const barWindowSize = bot.nnDetectionBarWindow ?? 60;
      const fetchCount = Math.max(100, barWindowSize + 20);
      const { bars: fetched } = await fetchOHLCV({
        instrumentId: inst.id,
        symbol,
        brokerId: inst.brokerId,
        timeframe: tfForFetch,
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
    const scopeTfs = getTimeframesForScope(pos.scope ?? 'day');
    const tf = scopeTfs.find((t) => bot.timeframes.includes(t)) ?? scopeTfs[0] ?? primaryTf;

    const closedTrades = closedTradesByBot[bot.id] ?? [];
    const closedTradesForPredict = closedTrades.slice(-50).map((t) => ({ pnl: t.pnl }));
    const barWindowSize = bot.nnDetectionBarWindow ?? 60;
    const barWindow = bars.length >= barWindowSize
      ? bars.slice(-barWindowSize).map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, time: b.time }))
      : undefined;
    const posScope = pos.scope ?? 'day';
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
    const { pnl } = positionPnl(pos.type, pos.size, pos.entryPrice, currentPrice);
    params.onClosePosition?.({
      position: pos,
      exitPrice: currentPrice,
      pnl,
      nnSlPct: pos.nnSlPct,
      nnTpR: pos.nnTpR,
      nnSizeMult: pos.nnSizeMult,
    });
    emitEvent(onEvent, bot.id, symbol, 'close', 'success', `Closed ${pos.type} on ${action === 2 ? 'NEUTRAL' : 'opposite'} (position eval)`, {
      positionId: pos.id,
      exitPrice: currentPrice,
      pnl,
      action,
    }, cycleId);
    if (onEmit) onEmit();
  }
}
