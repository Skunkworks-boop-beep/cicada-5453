/**
 * Cross-reference research (baseline, tuned) with backtest results.
 * Produces robust suggestions for config choice and strategy selection.
 */

export interface BaselineResult {
  instrumentId: string;
  instrumentSymbol: string;
  regimeDistribution: Record<string, number>;
  baselineAvgSharpe: number;
  baselineTotalProfit: number;
}

export interface RegimeTuneForSuggestion {
  instrumentId: string;
  instrumentSymbol: string;
  validated?: boolean;
  regimeValidationMessage?: string;
  regimeDistribution?: Record<string, number>;
  score?: number;
}

export interface ParamTuneForSuggestion {
  instrumentId: string;
  strategyId: string;
  regime: string;
  sharpeInSample: number;
  profitOOS: number;
  tradesOOS: number;
}

export interface BacktestRowForSuggestion {
  instrumentId: string;
  strategyId: string;
  profit: number;
}

export interface Suggestion {
  type: 'use_defaults' | 'use_research' | 'try_strategies' | 'regime_review' | 'research_helped' | 'research_hurt';
  priority: number;
  message: string;
  instrumentId?: string;
  strategyId?: string;
}

/**
 * Cross-reference baseline, tuned (paramTunes), and backtest results.
 * Returns prioritized suggestions.
 */
export function computeResearchSuggestions(
  baselineResults: BaselineResult[],
  regimeTunes: RegimeTuneForSuggestion[],
  paramTunes: ParamTuneForSuggestion[],
  backtestResults: BacktestRowForSuggestion[],
  backtestInstrumentIds: string[],
  backtestStrategyIds: string[]
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const baselineByInst = new Map(baselineResults.map((b) => [b.instrumentId, b]));
  const regimeByInst = new Map(regimeTunes.map((r) => [r.instrumentId, r]));
  const backtestProfit = backtestResults.reduce((s, r) => s + r.profit, 0);
  const backtestByInst = new Map<string, number>();
  for (const r of backtestResults) {
    backtestByInst.set(r.instrumentId, (backtestByInst.get(r.instrumentId) ?? 0) + r.profit);
  }
  const tunedProfitByInst = new Map<string, number>();
  for (const t of paramTunes) {
    tunedProfitByInst.set(t.instrumentId, (tunedProfitByInst.get(t.instrumentId) ?? 0) + t.profitOOS);
  }

  // 1. Regime validation failed → use defaults (high priority)
  for (const rt of regimeTunes) {
    if (rt.validated === false && backtestInstrumentIds.includes(rt.instrumentId)) {
      suggestions.push({
        type: 'use_defaults',
        priority: 10,
        message: `${rt.instrumentSymbol}: regime validation failed — using defaults (research skipped)`,
        instrumentId: rt.instrumentId,
      });
    }
  }

  // 2. Baseline vs tuned: if baseline profit > tuned profit, suggest defaults
  for (const instId of backtestInstrumentIds) {
    const baseline = baselineByInst.get(instId);
    const tunedProfit = tunedProfitByInst.get(instId) ?? 0;
    if (baseline && baseline.baselineTotalProfit > tunedProfit && tunedProfit <= 0) {
      const rt = regimeByInst.get(instId);
      if (rt?.validated === false) {
        suggestions.push({
          type: 'use_defaults',
          priority: 9,
          message: `${baseline.instrumentSymbol}: baseline (${baseline.baselineTotalProfit.toFixed(0)}) beats tuned (${tunedProfit.toFixed(0)}) — defaults recommended`,
          instrumentId: instId,
        });
      }
    }
  }

  // 3. Strategy has 0 trades in all regimes → try other strategies
  const strategiesWithNoTrades = new Set<string>();
  for (const stratId of backtestStrategyIds) {
    const tunes = paramTunes.filter((t) => t.strategyId === stratId);
    const totalTrades = tunes.reduce((s, t) => s + t.tradesOOS, 0);
    if (tunes.length > 0 && totalTrades === 0) {
      strategiesWithNoTrades.add(stratId);
    }
  }
  if (strategiesWithNoTrades.size > 0) {
    suggestions.push({
      type: 'try_strategies',
      priority: 7,
      message: `Strategy ${[...strategiesWithNoTrades].join(', ')} produced 0 trades — try ind-rsi, pa-fvg, or ind-bb-squeeze`,
      strategyId: [...strategiesWithNoTrades][0],
    });
  }

  // 4. Regime needs review (validation failed but not yet in use_defaults)
  const failedValidation = regimeTunes.filter((r) => r.validated === false);
  if (failedValidation.length > 0 && suggestions.every((s) => s.type !== 'use_defaults' || !s.instrumentId)) {
    for (const rt of failedValidation) {
      if (!suggestions.some((s) => s.instrumentId === rt.instrumentId && s.type === 'use_defaults')) {
        suggestions.push({
          type: 'regime_review',
          priority: 6,
          message: `${rt.instrumentSymbol}: ${rt.regimeValidationMessage ?? 'Regime needs review'}`,
          instrumentId: rt.instrumentId,
        });
      }
    }
  }

  // 5. Backtest vs baseline: did research help or hurt? (only when we have baseline for same instruments)
  const baselineTotal = baselineResults
    .filter((b) => backtestInstrumentIds.includes(b.instrumentId))
    .reduce((s, b) => s + b.baselineTotalProfit, 0);
  const validatedCount = regimeTunes.filter((r) => r.validated !== false && backtestInstrumentIds.includes(r.instrumentId)).length;
  if (baselineResults.length > 0 && validatedCount > 0 && backtestResults.length > 0) {
    if (backtestProfit > baselineTotal && backtestProfit > 0) {
      suggestions.push({
        type: 'research_helped',
        priority: 5,
        message: `Research helped: backtest $${backtestProfit.toFixed(0)} vs baseline $${baselineTotal.toFixed(0)}`,
      });
    } else if (baselineTotal > backtestProfit && baselineTotal > 0) {
      suggestions.push({
        type: 'research_hurt',
        priority: 5,
        message: `Defaults performed better: baseline $${baselineTotal.toFixed(0)} vs backtest $${backtestProfit.toFixed(0)} — consider unchecking research config`,
      });
    }
  }

  return suggestions.sort((a, b) => b.priority - a.priority);
}
