/**
 * Backtest results grid with longitude/latitude lines.
 * Displays each result as a dot-in-rectangle card with info.
 * Custom tactical hover display.
 */

import { useMemo, Fragment, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { BacktestResultRow, TradeScope } from '../core/types';
import type { ProfitByScope } from '../core/backtest';

function ResultHoverDisplay({
  result,
  anchorRef,
  statusColor,
  onMouseEnter,
  onMouseLeave,
}: {
  result: BacktestResultRow;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  statusColor: { primary: string };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const run = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const popW = 180;
      const popH = 120;
      let x = rect.left + rect.width / 2 - popW / 2;
      let y = rect.top - popH - 8;
      if (x < 8) x = 8;
      if (x + popW > viewW - 8) x = viewW - popW - 8;
      if (y < 8) y = rect.bottom + 8;
      if (y + popH > viewH - 8) y = rect.top - popH - 8;
      setPos({ x, y });
    };
    const id = requestAnimationFrame(() => run());
    return () => cancelAnimationFrame(id);
  }, [anchorRef, result.id]);

  if (!pos) return null;

  return (
    <div
      className="fixed z-[10001] border-2 bg-black/98 p-2.5 font-mono text-[9px] shadow-[0_0_20px_rgba(0,255,0,0.15)]"
      style={{
        left: pos.x,
        top: pos.y,
        borderColor: statusColor.primary,
        boxShadow: `0 0 20px ${statusColor.primary}20`,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="absolute top-0 left-0 w-2 h-2 border-l-2 border-t-2" style={{ borderColor: statusColor.primary }} />
      <div className="absolute top-0 right-0 w-2 h-2 border-r-2 border-t-2" style={{ borderColor: statusColor.primary }} />
      <div className="absolute bottom-0 left-0 w-2 h-2 border-l-2 border-b-2" style={{ borderColor: statusColor.primary }} />
      <div className="absolute bottom-0 right-0 w-2 h-2 border-r-2 border-b-2" style={{ borderColor: statusColor.primary }} />
      <div className="space-y-1.5 pl-1">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{
              backgroundColor: result.profit >= 0 ? '#00ff00' : '#ff6600',
              boxShadow: `0 0 4px ${result.profit >= 0 ? '#00ff00' : '#ff6600'}60`,
            }}
          />
          <span className="text-[#ff6600] font-bold">{result.instrumentSymbol}</span>
          <span className={`font-bold ${result.profit >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
            ${result.profit.toFixed(2)}
          </span>
        </div>
        <div className="text-[#00ff00]/90 truncate">&gt; {result.strategyName}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[#00ff00]/70">
          <span className="text-[#ffff00]">{result.timeframe}</span>
          <span title="Trade mode (scope)">mode: {result.scope}</span>
          <span>Win: {result.winRate.toFixed(1)}%</span>
          <span>Trades: {result.trades}</span>
          <span>{result.regime}</span>
        </div>
        {result.strategyParams && Object.keys(result.strategyParams).length > 0 && (
          <div className="text-[#00ff00]/50 text-[8px]">
            {Object.entries(result.strategyParams).map(([k, v]) => `${k}=${v}`).join(' · ')}
          </div>
        )}
        {result.diagnostics && result.trades === 0 && (
          <div className="text-[#ffff00]/80 text-[8px] border-t border-[#00ff00]/30 pt-1 mt-1">
            {result.diagnostics.zeroTradeReason ?? `bars=${result.diagnostics.barsCount} signals=${result.diagnostics.signalsFired} regimeBlocked=${result.diagnostics.regimeBlocked}`}
            {result.diagnostics.signalDirectionDistribution && (
              <div className="text-[7px] text-[#00ff00]/60 mt-0.5">
                long={result.diagnostics.signalDirectionDistribution.long} short={result.diagnostics.signalDirectionDistribution.short}
              </div>
            )}
            {Object.keys(result.diagnostics.regimeDistribution).length > 0 && (
              <div className="text-[7px] text-[#00ff00]/60 mt-0.5">
                regimes: {Object.entries(result.diagnostics.regimeDistribution).map(([k, v]) => `${k}:${v}`).join(' ')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const PIPELINE_STAGES = [
  { id: 'ohlcv', label: 'OHLCV', desc: 'Bars' },
  { id: 'regime', label: 'REGIME', desc: 'Detect' },
  { id: 'signals', label: 'SIGNALS', desc: 'Strategy' },
  { id: 'sim', label: 'EXECUTION', desc: 'PnL' },
  { id: 'metrics', label: 'METRICS', desc: 'Win/PF' },
];

const CARD_W = 68;
const CARD_H = 32;
const MIN_COLS = 6;
const MAX_COLS = 28;

export type BacktestStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface BacktestGridVisualizationProps {
  isRunning: boolean;
  progress: number;
  completedCount: number;
  totalEstimate?: number;
  status: BacktestStatus;
  dataSource?: 'live' | 'synthetic';
  results: BacktestResultRow[];
  totalProfit: number;
  /** Total profit per trade scope (scalp, day, swing, position). Forward/backward iteration summary. */
  profitByScope?: ProfitByScope;
}

export function BacktestGridVisualization({
  isRunning,
  progress,
  completedCount,
  totalEstimate,
  status,
  dataSource = 'synthetic',
  results,
  totalProfit,
  profitByScope,
}: BacktestGridVisualizationProps) {
  const [cyclingStage, setCyclingStage] = useState(0);
  useEffect(() => {
    if (!isRunning || completedCount > 0) return;
    const id = setInterval(() => setCyclingStage((s) => (s + 1) % 5), 1200);
    return () => clearInterval(id);
  }, [isRunning, completedCount]);

  const activeStage = useMemo(() => {
    if (!isRunning) return -1;
    if (completedCount === 0) return cyclingStage;
    const p = progress / 100;
    return Math.min(4, Math.floor(p * 5));
  }, [isRunning, progress, completedCount, cyclingStage]);

  const showPipeline = status !== 'idle';
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredCardRef = useRef<HTMLDivElement | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const userHasScrolledAwayRef = useRef(false);
  const prevResultsLengthRef = useRef(results.length);

  const handleCardEnter = (id: string) => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setHoveredId(id);
  };
  const handleCardLeave = () => {
    hideTimeoutRef.current = setTimeout(() => setHoveredId(null), 150);
  };
  const handlePopoverEnter = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };
  const handlePopoverLeave = () => {
    setHoveredId(null);
  };

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  const SNAP_THRESHOLD = 24;
  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SNAP_THRESHOLD;
    const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - SNAP_THRESHOLD;
    if (atBottom && atRight) {
      userHasScrolledAwayRef.current = false;
    } else {
      userHasScrolledAwayRef.current = true;
    }
  };

  useEffect(() => {
    if (results.length === 0) {
      userHasScrolledAwayRef.current = false;
    }
    const prevLen = prevResultsLengthRef.current;
    prevResultsLengthRef.current = results.length;
    if (results.length <= prevLen) return;
    if (!userHasScrolledAwayRef.current) {
      const el = scrollContainerRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - el.clientHeight;
          el.scrollLeft = el.scrollWidth - el.clientWidth;
        });
      }
    }
  }, [results.length]);

  const statusColor = useMemo(() => {
    switch (status) {
      case 'idle': return { primary: '#00ff00', secondary: '#00ff0040', label: 'STANDBY' };
      case 'running': return { primary: '#00ff00', secondary: '#00ff0040', label: 'SCANNING' };
      case 'completed': return { primary: '#00ff00', secondary: '#00ff0060', label: 'COMPLETE' };
      case 'cancelled': return { primary: '#ff6600', secondary: '#ff660040', label: 'CANCELLED' };
      case 'failed': return { primary: '#ff4444', secondary: '#ff444440', label: 'FAILED' };
      default: return { primary: '#00ff00', secondary: '#00ff0040', label: '—' };
    }
  }, [status]);

  const cardsPerRow = results.length > 0
    ? Math.max(MIN_COLS, Math.min(MAX_COLS, Math.ceil(Math.sqrt(results.length * 1.5))))
    : MIN_COLS;
  const rows = Math.max(1, cardsPerRow > 0 ? Math.ceil(results.length / cardsPerRow) : 1);
  const contentW = cardsPerRow * CARD_W;
  const contentH = rows * CARD_H;

  const gridStyle = useMemo(() => {
    const color = `${statusColor.primary}20`;
    const lonStep = 24;
    const latStep = 18;
    return {
      backgroundImage: `
        linear-gradient(to right, ${color} 1px, transparent 1px),
        linear-gradient(to bottom, ${color} 1px, transparent 1px)
      `,
      backgroundSize: `${lonStep}px ${latStep}px`,
    };
  }, [statusColor.primary]);

  return (
    <div className="relative overflow-hidden rounded border bg-black/95 p-4" style={{ borderColor: `${statusColor.primary}80` }}>
      {status !== 'idle' && (
        <div
          className="pointer-events-none absolute inset-0 opacity-10"
          style={{
            backgroundImage: `repeating-linear-gradient(0deg, transparent 0, transparent 2px, ${statusColor.secondary} 2px, ${statusColor.secondary} 4px)`,
            backgroundSize: '100% 8px',
            backgroundRepeat: 'repeat',
          }}
        />
      )}

      {showPipeline && (
        <div className="relative z-10 mb-3">
          <div className="flex items-center gap-1">
            {PIPELINE_STAGES.map((stage, i) => (
              <Fragment key={stage.id}>
                <div className="flex flex-1 flex-col items-center">
                  <div
                    className={`flex h-8 w-full items-center justify-center border text-[8px] font-bold uppercase tracking-wider transition-all duration-300 ${
                      activeStage >= i
                        ? 'border-[#00ff00] bg-[#00ff0015 text-[#00ff00]'
                        : 'border-[#00ff00]/30 text-[#00ff00]/40'
                    }`}
                  >
                    {stage.label}
                  </div>
                </div>
                {i < PIPELINE_STAGES.length - 1 && (
                  <span className={`text-[12px] ${activeStage > i ? 'text-[#00ff00]' : 'text-[#00ff00]/20'}`}>→</span>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <div
        className="relative z-10 w-full rounded border overflow-hidden"
        style={{
          borderColor: `${statusColor.primary}40`,
        }}
      >
        <div
          ref={scrollContainerRef}
          className="overflow-auto scrollbar-hide p-3"
          style={{ maxHeight: 200, minHeight: 120 }}
          onScroll={handleScroll}
        >
          <div
            className="inline-grid gap-1.5 p-1"
            style={{
              gridTemplateColumns: `repeat(${cardsPerRow}, ${CARD_W - 8}px)`,
              gridAutoRows: CARD_H - 4,
              width: contentW,
              minHeight: contentH,
              ...gridStyle,
            }}
          >
          {results.map((r) => (
            <div
              key={r.id}
              ref={hoveredId === r.id ? hoveredCardRef : undefined}
              className="flex items-center gap-1.5 border px-1.5 py-1 hover:bg-[#00ff0008] transition-colors shrink-0"
              style={{ borderColor: `${statusColor.primary}50`, minWidth: CARD_W - 8, minHeight: CARD_H - 8 }}
              onMouseEnter={() => handleCardEnter(r.id)}
              onMouseLeave={handleCardLeave}
            >
              <div
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: r.profit >= 0 ? '#00ff00' : '#ff6600',
                  boxShadow: `0 0 3px ${r.profit >= 0 ? '#00ff00' : '#ff6600'}50`,
                }}
              />
              <span className={`text-[8px] font-medium truncate ${r.profit >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
                ${r.profit.toFixed(2)}
              </span>
            </div>
          ))}
          </div>
        </div>
        <div
          className="flex flex-col gap-0.5 px-3 py-2 border-t text-[9px] flex-shrink-0 bg-black/95"
          style={{ borderColor: `${statusColor.primary}40` }}
        >
          <div className="flex items-center justify-between">
            <span style={{ color: statusColor.primary }}>{statusColor.label}</span>
            <span className="text-[#00ff00]/60">
              {completedCount}
              {totalEstimate ? ` / ${totalEstimate}` : ''}
            </span>
            <span className={dataSource === 'live' ? 'text-[#00ff00]' : 'text-[#ff6600]'}>
              {dataSource === 'live' ? '● LIVE' : '○ DISCONNECTED'}
            </span>
            <span className={`font-bold ${totalProfit >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
              Total: ${totalProfit.toFixed(2)}
            </span>
          </div>
          {profitByScope && Object.keys(profitByScope).length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0 text-[#00ff00]/80">
              {(['scalp', 'day', 'swing', 'position'] as TradeScope[]).map((scope) => {
                const p = profitByScope[scope];
                if (p == null) return null;
                return (
                  <span key={scope}>
                    {scope}: <span className={p >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]'}>${p.toFixed(2)}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {status === 'idle' && (
        <div className="relative z-10 mt-2 text-center text-[9px]" style={{ color: `${statusColor.primary}60` }}>
          Instrument × Strategy × Params × TF × Regime
        </div>
      )}

      {hoveredId && (() => {
        const r = results.find((x) => x.id === hoveredId);
        return r ? createPortal(
          <ResultHoverDisplay
            result={r}
            anchorRef={hoveredCardRef}
            statusColor={statusColor}
            onMouseEnter={handlePopoverEnter}
            onMouseLeave={handlePopoverLeave}
          />,
          document.body
        ) : null;
      })()}
    </div>
  );
}
