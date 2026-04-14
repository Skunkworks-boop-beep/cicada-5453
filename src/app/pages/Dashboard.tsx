import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { CicadaLogo } from '../components/CicadaLogo';
import { InstrumentManager } from '../components/InstrumentManager';
import { StrategyLibrary } from '../components/StrategyLibrary';
import { BacktestEngine } from '../components/BacktestEngine';
import { TradingModes } from '../components/TradingModes';
import { BotExecutionLog } from '../components/BotExecutionLog';
import { BotBuilder } from '../components/BotBuilder';
import { BotRegistry } from '../components/BotRegistry';
import { LivePortfolio } from '../components/LivePortfolio';
import { BrokersManager } from '../components/BrokersManager';
import { TickerBar } from '../components/TickerBar';
import { PriceChart } from '../components/PriceChart';
import { LiveSpreadPanel } from '../components/LiveSpreadPanel';
import { TerminalHeader } from '../components/TerminalHeader';
import { ServerOffload } from '../components/ServerOffload';
import { InstrumentSelector } from '../components/InstrumentSelector';
import { useTradingStore } from '../store/TradingStore';
import { getNextDueRebuilds } from '../core/scheduler';
import { Zap } from 'lucide-react';
export default function Dashboard() {
  const navigate = useNavigate();
  const [currentTime, setCurrentTime] = useState(new Date());
  const { state, actions } = useTradingStore();
  const hasLiveConnection = state.brokers.some((b) => b.status === 'connected');

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const scheduleLen = state.schedule.length;
  const rebuildRelevantBotIds = state.bots
    .filter(
      (b) =>
        b.status === 'deployed' ||
        (b.status === 'outdated' && (b.nnFeatureVector?.length ?? 0) > 0)
    )
    .map((b) => b.id)
    .sort()
    .join(',');
  useEffect(() => {
    const interval = setInterval(() => {
      const due = getNextDueRebuilds(state.schedule, 60);
      for (const entry of due) {
        const bot = state.bots.find((b) => b.instrumentId === entry.instrumentId);
        const isActuallyBuilt = bot && (bot.status === 'deployed' || (bot.status === 'outdated' && (bot.nnFeatureVector?.length ?? 0) > 0));
        if (isActuallyBuilt) {
          actions.rebuildBot(bot.id);
          actions.buildBot(bot.id).catch((e) => {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[Dashboard] buildBot failed for', bot.id, ':', e);
            }
          });
        }
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [scheduleLen, rebuildRelevantBotIds, actions]);

  const handleLogout = () => navigate('/');
  const activeBots = state.bots.filter((b) => b.status === 'deployed').length;
  const enabledStrategies = state.strategies.filter((s) => s.enabled).length;
  const activeInstruments = state.instruments.filter((i) => i.status === 'active').length;
  /** Total P/L = open (positions) + realized (closed trades); show when we have data (live or persisted). */
  const hasData = state.portfolio.dataSource !== 'none';
  const openPnl = Number.isFinite(state.portfolio.totalPnl) ? state.portfolio.totalPnl : 0;
  const realizedPnl = Object.values(state.closedTradesByBot ?? {}).flat().filter((t) => t.contractId != null).reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalPnl = openPnl + realizedPnl;
  const showPnl = hasData && Number.isFinite(totalPnl);

  return (
    <div className="min-h-screen bg-black text-[#00ff00] font-mono">
      {/* Top Header Bar */}
      <div className="sticky top-0 z-50 border-b border-[#00ff00] bg-black py-2 px-3" style={{ boxShadow: '0 0 20px rgba(0,255,0,0.25)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <CicadaLogo size={80} showText={true} compact={true} />
            {/* Data mode: LIVE vs DISCONNECTED — always visible */}
            <div
              className={`flex items-center gap-1.5 px-3 py-1 border-2 text-xs font-bold uppercase tracking-wider ${
                hasLiveConnection
                  ? 'border-[#00ff00] bg-[#00ff0015 text-[#00ff00] shadow-[0_0_12px_rgba(0,255,0,0.4)]'
                  : 'border-[#ff6600] bg-[#ff660015 text-[#ff6600] shadow-[0_0_8px_rgba(255,102,0,0.3)]'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${hasLiveConnection ? 'bg-[#00ff00]' : 'bg-[#ff6600]'}`} />
              {hasLiveConnection ? 'LIVE' : 'DISCONNECTED'}
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="text-xs text-[#00ff00]" style={{ textShadow: '0 0 6px rgba(0,255,0,0.7)' }}>
              {currentTime.toLocaleTimeString('en-US', { hour12: false })}
            </div>
            {/* Bot execution: enable/disable */}
            <button
              onClick={() => actions.setExecutionEnabled(!state.execution.enabled)}
              className={`flex items-center gap-2 border-2 px-3 py-1.5 text-xs transition-all ${
                state.execution.enabled
                  ? 'border-[#00ff00] bg-[#00ff0011] text-[#00ff00] shadow-[0_0_12px_rgba(0,255,0,0.5)]'
                  : 'border-[#ff6600] bg-black text-[#ff6600]'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              {state.execution.enabled ? '[ BOT EXECUTION ON ]' : '[ BOT EXECUTION OFF ]'}
            </button>
            <div className="flex items-center gap-3 text-[10px]">
              {state.brokers.map((b) => (
                <span key={b.id} className={b.status === 'connected' ? 'text-[#00ff00]' : 'text-[#ff6600] opacity-80'} style={{ textShadow: b.status === 'connected' ? '0 0 6px rgba(0,255,0,0.8)' : 'none' }}>
                  {b.name}: {b.status === 'connected' ? '●' : '○'} {b.status === 'connecting' ? '…' : b.status}
                </span>
              ))}
            </div>
            <button
                onClick={handleLogout}
                className="border border-[#00ff00] px-3 py-1 text-xs hover:bg-[#00ff0011] transition-all"
                style={{ boxShadow: '0 0 8px rgba(0,255,0,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 15px rgba(0,255,0,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 0 8px rgba(0,255,0,0.3)')}
              >
                [ LOGOUT ]
              </button>
          </div>
        </div>
      </div>

      {/* Main Content: compact two-column layout, no empty gaps */}
      <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden bg-black">
        <div className="flex-1 min-h-0 overflow-auto scrollbar-hide">
          <div className="container mx-auto p-2 sm:p-3 max-w-[1600px] space-y-2 sm:space-y-3">
            <TerminalHeader />
            <TickerBar />
            {/* Status strip: single compact row */}
            <div className="grid grid-cols-5 gap-1 sm:gap-2 text-center text-[10px] sm:text-xs py-1.5 px-2 border border-[#00ff00]/50 bg-black/90 rounded shrink-0">
              <div><span className="text-[#00ff00]/80">BOTS</span><span className="text-[#ff6600] ml-1">{activeBots}</span></div>
              <div><span className="text-[#00ff00]/80">STRAT</span><span className="text-[#ff6600] ml-1">{enabledStrategies}/{state.strategies.length}</span></div>
              <div><span className="text-[#00ff00]/80">WIN</span><span className="text-[#00ff00] ml-1">—</span></div>
              <div><span className="text-[#00ff00]/80">P/L</span><span className={`ml-1 ${showPnl ? (totalPnl >= 0 ? 'text-[#00ff00]' : 'text-[#ff6600]') : 'text-[#00ff00]/70'}`}>{showPnl ? (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2) : '—'}</span></div>
              <div><span className="text-[#00ff00]/80">INST</span><span className="text-[#ff6600] ml-1">{activeInstruments}/{state.instruments.length}</span></div>
            </div>

            {/* Two columns: left = Instrument + Backtest + Bot Builder + Bot Registry + Instrument Registry; right = Portfolio + Brokers + Modes + Strategy Library */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 sm:gap-3 items-start">
              <div className="space-y-2 sm:space-y-3 min-w-0">
                <InstrumentSelector />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <PriceChart />
                  <LiveSpreadPanel />
                </div>
                <BacktestEngine />
                <BotBuilder />
                <BotRegistry />
                <InstrumentManager />
              </div>
              <div className="space-y-2 sm:space-y-3 min-w-0">
                <ServerOffload />
                <LivePortfolio />
                <BotExecutionLog />
                <BrokersManager />
                <TradingModes />
                <StrategyLibrary />
              </div>
            </div>

            <div className="py-2 text-center border-t border-[#00ff00]/30">
              <span className="text-[10px] text-[#00ff00]/50">CICADA-5453 · Backtest → Build → Deploy · Weekly rebuilds</span>
            </div>
          </div>
        </div>
      </div>

      <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10 opacity-10" style={{
        backgroundImage: 'linear-gradient(#00ff00 1px, transparent 1px), linear-gradient(90deg, #00ff00 1px, transparent 1px)',
        backgroundSize: '50px 50px',
      }} />
    </div>
  );
}
