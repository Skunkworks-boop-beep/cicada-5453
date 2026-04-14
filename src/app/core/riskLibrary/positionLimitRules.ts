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

export const POSITION_LIMIT_RULES: RiskRuleDef[] = [
  rule(
    'pos-one-per-instrument',
    'Max positions per instrument',
    'position_limit',
    'At most N open positions per instrument (N from confidence: 1–3).',
    [],
    (ctx) => {
      const max = ctx.maxPositionsPerInstrument ?? 1;
      const count = ctx.existingPositions.filter((p) => p.instrumentId === ctx.instrumentId).length;
      return count >= max
        ? { allowed: false, reason: `Max ${max} position(s) per instrument` }
        : { allowed: true };
    }
  ),
  rule(
    'pos-max-per-bot',
    'Max positions per bot',
    'position_limit',
    'Bot may not exceed its maxPositions limit.',
    [],
    (ctx) => {
      if (ctx.botId == null || ctx.maxPositionsPerBot == null) return { allowed: true };
      const count = ctx.existingPositions.filter((p) => p.botId === ctx.botId).length;
      return count >= ctx.maxPositionsPerBot
        ? { allowed: false, reason: `Bot max positions (${ctx.maxPositionsPerBot}) reached` }
        : { allowed: true };
    }
  ),
  rule(
    'pos-max-same-direction',
    'Max same-direction positions',
    'position_limit',
    'At most 4 positions in the same direction (long or short) across portfolio.',
    [],
    (ctx) => {
      if (ctx.side == null) return { allowed: true };
      const sameDir = ctx.existingPositions.filter((p) =>
        ctx.side === 'LONG' ? p.type === 'LONG' : p.type === 'SHORT'
      ).length;
      return sameDir >= 4
        ? { allowed: false, reason: 'Max same-direction positions (4)' }
        : { allowed: true };
    }
  ),
  rule(
    'pos-max-total-5',
    'Max 5 total positions',
    'position_limit',
    'Block if total open positions would exceed 5.',
    ['scalp', 'day'],
    (ctx) =>
      ctx.existingPositions.length >= 5 ? { allowed: false, reason: 'Max 5 positions (scalp/day)' } : { allowed: true }
  ),
  rule(
    'pos-max-total-10',
    'Max 10 total positions',
    'position_limit',
    'Block if total open positions would exceed 10.',
    ['swing', 'position'],
    (ctx) =>
      ctx.existingPositions.length >= 10
        ? { allowed: false, reason: 'Max 10 positions (swing/position)' }
        : { allowed: true }
  ),
  rule(
    'pos-max-same-scope-3',
    'Max 3 per scope',
    'position_limit',
    'At most 3 positions in the same scope (scalp/day/swing/position).',
    [],
    (ctx) => {
      const sameScope = ctx.existingPositions.filter((p) => p.scope === ctx.scope);
      return sameScope.length >= 3
        ? { allowed: false, reason: `Max 3 positions per scope (${ctx.scope})` }
        : { allowed: true };
    }
  ),
  rule(
    'pos-scalp-max-3',
    'Scalp max 3 positions',
    'position_limit',
    'Scalp: max 3 open positions.',
    ['scalp'],
    (ctx) =>
      ctx.existingPositions.length >= 3 ? { allowed: false, reason: 'Scalp max 3 positions' } : { allowed: true }
  ),
  rule(
    'pos-day-max-5',
    'Day max 5 positions',
    'position_limit',
    'Day: max 5 open positions.',
    ['day'],
    (ctx) =>
      ctx.existingPositions.length >= 5 ? { allowed: false, reason: 'Day max 5 positions' } : { allowed: true }
  ),
  rule(
    'pos-swing-max-7',
    'Swing max 7 positions',
    'position_limit',
    'Swing: max 7 open positions.',
    ['swing'],
    (ctx) =>
      ctx.existingPositions.length >= 7 ? { allowed: false, reason: 'Swing max 7 positions' } : { allowed: true }
  ),
  rule(
    'pos-position-max-8',
    'Position max 8 positions',
    'position_limit',
    'Position: max 8 open positions.',
    ['position'],
    (ctx) =>
      ctx.existingPositions.length >= 8 ? { allowed: false, reason: 'Position max 8 positions' } : { allowed: true }
  ),
];
