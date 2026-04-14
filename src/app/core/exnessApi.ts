/**
 * eXness REST API client (primary connection to eXness).
 * Connect with API key from Exness Personal Area → API section.
 * MT5 is an add-on; this API is the main way to connect to eXness programmatically.
 *
 * Base URL and endpoint paths follow common patterns; adjust per official Exness developer docs
 * if your token or region uses different URLs.
 */

const DEFAULT_EXNESS_API_BASE = 'https://api.exness.com';

export interface ExnessAccountInfo {
  balance: number;
  equity?: number;
  currency?: string;
}

export interface ExnessPositionRow {
  id: string;
  symbol: string;
  type: 'buy' | 'sell';
  volume: number;
  price_open: number;
  price_current: number;
  profit?: number;
  sl?: number;
  tp?: number;
  time?: number;
}

function getBaseUrl(configBaseUrl?: string): string {
  const u = (configBaseUrl ?? '').trim();
  return u.length > 0 ? u.replace(/\/$/, '') : DEFAULT_EXNESS_API_BASE;
}

const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (!text || !text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`eXness API response parse error: ${msg}`);
  }
}

/**
 * Test connection and fetch account info (balance, equity).
 * Use this to connect the broker; on success the app sets portfolio balance and dataSource.
 */
export async function getExnessAccount(
  apiKey: string,
  baseUrl?: string
): Promise<ExnessAccountInfo> {
  const base = getBaseUrl(baseUrl);
  const data = await request<{ balance?: number; equity?: number; currency?: string; data?: ExnessAccountInfo }>(
    base,
    apiKey,
    '/account',
    { method: 'GET' }
  );
  const info = (data as { data?: ExnessAccountInfo }).data ?? data;
  const balance = Number(info?.balance ?? (data as ExnessAccountInfo).balance ?? 0);
  const equity = Number(info?.equity ?? (data as ExnessAccountInfo).equity ?? balance);
  return {
    balance: Number.isFinite(balance) ? balance : 0,
    equity: Number.isFinite(equity) ? equity : balance,
    currency: (info as ExnessAccountInfo)?.currency ?? (data as ExnessAccountInfo)?.currency,
  };
}

/**
 * Fetch open positions from eXness API (if supported by the token scope).
 * Returns list of positions for display in Live Portfolio.
 */
export async function getExnessPositions(
  apiKey: string,
  baseUrl?: string
): Promise<ExnessPositionRow[]> {
  const base = getBaseUrl(baseUrl);
  try {
    const data = await request<{ positions?: ExnessPositionRow[]; data?: ExnessPositionRow[] }>(
      base,
      apiKey,
      '/positions',
      { method: 'GET' }
    );
    const list = (data as { data?: ExnessPositionRow[] }).data ?? (data as { positions?: ExnessPositionRow[] }).positions ?? [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[exnessApi] getExnessPositions failed:', e);
    }
    return [];
  }
}

/**
 * Test that the API key and base URL are valid (e.g. before saving in Brokers).
 */
export async function testExnessConnection(
  apiKey: string,
  baseUrl?: string
): Promise<{ success: boolean; message: string }> {
  try {
    await getExnessAccount(apiKey, baseUrl);
    return { success: true, message: 'Connected to eXness API' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: msg || 'Connection failed' };
  }
}
