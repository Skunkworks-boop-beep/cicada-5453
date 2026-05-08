/**
 * NN API client for bot build and MT5. All requests use getNnApiBaseUrl() (local or
 * remote when offload is configured). No mock or simulated responses; production only.
 */

import { getNnApiBaseUrl } from './config';
import {
  DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
  DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
  DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
  DEFAULT_RESEARCH_REGIME_GRID_MAX,
} from './gridConfig';
import type { BacktestResultRow, StrategyParams, Timeframe, TradeScope } from './types';

export interface BuildRequestPayload {
  results: Array<{
    instrumentId: string;
    strategyId: string;
    strategyParams?: StrategyParams;
    timeframe: string;
    regime: string;
    winRate: number;
    profit: number;
    trades: number;
    maxDrawdown?: number;
    profitFactor?: number;
    dataEndTime?: string;
  }>;
  validation_results?: Array<{
    instrumentId: string;
    strategyId: string;
    strategyParams?: StrategyParams;
    timeframe: string;
    regime: string;
    winRate: number;
    profit: number;
    trades: number;
    maxDrawdown?: number;
    profitFactor?: number;
    dataEndTime?: string;
  }>;
  instrument_types: Record<string, string>;
  epochs?: number;
  lr?: number;
  /** "instrumentId|timeframe" -> OHLC bars for detection training. When present, trains bar-level detection model. */
  bars?: Record<string, Array<{ open: number; high: number; low: number; close: number; time?: number }>>;
}

export interface BuildResponse {
  success: boolean;
  message: string;
  checkpoint_path?: string | null;
  /** 256-dim vector for /predict; store on bot as nnFeatureVector for regime-aware inference. */
  feature_vector?: number[] | null;
  /** Out-of-sample accuracy on validation set (0–1). */
  oos_accuracy?: number | null;
  /** Number of validation samples used. */
  oos_sample_count?: number | null;
  /** When detection model: timeframe NN was trained on (for bar fetch at predict). */
  detection_timeframe?: string | null;
  /** When detection model: bar window size (for bar_window at predict). */
  detection_bar_window?: number | null;
  /** Per-timeframe detection models trained during build. Keyed by timeframe. */
  detection_models?: Record<string, {
    timeframe: Timeframe;
    scope?: TradeScope;
    bar_window: number;
    checkpoint_path?: string;
    val_accuracy?: number;
    num_samples?: number;
    strategy_id?: string;
  }> | null;
}

/** NN `/build` can run for many minutes (detection training + epochs). User cancel still aborts via merged signal. */
const BUILD_REQUEST_TIMEOUT_MS = 900_000;

/** Abort when either signal aborts (user cancel or server-side timeout). */
function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const c = new AbortController();
  const onAbort = () => {
    c.abort();
    a.removeEventListener('abort', onAbort);
    b.removeEventListener('abort', onAbort);
  };
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return c.signal;
}

function toBacktestRow(r: BacktestResultRow) {
  return {
    instrumentId: r.instrumentId,
    strategyId: r.strategyId,
    strategyParams: r.strategyParams,
    timeframe: r.timeframe,
    regime: r.regime,
    winRate: r.winRate,
    profit: r.profit,
    trades: r.trades,
    maxDrawdown: r.maxDrawdown,
    profitFactor: r.profitFactor,
    sharpeRatio: r.sharpeRatio ?? 0,
    sortinoRatio: r.sortinoRatio ?? 0,
    dataEndTime: r.dataEndTime ?? r.completedAt,
  };
}

