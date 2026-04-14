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

export const REGIME_INSTRUMENT_RULES: RiskRuleDef[] = [
  rule(
    'reg-unknown-caution',
    'Unknown regime caution',
    'regime',
    'Reduce size in unknown regime (optional: block scalp in unknown).',
    ['scalp'],
    (ctx) =>
      ctx.regime === 'unknown'
        ? { allowed: false, reason: 'Scalp blocked in unknown regime' }
        : { allowed: true }
  ),
  rule(
    'reg-volatile-scalp-block',
    'No scalp in volatile',
    'regime',
    'Scalp: block in volatile regime.',
    ['scalp'],
    (ctx) =>
      ctx.regime === 'volatile'
        ? { allowed: false, reason: 'Scalp blocked in volatile regime' }
        : { allowed: true }
  ),
  rule(
    'inst-crypto-diversify',
    'Crypto diversify',
    'instrument',
    'When adding crypto, block if already 4+ positions (diversification).',
    [],
    (ctx) => {
      if (ctx.instrumentType !== 'crypto') return { allowed: true };
      return ctx.existingPositions.length >= 4
        ? { allowed: false, reason: 'Crypto: max 4 positions before adding crypto' }
        : { allowed: true };
    }
  ),
  rule(
    'inst-synthetic-diversify',
    'Synthetic diversify',
    'instrument',
    'When adding synthetic, block if already 5+ positions.',
    [],
    (ctx) => {
      if (ctx.instrumentType !== 'synthetic_deriv') return { allowed: true };
      return ctx.existingPositions.length >= 5
        ? { allowed: false, reason: 'Synthetic: max 5 positions before adding' }
        : { allowed: true };
    }
  ),
  rule(
    'inst-indices-diversify',
    'Indices diversify',
    'instrument',
    'When adding indices, block if already 4+ positions.',
    [],
    (ctx) => {
      if (ctx.instrumentType !== 'indices_exness') return { allowed: true };
      return ctx.existingPositions.length >= 4
        ? { allowed: false, reason: 'Indices: diversify' }
        : { allowed: true };
    }
  ),
];
