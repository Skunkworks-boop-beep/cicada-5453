/**
 * Live visual representation of bot execution lifecycle: OHLCV fetch, regime detection,
 * scope selection, NN predict, risk check, order placement. Shows predictions, skips,
 * ignores, and outcomes. Connected to backend for persistent lookback across reloads.
 */

import { useState, useEffect, useMemo } from 'react';
import { Activity, CheckCircle, XCircle, MinusCircle, AlertCircle, Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { useTradingStore } from '../store/TradingStore';
import { getRemoteServerUrl } from '../core/config';
import { isTickContractInstrument } from '../core/tradePnl';
import { getBotExecutionIntervalMs, POSITION_EVAL_INTERVAL_MS } from '../core/botExecution';
import { getDaemonBots } from '../core/api';
import type { BotExecutionEvent, BotExecutionEventPhase, BotExecutionEventOutcome, BotExecutionEventDetails } from '../core/botExecution';

const PHASE_LABELS: Record<BotExecutionEventPhase, string> = {
  fetch_ohlcv: 'OHLCV',
  detect_regime: 'Regime',
  select_scope: 'Scope',
  predict: 'Predict',
  risk_check: 'Risk',
  validate: 'Validate',
  order: 'Order',
  close: 'Close',
  skipped: 'Skip',
  trade_open: 'Trade Open',
  trade_close: 'Trade Close',
  broker: 'Broker',
  sl_modify: 'SL Modify',
  tp_partial: 'TP Partial',
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase as BotExecutionEventPhase] ?? phase.replace(/_/g, ' ');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function outcomeColor(outcome: BotExecutionEventOutcome): string {
  switch (outcome) {
    case 'success':
      return 'text-[#00ff00]';
    case 'fail':
      return 'text-[#ff4444]';
    case 'skip':
      return 'text-[#ffaa00]';
    case 'ignored':
      return 'text-[#888888]';
    case 'disconnect':
      return 'text-[#ff6600]';
    default:
      return 'text-[#00ff00]/70';
  }
}

function outcomeIcon(outcome: BotExecutionEventOutcome) {
  switch (outcome) {
    case 'success':
      return <CheckCircle className="w-3.5 h-3.5 text-[#00ff00]" />;
    case 'fail':
      return <XCircle className="w-3.5 h-3.5 text-[#ff4444]" />;
    case 'skip':
      return <MinusCircle className="w-3.5 h-3.5 text-[#ffaa00]" />;
    case 'ignored':
      return <AlertCircle className="w-3.5 h-3.5 text-[#888888]" />;
    case 'disconnect':
      return <AlertCircle className="w-3.5 h-3.5 text-[#ff6600]" />;
    default:
      return <Activity className="w-3.5 h-3.5 text-[#00ff00]/70" />;
  }
}

function detailsTooltip(d?: BotExecutionEventDetails): string {
  if (!d || Object.keys(d).length === 0) return '';
  const parts: string[] = [];
  if (d.entryPrice != null) parts.push(`Entry: ${Number(d.entryPrice).toFixed(3)}`);
  if (d.exitPrice != null) parts.push(`Exit: ${Number(d.exitPrice).toFixed(3)}`);
  if (d.regime != null) parts.push(`Regime: ${d.regime}`);
  if (d.regimeConfidence != null) parts.push(`Regime confidence: ${(d.regimeConfidence * 100).toFixed(0)}%`);
  if (d.nnConfidence != null) parts.push(`NN confidence: ${(d.nnConfidence * 100).toFixed(0)}%`);
  if (d.scope != null) parts.push(`Scope: ${d.scope}`);
  if (d.style != null) parts.push(`Mode: ${d.style}`);
  if (d.timeframe != null) parts.push(`TF: ${d.timeframe}`);
  if (d.fetchTimeframe != null && d.fetchTimeframe !== d.timeframe) parts.push(`Fetch TF: ${d.fetchTimeframe}`);
  if (d.predictTimeframe != null && d.predictTimeframe !== d.timeframe) parts.push(`Predict TF: ${d.predictTimeframe}`);
  if (d.htfTimeframe != null) parts.push(`HTF: ${d.htfTimeframe}`);
  if (d.pipelineScore != null) parts.push(`Pipeline score: ${d.pipelineScore.toFixed(2)}`);
  if (d.score != null) parts.push(`Score: ${d.score.toFixed(2)}`);
  if (d.volatilityPct != null) parts.push(`Vol: ${(d.volatilityPct * 100).toFixed(2)}%`);
  if (d.regimeLookback != null) parts.push(`Lookback: ${d.regimeLookback}`);
  if (d.equity != null) parts.push(`Equity: $${d.equity.toFixed(2)}`);
  if (d.drawdownPct != null) parts.push(`DD: ${(d.drawdownPct * 100).toFixed(1)}%`);
  if (d.barsCount != null) parts.push(`Bars: ${d.barsCount}`);
  // Cost breakdown for trade close events; surfaces commission/swap/slippage
  // so the operator can see why net P/L diverges from gross.
  const dx = d as BotExecutionEventDetails & {
    grossPnl?: number;
    commission?: number;
    swap?: number;
    slippage?: number;
    holdBars?: number;
    exitReason?: string;
  };
  if (dx.grossPnl != null) parts.push(`Gross: $${dx.grossPnl.toFixed(2)}`);
  if (dx.commission != null && dx.commission !== 0) parts.push(`Comm: $${dx.commission.toFixed(2)}`);
  if (dx.swap != null && dx.swap !== 0) parts.push(`Swap: $${dx.swap.toFixed(2)}`);
  if (dx.slippage != null && dx.slippage !== 0) parts.push(`Slip: $${dx.slippage.toFixed(2)}`);
  if (dx.holdBars != null) parts.push(`Hold: ${dx.holdBars}b`);
  if (dx.exitReason) parts.push(`Reason: ${dx.exitReason}`);
  if (d.reason != null) parts.push(`Reason: ${d.reason}`);
  if (d.agreementCount != null) parts.push(`Agreement: ${d.agreementCount}`);
  if (d.ruleName != null) parts.push(`Rule: ${d.ruleName}`);
  if (d.ruleId != null) parts.push(`RuleId: ${d.ruleId}`);
  return parts.join(' · ');
}

export function BotExecutionLog() {
  const { state, actions } = useTradingStore();
  const { botExecutionLog, execution, bots, portfolio } = state;
  const activeBotIds = useMemo(() => new Set(bots.map((b) => b.id)), [bots]);
  /** Only events for bots that still exist — avoids stale symbol filters after delete. */
  const logForView = useMemo(
    () => botExecutionLog.filter((e) => e.botId && activeBotIds.has(e.botId)),
    [botExecutionLog, activeBotIds]
  );
  const [symbolFilter, setSymbolFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  /**
   * Bot execution loop.
   *
   * Defers to the backend daemon when it's reachable: the FE only ticks if the
   * server-side daemon isn't already running the bot. This keeps the FE
   * compatible with the legacy "browser owns the loop" mode (development /
   * demo-only setups) while giving the backend daemon precedence whenever
   * uvicorn is running.
   */
  const deployedCount = bots.filter((b) => b.status === 'deployed').length;
  const [daemonOwns, setDaemonOwns] = useState<boolean>(false);

  // Probe the daemon list periodically so toggling the backend on/off doesn't
  // require a UI reload.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const bots = await getDaemonBots();
      const nowSec = Date.now() / 1000;
      const activeDaemon = bots.some((bot) =>
        bot.enabled && bot.last_tick_ts > 0 && nowSec - bot.last_tick_ts < 120
      );
      if (!cancelled) setDaemonOwns(activeDaemon);
    };
    void probe();
    const id = setInterval(() => void probe(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [deployedCount]);

  /** Tick even when execution is paused so OHLCV/regime/predict still run (observe-only; no orders). */
  useEffect(() => {
    if (daemonOwns) return;
    const deployed = bots.filter((b) => b.status === 'deployed');
    if (deployed.length === 0) return;
    const intervalMs = getBotExecutionIntervalMs(deployed);
    void actions.tickBotExecution();
    const interval = setInterval(() => actions.tickBotExecution(), intervalMs);
    return () => clearInterval(interval);
  }, [actions, deployedCount, daemonOwns]);

  /** Position-only evaluation: run every 8s when we have open positions. */
  const hasPositions = portfolio.positions.length > 0;
  useEffect(() => {
    if (!execution.enabled || !hasPositions || daemonOwns) return;
    void actions.tickPositionEvaluation();
    const interval = setInterval(() => actions.tickPositionEvaluation(), POSITION_EVAL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [actions, execution.enabled, hasPositions, daemonOwns]);

  useEffect(() => {
    if (!symbolFilter) return;
    const valid = new Set(logForView.map((e) => e.symbol));
    if (!valid.has(symbolFilter)) setSymbolFilter('');
  }, [symbolFilter, logForView]);

  const hasRemote = !!getRemoteServerUrl();

  const stats = { success: 0, fail: 0, skip: 0, ignored: 0 };
  for (const e of logForView) {
    if (e.outcome in stats) (stats as Record<string, number>)[e.outcome]++;
  }

  const symbols = useMemo(
    () => [...new Set(logForView.map((e) => e.symbol))].sort(),
    [logForView]
  );

  const filtered = symbolFilter
    ? logForView.filter(
        (e) =>
          (e.symbol || '').toUpperCase().replace(/\//g, '') ===
          symbolFilter.toUpperCase().replace(/\//g, '')
      )
    : logForView;

  /** Group events by execution cycle (same tick = same cycleId). Newest cycles first. */
  const byCycle = filtered.reduce<Map<string, typeof filtered>>((acc, ev) => {
    const cid = ev.details?.cycleId ?? 'ungrouped';
    const list = acc.get(cid) ?? [];
    list.push(ev);
    acc.set(cid, list);
    return acc;
  }, new Map());
  const cycles = [...byCycle.entries()].sort((a, b) => {
    const ta = a[1][0]?.timestamp ?? '';
    const tb = b[1][0]?.timestamp ?? '';
    return tb.localeCompare(ta);
  });

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ BOT EXECUTION LOG ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className="text-[10px] text-[#ff6600]" title={execution.enabled ? 'Live orders' : 'Observe-only: analysis runs; no broker orders'}>
          {execution.enabled ? '● LIVE' : '○ PAUSED · observe'} · {deployedCount} deployed
        </span>
        {hasRemote && (
          <span className="text-[9px] text-[#00ff00]/60">●</span>
        )}
        {hasRemote && (
          <button
              type="button"
              onClick={async () => {
                setSyncing(true);
                await actions.loadExecutionLogFromBackend({ merge: true });
                setSyncing(false);
              }}
              disabled={syncing}
              className="text-[10px] text-[#00ff00]/80 hover:text-[#00ff00] flex items-center gap-1 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} /> Sync
            </button>
        )}
        {botExecutionLog.length > 0 && (
          <button
              type="button"
              onClick={() => actions.clearBotExecutionLog()}
              className="text-[10px] text-[#ff6600]/80 hover:text-[#ff6600] flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" /> Clear
            </button>
        )}
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-3 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative max-h-[28rem] overflow-hidden flex flex-col">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        {deployedCount === 0 ? (
          <div className="flex-1 flex items-center justify-center text-[#00ff00]/50 text-[10px] py-8">
            Deploy a bot to see execution events
          </div>
        ) : logForView.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-[#00ff00]/50 text-[10px] py-8 gap-2">
            <span>
              {execution.enabled
                ? 'Waiting for next tick… (every 15–120s by scope)'
                : 'Observation ticks running — signals log here; enable BOT EXECUTION to place orders.'}
            </span>
            {hasRemote && (
              <button
                  type="button"
                  onClick={async () => {
                    setSyncing(true);
                    await actions.loadExecutionLogFromBackend();
                    setSyncing(false);
                  }}
                  disabled={syncing}
                  className="text-[#00ff00]/80 hover:text-[#00ff00] text-[9px]"
                >
                  Load from backend
                </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-2 text-[9px] text-[#00ff00]/70 flex-wrap">
              <span className="flex items-center gap-1">
                <CheckCircle className="w-3 h-3 text-[#00ff00]" /> {stats.success}
              </span>
              <span className="flex items-center gap-1">
                <XCircle className="w-3 h-3 text-[#ff4444]" /> {stats.fail}
              </span>
              <span className="flex items-center gap-1">
                <MinusCircle className="w-3 h-3 text-[#ffaa00]" /> {stats.skip}
              </span>
              <span className="flex items-center gap-1">
                <AlertCircle className="w-3 h-3 text-[#888888]" /> {stats.ignored}
              </span>
              {symbols.length > 1 && (
                <select
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  className="bg-black border border-[#00ff00]/50 text-[#00ff00] text-[9px] px-1 py-0.5"
                >
                  <option value="">All symbols</option>
                  {symbols.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-hide space-y-0.5 pr-1">
              {cycles.map(([cycleId, evs]) => {
                const firstTs = evs[0]?.timestamp;
                const cycleLabel = cycleId === 'ungrouped' ? 'Earlier' : formatTime(firstTs ?? '');
                return (
                  <div key={cycleId} className="mb-2">
                    <div className="text-[9px] text-[#00ff00]/40 mb-1 px-2 py-0.5 border-b border-[#00ff00]/20">
                      Run {cycleLabel}
                    </div>
                    {evs.map((ev) => {
                      const hasDetails = ev.details && Object.keys(ev.details).length > 0;
                      const isExpanded = expandedId === ev.id;
                      return (
                        <div
                          key={ev.id}
                          className="border-b border-[#00ff00]/10 last:border-0"
                        >
                          <div
                            className={`flex items-start gap-2 py-1.5 px-2 hover:bg-[#00ff0005] text-[10px] cursor-pointer ${hasDetails ? '' : ''}`}
                            onClick={() => hasDetails && setExpandedId(isExpanded ? null : ev.id)}
                          >
                            {hasDetails && (
                              <span className="shrink-0 text-[#00ff00]/50">
                                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              </span>
                            )}
                            {!hasDetails && <span className="w-3 shrink-0" />}
                            <span className="text-[#00ff00]/50 shrink-0 font-mono">
                              {formatTime(ev.timestamp)}
                            </span>
                            <span className="text-[#ff6600] shrink-0 font-medium">{ev.symbol}</span>
                            <span className="shrink-0 px-1 py-0.5 rounded bg-[#00ff00]/10 text-[#00ff00]/90">
                              {phaseLabel(ev.phase)}
                            </span>
                            <span className="shrink-0">{outcomeIcon(ev.outcome)}</span>
                            <span className={`flex-1 min-w-0 ${outcomeColor(ev.outcome)}`}>{ev.message}</span>
                            {ev.details?.regime && (
                              <span className="shrink-0 text-[#00ff00]/60">{ev.details.regime}</span>
                            )}
                            {ev.details?.scope && (
                              <span className="shrink-0 text-[#ffff00]/80">{ev.details.scope}</span>
                            )}
                            {ev.details?.action !== undefined && ev.details.action !== 2 && (
                              <span className="shrink-0 text-[#ff6600]">
                                {ev.details.action === 0 ? 'LONG' : ev.details.action === 1 ? 'SHORT' : ''}
                              </span>
                            )}
                            {ev.details?.entryPrice != null && (
                              <span className="shrink-0 text-[#00ff00]/80">Entry: {Number(ev.details.entryPrice).toFixed(3)}</span>
                            )}
                            {ev.details?.exitPrice != null && !isTickContractInstrument(ev.details?.instrumentId ?? '', ev.symbol) && (
                              <span className="shrink-0 text-[#ff6600]/80">Exit: {Number(ev.details.exitPrice).toFixed(3)}</span>
                            )}
                          </div>
                          {isExpanded && hasDetails && ev.details && (
                            <div className="px-2 pb-2 pt-0 text-[9px] text-[#00ff00]/70 space-y-1 bg-[#000000]/50">
                              {ev.details.entryPrice != null && <div>Entry price: {Number(ev.details.entryPrice).toFixed(3)}</div>}
                              {ev.details.exitPrice != null && !isTickContractInstrument(ev.details?.instrumentId ?? '', ev.symbol) && <div>Exit price (target): {Number(ev.details.exitPrice).toFixed(3)}</div>}
                              {ev.details.regime != null && <div>Regime: {ev.details.regime}</div>}
                              {ev.details.regimeConfidence != null && (
                                <div>Confidence: {(ev.details.regimeConfidence * 100).toFixed(0)}%</div>
                              )}
                              {ev.details.scope != null && <div>Scope: {ev.details.scope}</div>}
                              {ev.details.timeframe != null && <div>Timeframe: {ev.details.timeframe}</div>}
                              {ev.details.volatilityPct != null && (
                                <div>Volatility: {(ev.details.volatilityPct * 100).toFixed(2)}%</div>
                              )}
                              {ev.details.regimeLookback != null && (
                                <div>Lookback: {ev.details.regimeLookback} bars</div>
                              )}
                              {ev.details.equity != null && <div>Equity: ${ev.details.equity.toFixed(2)}</div>}
                              {ev.details.drawdownPct != null && (
                                <div>Drawdown: {(ev.details.drawdownPct * 100).toFixed(1)}%</div>
                              )}
                              {ev.details.barsCount != null && <div>Bars: {ev.details.barsCount}</div>}
                              {ev.details.reason != null && <div>Reason: {ev.details.reason}</div>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="mt-2 pt-2 border-t border-[#00ff00]/20 flex items-center gap-3 text-[9px] text-[#00ff00]/60">
          <span className="flex items-center gap-1">
            <CheckCircle className="w-3 h-3 text-[#00ff00]" /> success
          </span>
          <span className="flex items-center gap-1">
            <XCircle className="w-3 h-3 text-[#ff4444]" /> fail
          </span>
          <span className="flex items-center gap-1">
            <MinusCircle className="w-3 h-3 text-[#ffaa00]" /> skip
          </span>
          <span className="flex items-center gap-1">
            <AlertCircle className="w-3 h-3 text-[#888888]" /> ignored
          </span>
          {hasRemote && (
            <span className="text-[#00ff00]/50 shrink-0">Backend sync</span>
          )}
        </div>
      </div>
    </div>
  );
}
