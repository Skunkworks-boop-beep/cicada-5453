/**
 * App configuration. Production: use env vars / runtime config.
 *
 * Backend / offload: All NN API and MT5 requests use getNnApiBaseUrl(). When a remote
 * server is set (Server/Offload panel), that URL is used — build and MT5 run on the
 * remote machine. When empty, the local/default URL is used. No simulated or mock
 * backend; all requests are real HTTP to the chosen server.
 */

const ENV = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : ({} as Record<string, string | undefined>);

/** Max bars to request for backtests (full history depth). Deriv caps at 50k; MT5 copy_rates_range returns all in date range. */
export const BACKTEST_FULL_HISTORY_BARS = 50_000;

/** Min bars required before any process runs. Prevents inference/skip; halt with descriptive error if insufficient. */
export const MIN_BARS_REQUIRED_BACKTEST = 10;
export const MIN_BARS_REQUIRED_RESEARCH = 200;

/** Earliest date for backtest (YYYY-MM-DD). Broker returns from whenever it has data. Set VITE_BACKTEST_DATE_FROM to override. */
export const BACKTEST_DATE_FROM_EARLIEST = (ENV.VITE_BACKTEST_DATE_FROM as string | undefined) ?? '2000-01-01';

/** All timeframes for full historical depth (no partial TF selection). Used when full depth is required. */
export const FULL_DEPTH_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'] as const;

const _num = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Backtest execution config. Overridable via BacktestRunRequest or env (VITE_BACKTEST_*). */
export const BACKTEST_CONFIG = {
  /** Initial equity (USD). Set VITE_BACKTEST_INITIAL_EQUITY. */
  initialEquity: _num(ENV.VITE_BACKTEST_INITIAL_EQUITY, 10_000),
  /** Default spread as price fraction when no instrument spread (0.01%). Set VITE_BACKTEST_DEFAULT_SPREAD_PCT. */
  defaultSpreadPct: _num(ENV.VITE_BACKTEST_DEFAULT_SPREAD_PCT, 0.0001),
  /** Slippage as price fraction (0.005%). Set VITE_BACKTEST_SLIPPAGE_PCT. */
  slippagePct: _num(ENV.VITE_BACKTEST_SLIPPAGE_PCT, 0.00005),
  /** Risk per trade as fraction of equity (1%). Set VITE_BACKTEST_RISK_PER_TRADE_PCT. */
  riskPerTradePct: _num(ENV.VITE_BACKTEST_RISK_PER_TRADE_PCT, 0.01),
  /** Stop loss as fraction of entry price (2%). Set VITE_BACKTEST_STOP_LOSS_PCT. */
  stopLossPct: _num(ENV.VITE_BACKTEST_STOP_LOSS_PCT, 0.02),
  /** Take profit as multiple of stop distance (2R). Set VITE_BACKTEST_TAKE_PROFIT_R. */
  takeProfitR: _num(ENV.VITE_BACKTEST_TAKE_PROFIT_R, 2),
  /** Regime detection rolling window (bars). Set VITE_BACKTEST_REGIME_LOOKBACK. */
  regimeLookback: _num(ENV.VITE_BACKTEST_REGIME_LOOKBACK, 50),
} as const;

/** Live feed refresh interval (ms). Same rate for TickerBar, PriceChart, portfolio prices. */
export const LIVE_FEED_INTERVAL_MS = 2_000;

/** Cache TTL for Deriv active_symbols (ms). Avoids rate limit; symbols rarely change during session. */
export const DERIV_ACTIVE_SYMBOLS_CACHE_MS = 300_000;

/** Min delay (ms) between ticks_history requests. Deriv rate-limits; throttle to avoid "rate limit for ticks_history". */
export const DERIV_TICKS_HISTORY_THROTTLE_MS = 350;

/** Min delay (ms) between portfolio requests. Deriv rate-limits; all portfolio/positions callers share one fetch. */
export const DERIV_PORTFOLIO_THROTTLE_MS = 6_000;

/** Cache TTL for tick quotes per symbol. Avoids ticks rate limit when LiveSpreadPanel + syncInstrumentSpreads both fetch. */
export const DERIV_TICK_QUOTE_CACHE_MS = 3_000;

const defaultNnApiUrl =
  ENV.VITE_NN_API_URL ??
  (typeof window !== 'undefined' ? `${window.location.origin.replace(/:\d+$/, '')}:8000` : 'http://localhost:8000');

export const config = {
  /** NN API base URL when no remote server is set. Set VITE_NN_API_URL in production. */
  nnApiUrl: defaultNnApiUrl,
  /** Persist store to backend storage under this key. */
  persistenceKey: 'cicada-5453-store',
  /** Default risk limits (institutional). */
  defaultRiskLimits: {
    maxTotalExposurePct: 2,
    maxDrawdownPct: 0.2,
    maxPositionsPerInstrument: 3,
    maxCorrelatedBucketExposurePct: 1.5,
  },
} as const;

const SETTINGS_TIMEOUT_MS = 8000;
let remoteServerUrlCache: string | null = null;
let settingsLoaded = false;

/** True if URL points to localhost (same machine). Don't treat as "remote offload". */
export function isLocalBackendUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '';
  } catch {
    return false;
  }
}

/** Get the saved remote server URL, or null if using this machine. */
export function getRemoteServerUrl(): string | null {
  return remoteServerUrlCache;
}

/** Load remote-server setting from backend storage. */
export async function loadRemoteServerUrlFromBackend(): Promise<void> {
  if (settingsLoaded) return;
  try {
    const res = await fetch(`${config.nnApiUrl.replace(/\/$/, '')}/settings`, {
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    });
    if (!res.ok) {
      settingsLoaded = true;
      return;
    }
    const data = (await res.json()) as { settings?: { remoteServerUrl?: unknown } };
    const raw = data?.settings?.remoteServerUrl;
    const next = typeof raw === 'string' ? raw.trim() : '';
    remoteServerUrlCache = next.length > 0 ? next : null;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[config] loadRemoteServerUrlFromBackend failed:', e);
    }
  } finally {
    settingsLoaded = true;
  }
}

/** Save or clear the remote server URL via backend storage. Empty string or null = use this machine. */
export function setRemoteServerUrl(url: string | null): void {
  const u = url != null ? String(url).trim() : '';
  remoteServerUrlCache = u.length > 0 ? u : null;
  settingsLoaded = true;
  try {
    fetch(`${config.nnApiUrl.replace(/\/$/, '')}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteServerUrl: remoteServerUrlCache }),
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    }).catch((e) => {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[config] setRemoteServerUrl backend sync failed:', e);
      }
    });
  } catch (e) {
    console.error('setRemoteServerUrl failed:', e);
  }
}

/** Effective API base URL: remote server if set (offload), otherwise this machine (default). Used by all build and MT5 requests. */
export function getNnApiBaseUrl(): string {
  const remote = getRemoteServerUrl();
  if (remote != null && remote.length > 0) return remote.replace(/\/$/, '');
  return config.nnApiUrl;
}

/** True when a real remote server is configured (not localhost/0.0.0.0). Use for "Offloading to" display and remote-only logic. */
export function isRemoteOffloadConfigured(): boolean {
  const remote = getRemoteServerUrl();
  if (remote == null || remote.length === 0) return false;
  return !isLocalBackendUrl(remote);
}
