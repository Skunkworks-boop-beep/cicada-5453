import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  category: RiskRuleDef['category'],
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category, scopes, description, check };
}

export const COMPLIANCE_LIQUIDITY_RULES: RiskRuleDef[] = [
  rule(
    'liq-size-positive',
    'Position size positive',
    'liquidity',
    'Position size must be positive.',
    [],
    (ctx) =>
      (ctx.newPositionSize ?? 0) <= 0 ? { allowed: false, reason: 'Position size must be positive' } : { allowed: true }
  ),
  rule(
    'liq-entry-positive',
    'Entry price positive',
    'liquidity',
    'Entry price must be positive when provided.',
    [],
    (ctx) =>
      ctx.entryPrice != null && ctx.entryPrice <= 0
        ? { allowed: false, reason: 'Entry price must be positive' }
        : { allowed: true }
  ),
  rule(
    'comp-max-drawdown-respected',
    'Max drawdown respected',
    'compliance',
    'Bot max drawdown limit must be respected.',
    [],
    (ctx) =>
      ctx.portfolio.drawdownPct >= ctx.botParams.maxDrawdownPct
        ? { allowed: false, reason: 'Max drawdown (compliance)' }
        : { allowed: true }
  ),
  rule(
    'comp-risk-reward-min',
    'Min risk/reward',
    'compliance',
    'Require stop and entry to imply at least 0.5% risk (avoid micro positions).',
    [],
    (ctx) => {
      if (ctx.entryPrice == null || ctx.stopLossPrice == null) return { allowed: true };
      if (!Number.isFinite(ctx.entryPrice) || ctx.entryPrice <= 0) {
        return { allowed: false, reason: 'Invalid entry price for risk/reward check' };
      }
      const dist = Math.abs(ctx.entryPrice - ctx.stopLossPrice);
      const pct = dist / ctx.entryPrice;
      return pct < 0.005 ? { allowed: false, reason: 'Min risk distance 0.5%' } : { allowed: true };
    }
  ),
  rule(
    'liq-notional-min',
    'Min notional',
    'liquidity',
    'Position notional must be at least 1 (avoid dust).',
    [],
    (ctx) => {
      const notional = (ctx.entryPrice ?? 0) * (ctx.newPositionSize ?? 0);
      return notional > 0 && notional < 1
        ? { allowed: false, reason: 'Min notional 1' }
        : { allowed: true };
    }
  ),
];
