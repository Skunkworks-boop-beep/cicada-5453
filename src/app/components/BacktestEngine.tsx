import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTradingStore } from '../store/TradingStore';
import { ALL_REGIMES } from '../core/regimes';
import { ALL_TIMEFRAMES } from '../core/scope';
import { getMt5Status } from '../core/api';
import { estimateBacktestJobCount } from '../core/backtest';
import { BACKTEST_DATE_FROM_EARLIEST } from '../core/config';
import { getInstrumentDefaultRisk } from '../core/instrumentRisk';
import { buildJobRiskOverrides, buildJobRiskOverridesFromParamTunes } from '../core/strategyInstrumentConfig';
import { logLevelToTextClass } from '../core/logTheme';
import { getSelectedStrategyIds } from '../core/strategySelection';
import { DEFAULT_INSTRUMENTS } from '../core/registries';
import { CicadaCheckbox } from './CicadaCheckbox';
import { CicadaDropdown } from './CicadaDropdown';
import { EtaDisplay } from './EtaDisplay';
import { BacktestGridVisualization } from './BacktestGridVisualization';
import { computeResearchSuggestions } from '../core/researchSuggestions';
import type { BacktestRunRequest } from '../core/types';

/** Valid spread: finite number >= 0. Returns undefined when not fetched (backtest uses config default). */
function getValidSpread(instSpread: unknown): number | undefined {
  const n = typeof instSpread === 'number' && Number.isFinite(instSpread) && instSpread >= 0 ? instSpread : undefined;
  return n;
}

/** Same TF options as Bot Builder (scope.ts); backtest runs on selected subset. */
const BACKTEST_TIMEFRAMES: BacktestRunRequest['timeframes'] = [...ALL_TIMEFRAMES];

