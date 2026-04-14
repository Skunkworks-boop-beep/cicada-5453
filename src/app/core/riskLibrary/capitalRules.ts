import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'capital', scopes, description, check };
}

export const CAPITAL_RULES: RiskRuleDef[] = [
  rule(
    'cap-min-equity-100',
    'Min equity 100',
    'Block when equity is below 100 (account currency).',
    [],
    (ctx) =>
      ctx.portfolio.equity < 100 ? { allowed: false, reason: 'Min equity 100' } : { allowed: true }
  ),
  rule(
    'cap-scalp-min-equity-1000',
    'Scalp min equity 1000',
    'Scalp: require at least 1000 equity.',
    ['scalp'],
    (ctx) =>
      ctx.portfolio.equity < 1000 ? { allowed: false, reason: 'Scalp min equity 1000' } : { allowed: true }
  ),
  rule(
    'cap-risk-per-trade-respected',
    'Risk per trade respected',
    'New position risk must not exceed equity × riskPerTradePct.',
    [],
    (ctx) =>
      ctx.newPositionRiskAmount > ctx.portfolio.equity * ctx.botParams.riskPerTradePct
        ? { allowed: false, reason: 'Risk per trade exceeded' }
        : { allowed: true }
  ),
  rule(
    'cap-balance-positive',
    'Balance positive',
    'Block when balance is negative.',
    [],
    (ctx) =>
      ctx.portfolio.balance < 0 ? { allowed: false, reason: 'Balance must be positive' } : { allowed: true }
  ),
  rule(
    'cap-equity-drop-20-no-new',
    'No new after 20% equity drop',
    'Block new positions if equity dropped more than 20% from peak in session.',
    ['scalp', 'day'],
    (ctx) =>
      ctx.portfolio.peakEquity > 0 && ctx.portfolio.equity / ctx.portfolio.peakEquity < 0.8
        ? { allowed: false, reason: 'Equity down 20% from peak' }
        : { allowed: true }
  ),
];
