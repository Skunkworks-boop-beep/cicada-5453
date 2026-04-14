import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'correlation', scopes, description, check };
}

export const CORRELATION_RULES: RiskRuleDef[] = [
  rule(
    'corr-total-risk-cap',
    'Total risk cap',
    'Total open risk must not exceed maxCorrelatedExposure × equity.',
    [],
    (ctx) => {
      const total =
        ctx.existingPositions.reduce((s, p) => s + p.riskAmount, 0) + ctx.newPositionRiskAmount;
      return total > ctx.portfolio.equity * ctx.botParams.maxCorrelatedExposure
        ? { allowed: false, reason: 'Total risk (correlated) cap' }
        : { allowed: true };
    }
  ),
  rule(
    'corr-scalp-low-correlation',
    'Scalp low correlation',
    'Scalp: total risk from scalp positions must not exceed 4% equity.',
    ['scalp'],
    (ctx) => {
      const scalpRisk =
        ctx.existingPositions.filter((p) => p.scope === 'scalp').reduce((s, p) => s + p.riskAmount, 0) +
        (ctx.scope === 'scalp' ? ctx.newPositionRiskAmount : 0);
      return scalpRisk > ctx.portfolio.equity * 0.04
        ? { allowed: false, reason: 'Scalp total risk 4%' }
        : { allowed: true };
    }
  ),
  rule(
    'corr-day-total-8pct',
    'Day total risk 8%',
    'Day: total day-scope risk must not exceed 8% equity.',
    ['day'],
    (ctx) => {
      const dayRisk =
        ctx.existingPositions.filter((p) => p.scope === 'day').reduce((s, p) => s + p.riskAmount, 0) +
        (ctx.scope === 'day' ? ctx.newPositionRiskAmount : 0);
      return dayRisk > ctx.portfolio.equity * 0.08
        ? { allowed: false, reason: 'Day total risk 8%' }
        : { allowed: true };
    }
  ),
  rule(
    'corr-swing-total-12pct',
    'Swing total risk 12%',
    'Swing: total swing-scope risk must not exceed 12% equity.',
    ['swing'],
    (ctx) => {
      const swingRisk =
        ctx.existingPositions.filter((p) => p.scope === 'swing').reduce((s, p) => s + p.riskAmount, 0) +
        (ctx.scope === 'swing' ? ctx.newPositionRiskAmount : 0);
      return swingRisk > ctx.portfolio.equity * 0.12
        ? { allowed: false, reason: 'Swing total risk 12%' }
        : { allowed: true };
    }
  ),
];
