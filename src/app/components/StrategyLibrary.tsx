import { useState, useMemo } from 'react';
import { useTradingStore } from '../store/TradingStore';
import { CicadaRadio } from './CicadaRadio';
import { getRegimeLabel } from '../core/regimes';
import type { AnyStrategyDef } from '../core/types';

function getCategoryColor(category: string) {
  switch (category) {
    case 'pattern': return 'text-[#ff6600]';
    case 'candlestick': return 'text-[#00ff00]';
    case 'indicator': return 'text-[#ffff00]';
    case 'logic':
    case 'custom': return 'text-[#00ffff]';
    default: return 'text-[#00ff00]';
  }
}

export function StrategyLibrary() {
  const { state, actions } = useTradingStore();
  const { strategies } = state;
  const [search, setSearch] = useState('');
  const searchLower = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!searchLower) return strategies;
    return strategies.filter((s) =>
      s.name.toLowerCase().includes(searchLower) ||
      s.id.toLowerCase().includes(searchLower) ||
      s.category.toLowerCase().includes(searchLower)
    );
  }, [strategies, searchLower]);
  const enabledCount = strategies.filter((s) => s.enabled).length;
  const total = strategies.length;
  const allEnabled = total > 0 && enabledCount === total;
  const noneEnabled = enabledCount === 0;

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ STRATEGY LIBRARY ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => actions.setAllStrategiesEnabled(true)}
            className={`text-[10px] border border-[#00ff00] text-[#00ff00] px-1.5 py-0.5 hover:bg-[#00ff0011] transition-opacity duration-200 ${allEnabled ? 'opacity-40 hover:opacity-70' : 'opacity-100'}`}
          >
            [ SELECT ALL ]
          </button>
          <button
            onClick={() => actions.setAllStrategiesEnabled(false)}
            className={`text-[10px] border border-[#ff6600] text-[#ff6600] px-1.5 py-0.5 hover:bg-[#ff660011] transition-opacity duration-200 ${noneEnabled ? 'opacity-40 hover:opacity-70' : 'opacity-100'}`}
          >
            [ DESELECT ALL ]
          </button>
        </div>
        <span className="text-[10px]">{enabledCount}/{total}{searchLower ? ` (${filtered.length} of ${total})` : ''}</span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        <input
          type="text"
          placeholder="Search strategies..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full mb-3 px-2 py-1.5 text-xs bg-black border border-[#00ff00] text-[#00ff00] placeholder-[#00ff0066] focus:outline-none focus:ring-1 focus:ring-[#00ff00]"
        />

        <div className="text-xs space-y-1">
          <div className="grid grid-cols-5 gap-2 text-[#00ff00] opacity-70 pb-2 border-b border-[#00ff00]">
            <div className="col-span-2">&gt; STRATEGY</div>
            <div>&gt; CATEGORY</div>
            <div>&gt; REGIMES</div>
            <div className="text-center">&gt; ENABLED</div>
          </div>

          {filtered.length === 0 && (
            <div className="py-4 text-center text-[#00ff00] opacity-60 text-xs">
              {searchLower ? `No strategies match "${search}"` : 'No strategies'}
            </div>
          )}
          {filtered.length > 0 && filtered.map((s: AnyStrategyDef) => (
            <div
              key={s.id}
              onClick={() => actions.toggleStrategyEnabled(s.id)}
              className={`grid grid-cols-5 gap-2 py-2 border-b border-[#00ff0011] hover:bg-[#00ff0011] cursor-pointer transition-colors ${!s.enabled ? 'opacity-50' : ''}`}
            >
              <div className="col-span-2 text-[#00ff00]">{s.name}</div>
              <div className={getCategoryColor(s.category)}>{s.category.toUpperCase()}</div>
              <div className="text-[10px] text-[#00ff00] opacity-80 truncate">
                {s.regimes.slice(0, 2).map(getRegimeLabel).join(', ')}
              </div>
              <div className="text-center flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                <CicadaRadio
                  checked={s.enabled}
                  onChange={() => actions.toggleStrategyEnabled(s.id)}
                  size="xs"
                  labelClassName="opacity-100"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
