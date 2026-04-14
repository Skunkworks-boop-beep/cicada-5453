import { useState, useEffect } from 'react';
import { useTradingStore } from '../store/TradingStore';
import { REBUILD_INTERVAL_PRESETS } from '../core/rebuildInterval';
import { isMarketOpen } from '../core/marketHours';
import { CicadaDropdown } from './CicadaDropdown';

function getTypeColor(type: string) {
  switch (type) {
    case 'fiat': return 'text-[#00ff00]';
    case 'crypto': return 'text-[#00ffff]';
    case 'synthetic_deriv': return 'text-[#ff6600]';
    case 'indices_exness': return 'text-[#ffaa00]';
    default: return 'text-[#00ff00]';
  }
}

function getTypeLabel(type: string) {
  switch (type) {
    case 'fiat': return 'FIAT';
    case 'crypto': return 'CRYPTO';
    case 'synthetic_deriv': return 'SYNTH (DERIV)';
    case 'indices_exness': return 'INDICES (EXNESS)';
    default: return type.toUpperCase();
  }
}

export function InstrumentManager() {
  const { state, actions } = useTradingStore();
  const { instruments, brokers } = state;
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const brokerName = (id: string) => brokers.find((b) => b.id === id)?.name ?? id;

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ INSTRUMENT REGISTRY ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <span className="text-[10px]">Timeframes, broker, rebuild interval</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <span className="text-[#00ff00] text-[10px] opacity-70">Apply rebuild interval to all:</span>
          <CicadaDropdown
            options={REBUILD_INTERVAL_PRESETS.map((p) => ({ value: p.hours, label: p.label }))}
            value={undefined}
            onChange={(hours) => actions.setAllInstrumentsRebuildInterval(hours)}
            placeholder="— select —"
            variant="green"
          />
        </div>

        <div className="text-xs overflow-x-auto">
          <div
            className="grid gap-x-4 gap-y-2 text-[#00ff00] opacity-70 pb-2 border-b border-[#00ff00]"
            style={{
              gridTemplateColumns: 'minmax(6.5rem, 1.4fr) minmax(7rem, 1.2fr) minmax(4rem, 1fr) minmax(4rem, 0.8fr) minmax(5rem, 1fr) minmax(5.5rem, 1fr) minmax(3rem, 0.6fr)',
            }}
          >
            <div className="text-center">&gt; SYMBOL</div>
            <div className="text-center">&gt; TYPE</div>
            <div className="text-center">&gt; BROKER</div>
            <div className="text-center">&gt; SPREAD</div>
            <div className="text-center">&gt; MARKET</div>
            <div className="text-center">&gt; REBUILD</div>
            <div className="text-center">&gt; ACTIONS</div>
          </div>

          <div className="space-y-1 mt-2">
            {instruments.map((i) => (
              <div
                key={i.id}
                role="button"
                tabIndex={0}
                onClick={() => actions.toggleInstrumentStatus(i.id)}
                onKeyDown={(e) => e.key === 'Enter' && actions.toggleInstrumentStatus(i.id)}
                className={`grid gap-x-4 py-2 border-b border-[#00ff0011] hover:bg-[#00ff0011] transition-opacity cursor-pointer items-center ${
                  i.status === 'inactive' ? 'opacity-50' : ''
                }`}
                style={{
                  gridTemplateColumns: 'minmax(6.5rem, 1.4fr) minmax(7rem, 1.2fr) minmax(4rem, 1fr) minmax(4rem, 0.8fr) minmax(5rem, 1fr) minmax(5.5rem, 1fr) minmax(3rem, 0.6fr)',
                }}
              >
                <div className="text-center text-[#00ff00] min-w-0">
                  {i.symbol}
                </div>
                <div className={`text-center min-w-0 ${getTypeColor(i.type)}`}>
                  {getTypeLabel(i.type)}
                </div>
                <div className="text-center text-[10px] text-[#ffaa00] min-w-0">
                  {brokerName(i.brokerId)}
                </div>
                <div className="text-center text-[#00ff00]">
                  {i.spread != null ? i.spread.toFixed(1) : '—'}
                </div>
                <div className={`text-center ${isMarketOpen(i.type) ? 'text-[#00ff00]' : 'text-[#ff6600]'}`}>
                  {isMarketOpen(i.type) ? '● Open' : '○ Closed'}
                </div>
                <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                  <CicadaDropdown
                    options={REBUILD_INTERVAL_PRESETS.map((p) => ({ value: p.hours, label: p.label }))}
                    value={i.rebuildIntervalHours}
                    onChange={(hours) => actions.setInstrumentRebuildInterval(i.id, hours)}
                    variant="orange"
                    compact
                  />
                </div>
                <div className="flex items-center justify-center">
                  <span
                    className={
                      'text-[10px] ' + (i.status === 'active' ? 'text-[#00ff00]' : 'text-[#ff6600]')
                    }
                  >
                    {i.status === 'active' ? '●' : '○'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 text-[10px] text-[#00ff00] opacity-50 text-center border-t border-[#00ff00] pt-2">
          {instruments.filter((i) => i.status === 'active').length} / {instruments.length} ACTIVE
        </div>
      </div>
    </div>
  );
}
