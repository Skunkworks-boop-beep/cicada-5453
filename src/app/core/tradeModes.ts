/**
 * Canonical trade-mode rules (TS mirror of python/cicada_nn/trade_modes.py).
 *
 * Single source of truth for the five trade styles. The Python and TS tables
 * are kept identical by `scripts/verify-trade-mode-parity.ts`, run via
 * `npm run verify-all`.
 *
 * If you change a number here, change it in `trade_modes.py` too. Otherwise
 * the parity script will fail in CI.
 */

import type { TradeStyle } from './types';

export type SLManagement =
  | 'static'
  | 'trail_after_1r'
  | 'be_then_trail'
  | 'trail_from_entry';

export type TPManagement =
  | 'fixed'
  | 'partial_1r_rest_tp'
  | 'partial_1r_rest_2r';

export interface TradeModeRules {
  style: TradeStyle;
  timeframes: readonly string[];
  minHoldBars: number;
  minTpAtr: number;
  minSlAtr: number;
  maxSlAtr: number;
  slManagement: SLManagement;
  tpManagement: TPManagement;
  entryConfirmation: string;
  exitTrigger: string;
  maxConcurrent: number;
  confidenceThreshold: number;
  mt5Magic: number;
}

export const TRADE_MODES: Record<TradeStyle, TradeModeRules> = {
  scalping: {
    style: 'scalping',
    timeframes: ['M1', 'M5'],
    minHoldBars: 3,
    minTpAtr: 0.5,
    minSlAtr: 0.3,
    maxSlAtr: 1.0,
    slManagement: 'static',
    tpManagement: 'fixed',
    entryConfirmation: 'PA + map zone',
    exitTrigger: 'TP/SL/reversal after min hold',
    maxConcurrent: 3,
    confidenceThreshold: 0.6,
    mt5Magic: 1001,
  },
  day: {
    style: 'day',
    timeframes: ['M15', 'M30', 'H1'],
    minHoldBars: 6,
    minTpAtr: 1.0,
    minSlAtr: 0.6,
    maxSlAtr: 2.0,
    slManagement: 'trail_after_1r',
    tpManagement: 'partial_1r_rest_tp',
    entryConfirmation: 'PA + map zone + 1 indicator',
    exitTrigger: 'TP/SL/regime break',
    maxConcurrent: 2,
    confidenceThreshold: 0.65,
    mt5Magic: 1002,
  },
  medium_swing: {
    style: 'medium_swing',
    timeframes: ['H1', 'H4'],
    minHoldBars: 8,
    minTpAtr: 1.5,
    minSlAtr: 0.8,
    maxSlAtr: 3.0,
    slManagement: 'be_then_trail',
    tpManagement: 'partial_1r_rest_2r',
    entryConfirmation: 'Map zone + momentum',
    exitTrigger: 'TP/SL/structure break',
    maxConcurrent: 2,
    confidenceThreshold: 0.7,
    mt5Magic: 1003,
  },
  swing: {
    style: 'swing',
    timeframes: ['H4', 'D1'],
    minHoldBars: 12,
    minTpAtr: 2.0,
    minSlAtr: 1.0,
    maxSlAtr: 4.0,
    slManagement: 'be_then_trail',
    tpManagement: 'partial_1r_rest_2r',
    entryConfirmation: 'Map zone + momentum + structure',
    exitTrigger: 'TP/SL/structure break',
    maxConcurrent: 2,
    confidenceThreshold: 0.7,
    mt5Magic: 1004,
  },
  sniper: {
    style: 'sniper',
    timeframes: ['M15', 'M30', 'H1'],
    minHoldBars: 6,
    minTpAtr: 1.5,
    minSlAtr: 0.8,
    maxSlAtr: 2.5,
    slManagement: 'trail_from_entry',
    tpManagement: 'fixed',
    entryConfirmation: '2+ S/R confluence + map zone',
    exitTrigger: 'TP or SL only',
    maxConcurrent: 1,
    confidenceThreshold: 0.8,
    mt5Magic: 1005,
  },
};

export const ALL_TRADE_MODES: readonly TradeStyle[] = [
  'scalping',
  'day',
  'medium_swing',
  'swing',
  'sniper',
];

export function getRules(style: TradeStyle): TradeModeRules {
  const r = TRADE_MODES[style];
  if (!r) throw new Error(`Unknown trade style: ${style}`);
  return r;
}

// ─── Validation (mirror of validate_order in trade_modes.py) ────────────────

export type RejectReason =
  | 'ok'
  | 'tp_too_tight'
  | 'sl_too_tight'
  | 'sl_too_wide'
  | 'confidence_below_threshold'
  | 'max_concurrent_exceeded'
  | 'min_hold_not_elapsed'
  | 'invalid_signal';

export interface OrderSignal {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
}

export interface ValidationResult {
  ok: boolean;
  reason: RejectReason;
  detail: string;
}

function reject(reason: RejectReason, detail: string): ValidationResult {
  return { ok: false, reason, detail };
}

function accept(): ValidationResult {
  return { ok: true, reason: 'ok', detail: '' };
}

export function validateOrder(
  rules: TradeModeRules,
  signal: OrderSignal,
  atr: number,
  nConcurrent: number,
  barsSinceLastOpen: number | null = null
): ValidationResult {
  if (signal.entryPrice <= 0 || atr <= 0) {
    return reject('invalid_signal', `entry=${signal.entryPrice}, atr=${atr}`);
  }
  if (signal.confidence < rules.confidenceThreshold) {
    return reject(
      'confidence_below_threshold',
      `${signal.confidence.toFixed(3)} < ${rules.confidenceThreshold.toFixed(3)}`
    );
  }
  if (nConcurrent >= rules.maxConcurrent) {
    return reject('max_concurrent_exceeded', `${nConcurrent} >= ${rules.maxConcurrent}`);
  }
  if (barsSinceLastOpen !== null && barsSinceLastOpen < rules.minHoldBars) {
    return reject('min_hold_not_elapsed', `${barsSinceLastOpen} < ${rules.minHoldBars}`);
  }
  const slDistance = Math.abs(signal.entryPrice - signal.stopLoss);
  const tpDistance = Math.abs(signal.entryPrice - signal.takeProfit);
  const slAtrMult = slDistance / atr;
  const tpAtrMult = tpDistance / atr;
  if (tpAtrMult < rules.minTpAtr) {
    return reject('tp_too_tight', `${tpAtrMult.toFixed(3)}xATR < ${rules.minTpAtr}`);
  }
  if (slAtrMult < rules.minSlAtr) {
    return reject('sl_too_tight', `${slAtrMult.toFixed(3)}xATR < ${rules.minSlAtr}`);
  }
  if (slAtrMult > rules.maxSlAtr) {
    return reject('sl_too_wide', `${slAtrMult.toFixed(3)}xATR > ${rules.maxSlAtr}`);
  }
  return accept();
}
