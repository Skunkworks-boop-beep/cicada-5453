import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'daily_loss', scopes, description, check };
}

/** Uses portfolio totalPnl as proxy for "today" when no separate daily PnL is stored. */
export const DAILY_LOSS_RULES: RiskRuleDef[] = [
  rule(
    'daily-loss-5pct',
    'Daily loss 5% stop',
    'Block new positions when total PnL is below -5% of peak equity.',
    ['scalp', 'day'],
    (ctx) =>
      ctx.portfolio.peakEquity > 0 &&
      ctx.portfolio.totalPnlPercent < -5 &&
      ctx.portfolio.equity < ctx.portfolio.peakEquity * 0.95
        ? { allowed: false, reason: 'Daily loss limit 5%' }
        : { allowed: true }
  ),
  rule(
    'daily-loss-10pct',
    'Daily loss 10% stop',
    'Block when drawdown from peak implies >10% daily loss.',
    ['swing', 'position'],
    (ctx) =>
      ctx.portfolio.drawdownPct >= 0.1
        ? { allowed: false, reason: 'Daily/drawdown loss limit 10%' }
        : { allowed: true }
  ),
  rule(
    'daily-scalp-stop-3pct',
    'Scalp daily stop 3%',
    'Scalp: block when total PnL % is below -3%.',
    ['scalp'],
    (ctx) =>
      ctx.portfolio.totalPnlPercent < -3
        ? { allowed: false, reason: 'Scalp daily stop 3%' }
        : { allowed: true }
  ),
  rule(
    'daily-day-stop-5pct',
    'Day daily stop 5%',
    'Day: block when total PnL % is below -5%.',
    ['day'],
    (ctx) =>
      ctx.portfolio.totalPnlPercent < -5
        ? { allowed: false, reason: 'Day daily stop 5%' }
        : { allowed: true }
  ),
];
