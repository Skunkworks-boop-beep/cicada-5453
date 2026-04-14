/**
 * Live Portfolio: balance, equity, open positions, and P/L.
 * Data comes only from live broker receival (sync/connect). When disconnected we do not
 * derive metrics from cached positions — we show last known balance only and mark as stale.
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTradingStore } from '../store/TradingStore';
import { isTickContractInstrument } from '../core/tradePnl';
import { logLevelToTextClass } from '../core/logTheme';
type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

/** Portfolio price tick interval (slightly slower to reduce broker load). */
const PORTFOLIO_TICK_MS = 5_000;
/** Balance sync interval (avoid frequent balance requests). */
const BALANCE_SYNC_MS = 10_000;
/** Position sync interval — detect closed positions and log them. */
const POSITIONS_SYNC_MS = 15_000;

export function LivePortfolio() {
  const { state, actions } = useTradingStore();
  const { portfolio, execution, brokers, closedTradesByBot } = state;
  const hasLiveConnection = brokers.some((b) => b.status === 'connected');
  const connectedNoData = hasLiveConnection && portfolio.dataSource === 'none';
  const hasData = portfolio.dataSource !== 'none';
  const isDerivConnection = portfolio.dataSource === 'deriv';
  /** Equity and P/L only from live receival when connected; when disconnected use balance only, no derived P/L. */
  const useLiveMetrics = hasData && hasLiveConnection;
  /** Show positions when we have data (live or persisted); persisted positions survive refresh. */
  const displayPositions = hasData ? portfolio.positions : [];
  /** Closed trades from broker only (Deriv profit_table). No estimated values. */
  const closedTradesList = Object.values(closedTradesByBot ?? {})
    .flat()
    .filter((t) => t.contractId != null)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  const equity = isDerivConnection ? portfolio.balance : (useLiveMetrics ? (portfolio.equity ?? portfolio.balance + portfolio.totalPnl) : portfolio.balance);
  const syncAttempted = useRef(false);
  const syncTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncFadeOut, setSyncFadeOut] = useState(false);

  useEffect(() => {
    if (!connectedNoData || syncAttempted.current) return;
    syncAttempted.current = true;
    actions.syncPortfolioBalance().finally(() => { syncAttempted.current = false; });
  }, [connectedNoData, actions]);

  useEffect(() => () => {
    syncTimeoutsRef.current.forEach((t) => clearTimeout(t));
  }, []);

  /** Isolated: tick portfolio prices only when this component is mounted and we have positions. */
  useEffect(() => {
    if (!hasLiveConnection || !hasData || portfolio.positions.length === 0) return;
    const interval = setInterval(() => actions.tickPortfolioPrices(), PORTFOLIO_TICK_MS);
    return () => clearInterval(interval);
  }, [actions, hasLiveConnection, hasData, portfolio.positions.length]);

  /** Isolated: sync balance only when this component is mounted and connected. */
  useEffect(() => {
    if (!hasLiveConnection) return;
    actions.syncPortfolioBalance();
    const interval = setInterval(() => actions.syncPortfolioBalance(), BALANCE_SYNC_MS);
    return () => clearInterval(interval);
  }, [actions, hasLiveConnection]);

  /** Isolated: sync positions periodically to detect closed trades and log them. */
  useEffect(() => {
    if (!hasLiveConnection || !hasData || portfolio.positions.length === 0) return;
    actions.syncBrokerPositions().catch(() => {});
    const interval = setInterval(() => actions.syncBrokerPositions().catch(() => {}), POSITIONS_SYNC_MS);
    return () => clearInterval(interval);
  }, [actions, hasLiveConnection, hasData, portfolio.positions.length]);

  const handleSyncPositions = async () => {
    syncTimeoutsRef.current.forEach((t) => clearTimeout(t));
    syncTimeoutsRef.current = [];
    setSyncError(null);
    setSyncStatus('syncing');
    try {
      await actions.syncBrokerPositions();
      setSyncStatus('synced');
      setSyncFadeOut(false);
      syncTimeoutsRef.current = [
        setTimeout(() => setSyncFadeOut(true), 1800),
        setTimeout(() => {
          setSyncStatus('idle');
          setSyncError(null);
        }, 2500),
      ];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSyncError(msg);
      setSyncStatus('error');
      setSyncFadeOut(false);
      syncTimeoutsRef.current = [
        setTimeout(() => setSyncFadeOut(true), 3200),
        setTimeout(() => {
          setSyncStatus('idle');
          setSyncError(null);
        }, 4000),
      ];
    }
  };

  const fmt = (n: number) => (hasData ? `$${n.toFixed(2)}` : '—');
  const pct = (n: number) => (useLiveMetrics ? `${(n * 100).toFixed(1)}%` : '—');

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ LIVE PORTFOLIO ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className={`text-[10px] font-medium ${hasLiveConnection ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
          {hasData ? (hasLiveConnection ? 'LIVE' : 'Stale — reconnect for live') : 'No data'}
        </span>
        {hasLiveConnection && (
          <>
            <button
                type="button"
                onClick={handleSyncPositions}
                disabled={syncStatus === 'syncing'}
                className="text-[10px] border border-[#00ff00] text-[#00ff00] px-1.5 py-0.5 hover:bg-[#00ff0011] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {syncStatus === 'syncing' ? 'Syncing…' : 'Sync positions'}
              </button>
            {(syncStatus === 'synced' || syncStatus === 'error') && (
              <span
                className={`text-[10px] transition-opacity duration-300 ${syncFadeOut ? 'opacity-0' : 'opacity-100'} ${syncStatus === 'synced' ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}
              >
                {syncStatus === 'synced' ? 'Synced' : syncError ?? 'Sync failed'}
              </span>
            )}
          </>
        )}
        <span className={`text-[10px] ${execution.enabled ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
          {execution.enabled ? '● BOTS ACTIVE' : '○ BOTS PAUSED'}
        </span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        {!hasData && (
          <div className="border border-[#ff6600]/60 bg-[#ff660008] p-3 mb-4 text-[#ff6600] text-[10px]">
            <div className="font-medium mb-1">&gt; NO DATA AVAILABLE</div>
            <div className="opacity-90 mb-2">Connect a broker (Deriv API, eXness API, or MT5 add-on) for live balance and positions. Positions opened on the broker are synced on connect and via Sync positions.</div>
            {connectedNoData && (
              <div className="flex gap-2 flex-wrap">
                <button
                    type="button"
                    onClick={() => actions.syncPortfolioBalance()}
                    className="border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] hover:bg-[#00ff0011]"
                  >
                    Sync balance
                  </button>
                <button
                    type="button"
                    onClick={handleSyncPositions}
                    disabled={syncStatus === 'syncing'}
                    className="border border-[#00ff00] text-[#00ff00] px-2 py-1 text-[10px] hover:bg-[#00ff0011] disabled:opacity-50"
                  >
                    {syncStatus === 'syncing' ? 'Syncing…' : 'Sync positions'}
                  </button>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="border border-[#00ff00] p-2">
            <div className="text-[10px] text-[#00ff00] opacity-70 mb-1">&gt; BALANCE</div>
            <div className="text-sm text-[#00ff00]">{fmt(portfolio.balance)}</div>
          </div>
          <div className="border border-[#00ff00] p-2">
            <div className="text-[10px] text-[#00ff00] opacity-70 mb-1">&gt; EQUITY</div>
            <div className="text-sm text-[#00ff00]">{fmt(equity)}</div>
          </div>
          <div className="border border-[#00ff00] p-2">
            <div className="text-[10px] text-[#00ff00] opacity-70 mb-1">&gt; OPEN_P/L</div>
            <div className={`text-sm flex items-center gap-1 ${!isDerivConnection && useLiveMetrics ? (portfolio.totalPnl >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]') : 'text-[#00ff00]/70'}`}>
              {!isDerivConnection && useLiveMetrics ? `${portfolio.totalPnl >= 0 ? '▲' : '▼'} $${Math.abs(portfolio.totalPnl).toFixed(2)}` : '—'}
            </div>
          </div>
          <div className="border border-[#00ff00] p-2">
            <div className="text-[10px] text-[#00ff00] opacity-70 mb-1">&gt; DRAWDOWN</div>
            <div className={`text-sm ${!isDerivConnection && useLiveMetrics && (portfolio.drawdownPct ?? 0) > 0.1 ? 'text-[#ff6600]' : 'text-[#00ff00]'}`}>
              {!isDerivConnection && useLiveMetrics ? pct(portfolio.drawdownPct ?? 0) : '—'}
            </div>
          </div>
        </div>

        <div className="text-xs">
          {!useLiveMetrics && hasData && (
            <div className="text-[10px] text-[#ff6600]/90 mb-2">Positions shown only when connected. Reconnect and sync for live positions.</div>
          )}
          <div className="grid grid-cols-11 gap-2 items-center text-[10px] text-[#00ff00] opacity-70 pb-2 border-b border-[#00ff00]">
            <div className="text-left">&gt; STATUS</div>
            <div className="text-left">&gt; INST</div>
            <div className="text-center">&gt; TYPE</div>
            <div className="text-right">&gt; LOT</div>
            <div className="text-right">&gt; ENTRY</div>
            <div className="text-right">&gt; EXIT</div>
            <div className="text-right">&gt; P/L</div>
            <div className="text-right">&gt; %</div>
            <div className="text-center">&gt; SCOPE</div>
            <div className="text-center">&gt; CLOSED</div>
            <div className="text-center">&gt; ACTIONS</div>
          </div>

          <div className="space-y-1 mt-2">
            {displayPositions.length === 0 ? (
              <div className="py-4 text-center text-[10px] text-[#ff6600]/80 border-b border-[#00ff00]/30">
                {useLiveMetrics ? 'No open positions. Use Sync positions to refresh.' : 'No open positions. Connect a broker and sync positions.'}
              </div>
            ) : (
              <>
                {displayPositions.map((pos) => {
                  const hasValidQuote = Number.isFinite(pos.currentPrice) && pos.currentPrice > 0;
                  const displayCurrent = hasValidQuote ? pos.currentPrice : pos.entryPrice;
                  const displayPnl = !isDerivConnection && useLiveMetrics && hasValidQuote ? pos.pnl : null;
                  const displayPnlPct = !isDerivConnection && useLiveMetrics && hasValidQuote ? pos.pnlPercent : null;
                  const isDerivTick = isTickContractInstrument(pos.instrumentId, pos.instrument);
                  const displayExit = isDerivTick ? undefined : (pos.takeProfit ?? pos.stopLoss ?? displayCurrent);
                  return (
                    <div key={pos.id} className="grid grid-cols-11 gap-2 items-center py-2 border-b border-[#00ff0011] hover:bg-[#00ff0011]">
                      <div className="text-left text-[10px]"><span className="text-[#00ff00] font-medium">OPEN</span></div>
                      <div className="text-left text-[#ff6600] text-[10px]">{pos.instrument}</div>
                      <div className={`text-center text-[10px] ${pos.type === 'LONG' ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>{pos.type}</div>
                      <div className="text-right text-[#00ff00] text-[10px]">{pos.size != null ? pos.size.toFixed(2) : '—'}</div>
                      <div className="text-right text-[#00ff00] text-[10px]">{Number(pos.entryPrice).toFixed(3)}</div>
                      <div className="text-right text-[#00ff00] text-[10px]">{displayExit != null ? Number(displayExit).toFixed(3) : '—'}{!hasValidQuote && !isDerivTick && (pos.takeProfit ?? pos.stopLoss) == null && pos.entryPrice > 0 ? ' *' : ''}</div>
                      <div className={`text-right text-[10px] ${displayPnl != null && displayPnl >= 0 ? 'text-[#00ff00]' : displayPnl != null ? 'text-[#ff6600]' : 'text-[#00ff00]/70'}`}>
                        {displayPnl != null ? (displayPnl >= 0 ? '+' : '') + '$' + displayPnl.toFixed(2) : '—'}
                      </div>
                      <div className={`text-right text-[10px] ${displayPnlPct != null && displayPnlPct >= 0 ? 'text-[#00ff00]' : displayPnlPct != null ? 'text-[#ff6600]' : 'text-[#00ff00]/70'}`}>
                        {displayPnlPct != null ? (displayPnlPct >= 0 ? '+' : '') + displayPnlPct.toFixed(2) + '%' : '—'}
                      </div>
                      <div className="text-center text-[10px] text-[#ffff00]">{pos.scope ?? '—'}</div>
                      <div className="text-center text-[10px] text-[#00ff00]/70">—</div>
                      <div className="flex justify-center items-center">
                        <button
                          type="button"
                          onClick={() => actions.removePosition(pos.id)}
                          className="text-[#ff4444] hover:text-[#ff0000] p-1 rounded border border-[#ff4444]/50 hover:border-[#ff0000]/70 transition-colors"
                          title="Remove position from portfolio (does not close on broker)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {displayPositions.some((p) => !isTickContractInstrument(p.instrumentId, p.instrument) && !(Number.isFinite(p.currentPrice) && p.currentPrice > 0) && p.entryPrice > 0 && (p.takeProfit ?? p.stopLoss) == null) && (
          <div className="text-[10px] text-[#00ff00]/70 mt-1">* Exit = current (no TP/SL). P/L shown as — when no quote.</div>
        )}
        {!useLiveMetrics && hasData && (
          <div className="flex items-center justify-start text-left text-[10px] text-[#ff6600]/90 mb-1 py-1">Metrics from live connection only. Reconnect to see P/L and drawdown.</div>
        )}
      </div>

      <div className="mt-4 border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>
        <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-3">
          <span>[ CLOSED TRADES ]</span>
          <div className="flex-1 border-b border-[#00ff00]"></div>
          {closedTradesList.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => actions.runBackwardValidation()}
                disabled={state.backwardValidation?.status === 'running'}
                className="text-[10px] border border-[#00ff00] text-[#00ff00] px-2 py-1 hover:bg-[#00ff0011] disabled:opacity-50"
                title="Analyze closed trades to find calibrations that would have been profitable"
              >
                {state.backwardValidation?.status === 'running' ? 'Running...' : '[BACKWARD VALIDATE]'}
              </button>
              {state.backwardValidation && (
                <button
                  type="button"
                  onClick={() => actions.clearBackwardValidation()}
                  className="text-[10px] border border-[#00ff00]/60 text-[#00ff00]/80 px-2 py-1 hover:bg-[#00ff0011]"
                  title="Clear backward validation results"
                >
                  Clear validation
                </button>
              )}
              <button
                type="button"
                onClick={() => actions.clearClosedTrades()}
                className="text-[10px] border border-[#ff6600] text-[#ff6600] px-2 py-1 hover:bg-[#ff660011]"
              >
                Clear all
              </button>
            </>
          )}
        </div>
        <div className="grid grid-cols-10 gap-2 items-center text-[10px] text-[#00ff00] opacity-70 pb-2 border-b border-[#00ff00]">
          <div className="text-center">&gt; STATUS</div>
          <div className="text-center">&gt; INST</div>
          <div className="text-center">&gt; TYPE</div>
          <div className="text-center">&gt; LOT</div>
          <div className="text-center">&gt; ENTRY</div>
          <div className="text-center">&gt; EXIT</div>
          <div className="text-center">&gt; P/L</div>
          <div className="text-center">&gt; %</div>
          <div className="text-center">&gt; SCOPE</div>
          <div className="text-center">&gt; CLOSED</div>
        </div>
        {!hasLiveConnection && closedTradesList.length > 0 && (
          <div className="py-2 px-2 border-b border-[#ff6600]/50 bg-[#ff660008] text-[#ff6600] text-[10px]">
            ⚠ Broker disconnected — closed trades below may be stale. Connect broker for live P/L.
          </div>
        )}
        <div className="space-y-1 mt-2">
          {closedTradesList.length === 0 ? (
            <div className="py-4 text-center text-[10px] text-[#ff6600]/80 border-b border-[#00ff00]/30">
              No closed trades yet.
            </div>
          ) : (
            closedTradesList.map((t, i) => {
              const symbol = state.instruments.find((inst) => inst.id === t.instrumentId)?.symbol ?? t.instrumentId;
              const isDerivTick = isTickContractInstrument(t.instrumentId, symbol);
              const entryValid = t.entryPrice != null && Number.isFinite(t.entryPrice) && t.entryPrice >= 100;
              const exitValid = !isDerivTick && t.exitPrice != null && Number.isFinite(t.exitPrice) && t.exitPrice > 0;
              const exitDisplay = exitValid;
              const entryDisplay = entryValid;
              const pctFromPrices = !isDerivTick && entryValid && exitValid
                ? (t.type === 'LONG'
                  ? ((t.exitPrice! - t.entryPrice!) / t.entryPrice!) * 100
                  : ((t.entryPrice! - t.exitPrice!) / t.entryPrice!) * 100)
                : null;
              const pctSensible = !isDerivTick && pctFromPrices != null && Math.abs(pctFromPrices) <= 9999;
              const displayPct = isDerivConnection || isDerivTick ? null : (pctSensible ? pctFromPrices : t.pnlPercent);
              return (
              <div key={`${t.id}-${t.closedAt ?? ''}-${i}`} className="grid grid-cols-10 gap-2 items-center py-2 border-b border-[#00ff0011] hover:bg-[#00ff0011]">
                <div className="text-center text-[10px]"><span className="text-[#ff6600] font-medium">CLOSED</span></div>
                <div className="text-center text-[#ff6600] text-[10px]">{state.instruments.find((inst) => inst.id === t.instrumentId)?.symbol ?? t.instrumentId}</div>
                <div className={`text-center text-[10px] ${t.type === 'LONG' ? 'text-[#00ff00]' : t.type === 'SHORT' ? 'text-[#ff6600]' : 'text-[#00ff00]/70'}`}>{t.type ?? '—'}</div>
                <div className="text-center text-[#00ff00] text-[10px]">{t.size != null ? Number(t.size).toFixed(2) : '—'}</div>
                <div className="text-center text-[#00ff00] text-[10px]">{entryDisplay ? Number(t.entryPrice).toFixed(3) : '—'}</div>
                <div className="text-center text-[#00ff00] text-[10px]">{exitDisplay ? Number(t.exitPrice).toFixed(3) : '—'}</div>
                <div className={`text-center text-[10px] ${!isDerivConnection && !isDerivTick && t.pnl >= 0 ? 'text-[#00ff00]' : !isDerivConnection && !isDerivTick ? 'text-[#ff6600]' : 'text-[#00ff00]/70'}`}>
                  {!isDerivConnection && !isDerivTick ? ((t.pnl >= 0 ? '+' : '') + '$' + (t.pnl ?? 0).toFixed(2)) : '—'}
                </div>
                <div className={`text-center text-[10px] ${!isDerivConnection && !isDerivTick && (displayPct ?? 0) >= 0 ? 'text-[#00ff00]' : !isDerivConnection && !isDerivTick ? 'text-[#ff6600]' : 'text-[#00ff00]/70'}`}>
                  {!isDerivConnection && !isDerivTick && displayPct != null && Number.isFinite(displayPct)
                    ? ((displayPct >= 0 ? '+' : '') + displayPct.toFixed(2) + '%')
                    : '—'}
                </div>
                <div className="text-center text-[10px] text-[#ffff00]">{t.scope ?? '—'}</div>
                <div className="text-center text-[10px] text-[#00ff00]/70">{t.closedAt ? new Date(t.closedAt).toLocaleString() : '—'}</div>
              </div>
            );
            })
          )}
        </div>
        {state.backwardValidation?.status === 'completed' && (
          <div className="mt-2 py-2 px-2 border border-[#00ff00]/50 bg-[#00ff0008] text-[#00ff00] text-[10px]">
            Backward validation: {state.backwardValidation.summary.verified} trades verified, {Object.keys(state.backwardValidation.calibrationHints).length} calibration hints. Use [RESEARCH] to apply.
          </div>
        )}
        {state.backwardValidation?.status === 'failed' && state.backwardValidation.error && (
          <div className="mt-2 py-2 px-2 border border-[#ff6600]/50 bg-[#ff660008] text-[#ff6600] text-[10px]">
            {state.backwardValidation.error}
          </div>
        )}
        {(state.backwardValidation?.status === 'running' || state.backwardValidation?.status === 'completed') && (state.backwardValidation?.log?.length ?? 0) > 0 && (
          <div className="mt-2 border border-[#00ff00]/40 bg-black p-2 max-h-20 overflow-auto font-mono text-[10px] space-y-0.5">
            {state.backwardValidation!.log.map((entry, i) => (
              <div key={i} className={`truncate ${logLevelToTextClass(entry.level)}`}>&gt; {entry.message}</div>
            ))}
          </div>
        )}
        <div className="mt-3 pt-2 border-t border-[#00ff00] space-y-1">
          {(() => {
            if (isDerivConnection) {
              return (
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-[#ff6600]">&gt; TOTAL_P/L:</span>
                  <span className="text-[10px] text-[#00ff00]/70">—</span>
                </div>
              );
            }
            const openPnl = Number.isFinite(portfolio.totalPnl) ? portfolio.totalPnl : 0;
            const realizedPnl = Object.values(closedTradesByBot ?? {}).flat().filter((t) => t.contractId != null).reduce((s, t) => s + (t.pnl ?? 0), 0);
            const totalPnl = openPnl + realizedPnl;
            const totalPct = portfolio.balance > 0 && Number.isFinite(totalPnl) ? (totalPnl / portfolio.balance) * 100 : 0;
            const showTotal = hasData && Number.isFinite(totalPnl);
            return (
              <>
                {realizedPnl !== 0 && (
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-[#ff6600]">&gt; REALIZED_P/L:</span>
                    <span className={`text-[10px] ${realizedPnl >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
                      {(realizedPnl >= 0 ? '+' : '') + '$' + realizedPnl.toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-[#ff6600]">&gt; TOTAL_P/L:</span>
                  <span className={`text-[10px] ${showTotal ? (totalPnl >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]') : 'text-[#00ff00]/70'}`}>
                    {showTotal
                      ? `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${Number.isFinite(totalPct) ? (totalPct >= 0 ? '+' : '') + totalPct.toFixed(2) : '0'}%)`
                      : '—'}
                  </span>
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
