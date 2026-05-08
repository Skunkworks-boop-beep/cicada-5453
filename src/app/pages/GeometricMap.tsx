/**
 * Stage 3: top-level route hosting the Beehive structural visualiser.
 *
 * Reuses the Dashboard's chrome (logo, time, broker pills, logout, BOT
 * EXECUTION toggle) so the operator stays in-context. The Beehive itself
 * is the body of the page. Cells map 1:1 to price points loaded from
 * `/map/geometric/{symbol}`; when no symbol is selected, an empty hive
 * is rendered with the spec's idle breathing animation.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CicadaLogo } from '../components/CicadaLogo';
import { Beehive } from '../components/Beehive/Beehive';
import { useTradingStore } from '../store/TradingStore';

export default function GeometricMap() {
  const navigate = useNavigate();
  const { state, actions } = useTradingStore();
  const [currentTime, setCurrentTime] = useState(new Date());
  const hasLiveConnection = state.brokers.some((b) => b.status === 'connected');

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => navigate('/');
  const handleBackToDashboard = () => navigate('/dashboard');

  /** Prefer the user's selected instrument, fall back to the first active one. */
  const selectedInstrument = useMemo(() => {
    return state.instruments.find((i) => i.selected)
      ?? state.instruments.find((i) => i.status === 'active')
      ?? state.instruments[0]
      ?? null;
  }, [state.instruments]);

  return (
    <div className="min-h-screen bg-black text-[#00ff00] font-mono">
      {/* Top header — same recipe as Dashboard.tsx so the chrome stays consistent */}
      <div
        className="sticky top-0 z-50 border-b border-[#00ff00] bg-black py-2 px-3"
        style={{ boxShadow: '0 0 20px rgba(0,255,0,0.25)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <CicadaLogo size={80} showText={true} compact={true} />
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
            <span className="text-[10px] text-[#00ff00]/70 tracking-[0.2em]">[ GEOMETRIC MAP · HIVE VIEW ]</span>
          </div>
          <div className="flex items-center gap-6">
            <div
              className="text-xs text-[#00ff00]"
              style={{ textShadow: '0 0 6px rgba(0,255,0,0.7)' }}
            >
              {currentTime.toLocaleTimeString('en-US', { hour12: false })}
            </div>
            <button
              onClick={handleBackToDashboard}
              className="border border-[#00ff00] px-3 py-1 text-xs hover:bg-[#00ff0011] transition-all"
              style={{ boxShadow: '0 0 8px rgba(0,255,0,0.3)' }}
            >
              [ DASHBOARD ]
            </button>
            <button
              onClick={handleLogout}
              className="border border-[#00ff00] px-3 py-1 text-xs hover:bg-[#00ff0011] transition-all"
              style={{ boxShadow: '0 0 8px rgba(0,255,0,0.3)' }}
            >
              [ LOGOUT ]
            </button>
          </div>
        </div>
      </div>

      {/* Beehive body — fills the remaining viewport. Strict green palette only. */}
      <div className="relative w-full" style={{ height: 'calc(100vh - 4rem)' }}>
        <Beehive symbol={selectedInstrument?.symbol ?? null} />
      </div>
    </div>
  );
}
