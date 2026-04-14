/**
 * Single source of truth for instrument selection.
 * Renders the selector and descriptive info for the selected instrument.
 * Other components (Bot Builder, Backtest Engine, etc.) read the selection from the store.
 */

import { useState, useEffect } from 'react';
import { useTradingStore } from '../store/TradingStore';
import type { InstrumentType } from '../core/types';
import { isMarketOpen } from '../core/marketHours';
import { LIVE_FEED_INTERVAL_MS } from '../core/config';
import { BarChart3, Building2, RefreshCw, Zap, ZapOff } from 'lucide-react';
function getTypeColor(type: InstrumentType | string): string {
  switch (type) {
    case 'fiat': return 'text-[#00ff00]';
    case 'crypto': return 'text-[#00ffff]';
    case 'synthetic_deriv': return 'text-[#ff6600]';
    case 'indices_exness': return 'text-[#ffaa00]';
    default: return 'text-[#00ff00]';
  }
}

function getTypeLabel(type: InstrumentType | string): string {
  switch (type) {
    case 'fiat': return 'Fiat (Forex)';
    case 'crypto': return 'Crypto';
    case 'synthetic_deriv': return 'Synthetic (Deriv)';
    case 'indices_exness': return 'Indices (eXness)';
    default: return String(type);
  }
}

export function InstrumentSelector() {
  const { state, actions } = useTradingStore();
  const { instruments, brokers, bots } = state;
  const activeInstruments = instruments.filter((i) => i.status === 'active');
  const selectedInstrument = instruments.find((i) => i.selected) ?? activeInstruments[0] ?? null;
  const selectedBot = selectedInstrument ? bots.find((b) => b.instrumentId === selectedInstrument.id) : null;

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  /** Isolated: sync instrument spreads only when this component is mounted and broker connected. Slower for Deriv (rate limit). */
  const hasBroker = brokers.some((b) => b.status === 'connected');
  useEffect(() => {
    if (!hasBroker) return;
    const sync = () => actions.syncInstrumentSpreads();
    sync();
    const interval = setInterval(sync, 30_000);
    return () => clearInterval(interval);
  }, [actions, hasBroker]);

  const brokerName = (id: string) => brokers.find((b) => b.id === id)?.name ?? id;
  const brokerConnected = (brokerId: string) => brokers.find((b) => b.id === brokerId)?.status === 'connected';

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ INSTRUMENT SELECTION ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className="text-[10px] opacity-80">Select one — Backtest, Bot Builder and others use this</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        {/* Picker */}
        <div className="mb-4">
          <label className="text-[#00ff00] text-[10px] block mb-2">&gt; CHOOSE INSTRUMENT</label>
          <div className="flex flex-wrap gap-2">
            {activeInstruments.map((inst) => (
              <button
                key={inst.id}
                onClick={() => actions.setSelectedInstrument(inst.id)}
                className={`px-3 py-1.5 text-xs border transition-all ${
                  inst.selected
                    ? 'border-[#00ff00] bg-[#00ff0011] text-[#00ff00]'
                    : 'border-[#00ff0066] text-[#00ff0088] hover:border-[#00ff00]'
                }`}
              >
                {inst.symbol}
              </button>
            ))}
          </div>
        </div>

        {/* Descriptive info for selected instrument */}
        {selectedInstrument ? (
          <div className="border border-[#00ff00]/50 bg-black/60 p-3 space-y-2">
            <div className="text-[10px] text-[#00ff00] opacity-80 mb-2">&gt; CURRENT SELECTION</div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[#ff6600] font-medium">{selectedInstrument.symbol}</span>
              <span className={getTypeColor(selectedInstrument.type)}>{getTypeLabel(selectedInstrument.type)}</span>
              <span className={`text-[10px] ${
                selectedInstrument.status === 'active' && brokerConnected(selectedInstrument.brokerId)
                  ? 'text-[#00ff00]'
                  : 'text-[#ff6600]'
              }`}>
                {selectedInstrument.status === 'inactive'
                  ? '○ Inactive'
                  : brokerConnected(selectedInstrument.brokerId)
                    ? '● Active'
                    : '○ Disconnected'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[10px]">
              <div className="flex items-center gap-1">
                <Building2 className="w-3 h-3 text-[#ffaa00]" />
                <span className="text-[#ffaa00]">Broker:</span>
                <span className="text-[#00ff00]">{brokerName(selectedInstrument.brokerId)}</span>
              </div>
              <div className="flex items-center gap-1">
                <BarChart3 className="w-3 h-3 text-[#ffff00]" />
                <span className="text-[#ffff00]">Spread:</span>
                <span className="text-[#00ff00]">{selectedInstrument.spread != null ? selectedInstrument.spread.toFixed(1) : '—'}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[#00ffff]">Market:</span>
                <span className={isMarketOpen(selectedInstrument.type) ? 'text-[#00ff00]' : 'text-[#ff6600]'}>
                  {isMarketOpen(selectedInstrument.type) ? '● Open' : '○ Closed'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <RefreshCw className="w-3 h-3 text-[#ff6600]" />
                <span className="text-[#ff6600]">Rebuild:</span>
                <span className="text-[#00ff00]">Weekly (or click [ REBUILD NOW ] in Bot Builder)</span>
              </div>
            </div>
            <div className="text-[10px] text-[#00ff0080]">
              Timeframes: {selectedInstrument.timeframes.slice(0, 6).join(', ')}
              {selectedInstrument.timeframes.length > 6 ? '…' : ''}
            </div>
            {selectedBot &&
              (['ready', 'deployed', 'building'].includes(selectedBot.status) ||
                (selectedBot.status === 'outdated' && (selectedBot.nnFeatureVector?.length ?? 0) > 0)) && (
              <div className="mt-3 pt-3 border-t border-[#00ff00]/30 flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[10px] text-[#00ff00] opacity-70">
                  Bot: {selectedBot.status === 'deployed' ? '● Deployed' : selectedBot.status === 'ready' ? '○ Ready' : selectedBot.status === 'outdated' ? '○ Outdated (rebuild)' : '… Building'}
                </span>
                <div className="flex items-center gap-2">
                  {selectedBot.status === 'ready' && (
                    <button
                      type="button"
                      onClick={() => actions.deployBot(selectedBot.id)}
                      className="text-[10px] border border-[#00ff00] text-[#00ff00] px-2 py-1 hover:bg-[#00ff0011] flex items-center gap-1"
                    >
                      <Zap className="w-3 h-3" />
                      Deploy
                    </button>
                  )}
                  {selectedBot.status === 'deployed' && (
                    <button
                      type="button"
                      onClick={() => actions.undeployBot(selectedBot.id)}
                      className="text-[10px] border border-[#ff6600] text-[#ff6600] px-2 py-1 hover:bg-[#ff660011] flex items-center gap-1"
                    >
                      <ZapOff className="w-3 h-3" />
                      Undeploy
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-[#ff6600] border border-[#ff6600]/50 p-2">
            No active instruments. Enable some in Instrument Registry.
          </div>
        )}
      </div>
    </div>
  );
}
