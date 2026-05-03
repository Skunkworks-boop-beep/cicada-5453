import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'sizing', scopes, description, check };
}

export const SIZING_RULES: RiskRuleDef[] = [
  rule(
    'size-min-risk-per-trade',
    'Min risk per trade',
    'New position risk must be at least 0.1% of equity (avoid dust).',
    [],
    (ctx) =>
      ctx.portfolio.equity > 0 && ctx.newPositionRiskAmount < ctx.portfolio.equity * 0.001
        ? { allowed: false, reason: 'Min risk per trade 0.1%' }
        : { allowed: true }
  ),
  rule(
    'size-scalp-max-size',
    'Scalp max size',
    'Scalp: single position risk max 1.5% of equity.',
    ['scalp'],
    (ctx) =>
      ctx.newPositionRiskAmount > ctx.portfolio.equity * 0.015
        ? { allowed: false, reason: 'Scalp single risk max 1.5%' }
        : { allowed: true }
  ),
  rule(
    'size-stop-required',
    'Stop required',
    'Block when stop distance is zero or invalid.',
    [],
    (ctx) =>
      ctx.stopLossPrice != null &&
      ctx.entryPrice != null &&
      Math.abs(ctx.entryPrice - ctx.stopLossPrice) < ctx.entryPrice * 0.0001
        ? { allowed: false, reason: 'Stop loss too tight' }
        : { allowed: true }
  ),
  rule(
    'size-day-max-2pct',
    'Day single max 2%',
    'Day: single position risk max 2% of equity.',
    ['day'],
    (ctx) =>
      ctx.newPositionRiskAmount > ctx.portfolio.equity * 0.02
        ? { allowed: false, reason: 'Day single risk max 2%' }
        : { allowed: true }
  ),
  rule(
    'size-swing-max-2.5pct',
    'Swing single max 2.5%',
    'Swing: single position risk max 2.5% of equity.',
    ['swing'],
    (ctx) =>
      ctx.newPositionRiskAmount > ctx.portfolio.equity * 0.025
        ? { allowed: false, reason: 'Swing single risk max 2.5%' }
        : { allowed: true }
  ),
  rule(
    'size-position-max-3pct',
    'Position-scope single max 3%',
    'Position (long-hold) scope: single position risk max 3% of equity.',
    ['position'],
    (ctx) =>
      ctx.newPositionRiskAmount > ctx.portfolio.equity * 0.03
        ? { allowed: false, reason: 'Position-scope single risk max 3%' }
        : { allowed: true }
  ),
];
