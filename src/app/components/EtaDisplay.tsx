/**
 * Dynamic animated ETA display for backtest and bot build.
 * Covers: starting, in progress, completed, cancelled, error.
 */

import { useState, useEffect, useRef } from 'react';

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export interface EtaDisplayProps {
  /** Whether the operation is active (running) */
  isActive: boolean;
  /** Progress 0–100 (for backtest; bot build may not have incremental progress) */
  progress: number;
  /** Total items (e.g. backtest jobs); used for ETA when progress > 0 */
  total?: number;
  /** Completed count (alternative to progress when total known) */
  completed?: number;
  /** Phase-specific progress (e.g. regime configs, param jobs) for more accurate ETA when progress is coarse */
  subProgress?: { completed: number; total: number };
  /** Status for edge cases */
  status?: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
  /** Fallback ETA in seconds when no progress (e.g. bot build ~90s) */
  fallbackEtaSec?: number;
  /** Label prefix */
  label?: string;
  className?: string;
}

export function EtaDisplay({
  isActive,
  progress,
  total,
  completed,
  subProgress,
  status = 'idle',
  fallbackEtaSec = 90,
  label = '',
  className = '',
}: EtaDisplayProps) {
  const [elapsed, setElapsed] = useState(0);
  const [eta, setEta] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  const tickRef = useRef<number>(0);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (isActive) {
      if (!wasActiveRef.current) {
        startRef.current = Date.now();
        wasActiveRef.current = true;
      }
      const tick = () => {
        const start = startRef.current ?? Date.now();
        const sec = (Date.now() - start) / 1000;
        setElapsed(sec);

        const totalJobs = total ?? (completed != null && progress > 0 && progress < 100 ? Math.round(completed / (progress / 100)) : null);

        // Phase-specific sub-progress (regime configs, param jobs): most accurate when available
        const sub = subProgress?.completed != null && subProgress?.total != null && subProgress.total > 0 ? subProgress : null;
        if (sub && sub.completed > 0 && sub.completed < sub.total) {
          const rate = sec / sub.completed;
          const remaining = sub.total - sub.completed;
          setEta(Math.max(0, rate * remaining));
        } else if (progress > 0 && progress < 100 && totalJobs != null && completed != null && completed > 0) {
          // Rate-based ETA: sec per job × remaining jobs (robust once we have real throughput)
          const rate = sec / completed;
          const remaining = totalJobs - completed;
          setEta(Math.max(0, rate * remaining));
        } else if (progress > 0 && progress < 100 && totalJobs != null) {
          // Total known but no completed yet: progress-based extrapolation
          setEta(Math.max(0, (sec / progress) * (100 - progress)));
        } else if (progress > 0 && progress < 100) {
          setEta(Math.max(0, (sec / progress) * (100 - progress)));
        } else if (progress === 0 && fallbackEtaSec > 0) {
          // Fallback: no progress yet (e.g. server-side backtest, bar fetch). Remaining = initial guess - elapsed.
          // When elapsed exceeds guess, keep eta=0; we'll show "—" instead of misleading "0s remaining"
          setEta(Math.max(0, fallbackEtaSec - sec));
        } else {
          setEta(null);
        }
      };
      tick();
      tickRef.current = window.setInterval(tick, 500);
    } else {
      wasActiveRef.current = false;
      clearInterval(tickRef.current);
    }
    return () => clearInterval(tickRef.current);
  }, [isActive, progress, total, completed, subProgress, fallbackEtaSec]);

  // Final elapsed when transitioning to terminal state
  useEffect(() => {
    if (status === 'completed' || status === 'cancelled' || status === 'failed') {
      if (startRef.current != null) {
        setElapsed((Date.now() - startRef.current) / 1000);
      }
    }
  }, [status]);

  if (!isActive && status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
    return null;
  }

  const isDone = status === 'completed' || status === 'cancelled' || status === 'failed';
  const hasTiming = elapsed >= 0.5;

  return (
    <div className={`flex items-center gap-2 text-[10px] ${className}`}>
      {label && <span className="text-[#00ff00] opacity-70">{label}</span>}
      {isDone ? (
        <span className={status === 'completed' ? 'text-[#00ff00]' : status === 'cancelled' ? 'text-[#ff6600]' : 'text-[#ff4444]'}>
          {status === 'completed' && (hasTiming ? `Done in ${formatDuration(elapsed)}` : 'Completed')}
          {status === 'cancelled' && (hasTiming ? `Cancelled after ${formatDuration(elapsed)}` : 'Cancelled')}
          {status === 'failed' && (hasTiming ? `Failed after ${formatDuration(elapsed)}` : 'Failed')}
        </span>
      ) : (
        <>
          <span className="text-[#ff6600] eta-animate">
            {progress === 0 && elapsed < 2 && 'Starting...'}
            {progress === 0 && elapsed >= 2 && eta != null && eta > 0 && `~${formatDuration(eta)} remaining`}
            {progress === 0 && elapsed >= 2 && eta != null && eta === 0 && '— estimating (no progress yet)'}
            {progress > 0 && progress < 100 && eta != null && eta > 0 && `~${formatDuration(eta)} left`}
            {progress > 0 && progress < 100 && eta != null && eta === 0 && '— finishing soon'}
            {progress > 0 && progress < 100 && eta == null && `${formatDuration(elapsed)} elapsed`}
            {progress >= 100 && 'Finishing...'}
          </span>
          <span className="text-[#00ff00]/80">{formatDuration(elapsed)} elapsed</span>
        </>
      )}
    </div>
  );
}
