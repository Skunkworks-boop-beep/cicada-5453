/**
 * Process monitor: live view of backend jobs and the resolved compute profile.
 * Keeps the terminal aesthetic while surfacing enough detail for operators to
 * see queue pressure, throughput, hardware use, progress, and recent failures.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle, Clock3, Cpu, Gauge, Loader2, RefreshCw, Server, XCircle } from 'lucide-react';
import { RetroBox } from './RetroBox';
import { getNnApiBaseUrl } from '../core/config';
import { postJobCancel, type ComputeInfo, type JobRecord } from '../core/api';

const POLL_MS = 2_000;
/** Research/backtests can block the same worker; short timeouts returned empty and wiped the UI. */
const POLL_TIMEOUT_MS = 30_000;

const STATUS_STYLE: Record<JobRecord['status'], { label: string; dot: string; text: string; border: string; bg: string }> = {
  queued: {
    label: 'QUEUED',
    dot: 'bg-[#888888]',
    text: 'text-[#aaaaaa]',
    border: 'border-[#888888]/50',
    bg: 'bg-[#888888]/5',
  },
  running: {
    label: 'RUNNING',
    dot: 'bg-[#00ff00] shadow-[0_0_8px_rgba(0,255,0,0.7)]',
    text: 'text-[#00ff00]',
    border: 'border-[#00ff00]/70',
    bg: 'bg-[#00ff00]/[0.08]',
  },
  succeeded: {
    label: 'DONE',
    dot: 'bg-[#00ff00]',
    text: 'text-[#00ff00]/90',
    border: 'border-[#00ff00]/45',
    bg: 'bg-[#00ff00]/5',
  },
  failed: {
    label: 'FAILED',
    dot: 'bg-[#ff4444]',
    text: 'text-[#ff4444]',
    border: 'border-[#ff4444]/70',
    bg: 'bg-[#ff4444]/[0.08]',
  },
  cancelled: {
    label: 'CANCELLED',
    dot: 'bg-[#ff9900]',
    text: 'text-[#ffaa00]',
    border: 'border-[#ffaa00]/60',
    bg: 'bg-[#ffaa00]/[0.08]',
  },
};

const KIND_LABEL: Record<string, string> = {
  backtest: 'BACKTEST',
  research: 'RESEARCH',
  shadow: 'SHADOW',
  backward_validation: 'B/W VALID',
};