export async function postBuild(
  results: BacktestResultRow[],
  instrumentTypes: Record<string, string>,
  options: {
    epochs?: number;
    lr?: number;
    signal?: AbortSignal;
    validationResults?: BacktestResultRow[];
    bars?: Record<string, Array<{ open: number; high: number; low: number; close: number; time?: number }>>;
  } = {}
): Promise<BuildResponse> {
  const payload: BuildRequestPayload = {
    results: results
      .filter((r) => r.status === 'completed' && (r.dataEndTime ?? r.completedAt))
      .map(toBacktestRow),
    instrument_types: instrumentTypes,
    epochs: options.epochs ?? 50,
    lr: options.lr ?? 1e-3,
  };
  if (options.validationResults?.length) {
    payload.validation_results = options.validationResults
      .filter((r) => r.status === 'completed' && (r.dataEndTime ?? r.completedAt))
      .map(toBacktestRow);
  }
  if (options.bars && Object.keys(options.bars).length > 0) {
    payload.bars = options.bars;
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), BUILD_REQUEST_TIMEOUT_MS);
  const userSignal = options.signal;
  const fetchSignal = userSignal
    ? mergeAbortSignals(userSignal, timeoutController.signal)
    : timeoutController.signal;

  try {
    const res = await fetch(`${getNnApiBaseUrl()}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: fetchSignal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      return { success: false, message: `HTTP ${res.status}: ${text}` };
    }
    const data = (await res.json()) as BuildResponse;
    return data;
  } catch (e) {
    clearTimeout(timeout);
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, message: `Request failed: ${message}` };
  }
}

export interface PredictRequest {
  instrument_id: string;
  feature_vector: number[];
  instrument_type: string;
  regime: string;
  timeframe: string;
  /** Scope (scalp/day/swing/position) for NN style head selection. When set, backend uses it for style_index. */
  scope?: string;
  closed_trades?: Array<{ pnl: number }>;
  volatility_pct?: number;
  /** Regime confidence (0–1). Used for regime_onehot scaling and gates multiple positions per instrument. */
  regime_confidence?: number;
  /** Last N OHLC bars for detection model (when trained on bars). */
  bar_window?: Array<{ open: number; high: number; low: number; close: number; time?: number }>;
}

export interface PredictResponse {
  actions: number[];
  style_names: string[];
  confidence?: number;
  size_multiplier?: number;
  sl_pct?: number;
  tp_r?: number;
  strategy_idx?: number | null;
  strategy_id?: string | null;
}

/** Parse FastAPI HTTPException body `{ "detail": "..." }` or string. */
function parseApiErrorDetail(text: string): string {
  const trimmed = text.trim().slice(0, 800);
  try {
    const j = JSON.parse(text) as { detail?: unknown };
    if (typeof j.detail === 'string') return j.detail;
    if (Array.isArray(j.detail)) return j.detail.map((x) => (typeof x === 'object' && x && 'msg' in x ? String((x as { msg: string }).msg) : String(x))).join('; ');
    if (j.detail != null) return String(j.detail);
  } catch {
    /* not JSON */
  }
  return trimmed || '(empty body)';
}

/** Run NN inference with current regime and timeframe so decisions are regime-aware. */
const PREDICT_TIMEOUT_MS = 60_000;

export async function postPredict(
  payload: PredictRequest,
  options: { signal?: AbortSignal } = {}
): Promise<PredictResponse> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options.signal ?? AbortSignal.timeout(PREDICT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = parseApiErrorDetail(text);
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[api] postPredict HTTP ${res.status}:`, detail);
      }
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return JSON.parse(text) as PredictResponse;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] postPredict failed:', e);
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Fetch persisted bot configs from backend. Used on load to restore bots across sessions/devices. */
export async function getBots(options?: { signal?: AbortSignal }): Promise<BotConfigPayload[]> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/bots`, {
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { bots?: BotConfigPayload[] };
    return Array.isArray(data.bots) ? data.bots : [];
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] getBots failed:', e);
    }
    return [];
  }
}

/** Persist bot configs to backend. Called after build/deploy/update/delete so bots survive reconnect/refresh. */
export async function postBots(bots: BotConfigPayload[], options?: { signal?: AbortSignal }): Promise<boolean> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bots),
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] postBots failed:', e);
    }
    return false;
  }
}

export type BotConfigPayload = Record<string, unknown>;

export async function getHealth(options?: { timeoutMs?: number }): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] getHealth failed:', e);
    }
    return false;
  }
}

/** Execution log event (matches backend schema). */
export interface ExecutionLogEventPayload {
  id: string;
  timestamp: string;
  botId: string;
  symbol: string;
  phase: string;
  outcome: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Append execution events to backend for persistent lookback. */
export async function postExecutionLogAppend(
  events: ExecutionLogEventPayload[],
  options?: { signal?: AbortSignal }
): Promise<{ appended: number; total: number } | null> {
  if (!events.length) return null;
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/execution-log/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { appended: number; total: number };
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] postExecutionLogAppend failed:', e);
    }
    return null;
  }
}

// ── Backend execution daemon control ──────────────────────────────────────

export interface DaemonBotSummary {
  bot_id: string;
  enabled: boolean;
  last_tick_ts: number;
  instrument_id: string;
  scope: string;
  last_event?: Record<string, unknown> | null;
}

export interface DaemonDeployPayload {
  bot_id: string;
  instrument_id: string;
  instrument_symbol: string;
  instrument_type?: string;
  primary_timeframe?: string;
  scope?: string;
  max_positions?: number;
  nn_feature_vector?: number[];
  nn_detection_timeframe?: string | null;
  nn_detection_bar_window?: number | null;
  risk_per_trade_pct?: number;
  max_drawdown_pct?: number;
  use_kelly?: boolean;
  kelly_fraction?: number;
  max_correlated_exposure?: number;
  default_stop_loss_pct?: number;
  default_risk_reward_ratio?: number;
}

export async function getDaemonBots(options?: { signal?: AbortSignal }): Promise<DaemonBotSummary[]> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/daemon/list`, {
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { bots?: DaemonBotSummary[] };
    return Array.isArray(data.bots) ? data.bots : [];
  } catch {
    return [];
  }
}

