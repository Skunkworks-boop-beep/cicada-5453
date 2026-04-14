/**
 * Risk library: 50+ industry-style risk rules across drawdown, position limits,
 * exposure, volatility, time, concentration, capital, daily loss, correlation,
 * sizing, regime, instrument, compliance, and liquidity.
 * Filter by trade scope (scalp/day/swing/position) and run in tryOpenPosition.
 */

import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';
import type { TradeScope } from '../types';
import { DRAWDOWN_RULES } from './drawdownRules';
import { POSITION_LIMIT_RULES } from './positionLimitRules';
import { EXPOSURE_RULES } from './exposureRules';
import { VOLATILITY_RULES } from './volatilityRules';
import { TIME_RULES } from './timeRules';
import { CAPITAL_RULES } from './capitalRules';
import { DAILY_LOSS_RULES } from './dailyLossRules';
import { CONCENTRATION_RULES } from './concentrationRules';
import { CORRELATION_RULES } from './correlationRules';
import { SIZING_RULES } from './sizingRules';
import { REGIME_INSTRUMENT_RULES } from './regimeInstrumentRules';
import { COMPLIANCE_LIQUIDITY_RULES } from './complianceLiquidityRules';

export type { RiskRuleDef, RiskRuleContext, RiskRuleResult, RiskRuleCategory } from './types';

const ALL_RULES: RiskRuleDef[] = [
  ...DRAWDOWN_RULES,
  ...POSITION_LIMIT_RULES,
  ...EXPOSURE_RULES,
  ...VOLATILITY_RULES,
  ...TIME_RULES,
  ...CAPITAL_RULES,
  ...DAILY_LOSS_RULES,
  ...CONCENTRATION_RULES,
  ...CORRELATION_RULES,
  ...SIZING_RULES,
  ...REGIME_INSTRUMENT_RULES,
  ...COMPLIANCE_LIQUIDITY_RULES,
];

export function getAllRiskRules(): RiskRuleDef[] {
  return [...ALL_RULES];
}

export function getRiskRulesForScope(scope: TradeScope): RiskRuleDef[] {
  return ALL_RULES.filter(
    (r) => r.scopes.length === 0 || r.scopes.includes(scope)
  );
}

export function getRiskRulesByCategory(category: RiskRuleDef['category']): RiskRuleDef[] {
  return ALL_RULES.filter((r) => r.category === category);
}

/**
 * Run all applicable risk library rules (by scope). Returns first failure or allowed.
 * When a rule blocks, includes ruleId and ruleName for logging.
 */
export function evaluateRiskLibrary(ctx: RiskRuleContext): RiskRuleResult {
  const rules = getRiskRulesForScope(ctx.scope);
  for (const r of rules) {
    const result = r.check(ctx);
    if (!result.allowed) {
      return { ...result, ruleId: r.id, ruleName: r.name };
    }
  }
  return { allowed: true };
}
