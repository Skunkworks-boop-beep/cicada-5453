import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'concentration', scopes, description, check };
}

/** Largest single-position risk vs sum of all open risks + new trade (first position exempt). */
function checkMaxSingleShareOfTotalRisk(
  ctx: RiskRuleContext,
  maxFraction: number,
  label: string
): RiskRuleResult {
  if (ctx.existingPositions.length === 0) return { allowed: true };
  const totalRisk =
    ctx.existingPositions.reduce((s, p) => s + p.riskAmount, 0) + ctx.newPositionRiskAmount;
  if (totalRisk <= 0) return { allowed: true };
  const maxSingle = Math.max(
    ...ctx.existingPositions.map((p) => p.riskAmount),
    ctx.newPositionRiskAmount
  );
  return maxSingle / totalRisk > maxFraction
    ? { allowed: false, reason: `Single position max ${label} of total risk (${ctx.scope})` }
    : { allowed: true };
}

export const CONCENTRATION_RULES: RiskRuleDef[] = [
  rule(
    'conc-max-single-scalp',
    'Scalp max single 15% of total risk',
    'Scalp: no single position risk may exceed 15% of combined open risk (skipped for first position).',
    ['scalp'],
    (ctx) => checkMaxSingleShareOfTotalRisk(ctx, 0.15, '15%')
  ),
  rule(
    'conc-max-single-day',
    'Day max single 20% of total risk',
    'Day: no single position risk may exceed 20% of combined open risk (skipped for first position).',
    ['day'],
    (ctx) => checkMaxSingleShareOfTotalRisk(ctx, 0.2, '20%')
  ),
  rule(
    'conc-max-single-swing',
    'Swing max single 25% of total risk',
    'Swing: no single position risk may exceed 25% of combined open risk (skipped for first position).',
    ['swing'],
    (ctx) => checkMaxSingleShareOfTotalRisk(ctx, 0.25, '25%')
  ),
  rule(
    'conc-max-single-position-scope',
    'Position-scope max single 35% of total risk',
    'Position (long-hold): no single position risk may exceed 35% of combined open risk (skipped for first position).',
    ['position'],
    (ctx) => checkMaxSingleShareOfTotalRisk(ctx, 0.35, '35%')
  ),
  rule(
    'conc-scalp-diversify-3',
    'Scalp diversify 3',
    'Scalp: prefer at least 3 different instruments before adding same again.',
    ['scalp'],
    (ctx) =>
      ctx.existingPositions.length < 3
        ? { allowed: true }
        : ctx.existingPositions.some((p) => p.instrumentId === ctx.instrumentId)
          ? { allowed: false, reason: 'Scalp: one position per instrument' }
          : { allowed: true }
  ),
  rule(
    'conc-same-side-max-4',
    'Max 4 same direction',
    'At most 4 positions in the same direction (all long or all short).',
    ['day', 'swing'],
    (ctx) => {
      if (!ctx.side) return { allowed: true };
      const sameSide = ctx.existingPositions.filter((p) => p.type === ctx.side).length;
      return sameSide >= 4
        ? { allowed: false, reason: 'Max 4 positions same direction' }
        : { allowed: true };
    }
  ),
  rule(
    'conc-position-diversify',
    'Position diversify',
    'Position: block if already 2+ positions in same scope.',
    ['position'],
    (ctx) => {
      const sameScope = ctx.existingPositions.filter((p) => p.scope === 'position').length;
      return sameScope >= 2 && ctx.scope === 'position'
        ? { allowed: false, reason: 'Position: max 2 position-scope positions' }
        : { allowed: true };
    }
  ),
  rule(
    'conc-notional-single-25pct',
    'Single notional 25%',
    'Single position notional must not exceed 25% of equity.',
    [],
    (ctx) => {
      const notional = (ctx.entryPrice ?? 0) * (ctx.newPositionSize ?? 0);
      return ctx.portfolio.equity > 0 && notional > ctx.portfolio.equity * 0.25
        ? { allowed: false, reason: 'Single position notional cap 25%' }
        : { allowed: true };
    }
  ),
  rule(
    'conc-scalp-same-direction-2',
    'Scalp max 2 same direction',
    'Scalp: at most 2 positions in the same direction.',
    ['scalp'],
    (ctx) => {
      if (!ctx.side) return { allowed: true };
      const sameSide = ctx.existingPositions.filter((p) => p.type === ctx.side).length;
      return sameSide >= 2
        ? { allowed: false, reason: 'Scalp max 2 same direction' }
        : { allowed: true };
    }
  ),
];
