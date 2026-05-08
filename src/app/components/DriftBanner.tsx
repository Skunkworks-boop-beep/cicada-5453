/**
 * Stage 3: dashboard-wide halt banner. Polls /drift/status every 10s.
 *
 * Surfaces three states:
 *  - hidden when guards are clear
 *  - amber strip when ``new_orders_halted`` (soft halt, recoverable)
 *  - red banner with [ RESUME ] button when ``emergency_stopped``
 *
 * Uses the same colour vocabulary as the rest of the dashboard
 * (#00ff00 / #ff6600 / #ff4444). No new accents.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { getDriftStatus, postDriftResume, type DriftStatus } from '../core/api';

const POLL_MS = 10_000;

export function DriftBanner() {
  const [status, setStatus] = useState<DriftStatus | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    const s = await getDriftStatus();
    setStatus(s);
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const handleResume = async () => {
    setResuming(true);
    setResumeError(null);
    const r = await postDriftResume();
    if (!r.ok) setResumeError(r.error ?? 'Resume failed');
    await poll();
    setResuming(false);
  };

  if (!status || !status.available) return null;
  const guards = status.guards;
  if (!guards.new_orders_halted && !guards.emergency_stopped) return null;

  if (guards.emergency_stopped) {
    return (
      <div className="border-2 border-[#ff4444] bg-black px-3 py-2 mb-2"
           style={{ boxShadow: '0 0 14px rgba(255,68,68,0.4)' }}>
        <div className="flex flex-wrap items-center gap-3">
          <ShieldAlert className="w-4 h-4 text-[#ff4444]" />
          <span className="text-[#ff4444] font-bold text-xs tracking-wider">
            [ EMERGENCY STOP ACTIVE ]
          </span>
          <span className="text-[10px] text-[#ff4444]/90 truncate flex-1">
            {guards.emergency_reason ?? 'unknown reason'}
          </span>
          <button
            type="button"
            onClick={handleResume}
            disabled={resuming}
            className="text-[10px] border border-[#00ff00] text-[#00ff00] px-2 py-1 hover:bg-[#00ff0011] disabled:opacity-50"
            style={{ boxShadow: '0 0 6px rgba(0,255,0,0.3)' }}
          >
            {resuming ? '[ RESUMING... ]' : '[ RESUME ]'}
          </button>
        </div>
        {resumeError && (
          <div className="text-[10px] text-[#ff6600] mt-1">{resumeError}</div>
        )}
        {status.snapshot && (
          <div className="text-[10px] text-[#ff4444]/70 mt-1">
            chosen action: {status.snapshot.chosen_action} · reason: {status.snapshot.chosen_reason}
          </div>
        )}
      </div>
    );
  }

  // Soft halt — amber.
  return (
    <div className="border-2 border-[#ff6600] bg-black px-3 py-2 mb-2"
         style={{ boxShadow: '0 0 10px rgba(255,102,0,0.3)' }}>
      <div className="flex flex-wrap items-center gap-3">
        <AlertTriangle className="w-4 h-4 text-[#ff6600]" />
        <span className="text-[#ff6600] font-bold text-xs tracking-wider">
          [ NEW ORDERS HALTED ]
        </span>
        <span className="text-[10px] text-[#ff6600]/90 truncate flex-1">
          {guards.halt_reason ?? 'unknown reason'}
        </span>
        <span className="text-[10px] text-[#ff6600]/70">
          (existing positions still managed)
        </span>
      </div>
    </div>
  );
}
