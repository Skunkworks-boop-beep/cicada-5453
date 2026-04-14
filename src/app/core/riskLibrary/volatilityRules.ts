import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'volatility', scopes, description, check };
}

export const VOLATILITY_RULES: RiskRuleDef[] = [
  rule(
    'vol-high-vol-no-scalp',
    'No scalp in high vol',
    'Scalp: block when volatility (ATR %) is above 3%.',
    ['scalp'],
    (ctx) =>
      (ctx.volatilityPct ?? 0) > 0.03
        ? { allowed: false, reason: 'Scalp blocked in high volatility' }
        : { allowed: true }
  ),
  rule(
    'vol-extreme-no-new',
    'No new in extreme vol',
    'Block new positions when volatility exceeds 5%.',
    [],
    (ctx) =>
      (ctx.volatilityPct ?? 0) > 0.05
        ? { allowed: false, reason: 'Extreme volatility: no new positions' }
        : { allowed: true }
  ),
  rule(
    'vol-day-cap-2pct',
    'Day vol cap 2%',
    'Day: block when volatility exceeds 2%.',
    ['day'],
    (ctx) =>
      (ctx.volatilityPct ?? 0) > 0.02 ? { allowed: false, reason: 'Day trade vol cap 2%' } : { allowed: true }
  ),
  rule(
    'vol-swing-cap-4pct',
    'Swing vol cap 4%',
    'Swing: block when volatility exceeds 4%.',
    ['swing'],
    (ctx) =>
      (ctx.volatilityPct ?? 0) > 0.04 ? { allowed: false, reason: 'Swing vol cap 4%' } : { allowed: true }
  ),
  rule(
    'vol-position-cap-6pct',
    'Position vol cap 6%',
    'Position: block when volatility exceeds 6%.',
    ['position'],
    (ctx) =>
      (ctx.volatilityPct ?? 0) > 0.06 ? { allowed: false, reason: 'Position vol cap 6%' } : { allowed: true }
  ),
];
