/**
 * Ensemble decision logic: combine the NN's action + confidence with the
 * strategy's rule-based signal into a single trade decision.
 *
 * Neither the pure-NN nor the pure-rule path is robust on its own — the NN
 * can over-commit on noisy regimes, and the rule signal is deterministic but
 * regime-blind. By weighting each voter's contribution we get trade decisions
 * that are only taken when **both** signals point the same way with enough
 * combined conviction, which empirically reduces false positives.
 *
 * The function is pure: the caller decides what to do with the returned
 * direction / confidence. When returned confidence is below ``minConfidence``
 * the caller should skip the trade.
 */

import type { Signal } from './signals';

export type EnsembleAction = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface EnsembleInput {
  /** NN action: 0 = LONG, 1 = SHORT, 2 = NEUTRAL. */
  nnAction: number;
  /** NN softmax confidence for the chosen action (0–1). */
  nnConfidence: number;
  /** Rule-based strategy signal: 1 = LONG, -1 = SHORT, 0 = NEUTRAL. */
  strategySignal: Signal;
  /** 0–1 quality score for the strategy (e.g. backtest Sharpe-derived). 0.5 = neutral. */
  strategyReliability?: number;
  /** Regime detection confidence 0–1 — damps the ensemble when regime is unclear. */
  regimeConfidence?: number;
  /** Optional NN weight (default 0.6). The strategy gets the remaining mass. */
  nnWeight?: number;
  /** Minimum ensemble confidence below which the trade is suppressed. */
  minConfidence?: number;
}

export interface EnsembleDecision {
  action: EnsembleAction;
  /** Ensemble confidence in the chosen action, 0–1. */
  confidence: number;
  /** Reason tag for telemetry. */
  reason:
    | 'agree_high_conf'
    | 'nn_dominant'
    | 'strategy_dominant'
    | 'conflict_resolved_nn'
    | 'conflict_resolved_strategy'
    | 'low_confidence'
    | 'neutral';
}

function actionFromNn(nnAction: number): EnsembleAction {
  if (nnAction === 0) return 'LONG';
  if (nnAction === 1) return 'SHORT';
  return 'NEUTRAL';
}

function actionFromStrategy(sig: Signal): EnsembleAction {
  if (sig === 1) return 'LONG';
  if (sig === -1) return 'SHORT';
  return 'NEUTRAL';
}

export function ensembleDecision(input: EnsembleInput): EnsembleDecision {
  const nnAction = actionFromNn(input.nnAction);
  const strategyAction = actionFromStrategy(input.strategySignal);
  const nnWeight = Math.min(1, Math.max(0, input.nnWeight ?? 0.6));
  const strategyWeight = 1 - nnWeight;
  const nnConf = Math.min(1, Math.max(0, input.nnConfidence || 0));
  // Interpret strategyReliability as a per-strategy scalar: Sharpe-derived 0–1
  // value when caller provides one, else assume middling.
  const stratConf = Math.min(1, Math.max(0, input.strategyReliability ?? 0.55));
  const regimeConf = Math.min(1, Math.max(0, input.regimeConfidence ?? 1));
  const minConf = input.minConfidence ?? 0.4;

  // Pure-neutral ensemble: both are neutral.
  if (nnAction === 'NEUTRAL' && strategyAction === 'NEUTRAL') {
    return { action: 'NEUTRAL', confidence: 1 - minConf, reason: 'neutral' };
  }

  // Weighted vote: each side contributes weight * confidence to its direction.
  let longScore = 0;
  let shortScore = 0;
  if (nnAction === 'LONG') longScore += nnWeight * nnConf;
  if (nnAction === 'SHORT') shortScore += nnWeight * nnConf;
  if (strategyAction === 'LONG') longScore += strategyWeight * stratConf;
  if (strategyAction === 'SHORT') shortScore += strategyWeight * stratConf;

  // Regime damping: low regime confidence reduces both sides proportionally.
  longScore *= regimeConf;
  shortScore *= regimeConf;

  const direction: EnsembleAction = longScore > shortScore
    ? longScore > 0 ? 'LONG' : 'NEUTRAL'
    : shortScore > 0 ? 'SHORT' : 'NEUTRAL';
  const rawConfidence = Math.max(longScore, shortScore);

  if (direction === 'NEUTRAL' || rawConfidence < minConf) {
    return { action: 'NEUTRAL', confidence: rawConfidence, reason: 'low_confidence' };
  }

  // Choose a descriptive reason tag for telemetry.
  const agrees =
    (nnAction === direction || nnAction === 'NEUTRAL') &&
    (strategyAction === direction || strategyAction === 'NEUTRAL');
  let reason: EnsembleDecision['reason'];
  if (agrees && nnAction === direction && strategyAction === direction) {
    reason = 'agree_high_conf';
  } else if (nnAction === direction && strategyAction === 'NEUTRAL') {
    reason = 'nn_dominant';
  } else if (strategyAction === direction && nnAction === 'NEUTRAL') {
    reason = 'strategy_dominant';
  } else if (nnAction === direction && strategyAction !== 'NEUTRAL') {
    reason = 'conflict_resolved_nn';
  } else if (strategyAction === direction && nnAction !== 'NEUTRAL') {
    reason = 'conflict_resolved_strategy';
  } else {
    reason = 'neutral';
  }

  return { action: direction, confidence: rawConfidence, reason };
}