export function BacktestEngine() {
  const { state, actions } = useTradingStore();
  const { backtest, research, instruments, strategies, brokers, bots } = state;

  const [error, setError] = useState<string | null>(null);
  const [mt5Status, setMt5Status] = useState<{ mt5_available: boolean; connected: boolean } | null>(null);
  /** 'any_only' = 1 job per strategy×TF×instrument (no regime filter); 'all' = 10 jobs (one per regime). Use 'any_only' to reduce $0 noise. */
  const [regimeMode, setRegimeMode] = useState<'all' | 'any_only'>('any_only');
  /** When true and research exists, run both default + research backtest, compare total profit, use best. */
  const [autoCompare, setAutoCompare] = useState(true);
  /** When true, research uses robust mode (OOS profit, walk-forward, successive halving). */
  const [robustMode, setRobustMode] = useState(false);
  /** Research grid size. Large grids (500k+) may need env CICADA_RESEARCH_MAX_* on backend. */
  const [regimeGridMax, setRegimeGridMax] = useState(9);
  const [paramTuneMaxStrat, setParamTuneMaxStrat] = useState(2);
  const [paramTuneMaxRisk, setParamTuneMaxRisk] = useState(6);
  const [gridExpanded, setGridExpanded] = useState(false);
  const researchLogRef = useRef<HTMLDivElement>(null);
  const researchLogUserScrolledAwayRef = useRef(false);
  const selectedTimeframes = Array.isArray(backtest.selectedTimeframes) ? backtest.selectedTimeframes : ALL_TIMEFRAMES;
  const setSelectedTimeframes = (nextOrFn: BacktestRunRequest['timeframes'] | ((prev: BacktestRunRequest['timeframes']) => BacktestRunRequest['timeframes'])) => {
    const next = typeof nextOrFn === 'function' ? nextOrFn(selectedTimeframes) : nextOrFn;
    actions.setBacktestSelectedTimeframes(next);
  };
  const RESEARCH_LOG_SNAP_THRESHOLD = 24;
  const handleResearchLogScroll = () => {
    const el = researchLogRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - RESEARCH_LOG_SNAP_THRESHOLD;
    researchLogUserScrolledAwayRef.current = !atBottom;
  };

  useEffect(() => {
    if (research?.status === 'running') {
      researchLogUserScrolledAwayRef.current = false;
    }
  }, [research?.status]);

  useEffect(() => {
    if (research?.log?.length && researchLogRef.current && !researchLogUserScrolledAwayRef.current) {
      researchLogRef.current.scrollTop = researchLogRef.current.scrollHeight;
    }
  }, [research?.log?.length]);

  useEffect(() => {
    let cancelled = false;
    getMt5Status()
      .then((s) => { if (!cancelled) setMt5Status(s); })
      .catch((e) => {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[BacktestEngine] getMt5Status failed:', e);
        }
        if (!cancelled) setMt5Status({ mt5_available: false, connected: false });
      });
    return () => { cancelled = true; };
  }, [brokers.map((b) => b.status).join(',')]);
  const activeInstruments = instruments.filter((i) => i.status === 'active');
  const selectedInstrument = instruments.find((i) => i.selected) ?? null;
  const selectedIsActive = selectedInstrument && selectedInstrument.status === 'active';
  const backtestInstrumentIds = selectedIsActive && selectedInstrument ? [selectedInstrument.id] : activeInstruments.map((i) => i.id);
  const botForSelected = selectedInstrument ? bots.find((b) => b.instrumentId === selectedInstrument.id) : null;
  /** Strategies 100% from Strategy Library (enabled only). No per-bot override. Robust detection via strategySelection. */
  const selection = getSelectedStrategyIds(strategies);
  const stratIds = selection.strategyIds;
  const enabledStrategies = selection.strategies;

  const allTimeframesSelected = selectedTimeframes.length === ALL_TIMEFRAMES.length;
  const noTimeframesSelected = selectedTimeframes.length === 0;

  const run = async () => {
    setError(null);

    // 1. Instruments: need at least one active
    if (!backtestInstrumentIds.length) {
      setError('No active instruments. Activate at least one in Instrument Registry.');
      return;
    }

    // 2. Strategies: 100% from Strategy Library (enabled only). No per-bot override.
    if (stratIds.length === 0) {
      const msg = selection.hasWarnings
        ? `No valid strategies. ${selection.invalidIds.length ? `${selection.invalidIds.length} invalid/removed. ` : ''}${selection.missingSignalIds.length ? `${selection.missingSignalIds.length} missing signal. ` : ''}Enable strategies with signal implementations in Strategy Library.`
        : 'No strategies enabled. Enable at least one in Strategy Library.';
      setError(msg);
      return;
    }

    // 3. Timeframes: need at least one
    if (selectedTimeframes.length === 0) {
      setError('Select at least one timeframe to run backtest.');
      return;
    }

    // 4. Date range: dateFrom must not be after dateTo
    const dateTo = new Date().toISOString().slice(0, 10);
    if (BACKTEST_DATE_FROM_EARLIEST > dateTo) {
      setError('Invalid date range. Check BACKTEST_DATE_FROM configuration.');
      return;
    }
    const instrumentSpreads: Record<string, number> = {};
    backtestInstrumentIds.forEach((id) => {
      const inst = instruments.find((i) => i.id === id);
      const spread = getValidSpread(inst?.spread);
      if (spread != null) instrumentSpreads[id] = spread;
    });
    const regimes = regimeMode === 'any_only' ? (['any'] as BacktestRunRequest['regimes']) : (ALL_REGIMES as BacktestRunRequest['regimes']);
    const instrumentRiskOverrides: Record<string, { riskPerTradePct: number; stopLossPct: number; takeProfitR: number }> = {};
    const instrumentSymbols: Record<string, string> = {};
    for (const id of backtestInstrumentIds) {
      const inst = instruments.find((i) => i.id === id);
      const symbol = inst?.symbol ?? id;
      instrumentSymbols[id] = symbol;
      const def = getInstrumentDefaultRisk(symbol);
      if (def) instrumentRiskOverrides[id] = def;
    }
    const baseJobRiskOverrides = buildJobRiskOverrides(stratIds, backtestInstrumentIds, instrumentSymbols);
    // Only use research config for instruments that passed regime validation (validated !== false).
    // When validation fails (e.g. R_10 with 84% breakout), research often hurts performance — use defaults.
    const validatedIds = new Set(
      (research?.regimeTunes ?? []).filter((r) => r.validated !== false).map((r) => r.instrumentId)
    );
    const useResearch = autoCompare && validatedIds.size > 0;
    const validParamTunes = (research?.paramTunes ?? []).filter((t) => validatedIds.has(t.instrumentId));
    const researchOverrides = useResearch && validParamTunes.length > 0
      ? buildJobRiskOverridesFromParamTunes(validParamTunes)
      : {};
    const jobRiskOverrides = Object.keys(researchOverrides).length > 0
      ? { ...baseJobRiskOverrides, ...researchOverrides }
      : baseJobRiskOverrides;
    const regimeTunes = useResearch && research?.regimeTunes?.length > 0
      ? Object.fromEntries(
          research.regimeTunes
            .filter((r) => validatedIds.has(r.instrumentId))
            .map((r) => [
              r.timeframe ? `${r.instrumentId}|${r.timeframe}` : r.instrumentId,
              r.regimeConfig,
            ])
        )
      : undefined;
    const baseRequest: Omit<BacktestRunRequest, 'regimeTunes' | 'jobRiskOverrides'> = {
      instrumentIds: backtestInstrumentIds,
      strategyIds: stratIds,
      timeframes: selectedTimeframes,
      regimes,
      dateFrom: BACKTEST_DATE_FROM_EARLIEST,
      dateTo,
      instrumentSpreads: Object.keys(instrumentSpreads).length > 0 ? instrumentSpreads : undefined,
      instrumentRiskOverrides: Object.keys(instrumentRiskOverrides).length > 0 ? instrumentRiskOverrides : undefined,
    };
    const requestDefault: BacktestRunRequest = {
      ...baseRequest,
      jobRiskOverrides: Object.keys(baseJobRiskOverrides).length > 0 ? baseJobRiskOverrides : undefined,
    };
    const requestResearch: BacktestRunRequest = {
      ...baseRequest,
      jobRiskOverrides: Object.keys(jobRiskOverrides).length > 0 ? jobRiskOverrides : undefined,
      regimeTunes,
    };
    const request: BacktestRunRequest = requestDefault;
    try {
      if (autoCompare && validatedIds.size > 0) {
        await actions.runBacktestWithCompare(requestDefault, requestResearch);
      } else {
        await actions.runBacktest(request);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed');
    }
  };

  const isRunning = backtest.status === 'running';
  const results = backtest.results;
  const totalProfit = results.reduce((s, r) => s + r.profit, 0);
  const hasLiveConnection = state.brokers.some((b) => b.status === 'connected');
  const totalEstimate = useMemo(() => estimateBacktestJobCount(backtest.runRequest), [backtest.runRequest]);

  const suggestions = useMemo(() => {
    if (!research?.regimeTunes?.length) return [];
    const instIds = backtest.runRequest?.instrumentIds ?? backtestInstrumentIds;
    const stratIdsForSuggestions = backtest.runRequest?.strategyIds ?? stratIds;

    // UI-only suggestions: paramTunes can be extremely large (full grids). We cap/filter what we
    // use for suggestion computation so the browser can't freeze when research completes.
    const MAX_PARAM_TUNES_FOR_SUGGESTIONS = 2500;
    const instIdSet = new Set(instIds);
    const stratIdSet = new Set(stratIdsForSuggestions);
    const paramTunesForSuggestions = research.paramTunes
      .filter((t) => instIdSet.has(t.instrumentId) && stratIdSet.has(t.strategyId))
      .slice(-MAX_PARAM_TUNES_FOR_SUGGESTIONS)
      .map((t) => ({ ...t, profitOOS: t.profitOOS ?? 0, tradesOOS: t.tradesOOS ?? 0 }));

    return computeResearchSuggestions(
      research.baselineResults ?? [],
      research.regimeTunes,
      paramTunesForSuggestions,
      results.map((r) => ({ instrumentId: r.instrumentId, strategyId: r.strategyId, profit: r.profit })),
      instIds,
      stratIdsForSuggestions
    );
  }, [research?.regimeTunes, research?.paramTunes, research?.baselineResults, backtest.runRequest, backtestInstrumentIds, stratIds, results]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ BACKTEST ENGINE ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <div className="flex gap-2">
          {research?.status === 'running' ? (
            <button
              onClick={() => actions.cancelResearch()}
              className="text-[10px] border border-[#ff4444] text-[#ff4444] px-1.5 py-0.5 hover:bg-[#ff444411]"
            >
              [CANCEL]
            </button>
          ) : (
            <button
              onClick={async () => {
                setError(null);
                if (!backtestInstrumentIds.length) { setError('No active instruments.'); return; }
                if (!stratIds.length) { setError('No strategies enabled.'); return; }
                if (!selectedTimeframes.length) { setError('Select at least one timeframe.'); return; }
                const dateTo = new Date().toISOString().slice(0, 10);
                const regimes = regimeMode === 'any_only' ? (['any'] as BacktestRunRequest['regimes']) : (ALL_REGIMES as BacktestRunRequest['regimes']);
                const instrumentSymbols: Record<string, string> = {};
                for (const id of backtestInstrumentIds) {
                  const inst = instruments.find((i) => i.id === id);
                  instrumentSymbols[id] = inst?.symbol ?? id;
                }
                const req: BacktestRunRequest = {
                  instrumentIds: backtestInstrumentIds,
                  strategyIds: stratIds,
                  timeframes: selectedTimeframes,
                  regimes,
                  dateFrom: BACKTEST_DATE_FROM_EARLIEST,
                  dateTo,
                  instrument_symbols: instrumentSymbols,
                  robustMode,
                  regimeGridMax,
                  paramTuneMaxStrat,
                  paramTuneMaxRisk,
                };
                try { await actions.runResearch(req); } catch (e) { setError(e instanceof Error ? e.message : 'Research failed'); }
              }}
              disabled={isRunning || noTimeframesSelected}
              className="text-[10px] border border-[#ff6600] text-[#ff6600] px-1.5 py-0.5 hover:bg-[#ff660011] disabled:opacity-50"
            >
              [RESEARCH]
            </button>
          )}
          <button
            onClick={() => setRobustMode((b) => !b)}
            disabled={isRunning || research?.status === 'running'}
            title={robustMode ? 'Robust mode ON: OOS profit, walk-forward, successive halving' : 'Robust mode OFF: click to enable'}
            className={`text-[10px] px-1.5 py-0.5 border ${robustMode ? 'border-[#00ff00] bg-[#00ff0011 text-[#00ff00]' : 'border-[#ff6600] text-[#ff6600] hover:bg-[#ff660011]'} disabled:opacity-50`}
          >
            [ROBUST]
          </button>
          <button
            onClick={() => setGridExpanded((b) => !b)}
            disabled={isRunning || research?.status === 'running'}
            title="Research grid: regime configs, strategy params, risk params"
            className={`text-[10px] px-1.5 py-0.5 border ${gridExpanded ? 'border-[#00ff00] bg-[#00ff0011 text-[#00ff00]' : 'border-[#ff6600] text-[#ff6600] hover:bg-[#ff660011]'} disabled:opacity-50`}
          >
            [GRID]
          </button>
          <button onClick={run} disabled={isRunning || noTimeframesSelected} className="text-[10px] hover:text-[#ff6600] disabled:opacity-50">[RUN]</button>
          <button onClick={() => actions.cancelBacktest()} disabled={!isRunning} className="text-[10px] text-[#ff4444] hover:text-[#ff6666] disabled:opacity-50">[CANCEL]</button>
          <button
            onClick={() => {
              actions.resetBacktest();
              setError(null);
            }}
            disabled={isRunning}
            className={`text-[10px] hover:text-[#ff6600] transition-opacity duration-200 ${
              isRunning ? 'opacity-50' : results.length === 0 ? 'opacity-40' : 'opacity-100'
            }`}
          >
            [CLEAR]
          </button>
        </div>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        <div className="mb-4">
          <div className="text-[#00ff00] text-[10px] block mb-1">&gt; INSTRUMENT (from Instrument Selection)</div>
          <div className="text-[10px] text-[#ff6600]">
            {selectedIsActive && selectedInstrument
              ? `[RUN] will backtest: ${selectedInstrument.symbol} only. Change selection above to backtest another.`
              : `[RUN] will backtest all active (${activeInstruments.length}). Select an instrument in Instrument Selection to backtest only that one.`}
          </div>
          <div className={`mt-2 px-2 py-1.5 border text-[10px] font-medium ${hasLiveConnection ? 'border-[#00ff00] bg-[#00ff0008 text-[#00ff00]' : 'border-[#ff6600] bg-[#ff660008 text-[#ff6600]'}`}>
            {hasLiveConnection
              ? '● LIVE — Backtest uses live candles from connected brokers when instrument matches.'
              : '● DISCONNECTED — No broker connected. Connect in Brokers panel for live data.'}
          </div>
        </div>

        <div className="mb-4">
          <div className="text-[#00ff00] text-[10px] block mb-1">
            &gt; STRATEGIES ({enabledStrategies.length} of {strategies.length}) — from Strategy Library
          </div>
          <div className="text-[10px] text-[#00ff0080] mb-1.5">
            Backtest and build use only strategies enabled in Strategy Library. Configure there.
            {selection.hasWarnings && (
              <span className="block mt-1 text-[#ff6600]">
                {selection.invalidIds.length > 0 && `${selection.invalidIds.length} invalid/removed filtered. `}
                {selection.missingSignalIds.length > 0 && `${selection.missingSignalIds.length} missing signal filtered. `}
              </span>
            )}
          </div>
          <div className="border border-[#00ff00] bg-black p-2 space-y-1 max-h-24 overflow-auto scrollbar-hide">
            {enabledStrategies.length === 0 ? (
              <div className="text-[10px] text-[#ff6600]">
                No strategies enabled. Enable at least one in Strategy Library.
              </div>
            ) : (
              enabledStrategies.map((s) => (
                <div key={s.id} className="text-[10px] text-[#00ff00]/90">{s.name}</div>
              ))
            )}
          </div>
        </div>

        <div className="mb-4">
          <div className="text-[#00ff00] text-[10px] block mb-1">&gt; REGIME FILTER</div>
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setRegimeMode('any_only')}
              className={`text-[10px] border px-2 py-1 transition-colors ${
                regimeMode === 'any_only'
                  ? 'border-[#00ff00] bg-[#00ff0011 text-[#00ff00]'
                  : 'border-[#00ff00]/40 text-[#00ff00]/60 hover:border-[#00ff00]/70'
              }`}
            >
              Any only (1× jobs) — recommended
            </button>
            <button
              type="button"
              onClick={() => setRegimeMode('all')}
              className={`text-[10px] border px-2 py-1 transition-colors ${
                regimeMode === 'all'
                  ? 'border-[#00ff00] bg-[#00ff0011 text-[#00ff00]'
                  : 'border-[#00ff00]/40 text-[#00ff00]/60 hover:border-[#00ff00]/70'
              }`}
            >
              All regimes (10× jobs)
            </button>
          </div>
          <div className="text-[10px] text-[#00ff0080] mb-3">
            {regimeMode === 'any_only'
              ? 'Enter on any regime (no filter). Fewer jobs, fewer $0 results.'
              : 'One job per regime. Many $0 when regime rarely matches.'}
          </div>
          {gridExpanded && (
            <div className="mb-4 border border-[#ff6600]/60 bg-[#ff660008] px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <span className="text-[#00ff00] text-[10px]">&gt; RESEARCH GRID</span>
                <button
                  type="button"
                  onClick={() => {
                    const isHigh = regimeGridMax === 10000 && paramTuneMaxStrat === 24 && paramTuneMaxRisk === 54;
                    if (isHigh) {
                      setRegimeGridMax(1000);
                      setParamTuneMaxStrat(6);
                      setParamTuneMaxRisk(6);
                    } else {
                      setRegimeGridMax(10000);
                      setParamTuneMaxStrat(24);
                      setParamTuneMaxRisk(54);
                    }
                  }}
                  className={`text-[9px] border px-1.5 py-0.5 transition-colors ${
                    regimeGridMax === 10000 && paramTuneMaxStrat === 24 && paramTuneMaxRisk === 54
                      ? 'border-red-500/80 bg-red-500/15 text-red-400/70'
                      : 'border-[#00ff00]/60 text-[#00ff00]/90 hover:bg-[#00ff0010]'
                  }`}
                  title="Regime 10k, Strat 24, Risk 54 — better coverage when M1 improves but M5 gets worse"
                >
                  High coverage (10k/24/54)
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className="text-[#00ff0080]">Regime:</span>
                <CicadaDropdown
                  options={[
                    { value: 9, label: '9' },
                    { value: 27, label: '27' },
                    { value: 81, label: '81' },
                    { value: 243, label: '243' },
                    { value: 500, label: '500' },
                    { value: 1000, label: '1k' },
                    { value: 10000, label: '10k' },
                    { value: 100000, label: '100k' },
                    { value: 600000, label: '500k+' },
                  ]}
                  value={regimeGridMax}
                  onChange={(v) => setRegimeGridMax(v)}
                  variant="green"
                  compact
                />
                <span className="text-[#00ff0080] ml-1">Strat:</span>
                <CicadaDropdown
                  options={[
                    { value: 1, label: '1' },
                    { value: 2, label: '2' },
                    { value: 6, label: '6' },
                    { value: 12, label: '12' },
                    { value: 24, label: '24' },
                    { value: 50, label: '50' },
                    { value: 100, label: '100' },
                    { value: 200, label: '200' },
                    { value: 10000, label: '10k' },
                    { value: 100000, label: '100k' },
                    { value: 600000, label: '500k+' },
                  ]}
                  value={paramTuneMaxStrat}
                  onChange={(v) => setParamTuneMaxStrat(v)}
                  variant="green"
                  compact
                />
                <span className="text-[#00ff0080] ml-1">Risk:</span>
                <CicadaDropdown
                  options={[
                    { value: 6, label: '6' },
                    { value: 54, label: '54' },
                    { value: 108, label: '108' },
                    { value: 252, label: '252' },
                    { value: 512, label: '512' },
                    { value: 1000, label: '1k' },
                    { value: 10000, label: '10k' },
                    { value: 100000, label: '100k' },
                    { value: 600000, label: '500k+' },
                  ]}
                  value={paramTuneMaxRisk}
                  onChange={(v) => setParamTuneMaxRisk(v)}
                  variant="green"
                  compact
                />
              </div>
              <div className="text-[9px] text-[#00ff0080] mt-1">
                Total jobs = Regime × Strat × Risk. Start small; use High coverage when lower TFs improve but higher TFs get worse.
                Configs must pass OOS validation — check &quot;need review&quot; after run.
              </div>
            </div>
          )}
          {research?.status === 'completed' && (research.regimeTunes.length > 0 || research.paramTunes.length > 0 || (research.skippedInstruments?.length ?? 0) > 0) && (
            <div className="flex items-center gap-2 text-[10px] text-[#00ff00] border border-[#00ff00]/50 bg-[#00ff0008 px-2 py-1 flex-wrap">
              <span>
                Research complete: {research.regimeTunes.length} regime configs, {research.paramTunes.length} param tunes.
                {(research.skippedInstruments?.length ?? 0) > 0 && (
                  <span className="text-[#ff6600] ml-1">
                    ({research.skippedInstruments!.length} instrument(s) skipped)
                  </span>
                )}
                {research.regimeTunes.some((r) => r.validated === false) && (
                  <span className="text-[#ff6600] ml-1">
                    ({research.regimeTunes.filter((r) => r.validated === false).length} regime(s) need review)
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setAutoCompare((v) => !v)}
                title="Run default + research backtest, compare total profit, use best config"
                className={`text-[10px] border px-1.5 py-0.5 transition-colors ${
                  autoCompare ? 'border-[#ff6600] bg-[#ff660022] text-[#ff6600]' : 'border-[#ff6600]/50 text-[#ff6600]/70 hover:border-[#ff6600]/70'
                }`}
              >
                [AUTO-COMPARE]
              </button>
              <button
                type="button"
                onClick={() => actions.clearResearch()}
                className="text-[10px] border border-[#ff6600] text-[#ff6600] px-1.5 py-0.5 hover:bg-[#ff660011]"
              >
                [CLEAR]
              </button>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-col gap-1 border border-[#ffff00]/40 bg-[#ffff0008 px-2 py-1">
              <span className="text-[9px] text-[#ffff00]/90 font-medium">Suggestions:</span>
              {suggestions.slice(0, 4).map((s, i) => (
                <div key={i} className={`text-[9px] ${s.type === 'research_helped' ? 'text-[#00ff00]' : s.type === 'research_hurt' || s.type === 'use_defaults' ? 'text-[#ff6600]' : 'text-[#ffff00]/90'}`}>
                  • {s.message}
                </div>
              ))}
            </div>
          )}
          {research?.status === 'failed' && research.error && (
            <div className="flex items-center gap-2 text-[10px] text-[#ff6600] border border-[#ff6600]/50 bg-[#ff660008 px-2 py-1">
              <span>Research failed: {research.error}</span>
              <button
                type="button"
                onClick={() => actions.clearResearch()}
                className="text-[9px] border border-[#ff6600]/70 text-[#ff6600]/90 px-1 py-0 hover:bg-[#ff660011]"
              >
                ×
              </button>
            </div>
          )}
          {research?.status === 'cancelled' && (
            <div className="flex items-center gap-2 text-[10px] text-[#ff6600] border border-[#ff6600]/50 bg-[#ff660008 px-2 py-1">
              <span>Research cancelled.</span>
              <button
                type="button"
                onClick={() => actions.clearResearch()}
                className="text-[9px] border border-[#ff6600]/70 text-[#ff6600]/90 px-1 py-0 hover:bg-[#ff660011]"
              >
                ×
              </button>
            </div>
          )}
          {research?.status === 'running' && (
            <div className="mb-2">
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-[#ffff00]">&gt; Research: regime + param tune</span>
                <span className="text-[#00ff00]">[{research.progress ?? 0}%]</span>
              </div>
              <div className="text-[9px] text-[#00ff00]/80 mb-1 font-mono">
                {research.currentPhase === 'baseline' && (
                  <span>Phase: baseline | Instrument: {research.currentInstrument ?? '—'} ({research.instrumentIdx ?? '?'}/{research.instrumentTotal ?? '?'})</span>
                )}
                {research.currentPhase === 'regime' && (
                  <span>
                    Phase: regime | {research.currentInstrument ?? '—'} ({research.instrumentIdx ?? '?'}/{research.instrumentTotal ?? '?'})
                    {typeof research.regimeConfigProgress === 'number' && typeof research.regimeConfigTotal === 'number' && (
                      <span> | Config {research.regimeConfigProgress}/{research.regimeConfigTotal}</span>
                    )}
                  </span>
                )}
                {research.currentPhase === 'param' && (
                  <span>
                    Phase: param | {research.currentInstrument ?? '—'} × {research.currentStrategy ?? '—'} × {research.currentRegime ?? '—'} ({research.paramJobDone ?? '?'}/{research.paramJobTotal ?? '?'})
                  </span>
                )}
                {research.currentPhase === 'skip' && (
                  <span>Phase: skip | {research.currentInstrument ?? '—'} (insufficient bars)</span>
                )}
                {!research.currentPhase && <span>Starting…</span>}
              </div>
              <div className="h-2 border border-[#00ff00] bg-black">
                <div
                  className="h-full bg-[#00ff00] transition-all duration-300 shadow-[0_0_10px_rgba(0,255,0,0.5)]"
                  style={{ width: `${Math.min(100, research.progress ?? 0)}%` }}
                />
              </div>
              <EtaDisplay
                isActive={true}
                progress={research.progress ?? 0}
                total={research.total}
                completed={research.completed}
                subProgress={
                  research.currentPhase === 'regime' &&
                  typeof research.regimeConfigProgress === 'number' &&
                  typeof research.regimeConfigTotal === 'number'
                    ? { completed: research.regimeConfigProgress, total: research.regimeConfigTotal }
                    : research.currentPhase === 'param' &&
                        typeof research.paramJobDone === 'number' &&
                        typeof research.paramJobTotal === 'number'
                      ? { completed: research.paramJobDone, total: research.paramJobTotal }
                      : undefined
                }
                status="running"
                fallbackEtaSec={
                  regimeGridMax <= 100 ? 120 : regimeGridMax <= 1000 ? 300 : regimeGridMax <= 10000 ? 600 : 900
                }
                label="Research"
                className="mt-1.5"
              />
            </div>
          )}
          {(research?.status === 'running' || research?.status === 'cancelled' || (research?.status === 'completed' && research.log.length > 0)) && (
            <div ref={researchLogRef} onScroll={handleResearchLogScroll} className="mt-2 border border-[#00ff00]/40 bg-black p-2 h-24 overflow-auto scrollbar-hide font-mono text-[10px] space-y-0.5">
              {research.log.map((entry, i) => {
                const msg = typeof entry === 'string' ? entry : entry.message;
                const level = typeof entry === 'string' ? 'info' : entry.level;
                return (
                  <div key={i} className={`truncate ${logLevelToTextClass(level)}`}>&gt; {msg}</div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mb-4">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="text-[#00ff00] opacity-70 text-[10px]">&gt; TIMEFRAMES (M1 → weekly)</span>
            <span className="text-[#ff6600] text-[10px]">({selectedTimeframes.length} selected)</span>
            <button
              type="button"
              onClick={() => setSelectedTimeframes([...BACKTEST_TIMEFRAMES])}
              className={`text-[10px] border border-[#00ff00] text-[#00ff00] px-1.5 py-0.5 hover:bg-[#00ff0011] transition-opacity duration-200 ${allTimeframesSelected ? 'opacity-40 hover:opacity-70' : 'opacity-100'}`}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelectedTimeframes([])}
              className={`text-[10px] border border-[#ff6600] text-[#ff6600] px-1.5 py-0.5 hover:bg-[#ff660011] transition-opacity duration-200 ${noTimeframesSelected ? 'opacity-40 hover:opacity-70' : 'opacity-100'}`}
            >
              Deselect all
            </button>
            {botForSelected?.timeframes?.length ? (
              <button
                type="button"
                onClick={() => setSelectedTimeframes([...botForSelected.timeframes])}
                className="text-[10px] border border-[#ffff00] text-[#ffff00] px-1.5 py-0.5 hover:bg-[#ffff0011]"
              >
                Sync from bot
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_TIMEFRAMES.map((tf) => {
              const selected = selectedTimeframes.includes(tf);
              const instrumentSupports = selectedInstrument?.timeframes.includes(tf) ?? true;
              return (
                <div
                  key={tf}
                  className={`flex items-center gap-1.5 border px-2 py-1 transition-colors ${
                    selected ? 'border-[#00ff00] bg-[#00ff0011 text-[#00ff00]' : 'border-[#00ff00]/40 text-[#00ff00]/60 hover:border-[#00ff00]/70'
                  } ${!instrumentSupports ? 'opacity-80' : ''}`}
                >
                  <CicadaCheckbox
                    checked={selected}
                    onChange={(checked) => {
                      setSelectedTimeframes((prev) =>
                        checked ? [...prev, tf] : prev.filter((t) => t !== tf)
                      );
                    }}
                    label={tf}
                    size="xs"
                    labelClassName="cursor-pointer"
                  />
                </div>
              );
            })}
          </div>
          {noTimeframesSelected && (
            <div className="mt-2 text-[10px] text-[#ff6600]">
              Select at least one timeframe to run backtest.
            </div>
          )}
        </div>

        <div className="mb-4">
          <BacktestGridVisualization
            isRunning={isRunning}
            progress={backtest.progress}
            completedCount={results.length}
            totalEstimate={totalEstimate}
            status={backtest.status}
            dataSource={hasLiveConnection ? 'live' : 'synthetic'}
            results={results}
            totalProfit={totalProfit}
            profitByScope={backtest.profitByScope}
          />
        </div>

        {(isRunning || backtest.status === 'completed' || backtest.status === 'cancelled' || backtest.status === 'failed') && (
          <div className="mb-4">
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-[#ff6600]">&gt; {backtest.currentPhase}</span>
              <span className="text-[#00ff00]">[{backtest.progress}%]</span>
            </div>
            <div className="h-2 border border-[#00ff00] bg-black">
              <div className="h-full bg-[#00ff00] transition-all shadow-[0_0_10px_rgba(0,255,0,0.5)]" style={{ width: `${backtest.progress}%` }} />
            </div>
            <EtaDisplay
              isActive={isRunning}
              progress={backtest.progress}
              total={totalEstimate}
              completed={results.length}
              status={backtest.status}
              fallbackEtaSec={totalEstimate != null ? Math.max(90, Math.min(900, 90 + totalEstimate * 0.15)) : 150}
              className="mt-1.5"
            />
          </div>
        )}

        {error && (
          <div className="mb-3 p-2 border border-[#ff6600] bg-[#ff660011] text-[#ff6600] text-xs">
            {error}
          </div>
        )}
        <div className="mb-3 p-2 border border-[#00ff00]/50 bg-[#00ff0005] text-[10px] text-[#00ff00]/90">
          <strong>R_10 / volatility:</strong> Use &quot;Any only&quot; regime. For better results: VITE_BACKTEST_STOP_LOSS_PCT=0.04, VITE_BACKTEST_RISK_PER_TRADE_PCT=0.005. See docs/BACKTEST_CONFIG_R10.md.
        </div>
        <div className="border border-[#00ff00]/50 bg-black p-3 mb-3 h-24 overflow-auto scrollbar-hide">
          <div className="text-[10px] space-y-1 font-mono">
            <div className={hasLiveConnection ? 'text-[#00ff00]' : 'text-[#ff6600]'}>
              &gt; OHLCV: {hasLiveConnection ? 'LIVE (from broker when available)' : 'DISCONNECTED (connect broker for live data)'}
            </div>
            <div className="text-[#00ff00]/80">&gt; Regime detection + strategy signals + rule execution → metrics</div>
            <div className="text-[#ff6600]/90">&gt; Run backtest to generate neural bot configs per instrument.</div>
            {isRunning && (
              <div className="text-[#ffff00]">
                &gt; {backtest.currentPhase || 'Processing...'} [{backtest.progress}%] █
              </div>
            )}
            {backtest.status === 'completed' && (
              <div className="text-[#00ff00]">
                &gt; Backtest completed. {results.length} result rows.
                {results.length > 0 && totalProfit === 0 && (() => {
                  const sample = results.find((r) => r.diagnostics);
                  return (
                    <span className="block mt-1 text-[#ff6600]">
                      All $0.00? Check browser console (F12) for diagnostics. Sample:{' '}
                      {sample?.diagnostics
                        ? `bars=${sample.diagnostics.barsCount} signals=${sample.diagnostics.signalsFired} regimeBlocked=${sample.diagnostics.regimeBlocked} — signals=0 means pattern never fired; regimeBlocked&gt;0 means regime filter blocked entries.`
                        : 'No diagnostics (some jobs had trades).'}
                    </span>
                  );
                })()}
              </div>
            )}
            {backtest.status === 'cancelled' && <div className="text-[#ff6600]">&gt; Backtest cancelled. {results.length} result rows (partial).</div>}
            {backtest.status === 'failed' && backtest.runRequest && <div className="text-[#ff4444]">&gt; Backtest failed. Check connection and try again.</div>}
          </div>
        </div>

        {autoCompare && (
          <div className="mb-3 border border-[#ff6600]/60 bg-[#ff660008] p-2">
            <div className="text-[10px] text-[#ff6600] font-medium mb-1.5">AUTO-COMPARE LOG</div>
            {backtest.lastAutoCompareResult && (
              <div className={`text-[10px] mb-1.5 font-mono ${
                backtest.lastAutoCompareResult.winner === 'research' ? 'text-[#00ff00]' : 'text-[#ff6600]'
              }`}>
                &gt; Selected: <strong>{backtest.lastAutoCompareResult.winner.toUpperCase()}</strong> config
                {' '}(default ${backtest.lastAutoCompareResult.profitDefault.toFixed(2)} vs research ${backtest.lastAutoCompareResult.profitResearch.toFixed(2)})
              </div>
            )}
            <div className="max-h-20 overflow-auto scrollbar-hide font-mono text-[10px] space-y-0.5">
              {!backtest.autoCompareLog?.length && !backtest.lastAutoCompareResult && (
                <div className="text-[#ff6600]/80">
                  &gt; {backtest.status === 'running' ? 'Auto-compare in progress...' : 'Run backtest to see auto-compare log (default vs research config).'}
                </div>
              )}
              {backtest.autoCompareLog?.map((entry, i) => (
                <div key={i} className={logLevelToTextClass(entry.level as Parameters<typeof logLevelToTextClass>[0])}>
                  &gt; [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.message}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 text-[10px] text-center border-t border-[#00ff00] pt-2">
          <span className="text-[#ff6600]">MT5_CONNECTION: </span>
          {mt5Status === null ? (
            <span className="text-[#00ff00]/70">— checking...</span>
          ) : mt5Status.connected ? (
            <span className="text-[#00ff00]">● ACTIVE</span>
          ) : !mt5Status.mt5_available ? (
            <span className="text-[#ff6600]">○ N/A</span>
          ) : (
            <span className="text-[#ff6600]">○ INACTIVE</span>
          )}
        </div>
      </div>
    </div>
  );
}
