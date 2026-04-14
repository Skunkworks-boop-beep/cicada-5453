import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'drawdown', scopes, description, check };
}

export const DRAWDOWN_RULES: RiskRuleDef[] = [
  rule(
    'dd-max-drawdown',
    'Max drawdown cap',
    'Block new positions when portfolio drawdown exceeds bot max drawdown.',
    [],
    (ctx) =>
      ctx.portfolio.drawdownPct >= ctx.botParams.maxDrawdownPct
        ? { allowed: false, reason: 'Max drawdown reached' }
        : { allowed: true }
  ),
  rule(
    'dd-peak-equity-10',
    'Peak equity 10% drawdown',
    'Block if current equity is more than 10% below peak.',
    ['scalp', 'day'],
    (ctx) =>
      ctx.portfolio.peakEquity > 0 && ctx.portfolio.equity / ctx.portfolio.peakEquity < 0.9
        ? { allowed: false, reason: 'Drawdown > 10% from peak' }
        : { allowed: true }
  ),
  rule(
    'dd-peak-equity-15',
    'Peak equity 15% drawdown',
    'Block if current equity is more than 15% below peak.',
    ['swing', 'position'],
    (ctx) =>
      ctx.portfolio.peakEquity > 0 && ctx.portfolio.equity / ctx.portfolio.peakEquity < 0.85
        ? { allowed: false, reason: 'Drawdown > 15% from peak' }
        : { allowed: true }
  ),
  rule(
    'dd-equity-zero',
    'Positive equity required',
    'Block when equity is zero or negative.',
    [],
    (ctx) =>
      ctx.portfolio.equity <= 0 ? { allowed: false, reason: 'Equity must be positive' } : { allowed: true }
  ),
  rule(
    'dd-scalp-tight',
    'Scalp tight drawdown',
    'Scalp: block if drawdown > 5%.',
    ['scalp'],
    (ctx) =>
      ctx.portfolio.drawdownPct > 0.05 ? { allowed: false, reason: 'Scalp drawdown limit 5%' } : { allowed: true }
  ),
];