function formatRel(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function formatClock(iso?: string | null): string {
  if (!iso) return '--:--:--';
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '--:--:--';
  return t.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(start?: string | null, end?: string | null): string {
  if (!start) return '--';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '--';
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function formatMetaValue(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value.length > 26 ? `${value.slice(0, 23)}...` : value;
  if (Array.isArray(value)) return `${value.length} items`;
  return 'object';
}

function getMetaEntries(meta?: Record<string, unknown>): Array<[string, string]> {
  if (!meta) return [];
  return Object.entries(meta)
    .filter(([, value]) => value != null && typeof value !== 'object')
    .slice(0, 4)
    .map(([key, value]) => [key.replace(/_/g, ' '), formatMetaValue(value)]);
}

function StatusIcon({ status }: { status: JobRecord['status'] }) {
  if (status === 'running') return <Loader2 className="h-3 w-3 animate-spin" />;
  if (status === 'succeeded') return <CheckCircle className="h-3 w-3" />;
  if (status === 'failed') return <XCircle className="h-3 w-3" />;
  if (status === 'cancelled') return <AlertTriangle className="h-3 w-3" />;
  return <Clock3 className="h-3 w-3" />;
}

export function ProcessMonitor() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [compute, setCompute] = useState<ComputeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  /** Set when a poll fails or times out; previous jobs/compute are kept. */
  const [pollError, setPollError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const base = getNnApiBaseUrl();
    const signal = AbortSignal.timeout(POLL_TIMEOUT_MS);
    let okJobs = false;
    let okCompute = false;
    let failReason: string | null = null;
    try {
      const [jr, cr] = await Promise.allSettled([
        fetch(`${base}/jobs`, { signal }),
        fetch(`${base}/compute`, { signal }),
      ]);

      if (jr.status === 'fulfilled' && jr.value.ok) {
        try {
          const data = (await jr.value.json()) as { jobs?: JobRecord[] };
          if (Array.isArray(data.jobs)) {
            setJobs(data.jobs);
            okJobs = true;
          } else {
            failReason = 'invalid jobs response';
          }
        } catch {
          failReason = 'could not read jobs';
        }
      } else if (jr.status === 'rejected') {
        failReason = jr.reason instanceof Error ? jr.reason.message : String(jr.reason);
      } else {
        const st = jr.status === 'fulfilled' ? jr.value.status : '?';
        failReason = `jobs HTTP ${st}`;
      }

      if (cr.status === 'fulfilled' && cr.value.ok) {
        try {
          setCompute((await cr.value.json()) as ComputeInfo);
          okCompute = true;
        } catch {
          if (!failReason) {
            failReason = 'could not read compute';
          }
        }
      } else if (cr.status === 'rejected') {
        if (!failReason) {
          failReason = cr.reason instanceof Error ? cr.reason.message : String(cr.reason);
        }
      } else if (!failReason) {
        const st = cr.status === 'fulfilled' ? cr.value.status : '?';
        failReason = `compute HTTP ${st}`;
      }

      if (okJobs && okCompute) {
        setPollError(null);
        setError(null);
      } else {
        setPollError(
          failReason
            ? `Refresh incomplete (${failReason}) — last snapshot below${!okCompute ? ' · compute may be stale' : ''}${!okJobs ? ' · job list may be stale' : ''}`
            : 'Refresh incomplete — last snapshot below'
        );
      }
    } catch (e) {
      setPollError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const handleCancel = async (jobId: string) => {
    setCancellingIds((prev) => new Set(prev).add(jobId));
    try {
      await postJobCancel(jobId);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const visibleJobs = jobs.filter((j) =>
    showFinished ? true : j.status === 'queued' || j.status === 'running'
  );

  const stats = useMemo(() => {
    const next = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    } satisfies Record<JobRecord['status'], number>;
    for (const job of jobs) {
      const s = job.status;
      if (s in next) next[s] += 1;
    }
    return next;
  }, [jobs]);

  const activeCount = stats.queued + stats.running;
  const finishedCount = stats.succeeded + stats.failed + stats.cancelled;

  return (
    <RetroBox title="PROCESS MONITOR">
      <div className="h-96 min-h-0 font-mono text-[10px] text-[#00ff00]/80 space-y-2.5 overflow-y-auto overflow-x-hidden pr-1.5 scrollbar-visible">
        <div className="flex flex-wrap items-center gap-2 border border-[#00ff00]/30 bg-[#00ff00]/[0.03] px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[#00ff00]">
            <Activity className="h-3.5 w-3.5" />
            <span className="tracking-[0.18em]">LIVE OPS</span>
          </div>
          <div className="h-3 border-l border-[#00ff00]/25" />
          <span className="text-[#00ff00]/65">active</span>
          <span className="text-[#ff6600]">{activeCount}</span>
          <span className="text-[#00ff00]/45">queued</span>
          <span>{stats.queued}</span>
          <span className="text-[#00ff00]/45">running</span>
          <span>{stats.running}</span>
          <span className="text-[#00ff00]/45">finished</span>
          <span>{finishedCount}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-1 text-[10px] border border-[#00ff00]/50 text-[#00ff00]/80 px-1.5 py-0.5 hover:bg-[#00ff0011] disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
              [REFRESH]
            </button>
            <button
              type="button"
              onClick={() => setShowFinished((v) => !v)}
              className="text-[10px] border border-[#00ff00]/50 text-[#00ff00]/80 px-1.5 py-0.5 hover:bg-[#00ff0011]"
            >
              {showFinished ? '[HIDE DONE]' : '[SHOW DONE]'}
            </button>
          </div>
        </div>

        {compute ? (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1.5">
            <div className="border border-[#00ff00]/25 bg-black/60 p-2">
              <div className="flex items-center gap-1 text-[#00ff00]/55 mb-1">
                <Cpu className="h-3 w-3" />
                <span>CPU</span>
              </div>
              <div className="text-[13px] leading-none text-[#00ff00]">{compute.cpu_count}</div>
              <div className="mt-1 text-[#00ff00]/55">logical cores</div>
            </div>
            <div className="border border-[#00ff00]/25 bg-black/60 p-2">
              <div className="flex items-center gap-1 text-[#00ff00]/55 mb-1">
                <Gauge className="h-3 w-3" />
                <span>WORKERS</span>
              </div>
              <div className="text-[13px] leading-none text-[#00ff00]">{compute.backtest_workers}</div>
              <div className="mt-1 text-[#00ff00]/55">backtest · {compute.research_workers} research</div>
            </div>
            <div className="border border-[#00ff00]/25 bg-black/60 p-2">
              <div className="flex items-center gap-1 text-[#00ff00]/55 mb-1">
                <Server className="h-3 w-3" />
                <span>TRAINING</span>
              </div>
              <div className="text-[13px] leading-none text-[#00ff00]">{compute.torch_num_threads}</div>
              <div className="mt-1 text-[#00ff00]/55">
                torch threads · {compute.dataloader_workers} loaders
              </div>
            </div>
            <div className="border border-[#00ff00]/25 bg-black/60 p-2">
              <div className="flex items-center gap-1 text-[#00ff00]/55 mb-1">
                <Activity className="h-3 w-3" />
                <span>ACCEL</span>
              </div>
              <div className={`text-[13px] leading-none ${compute.use_cuda ? 'text-[#00ff00]' : 'text-[#888888]'}`}>
                {compute.use_cuda
                  ? compute.use_multi_gpu && (compute.cuda_device_count ?? 0) > 1
                    ? `${compute.cuda_device_count} GPUs`
                    : compute.device
                  : 'CPU'}
              </div>
              <div className="mt-1 text-[#00ff00]/55">
                {compute.use_cuda
                  ? `${compute.use_multi_gpu ? 'multi on' : compute.device} · ${compute.tf32 ? 'TF32 on' : 'TF32 off'} · pin ${compute.pin_memory ? 'on' : 'off'}`
                  : `${compute.shadow_workers} shadow workers`}
              </div>
            </div>
          </div>
        ) : (
          <div className="border border-[#ffaa00]/40 bg-[#ffaa00]/[0.04] px-2 py-1.5 text-[#ffaa00]/80">
            Compute profile unavailable. Waiting for backend...
          </div>
        )}

        {pollError && (
          <div className="flex items-start gap-2 border border-[#ffaa00]/50 bg-[#ffaa00]/[0.06] px-2 py-1.5 text-[#ffaa00]/90">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{pollError}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 border border-[#ff4444]/60 bg-[#ff4444]/[0.06] px-2 py-1.5 text-[#ff4444]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {visibleJobs.length === 0 ? (
          <div className="border border-dashed border-[#00ff00]/25 bg-black/40 px-3 py-4 text-center text-[#00ff00]/45">
            No {showFinished ? 'jobs recorded' : 'active jobs'}.
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleJobs.map((j) => {
              const status = STATUS_STYLE[j.status] ?? STATUS_STYLE.queued;
              const progress = clampProgress(j.progress);
              const startedOrCreated = j.started_at ?? j.created_at;
              const metaEntries = getMetaEntries(j.meta);
              const canCancel = j.status === 'queued' || j.status === 'running';
              const cancelling = cancellingIds.has(j.job_id);

              return (
                <div
                  key={j.job_id}
                  className={`relative overflow-hidden border ${status.border} ${status.bg} px-2.5 py-2 shadow-[inset_0_0_18px_rgba(0,255,0,0.025)]`}
                >
                  <div className={`absolute left-0 top-0 h-full w-0.5 ${status.dot}`} />
                  <div className="flex min-w-0 items-start gap-2">
                    <div className={`mt-0.5 inline-flex items-center gap-1 border ${status.border} px-1.5 py-0.5 ${status.text}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                      <StatusIcon status={j.status} />
                      <span>{status.label}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="border border-[#00ff00]/30 px-1.5 py-0.5 text-[#00ff00]/70">
                          {KIND_LABEL[j.kind] ?? j.kind.toUpperCase()}
                        </span>
                        <span className="truncate text-[11px] text-[#00ff00]">{j.title}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[#00ff00]/50">
                        <span>id {j.job_id.slice(0, 8)}</span>
                        <span>created {formatRel(j.created_at)}</span>
                        <span>start {formatClock(startedOrCreated)}</span>
                        <span>duration {formatDuration(startedOrCreated, j.finished_at)}</span>
                        {j.finished_at ? <span>finished {formatClock(j.finished_at)}</span> : null}
                      </div>
                    </div>
                    {canCancel && (
                      <button
                        type="button"
                        onClick={() => handleCancel(j.job_id)}
                        disabled={cancelling}
                        className="text-[10px] border border-[#ff4444] text-[#ff4444] px-1.5 py-0.5 hover:bg-[#ff444411] disabled:opacity-50"
                      >
                        {cancelling ? '[...]' : '[CANCEL]'}
                      </button>
                    )}
                  </div>

                  {(j.status === 'running' || progress > 0) && (
                    <div className="mt-2">
                      <div className="mb-1 flex items-center justify-between text-[#00ff00]/55">
                        <span>{j.message || 'processing'}</span>
                        <span>{progress.toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 border border-[#00ff00]/25 bg-[#001b00]">
                        <div
                          className={`h-full ${j.status === 'failed' ? 'bg-[#ff4444]' : j.status === 'cancelled' ? 'bg-[#ffaa00]' : 'bg-[#00ff00] shadow-[0_0_8px_rgba(0,255,0,0.7)]'}`}
                          style={{ width: `${Math.max(j.status === 'running' ? 3 : 0, progress)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {j.message && j.status !== 'running' && progress <= 0 ? (
                    <div className="mt-1 text-[#00ff00]/55">{j.message}</div>
                  ) : null}

                  {metaEntries.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {metaEntries.map(([key, value]) => (
                        <span key={`${j.job_id}-${key}`} className="border border-[#00ff00]/20 bg-black/50 px-1.5 py-0.5 text-[#00ff00]/55">
                          {key}: <span className="text-[#00ff00]/80">{value}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {j.status === 'failed' && j.error && (
                    <div className="mt-2 border border-[#ff4444]/35 bg-[#ff4444]/[0.06] px-2 py-1 text-[#ff4444]/90">
                      {j.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </RetroBox>
  );
}
