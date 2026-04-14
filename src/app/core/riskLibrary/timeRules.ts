import type { RiskRuleDef, RiskRuleContext, RiskRuleResult } from './types';

function rule(
  id: string,
  name: string,
  description: string,
  scopes: RiskRuleDef['scopes'],
  check: (ctx: RiskRuleContext) => RiskRuleResult
): RiskRuleDef {
  return { id, name, category: 'time', scopes, description, check };
}

export const TIME_RULES: RiskRuleDef[] = [
  rule(
    'time-scalp-session',
    'Scalp session hours',
    'Scalp: only allow 06–22 UTC (liquid sessions).',
    ['scalp'],
    (ctx) => {
      const h = ctx.utcHour ?? new Date().getUTCHours();
      return h < 6 || h >= 22
        ? { allowed: false, reason: 'Scalp only 06–22 UTC' }
        : { allowed: true };
    }
  ),
  rule(
    'time-day-session',
    'Day session hours',
    'Day: only allow 07–21 UTC.',
    ['day'],
    (ctx) => {
      const h = ctx.utcHour ?? new Date().getUTCHours();
      return h < 7 || h >= 21 ? { allowed: false, reason: 'Day only 07–21 UTC' } : { allowed: true };
    }
  ),
  rule(
    'time-weekend-no-scalp',
    'No scalp weekend',
    'Scalp: block Saturday–Sunday UTC.',
    ['scalp'],
    (ctx) => {
      const d = new Date().getUTCDay();
      return d === 0 || d === 6
        ? { allowed: false, reason: 'No scalp on weekend' }
        : { allowed: true };
    }
  ),
  rule(
    'time-asia-close-avoid',
    'Avoid Asia close',
    'Block 00–02 UTC (thin Asia close) for scalp/day.',
    ['scalp', 'day'],
    (ctx) => {
      const h = ctx.utcHour ?? new Date().getUTCHours();
      return h >= 0 && h < 2
        ? { allowed: false, reason: 'Avoid Asia close (00–02 UTC)' }
        : { allowed: true };
    }
  ),
  rule(
    'time-ny-close-avoid-scalp',
    'Avoid NY close for scalp',
    'Scalp: block 21–22 UTC (NY close).',
    ['scalp'],
    (ctx) => {
      const h = ctx.utcHour ?? new Date().getUTCHours();
      return h >= 21 && h < 22
        ? { allowed: false, reason: 'Avoid NY close for scalp' }
        : { allowed: true };
    }
  ),
  rule(
    'time-swing-any',
    'Swing/position any time',
    'Swing and position trades allowed any hour (no time filter).',
    ['swing', 'position'],
    () => ({ allowed: true })
  ),
];