export async function postDaemonDeploy(
  payload: DaemonDeployPayload,
  options?: { signal?: AbortSignal }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/daemon/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options?.signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postDaemonAction(
  botId: string,
  action: 'stop' | 'enable' | 'disable',
  options?: { signal?: AbortSignal }
): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/daemon/${encodeURIComponent(botId)}/${action}`, {
      method: 'POST',
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function postDaemonPortfolio(
  equity: number,
  drawdownPct: number = 0,
  options?: { signal?: AbortSignal }
): Promise<boolean> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/daemon/portfolio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ equity, drawdown_pct: drawdownPct }),
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}


// ── Cross-request job registry + compute info ────────────────────────────

export interface JobRecord {
  job_id: string;
  kind: string;            // 'backtest' | 'research' | 'shadow' | …
  title: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;        // 0–100
  message: string;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  meta?: Record<string, unknown>;
  error?: string | null;
}

export interface ComputeInfo {
  cpu_count: number;
  backtest_workers: number;
  research_workers: number;
  torch_num_threads: number;
  use_cuda: boolean;
  device: string;
  cuda_device_count?: number;
  cuda_devices?: string[];
  use_multi_gpu?: boolean;
  tf32: boolean;
  dataloader_workers: number;
  pin_memory: boolean;
  shadow_workers: number;
}

export async function getJobs(
  options?: { kind?: string; activeOnly?: boolean; signal?: AbortSignal }
): Promise<JobRecord[]> {
  try {
    const params = new URLSearchParams();
    if (options?.kind) params.set('kind', options.kind);
    if (options?.activeOnly) params.set('active_only', 'true');
    const qs = params.toString();
    const url = `${getNnApiBaseUrl()}/jobs${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, { signal: options?.signal ?? AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { jobs?: JobRecord[] };
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

export async function postJobCancel(
  jobId: string,
  options?: { signal?: AbortSignal }
): Promise<boolean> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch one job record by id. Returns null on network failure or 404 so
 *  callers can treat "no record" and "request failed" identically. The
 *  server endpoint is ``GET /jobs/{job_id}`` (cicada_nn/api.py:455). */
export async function getJobRecord(
  jobId: string,
  options?: { signal?: AbortSignal }
): Promise<JobRecord | null> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/jobs/${encodeURIComponent(jobId)}`, {
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as JobRecord;
  } catch {
    return null;
  }
}

export async function getComputeInfo(
  options?: { signal?: AbortSignal }
): Promise<ComputeInfo | null> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/compute`, {
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ComputeInfo;
  } catch {
    return null;
  }
}

// ── Shadow training (live learning + hot-swap) ───────────────────────────

export interface ShadowTrainRequestPayload {
  instrument_id: string;
  results: Array<{
    instrumentId: string;
    strategyId: string;
    timeframe: string;
    regime: string;
    winRate: number;
    profit: number;
    trades?: number;
    maxDrawdown?: number;
    profitFactor?: number;
    sharpeRatio?: number;
    sortinoRatio?: number;
    dataEndTime?: string;
  }>;
  instrument_types?: Record<string, string>;
  epochs?: number;
  lr?: number;
  kind?: 'detection' | 'tabular';
  bars?: Record<string, Array<{ open: number; high: number; low: number; close: number; time?: number }>>;
}

export interface ShadowJobSummary {
  job_id: string;
  instrument_id: string;
  kind: string;
  status: 'queued' | 'running' | 'ready' | 'promoted' | 'failed' | 'aborted';
  started_at: string;
  finished_at?: string | null;
  error?: string | null;
  oos_accuracy?: number | null;
  parent_oos_accuracy?: number | null;
  message?: string | null;
}

export async function postShadowTrain(
  payload: ShadowTrainRequestPayload,
  options?: { signal?: AbortSignal }
): Promise<{ success: boolean; job_id?: string; status?: string; message?: string; error?: string }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/shadow/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options?.signal ?? AbortSignal.timeout(30_000),
    });
    const data = (await res.json()) as { job_id?: string; status?: string; message?: string; detail?: string };
    if (!res.ok) return { success: false, error: data.detail ?? `HTTP ${res.status}` };
    return { success: true, job_id: data.job_id, status: data.status, message: data.message };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getShadowJobs(
  instrumentId?: string,
  options?: { signal?: AbortSignal }
): Promise<ShadowJobSummary[]> {
  try {
    const url = `${getNnApiBaseUrl()}/shadow/jobs${instrumentId ? `?instrument_id=${encodeURIComponent(instrumentId)}` : ''}`;
    const res = await fetch(url, { signal: options?.signal ?? AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { jobs?: ShadowJobSummary[] };
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

export async function postShadowPromote(
  jobId: string,
  gate?: { minOosAccuracy?: number; accuracyTolerance?: number; warmupSeconds?: number },
  options?: { signal?: AbortSignal }
): Promise<{ promoted: boolean; reason?: string; job_id?: string }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/shadow/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: jobId,
        min_oos_accuracy: gate?.minOosAccuracy,
        accuracy_tolerance: gate?.accuracyTolerance,
        warmup_seconds: gate?.warmupSeconds,
      }),
      signal: options?.signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { promoted: false, reason: `HTTP ${res.status}` };
    return (await res.json()) as { promoted: boolean; reason?: string; job_id?: string };
  } catch (e) {
    return { promoted: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function postShadowAbort(
  jobId: string,
  options?: { signal?: AbortSignal }
): Promise<{ aborted: boolean }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/shadow/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { aborted: false };
    return (await res.json()) as { aborted: boolean };
  } catch {
    return { aborted: false };
  }
}

/** Fetch execution log from backend (persistent lookback across reloads). */
export async function getExecutionLog(
  options?: { limit?: number; symbol?: string; signal?: AbortSignal }
): Promise<ExecutionLogEventPayload[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.symbol != null) params.set('symbol', options.symbol);
    const url = `${getNnApiBaseUrl()}/execution-log${params.toString() ? '?' + params : ''}`;
    const res = await fetch(url, {
      signal: options?.signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { events?: ExecutionLogEventPayload[] };
    return data.events ?? [];
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] getExecutionLog failed:', e);
    }
    return [];
  }
}

