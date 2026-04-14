import { Target, Zap, TrendingUp, Crosshair, BarChart3, Check } from 'lucide-react';
import { useTradingStore } from '../store/TradingStore';
import { STYLE_TO_SCOPE } from '../core/scope';
import type { TradeStyle } from '../core/types';

const ALL_STYLE_IDS: TradeStyle[] = ['scalping', 'day', 'medium_swing', 'swing', 'sniper'];

const MODES: { id: TradeStyle; name: string; icon: typeof Zap; description: string }[] = [
  { id: 'scalping', name: 'SCALP', icon: Zap, description: '1–5 min, precision entry/exit' },
  { id: 'day', name: 'DAY_TRADE', icon: TrendingUp, description: '15–60 min intraday' },
  { id: 'medium_swing', name: 'MED_SWING', icon: BarChart3, description: 'Multi-day, 4H focus' },
  { id: 'swing', name: 'SWING', icon: Target, description: '4H–D1 positions' },
  { id: 'sniper', name: 'SNIPER', icon: Crosshair, description: 'Precision entry/exit any scope' },
];

export function TradingModes() {
  const { state, actions } = useTradingStore();
  const { bots, instruments, strategies } = state;
  const selectedInstrument = instruments.find((i) => i.selected) ?? instruments[0];
  const bot = selectedInstrument ? bots.find((b) => b.instrumentId === selectedInstrument.id) : null;
  /** Only allow mode selection when bot has actually been built (ready, deployed, or outdated with nnFeatureVector). */
  const canSelect =
    bot &&
    (['ready', 'deployed'].includes(bot.status) ||
      (bot.status === 'outdated' && (bot.nnFeatureVector?.length ?? 0) > 0));
  /** Strategies this bot was built with (from backtest/build), filtered by Strategy Library enabled state */
  const botStrategyIds = Array.isArray(bot?.strategyIds) ? bot.strategyIds : [];
  const botStrategies = strategies.filter(
    (s) => botStrategyIds.includes(s.id) && s.enabled
  );
  const byStyle = (style: TradeStyle) =>
    botStrategies.filter((s) => s.styles.includes(style)).length;

  const selectMode = (style: TradeStyle | 'auto') => {
    if (!bot || !canSelect) return;
    if (style !== 'auto' && byStyle(style) === 0) return; // Cannot select mode with no supporting strategy
    if (style === 'auto') {
      actions.setBot({
        ...bot,
        scopeMode: 'auto',
        fixedScope: undefined,
        fixedStyle: undefined,
        fixedStyles: undefined,
      });
      return;
    }
    const current = Array.isArray(bot.fixedStyles) ? bot.fixedStyles : (bot.fixedStyle ? [bot.fixedStyle] : []);
    const idx = current.indexOf(style);
    const next =
      idx >= 0 ? current.filter((_, i) => i !== idx) : [...current, style];
    if (next.length === 0 || next.length === ALL_STYLE_IDS.length) {
      actions.setBot({
        ...bot,
        scopeMode: 'auto',
        fixedScope: undefined,
        fixedStyle: undefined,
        fixedStyles: undefined,
      });
      return;
    }
    const allowed = bot.allowedScopes?.length ? bot.allowedScopes : ['scalp', 'day', 'swing'];
    const scopes = [...new Set(next.map((s) => STYLE_TO_SCOPE[s]))];
    const allowedScopes = [...new Set([...allowed, ...scopes])];
    if (next.length === 1) {
      actions.setBot({
        ...bot,
        scopeMode: 'manual',
        fixedScope: STYLE_TO_SCOPE[next[0]],
        fixedStyle: next[0],
        fixedStyles: next,
        allowedScopes,
      });
    } else {
      actions.setBot({
        ...bot,
        scopeMode: 'manual',
        fixedScope: undefined,
        fixedStyle: undefined,
        fixedStyles: next,
        allowedScopes,
      });
    }
  };

  const isSelected = (style: TradeStyle | 'auto') => {
    if (!bot) return false;
    if (style === 'auto') {
      const fs = Array.isArray(bot.fixedStyles) ? bot.fixedStyles : [];
      return (
        (bot.scopeMode ?? 'auto') === 'auto' ||
        (fs.length === 0 && !bot.fixedScope) ||
        fs.length === ALL_STYLE_IDS.length
      );
    }
    const fs = Array.isArray(bot.fixedStyles) ? bot.fixedStyles : (bot.fixedStyle ? [bot.fixedStyle] : []);
    return fs.includes(style);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-1">
        <span>[ TRADING MODES ]</span>
        <div className="flex-1 border-b border-[#00ff00]"></div>
        {selectedInstrument && (
          <span className="text-[10px] text-[#ff6600] shrink-0">
            for {selectedInstrument.symbol}
          </span>
        )}
        <button
          onClick={() => selectMode('auto')}
          disabled={!canSelect}
          className={`text-[10px] transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0 px-2 py-1 rounded border ${
            isSelected('auto') ? 'opacity-100 border-[#00ff00] bg-[#00ff0020] text-[#00ff00] font-medium' : 'opacity-50 border-[#00ff00]/50 text-[#00ff00]/70 hover:opacity-70 hover:text-[#00ff00] hover:border-[#00ff00]'
          }`}
        >
          {isSelected('auto') && <Check className="w-3 h-3 inline mr-1" />}[ AUTO ]
        </button>
        <span className="text-[10px] shrink-0">
          {bot && canSelect
            ? isSelected('auto')
              ? 'AUTO: scope varies by regime, volatility, time'
              : (() => {
                  const fs = Array.isArray(bot.fixedStyles) ? bot.fixedStyles : (bot.fixedStyle ? [bot.fixedStyle] : []);
                  const names = fs.map((s) => MODES.find((m) => m.id === s)?.name ?? s).join(' + ');
                  return `MANUAL: ${names}`;
                })()
            : 'By style (strategies this bot was built with)'}
        </span>
      </div>

      <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
        <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]"></div>
        <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]"></div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {MODES.map((mode) => {
            const Icon = mode.icon;
            const count = byStyle(mode.id);
            const selected = isSelected(mode.id);
            const modeDisabled = !canSelect || count === 0;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => selectMode(mode.id)}
                disabled={modeDisabled}
                className={`border-2 p-3 bg-black text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-start relative ${
                  selected ? 'opacity-100 border-[#00ff00] bg-[#00ff0020] ring-2 ring-[#00ff00]/50' : modeDisabled ? 'opacity-40 border-[#00ff00]/30' : 'opacity-50 border-[#00ff00]/50 hover:opacity-70 hover:border-[#00ff00] hover:bg-[#00ff0008]'
                }`}
                style={{ boxShadow: selected ? '0 0 12px rgba(0,255,0,0.4)' : '0 0 6px rgba(0,255,0,0.1)' }}
              >
                {selected && (
                  <span className="absolute top-1.5 right-1.5 text-[#00ff00]">
                    <Check className="w-4 h-4" />
                  </span>
                )}
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-4 h-4 text-[#00ff00]" />
                  <span className="text-xs text-[#00ff00] font-medium">{mode.name}</span>
                </div>
                <div className="text-[10px] text-[#00ff00] opacity-70 mb-2">{mode.description}</div>
                <div className={`text-[10px] ${count === 0 ? 'text-[#ff6600]/60' : 'text-[#ff6600]'}`}>
                  &gt; Strategies: {count}{count === 0 ? ' (disabled)' : ''}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
