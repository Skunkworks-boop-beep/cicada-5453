/**
 * Portfolio view (asset/holdings style). No fake data — shows empty state until live data is available.
 * For live balance and positions from MT5/Deriv, see LivePortfolio.
 */

export function Portfolio() {
  return (
    <div className="border-2 border-[#00ff00] bg-black p-4 shadow-[0_0_15px_rgba(0,255,0,0.2)] relative">
      <div className="absolute top-0 left-0 w-3 h-3 border-l-2 border-t-2 border-[#00ff00]" />
      <div className="absolute top-0 right-0 w-3 h-3 border-r-2 border-t-2 border-[#00ff00]" />
      <div className="absolute bottom-0 left-0 w-3 h-3 border-l-2 border-b-2 border-[#00ff00]" />
      <div className="absolute bottom-0 right-0 w-3 h-3 border-r-2 border-b-2 border-[#00ff00]" />

      <div className="flex items-center gap-2 text-[#00ff00] text-xs mb-3">
        <span>[ PORTFOLIO ]</span>
        <div className="flex-1 border-b border-[#00ff00]" />
      </div>

      <div className="border border-[#ff6600]/60 bg-[#ff660008 p-4 text-[#ff6600] text-[10px]">
        <div className="font-medium mb-1">&gt; NO DATA AVAILABLE</div>
        <div className="opacity-90">Use [ LIVE PORTFOLIO ] on the dashboard for balance and positions from MT5. Connect a broker (Brokers → eXness) for live data.</div>
      </div>

      <div className="mt-3 pt-2 border-t border-[#00ff00]/50 text-[10px] text-[#00ff00]/60 text-center">
        No simulated or fake data. Connect a broker for real P/L and positions.
      </div>
    </div>
  );
}