/** Test connection to a server URL (e.g. before saving as remote). Returns success and a user-facing message. */
export async function testServerConnection(
  baseUrl: string,
  options: { timeoutMs?: number; username?: string; password?: string } = {}
): Promise<{ success: boolean; message: string; status?: number }> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = baseUrl.replace(/\/$/, '') + '/health';
  const headers: Record<string, string> = {};
  if (options.username != null && options.password != null && (options.username !== '' || options.password !== '')) {
    try {
      const cred = options.username + ':' + options.password;
      headers.Authorization = 'Basic ' + btoa(cred);
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[api] Basic auth skipped (btoa non-Latin1):', e);
      }
    }
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (res.ok) {
      return { success: true, message: `Connected to server at ${baseUrl}`, status: res.status };
    }
    if (res.status === 401) {
      return { success: false, message: 'Authentication failed. Check username and password.', status: 401 };
    }
    if (res.status === 403) {
      return { success: false, message: 'Access denied. Check credentials.', status: 403 };
    }
    if (res.status === 404) {
      return { success: false, message: 'API not found. Check port (e.g. 8000 for backend).', status: 404 };
    }
    if (res.status >= 500) {
      return { success: false, message: `Server error (${res.status}). Try again later.`, status: res.status };
    }
    return { success: false, message: `Server returned ${res.status}.`, status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('timeout') || msg.includes('abort')) {
      return { success: false, message: 'Connection timed out. Check firewall and that the server is reachable.' };
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      return { success: false, message: 'Server unreachable. Check IP, port, and that the server is running.' };
    }
    return { success: false, message: msg || 'Connection failed.' };
  }
}

// ---------- MT5: login page credentials → backend MT5 account ----------

export interface Mt5ConnectRequest {
  login: string;
  password: string;
  server?: string;
}

export interface Mt5ConnectResponse {
  connected: boolean;
  message: string;
  account?: {
    login: number;
    server: string;
    balance: number;
    /** When present, use for display (balance + floating P/L from MT5 positions). */
    equity?: number;
    currency: string;
    leverage: number;
    trade_allowed: boolean;
    company: string;
  } | null;
}

export async function postMt5Connect(
  login: string,
  password: string,
  server: string = ''
): Promise<Mt5ConnectResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/mt5/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: String(login).trim(), password, server: String(server).trim() }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = (await res.json()) as Mt5ConnectResponse;
    if (!res.ok) {
      return { connected: false, message: data.message || `HTTP ${res.status}`, account: null };
    }
    return data;
  } catch (e) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    return { connected: false, message: msg.includes('abort') ? 'Connection timeout' : msg, account: null };
  }
}

export async function getMt5Status(): Promise<{ mt5_available: boolean; connected: boolean }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/mt5/status`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return { mt5_available: !!data.mt5_available, connected: !!data.connected };
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] getMt5Status failed:', e);
    }
    return { mt5_available: false, connected: false };
  }
}

/** Get current MT5 account balance/equity when already connected. No reconnect. */
export async function getMt5Account(): Promise<{ connected: boolean; account?: { balance: number; equity?: number } }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/mt5/account`, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { connected?: boolean; account?: { balance?: number; equity?: number } };
    if (!data.connected || !data.account) {
      return { connected: false };
    }
    const bal = Number(data.account.balance ?? 0);
    const eq = data.account.equity != null ? Number(data.account.equity) : bal;
    return {
      connected: true,
      account: {
        balance: Number.isFinite(bal) ? bal : 0,
        equity: Number.isFinite(eq) ? eq : bal,
      },
    };
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[api] getMt5Account failed:', e);
    }
    return { connected: false };
  }
}

export interface Mt5OhlcBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getMt5Ohlc(
  symbol: string,
  timeframe: string = "M5",
  count: number = 50_000,
  dateFrom?: string,
  dateTo?: string,
  signal?: AbortSignal
): Promise<{ bars: Mt5OhlcBar[] } | { error: string }> {
  try {
    const params = new URLSearchParams({
      symbol,
      timeframe,
      count: String(Math.min(count, 50_000)),
    });
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    const res = await fetch(
      `${getNnApiBaseUrl()}/mt5/ohlc?${params.toString()}`,
      { signal: signal ?? AbortSignal.timeout(15_000) }
    );
    const data = (await res.json()) as { bars?: Mt5OhlcBar[]; error?: string };
    if (data.error || !data.bars) {
      return { error: data.error ?? "No data" };
    }
    return { bars: data.bars };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'MT5 OHLC fetch failed' };
  }
}

/** Open positions from MT5 (so positions opened via the MT5 add-on can be viewed in the app). */
export interface Mt5PositionRow {
  ticket: number;
  symbol: string;
  type: number; // 0 = buy, 1 = sell
  volume: number;
  price_open: number;
  price_current: number;
  profit: number;
  sl?: number | null;
  tp?: number | null;
  time: number;
}

