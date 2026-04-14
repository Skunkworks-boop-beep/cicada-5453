/**
 * Risk library types: rule definition and evaluation context.
 * Mirrors strategy library pattern: id, name, category, applicable scopes, and a check function.
 */

import type {
  BotRiskParams,
  InstrumentType,
  Position,
  PortfolioState,
  TradeScope,
} from '../types';

export type RiskRuleCategory =
  | 'drawdown'
  | 'position_limit'
  | 'exposure'
  | 'volatility'
  | 'time'
  | 'concentration'
  | 'capital'
  | 'daily_loss'
  | 'correlation'
  | 'sizing'
  | 'liquidity'
  | 'regime'
  | 'instrument'
  | 'compliance';

/** Context passed to each risk rule when evaluating a potential new position. */
export interface RiskRuleContext {
  portfolio: PortfolioState;
  botParams: BotRiskParams;
  instrumentId: string;
  instrumentType: InstrumentType;
  /** Scope of the trade being opened (scalp/day/swing/position). */
  scope: TradeScope;
  newPositionRiskAmount: number;
  newPositionSize?: number;
  entryPrice?: number;
  stopLossPrice?: number;
  side?: 'LONG' | 'SHORT';
  existingPositions: Position[];
  /** Optional: current UTC hour 0–23 for time-of-day rules. */
  utcHour?: number;
  /** Optional: current volatility (e.g. ATR % of price) for vol-based rules. */
  volatilityPct?: number;
  /** Optional: regime for regime-sensitive rules. */
  regime?: string;
  /** Optional: bot ID for per-bot limits (e.g. max positions per bot). */
  botId?: string;
  /** Optional: max positions this bot may have open. */
  maxPositionsPerBot?: number;
  /** Optional: max positions per instrument (confidence-based; default 1). */
  maxPositionsPerInstrument?: number;
}

export interface RiskRuleResult {
  allowed: boolean;
  reason?: string;
  /** When disallowed: rule id that blocked (for logging). */
  ruleId?: string;
  /** When disallowed: rule name (human-readable). */
  ruleName?: string;
}

export interface RiskRuleDef {
  id: string;
  name: string;
  category: RiskRuleCategory;
  /** Scopes this rule applies to (empty = all). */
  scopes: TradeScope[];
  /** Human-readable description. */
  description: string;
  /** Evaluate the rule; return allowed/reason. */
  check: (ctx: RiskRuleContext) => RiskRuleResult;
}
