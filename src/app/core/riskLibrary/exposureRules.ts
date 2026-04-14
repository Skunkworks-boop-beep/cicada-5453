import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'exposure', scopes, description, check };
}

export const EXPOSURE_RULES: RiskRuleDef[] = [
  rule(
    'exp-correlated-cap',
    'Correlated exposure cap',
    'Total risk (existing + new) must not exceed equity × maxCorrelatedExposure.',
    [],
    (ctx) => {
      const totalRisk =
        ctx.existingPositions.reduce((s, p) => s + p.riskAmount, 0) + ctx.newPositionRiskAmount;
      return totalRisk > ctx.portfolio.equity * ctx.botParams.maxCorrelatedExposure
        ? { allowed: false, reason: 'Correlated exposure limit' }
        : { allowed: true };
    }
  ),
  rule(
    'exp-single-risk-2pct',
    'Single position risk cap 2%',
    'New position risk must not exceed 2% of equity.',
    [],
    (ctx) =>
      ctx.newPositionRiskAmount > ctx.portfolio.equity * 0.02
        ? { allowed: false, reason: 'Single position risk cap 2%' }
        : { allowed: true }
  ),
  rule(
    'exp-scalp-total-risk-5pct',
    'Scalp total risk 5%',
    'Scalp: total open risk must not exceed 5% of equity.',
    ['scalp'],
    (ctx) => {
      const total = ctx.existingPositions.reduce((s, p) => s + p.riskAmount, 0) + ctx.newPositionRiskAmount;
      return total > ctx.portfolio.equity * 0.05
        ? { allowed: false, reason: 'Scalp total risk 5%' }
        : { allowed: true };
    }
  ),
  rule(
    'exp-day-total-risk-10pct',
    'Day total risk 10%',
    'Day: total open risk must not exceed 10% of equity.',
    ['day'],
    (ctx) => {
      const total = ctx.existingPositions.reduce((s, p) => s + p.riskAmount, 0) + ctx.newPositionRiskAmount;
      return total > ctx.portfolio.equity * 0.1
        ? { allowed: false, reason: 'Day total risk 10%' }
        : { allowed: true };
    }
  ),
  rule(
    'exp-swing-total-risk-15pct',
    'Swing total risk 15%',
    'Swing: total open risk must not exceed 15% of equity.',
    ['swing'],
    (ctx) => {
      const total = ctx.existingPositions.reduce((s, p) => s + p.riskAmount, 0) + ctx.newPositionRiskAmount;
      return total > ctx.portfolio.equity * 0.15
        ? { allowed: false, reason: 'Swing total risk 15%' }
        : { allowed: true };
    }
  ),
  rule(
    'exp-notional-50pct',
    'Notional cap 50%',
    'Total notional (sum of entry × size) must not exceed 50% of equity.',
    [],
    (ctx) => {
      const entryPrice = ctx.entryPrice ?? 0;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        return { allowed: false, reason: 'Invalid entry price for notional calculation' };
      }
      const existingNotional = ctx.existingPositions.reduce((s, p) => s + p.entryPrice * p.size, 0);
      const newSize = ctx.newPositionSize ?? (ctx.newPositionRiskAmount / entryPrice);
      const newNotional = entryPrice * newSize;
      const total = existingNotional + newNotional;
      return ctx.portfolio.equity > 0 && total > ctx.portfolio.equity * 0.5
        ? { allowed: false, reason: 'Notional cap 50% of equity' }
        : { allowed: true };
    }
  ),
  rule(
    'exp-long-short-balance',
    'Long/short balance',
    'Block new long if net position is already heavily long (and vice versa).',
    ['day', 'swing'],
    (ctx) => {
      const entryPrice = ctx.entryPrice ?? 0;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        return { allowed: false, reason: 'Invalid entry price for long/short balance' };
      }
      const netLong = ctx.existingPositions.reduce(
        (s, p) => s + (p.type === 'LONG' ? p.size * p.entryPrice : -p.size * p.entryPrice),
        0
      );
      const newNotional = entryPrice * (ctx.newPositionSize ?? 0);
      const newSide = ctx.side === 'LONG' ? 1 : ctx.side === 'SHORT' ? -1 : 0;
      if (newSide === 0) return { allowed: true };
      const after = netLong + newSide * newNotional;
      const cap = ctx.portfolio.equity * 0.3;
      return Math.abs(after) > cap
        ? { allowed: false, reason: 'Long/short imbalance cap' }
        : { allowed: true };
    }
  ),
  rule(
    'exp-position-total-risk-20pct',
    'Position total risk 20%',
    'Position: total open risk must not exceed 20% of equity.',
    ['position'],
    (ctx) => {
      const total = ctx.existingPositions.reduce((s, p) => s + p.riskAmount, 0) + ctx.newPositionRiskAmount;
      return total > ctx.portfolio.equity * 0.2
        ? { allowed: false, reason: 'Position total risk 20%' }
        : { allowed: true };
    }
  ),
];