export async function getMt5Positions(): Promise<{ positions: Mt5PositionRow[] } | { error: string }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/mt5/positions`, { signal: AbortSignal.timeout(10_000) });
    const data = (await res.json()) as { positions?: Mt5PositionRow[]; error?: string };
    if (data.error) return { error: data.error };
    return { positions: data.positions ?? [] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'MT5 positions fetch failed' };
  }
}

/** Partially close an MT5 position by ticket. Requires MT5 connected. */
export async function postMt5ClosePartial(params: {
  ticket: number;
  symbol: string;
  volume: number;
  positionType: number; // 0=buy, 1=sell
}): Promise<{ success: true } | { error: string }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/mt5/close-partial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket: params.ticket,
        symbol: params.symbol,
        volume: params.volume,
        position_type: params.positionType,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { success?: boolean; detail?: string };
    if (!res.ok) return { error: data.detail ?? `HTTP ${res.status}` };
    if (data.success) return { success: true };
    return { error: 'Partial close failed' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'MT5 partial close failed' };
  }
}

/** Place a market order via MT5. Requires MT5 connected. */
export async function postMt5Order(params: {
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  sl?: number;
  tp?: number;
}): Promise<{ success: true; order?: number; ticket?: number } | { error: string }> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/mt5/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { success?: boolean; order?: number; ticket?: number; detail?: string };
    if (!res.ok) return { error: data.detail ?? `HTTP ${res.status}` };
    if (data.success) return { success: true, order: data.order, ticket: data.ticket };
    return { error: 'Order failed' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'MT5 order failed' };
  }
}

/** Live spread in points per symbol (from broker). Requires MT5 connected. */
export async function getMt5SymbolSpreads(
  symbols: string[]
): Promise<{ spreads: Record<string, number> } | { error: string }> {
  if (symbols.length === 0) return { spreads: {} };
  try {
    const q = symbols.map((s) => s.replace(/\s/g, '')).filter(Boolean).join(',');
    const res = await fetch(
      `${getNnApiBaseUrl()}/mt5/symbols_spread?symbols=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = (await res.json()) as { spreads?: Record<string, number>; error?: string };
    if (data.error) return { error: data.error };
    return { spreads: data.spreads ?? {} };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'MT5 symbols spread fetch failed' };
  }
}

/** Live position prices: bid/ask per symbol for mark-to-market P/L. Requires MT5 connected. */
export async function getMt5Prices(
  symbols: string[]
): Promise<{ prices: Record<string, { bid: number; ask: number }> } | { error: string }> {
  if (symbols.length === 0) return { prices: {} };
  try {
    const q = symbols.map((s) => s.replace(/\s/g, '')).filter(Boolean).join(',');
    const res = await fetch(
      `${getNnApiBaseUrl()}/mt5/prices?symbols=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = (await res.json()) as { prices?: Record<string, { bid: number; ask: number }>; error?: string };
    if (data.error) return { error: data.error };
    return { prices: data.prices ?? {} };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'MT5 prices fetch failed' };
  }
}

/** OHLC bar for server backtest (client fetches from Deriv/eXness/MT5). */
export interface OhlcBarForBacktest {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Server-side backtest offload: POST /backtest. Returns results when backend supports it. */
export async function postBacktest(
  request: {
    instrumentIds: string[];
    strategyIds: string[];
    timeframes: string[];
    regimes: string[];
    dateFrom: string;
    dateTo: string;
    instrument_symbols?: Record<string, string>;
    strategy_names?: Record<string, string>;
    /** Bars fetched by client from chosen brokers (Deriv/eXness/MT5). Key: "instrumentId|timeframe" */
    bars?: Record<string, OhlcBarForBacktest[]>;
    /** instrumentId -> spread (points). When set, backtest uses live broker spreads. */
    instrumentSpreads?: Record<string, number>;
    /** Risk per trade (0.01 = 1%), stop loss (0.02 = 2%), take profit R (2), regime lookback (50), etc. */
    riskPerTradePct?: number;
    stopLossPct?: number;
    takeProfitR?: number;
    regimeLookback?: number;
    initialEquity?: number;
    slippagePct?: number;
    /** instrumentId -> { riskPerTradePct?, stopLossPct?, takeProfitR? } */
    instrumentRiskOverrides?: Record<string, { riskPerTradePct?: number; stopLossPct?: number; takeProfitR?: number }>;
    /** "instrumentId|strategyId" -> risk params (takes precedence) */
    jobRiskOverrides?: Record<string, { riskPerTradePct?: number; stopLossPct?: number; takeProfitR?: number }>;
    /** Max param combos per strategy (1 = default only; 24 = full grid) */
    paramCombosLimit?: number;
    /** Instrument-specific regime config (from research). Tuned from each instrument's own behavior. */
    regimeTunes?: Record<string, Record<string, number>>;
    /** When HTF bars are sent under instrumentId|HTF: map regime from HTF (omit/auto/true/false). */
    preferHtfRegime?: boolean;
    /** Instrument types so the server cost model charges per-type commission/swap. */
    instrumentTypes?: Record<string, string>;
  },
  signal?: AbortSignal
): Promise<{ results: BacktestResultRow[]; status: string } | { error: string }> {
  const timeoutMs = 1_800_000;
  const abortSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instrumentIds: request.instrumentIds,
        strategyIds: request.strategyIds,
        timeframes: request.timeframes,
        regimes: request.regimes,
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
        instrument_symbols: request.instrument_symbols ?? {},
        strategy_names: request.strategy_names ?? {},
        bars: request.bars ?? {},
        instrument_spreads: request.instrumentSpreads ?? {},
        risk_per_trade_pct: request.riskPerTradePct,
        stop_loss_pct: request.stopLossPct,
        take_profit_r: request.takeProfitR,
        regime_lookback: request.regimeLookback,
        initial_equity: request.initialEquity,
        slippage_pct: request.slippagePct,
        instrument_risk_overrides: request.instrumentRiskOverrides ?? undefined,
        job_risk_overrides: request.jobRiskOverrides ?? undefined,
        param_combos_limit: request.paramCombosLimit ?? DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
        regime_tunes: request.regimeTunes ?? undefined,
        prefer_htf_regime: request.preferHtfRegime,
        instrument_types: request.instrumentTypes ?? undefined,
      }),
      signal: abortSignal,
    });
    const data = (await res.json()) as { results?: BacktestResultRow[]; status?: string; detail?: string };
    if (!res.ok) return { error: data.detail ?? `HTTP ${res.status}` };
    const results = (data.results ?? []).map((r) => ({
      ...r,
      id: r.id ?? `bt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      status: (r.status === 'completed' || r.status === 'failed' ? r.status : 'completed') as 'completed' | 'failed',
    }));
    return { results, status: data.status ?? 'completed' };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return { error: e instanceof Error ? e.message : 'Backtest request failed' };
  }
}

/** Stream server-side backtest progress/results (NDJSON). */
export async function postBacktestStream(
  request: {
    instrumentIds: string[];
    strategyIds: string[];
    timeframes: string[];
    regimes: string[];
    dateFrom: string;
    dateTo: string;
    instrument_symbols?: Record<string, string>;
    strategy_names?: Record<string, string>;
    bars?: Record<string, OhlcBarForBacktest[]>;
    instrumentSpreads?: Record<string, number>;
    riskPerTradePct?: number;
    stopLossPct?: number;
    takeProfitR?: number;
    regimeLookback?: number;
    initialEquity?: number;
    slippagePct?: number;
    instrumentRiskOverrides?: Record<string, { riskPerTradePct?: number; stopLossPct?: number; takeProfitR?: number }>;
    jobRiskOverrides?: Record<string, { riskPerTradePct?: number; stopLossPct?: number; takeProfitR?: number }>;
    paramCombosLimit?: number;
    regimeTunes?: Record<string, Record<string, number>>;
    preferHtfRegime?: boolean;
    instrumentTypes?: Record<string, string>;
  },
  onChunk: (chunk: {
    type?: string;
    row?: BacktestResultRow;
    completed?: number;
    total?: number;
    progress?: number;
    phase?: string;
    message?: string;
    results?: BacktestResultRow[];
    status?: string;
  }) => void,
  signal?: AbortSignal
): Promise<{ results: BacktestResultRow[]; status: string } | { error: string }> {
  const timeoutMs = 1_800_000;
  const abortSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/backtest/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instrumentIds: request.instrumentIds,
        strategyIds: request.strategyIds,
        timeframes: request.timeframes,
        regimes: request.regimes,
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
        instrument_symbols: request.instrument_symbols ?? {},
        strategy_names: request.strategy_names ?? {},
        bars: request.bars ?? {},
        instrument_spreads: request.instrumentSpreads ?? {},
        risk_per_trade_pct: request.riskPerTradePct,
        stop_loss_pct: request.stopLossPct,
        take_profit_r: request.takeProfitR,
        regime_lookback: request.regimeLookback,
        initial_equity: request.initialEquity,
        slippage_pct: request.slippagePct,
        instrument_risk_overrides: request.instrumentRiskOverrides ?? undefined,
        job_risk_overrides: request.jobRiskOverrides ?? undefined,
        param_combos_limit: request.paramCombosLimit ?? DEFAULT_BACKTEST_PARAM_COMBOS_LIMIT,
        regime_tunes: request.regimeTunes ?? undefined,
        prefer_htf_regime: request.preferHtfRegime,
        instrument_types: request.instrumentTypes ?? undefined,
      }),
      signal: abortSignal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { detail?: string };
      return { error: data.detail ?? `HTTP ${res.status}` };
    }
    const reader = res.body?.getReader();
    if (!reader) return { error: 'No response body' };
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResults: BacktestResultRow[] = [];
    let finalStatus = 'completed';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as {
            type?: string;
            row?: BacktestResultRow;
            completed?: number;
            total?: number;
            progress?: number;
            phase?: string;
            message?: string;
            results?: BacktestResultRow[];
            status?: string;
          };
          onChunk(chunk);
          if (chunk.type === 'done') {
            finalResults = (chunk.results ?? []).map((r) => ({
              ...r,
              id: r.id ?? `bt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              status: (r.status === 'completed' || r.status === 'failed' ? r.status : 'completed') as 'completed' | 'failed',
            }));
            finalStatus = chunk.status ?? 'completed';
          } else if (chunk.type === 'error') {
            return { error: chunk.message ?? 'Backtest stream failed' };
          }
        } catch {
          // skip malformed line
        }
      }
    }
    return { results: finalResults, status: finalStatus };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return { error: e instanceof Error ? e.message : 'Backtest stream failed' };
  }
}

/** Regime tune result for one instrument. */
export interface RegimeTune {
  instrumentId: string;
  instrumentSymbol: string;
  regimeConfig: Record<string, number>;
  score: number;
  regimeDistribution: Record<string, number>;
  /** Phase 0: regime detection validated (unknown < 10%, no single regime > 80%, entropy OK). */
  validated?: boolean;
  regimeValidationMessage?: string;
}

/** Param tune result for one instrument × strategy × regime. */
export interface ParamTune {
  instrumentId: string;
  strategyId: string;
  regime: string;
  timeframe: string;
  strategyParams: Record<string, number>;
  riskParams: { stopLossPct: number; riskPerTradePct: number; takeProfitR: number };
  sharpeInSample: number;
  profitOOS: number;
  tradesOOS: number;
}

/** Stream research progress (NDJSON). Calls onProgress for each chunk, returns final result. */
export async function postResearchGridStream(
  request: {
    instrumentIds: string[];
    strategyIds: string[];
    timeframes?: string[];
    regimes?: string[];
    dateFrom: string;
    dateTo: string;
    instrument_symbols?: Record<string, string>;
    strategy_names?: Record<string, string>;
    bars?: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>>;
    instrument_spreads?: Record<string, number>;
    regime_grid_max?: number;
    param_tune_max_strat?: number;
    param_tune_max_risk?: number;
    robust_mode?: boolean;
    calibration_hints?: Record<string, { regimeConfig: Record<string, number>; strategyId: string; score: number }>;
  },
  onProgress: (msg: { type: string; message?: string; level?: 'info' | 'progress' | 'success' | 'warning' | 'error'; phase?: string; instrumentId?: string; strategyId?: string; regime?: string; progress?: number; total?: number; completed?: number }) => void,
  signal?: AbortSignal
): Promise<
  | { status: string; regimeTunes: RegimeTune[]; paramTunes: ParamTune[]; baselineResults?: Array<{ instrumentId: string; instrumentSymbol: string; regimeDistribution: Record<string, number>; baselineAvgSharpe: number; baselineTotalProfit: number }>; skippedInstruments?: Array<{ instrumentId: string; instrumentSymbol?: string; reason: string; barCount?: number; minRequired?: number; detail?: string }> }
  | { error: string }
> {
  const timeoutMs = 600_000;
  const abortSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/research/grid/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instrumentIds: request.instrumentIds,
        strategyIds: request.strategyIds,
        timeframes: request.timeframes ?? ['M5', 'H1'],
        regimes: request.regimes ?? [],
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
        instrument_symbols: request.instrument_symbols ?? {},
        strategy_names: request.strategy_names ?? {},
        bars: request.bars ?? {},
        instrument_spreads: request.instrument_spreads ?? {},
        regime_grid_max: request.regime_grid_max ?? DEFAULT_RESEARCH_REGIME_GRID_MAX,
        param_tune_max_strat: request.param_tune_max_strat ?? DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
        param_tune_max_risk: request.param_tune_max_risk ?? DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
        robust_mode: request.robust_mode ?? false,
        calibration_hints: request.calibration_hints,
      }),
      signal: abortSignal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { detail?: string };
      return { error: data.detail ?? `HTTP ${res.status}` };
    }
    const reader = res.body?.getReader();
    if (!reader) return { error: 'No response body' };
    const decoder = new TextDecoder();
    let buffer = '';
    let result: { regimeTunes: RegimeTune[]; paramTunes: ParamTune[]; baselineResults?: Array<{ instrumentId: string; instrumentSymbol: string; regimeDistribution: Record<string, number>; baselineAvgSharpe: number; baselineTotalProfit: number }>; skippedInstruments?: Array<{ instrumentId: string; instrumentSymbol?: string; reason: string; barCount?: number; minRequired?: number; detail?: string }> } | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as { type?: string; message?: string; phase?: string; instrumentId?: string; strategyId?: string; regime?: string; regimeTunes?: RegimeTune[]; paramTunes?: ParamTune[]; baselineResults?: Array<{ instrumentId: string; instrumentSymbol: string; regimeDistribution: Record<string, number>; baselineAvgSharpe: number; baselineTotalProfit: number }>; skippedInstruments?: Array<{ instrumentId: string; instrumentSymbol?: string; reason: string; barCount?: number; minRequired?: number; detail?: string }> };
          if (chunk.type === 'done') {
            result = { regimeTunes: chunk.regimeTunes ?? [], paramTunes: chunk.paramTunes ?? [], baselineResults: chunk.baselineResults ?? [], skippedInstruments: chunk.skippedInstruments ?? [] };
          } else if (chunk.type === 'progress') {
            onProgress(chunk);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
    if (result) return { status: 'completed', ...result };
    return { error: 'Stream ended without result' };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return { error: e instanceof Error ? e.message : 'Research request failed' };
  }
}

/** Backward validation: analyze closed trades to find calibrations that would have been profitable. */
export async function postBackwardValidate(request: {
  closed_trades: Array<{
    instrumentId: string;
    botId: string;
    type: string;
    pnl: number;
    entryPrice?: number;
    openedAt?: string;
    closedAt: string;
    scope?: string;
    nnSlPct?: number;
    nnTpR?: number;
  }>;
  bars: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>>;
  instrument_symbols: Record<string, string>;
  strategy_ids: string[];
}): Promise<
  | { validatedTrades: Array<{ instrumentId: string; correctSide: string; simulatedPnl: number }>; calibrationHints: Record<string, { regimeConfig: Record<string, number>; strategyId: string; score: number }>; summary: { total: number; verified: number; skipped: number } }
  | { error: string }
> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/research/backward-validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: (data as { detail?: string }).detail ?? `HTTP ${res.status}` };
    return data as { validatedTrades: Array<{ instrumentId: string; correctSide: string; simulatedPnl: number }>; calibrationHints: Record<string, { regimeConfig: Record<string, number>; strategyId: string; score: number }>; summary: { total: number; verified: number; skipped: number } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Backward validation failed' };
  }
}

/** Server-side grid research: regime calibration + param tune per instrument × regime. */
export async function postResearchGrid(
  request: {
    instrumentIds: string[];
    strategyIds: string[];
    timeframes?: string[];
    regimes?: string[];
    dateFrom: string;
    dateTo: string;
    instrument_symbols?: Record<string, string>;
    strategy_names?: Record<string, string>;
    bars?: Record<string, Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>>;
    instrument_spreads?: Record<string, number>;
    regime_grid_max?: number;
    param_tune_max_strat?: number;
    param_tune_max_risk?: number;
  },
  signal?: AbortSignal
): Promise<
  | { status: string; regimeTunes: RegimeTune[]; paramTunes: ParamTune[] }
  | { error: string }
> {
  const timeoutMs = 600_000; // 10 min for research
  const abortSignal = signal ?? AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/research/grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instrumentIds: request.instrumentIds,
        strategyIds: request.strategyIds,
        timeframes: request.timeframes ?? ['M5', 'H1'],
        regimes: request.regimes ?? [],
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
        instrument_symbols: request.instrument_symbols ?? {},
        strategy_names: request.strategy_names ?? {},
        bars: request.bars ?? {},
        instrument_spreads: request.instrument_spreads ?? {},
        regime_grid_max: request.regime_grid_max ?? DEFAULT_RESEARCH_REGIME_GRID_MAX,
        param_tune_max_strat: request.param_tune_max_strat ?? DEFAULT_RESEARCH_PARAM_TUNE_MAX_STRAT,
        param_tune_max_risk: request.param_tune_max_risk ?? DEFAULT_RESEARCH_PARAM_TUNE_MAX_RISK,
      }),
      signal: abortSignal,
    });
    const data = (await res.json()) as {
      status?: string;
      regimeTunes?: RegimeTune[];
      paramTunes?: ParamTune[];
      baselineResults?: Array<{ instrumentId: string; instrumentSymbol: string; regimeDistribution: Record<string, number>; baselineAvgSharpe: number; baselineTotalProfit: number }>;
      detail?: string;
    };
    if (!res.ok) return { error: data.detail ?? `HTTP ${res.status}` };
    return {
      status: data.status ?? 'completed',
      regimeTunes: data.regimeTunes ?? [],
      paramTunes: data.paramTunes ?? [],
      baselineResults: data.baselineResults ?? [],
    };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return { error: e instanceof Error ? e.message : 'Research request failed' };
  }
}

// ─── Stage 2A: bridge + latency endpoints ───────────────────────────────

export interface BridgeHealth {
  reachable: boolean;
  mt5_connected: boolean;
  account?: string | null;
  error?: string | null;
}

/** Probe the MT5 bridge running inside the Windows VM. Never throws. */
export async function getBridgeHealth(): Promise<BridgeHealth> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/bridge/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return {
      reachable: !!data.reachable,
      mt5_connected: !!data.mt5_connected,
      account: data.account ?? null,
      error: data.error ?? null,
    };
  } catch (e) {
    return { reachable: false, mt5_connected: false, account: null, error: e instanceof Error ? e.message : 'unknown' };
  }
}

export interface LatencyStatus {
  current_rtt_ms: number | null;
  current_session: string;
  baseline_p50_ms: number | null;
  baseline_p95_ms: number | null;
  baseline_p99_ms: number | null;
  baseline_sample_count: number;
  baseline_valid: boolean;
  anomaly: boolean;
}

/** Live latency snapshot: current RTT + per-session baseline. Polled by ProcessMonitor. */
export async function getLatencyStatus(): Promise<LatencyStatus | null> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/latency/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      current_rtt_ms: data.current_rtt_ms ?? null,
      current_session: String(data.current_session ?? ''),
      baseline_p50_ms: data.baseline_p50_ms ?? null,
      baseline_p95_ms: data.baseline_p95_ms ?? null,
      baseline_p99_ms: data.baseline_p99_ms ?? null,
      baseline_sample_count: Number(data.baseline_sample_count ?? 0),
      baseline_valid: !!data.baseline_valid,
      anomaly: !!data.anomaly,
    };
  } catch {
    return null;
  }
}

export interface LatencyBaseline {
  session_profile: Record<string, { p50?: number; p95?: number; p99?: number; sample_count: number }>;
  day_of_week_profile: Record<string, { avg?: number; p95?: number; sample_count: number }>;
  current_session: string;
}

export async function getLatencyBaseline(): Promise<LatencyBaseline | null> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/latency/baseline`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as LatencyBaseline;
  } catch {
    return null;
  }
}


// ── Stage 2B: analytical-core endpoints ──────────────────────────────────

export interface GeometricMapVolumeNode {
  price: number;
  score: number;
}

export interface GeometricMapSwingPoint {
  idx: number;
  time: number;
  price: number;
}

export interface GeometricMapSRLevel {
  price: number;
  kind: 'support' | 'resistance';
  confirmations: number;
  score: number;
}

export interface GeometricMapMeta {
  version: number;
  symbol: string;
  n_bars: number;
  bar_first_time: number;
  bar_last_time: number;
  atr_at_build: number;
  input_sha: string;
}

export interface GeometricMap {
  symbol: string;
  bins: number[];
  volume_nodes: GeometricMapVolumeNode[];
  swing_highs: GeometricMapSwingPoint[];
  swing_lows: GeometricMapSwingPoint[];
  support_levels: GeometricMapSRLevel[];
  resistance_levels: GeometricMapSRLevel[];
  meta: GeometricMapMeta;
}

/** Fetch the latest persisted geometric map for a symbol. ``null`` on 404 so the
 * dashboard panel can show ``[ NO MAP — RUN BUILD ]`` without throwing. */
export async function getGeometricMap(symbol: string): Promise<GeometricMap | null> {
  try {
    const res = await fetch(`${getNnApiBaseUrl()}/map/geometric/${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as GeometricMap;
  } catch {
    return null;
  }
}

