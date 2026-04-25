/**
 * Deriv WebSocket API client.
 * Connects to wss://ws.derivws.com/websockets/v3, authorizes with token, keeps connection alive.
 * @see https://developers.deriv.com/docs/websockets
 */

import { DERIV_ACTIVE_SYMBOLS_CACHE_MS, DERIV_TICKS_HISTORY_THROTTLE_MS, DERIV_PORTFOLIO_THROTTLE_MS, DERIV_TICK_QUOTE_CACHE_MS } from './config';
import {
  DERIV_GLOBAL,
  DERIV_PORTFOLIO,
  DERIV_PROPOSAL,
  DERIV_BUY_SELL,
  DERIV_TICK,
  DERIV_TICKS_HISTORY,
} from './rateLimiter';
import { inferPointSize } from './spreadUtils';
import { isDerivFiatOrCryptoApiSymbol, resolveDerivMarketDataSymbol } from './derivSymbolMaps';

const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3';
const PING_INTERVAL_MS = 30000;

type DerivMessage = Record<string, unknown>;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reqId = 0;
const pending = new Map<number, { resolve: (v: DerivMessage) => void; reject: (e: Error) => void }>();
/** One-time listener for tick stream: first response may be subscription ack without tick; tick arrives in subsequent message. */
let pendingTickResolve: ((tick: { bid: number; ask: number; quote?: number; pip_size?: number }) => void) | null = null;

/** Called when the WebSocket closes (explicit disconnect or unexpected). Register from store to sync broker status. */
let onConnectionLost: (() => void) | null = null;
export function setOnDerivConnectionLost(cb: (() => void) | null): void {
  onConnectionLost = cb;
}

function nextReqId(): number {
  return ++reqId;
}

function clearPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/**
 * Connect to Deriv WebSocket and authorize with the given token.
 * @param appId - App ID from api.deriv.com
 * @param token - Session token (Personal Access Token or OAuth token)
 * @returns Resolves with authorize response on success; rejects on connection or auth error.
 */
export function connect(appId: string, token: string): Promise<DerivMessage> {
  return new Promise((resolve, reject) => {
    // Close any existing connection and reject its pending; don't use disconnect() so we don't
    // accidentally reject this promise if it's a double-invocation (we haven't added to pending yet).
    clearPing();
    if (ws) {
      const old = ws;
      ws = null;
      pending.forEach(({ reject: rej }) => rej(new Error('Disconnected')));
      pending.clear();
      old.close();
    }
    const url = `${DERIV_WS_URL}?app_id=${encodeURIComponent(appId.trim())}`;
    const socket = new WebSocket(url);
    ws = socket;

    const timeout = setTimeout(() => {
      if (ws === socket) {
        pending.forEach((_, id) => {
          const p = pending.get(id);
          if (p) p.reject(new Error('Connection timeout'));
        });
        pending.clear();
        ws = null;
        socket.close();
      }
    }, 15000);

    socket.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as DerivMessage;
        // Tick stream: first response may be subscription ack without tick; tick arrives in subsequent push message
        if (data.msg_type === 'tick' && data.tick && pendingTickResolve) {
          const t = data.tick as { bid?: number; ask?: number; quote?: number; pip_size?: number };
          const bid = Number(t.bid ?? 0);
          const ask = Number(t.ask ?? 0);
          if (bid > 0 && ask > 0) {
            pendingTickResolve({ bid, ask, pip_size: t.pip_size });
            pendingTickResolve = null;
          }
          /* quote-only (no bid/ask): do not estimate — broker data only */
        }
        const id = data.req_id as number | undefined;
        if (id != null && pending.has(id)) {
          clearTimeout(timeout);
          const { resolve: res, reject: rej } = pending.get(id)!;
          pending.delete(id);
          const err = data.error as { message?: string; code?: string } | undefined;
          if (err?.message) {
            const msg = (err.message as string).toLowerCase();
            const isAuthError =
              /invalid\s*token|authorization|not\s*authorized|login|session|oauth|unauthorized|auth\s*failed/i.test(msg) ||
              err.code === 'InvalidToken' ||
              err.code === 'AuthorizationRequired';
            if (isAuthError) disconnect();
            rej(new Error(err.message as string));
            return;
          }
          if (pingTimer == null) {
            pingTimer = setInterval(() => {
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ ping: 1, req_id: nextReqId() }));
              }
            }, PING_INTERVAL_MS);
          }
          res(data);
        }
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[derivApi] WebSocket message parse error:', e);
        }
      }
    };

    socket.onopen = () => {
      const id = nextReqId();
      pending.set(id, {
        resolve: (msg) => resolve(msg),
        reject: (e) => reject(e),
      });
      socket.send(JSON.stringify({ authorize: token.trim(), req_id: id }));
    };

    socket.onerror = () => {
      clearTimeout(timeout);
      if (ws === socket) {
        pending.forEach(({ reject: rej }) => rej(new Error('WebSocket error')));
        pending.clear();
        ws = null;
        reject(new Error('WebSocket error'));
      }
    };

    socket.onclose = (ev) => {
      clearTimeout(timeout);
      if (ws === socket) {
        clearPing();
        ws = null;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[derivApi] Broker disconnected (WebSocket closed)', ev.code, ev.reason || '');
        }
        pending.forEach(({ reject: rej }) => rej(new Error('Connection closed')));
        pending.clear();
        const cb = onConnectionLost;
        onConnectionLost = null;
        cb?.();
        reject(new Error('Connection closed'));
      }
    };
  });
}

/**
 * Disconnect and clear state.
 */
export function disconnect(): void {
  clearPing();
  pendingTickResolve = null;
  portfolioPricesCache = null;
  portfolioRawCache = null;
  tickQuoteCache.clear();
  if (ws) {
    ws.close();
    ws = null;
  }
  pending.forEach(({ reject: rej }) => rej(new Error('Disconnected')));
  pending.clear();
  clearActiveSymbolsCache();
  const cb = onConnectionLost;
  onConnectionLost = null;
  cb?.();
}

/**
 * Whether the client is connected and authorized.
 */
export function isConnected(): boolean {
  return ws != null && ws.readyState === WebSocket.OPEN;
}

/**
 * Get current account balance. Requires authorized connection.
 * Response shape: { balance: { balance: number, currency?: string, loginid?: string } }.
 * @returns Balance in account currency (e.g. USD)
 */
export async function getBalance(): Promise<number> {
  const res = await request<{ balance?: { balance?: number } | number }>({ balance: 1 });
  const raw = typeof res.balance === 'object' && res.balance !== null ? (res.balance as { balance?: number }).balance : res.balance;
  return raw != null && Number.isFinite(Number(raw)) ? Number(raw) : 0;
}

/**
 * Send a request and wait for the response (by req_id).
 * Use after connect() for active_symbols, proposal, buy, etc.
 */
export function request<T = DerivMessage>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected'));
      return;
    }
    const id = nextReqId();
    const msg = { ...payload, req_id: id };
    pending.set(id, {
      resolve: (r) => resolve(r as T),
      reject,
    });
    ws.send(JSON.stringify(msg));
  });
}

/**
 * Fetch active symbols (available instruments) from Deriv.
 * Returns the raw API response; extract symbols from response.active_symbols.
 * API requires active_symbols to be "full" or "brief" (string), not a number.
 */
export function getActiveSymbols(): Promise<DerivMessage> {
  return request({ active_symbols: 'full' });
}

/** Single entry from active_symbols (legacy `symbol` or new `underlying_symbol`). */
export interface DerivActiveSymbol {
  symbol?: string;
  underlying_symbol?: string;
  market?: string;
  submarket?: string;
  subgroup?: string;
}

/**
 * Deriv synthetic indices: exact underlying_symbol names (API short codes).
 * Volatility 1s, DEX, Drift removed — not returned by API for this account.
 */
const DERIV_SYNTHETIC_UNDERLYING_SYMBOLS = {
  volatility: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
  crashBoom: [
    'BOOM50', 'BOOM150N', 'BOOM300N', 'BOOM500', 'BOOM600', 'BOOM900', 'BOOM1000',
    'CRASH50', 'CRASH150N', 'CRASH300N', 'CRASH500', 'CRASH600', 'CRASH900', 'CRASH1000',
  ],
  step: ['10', '15', '25', '30', '50', '75', '90', '100', '150', '200'].map((n) => `1HZ${n}V`),
  jump: ['10', '25', '50', '75', '100'].map((n) => `jump_${n}`),
  rangeBreak: ['range_break_100', 'range_break_200'],
  /** RDBULL/RDBEAR: distinct bull/bear variants so callers can tell direction. */
  rangeBreakRdBull: ['range_break_rdbull'],
  rangeBreakRdBear: ['range_break_rdbear'],
  /** World / other indices returned by API (WLDAUD, etc.) — include so they validate and appear in app. */
  world: ['WLDAUD', 'WLDEUR', 'WLDGBP', 'WLDXAU', 'WLDUSD'],
  /** Step indices API codes (stpRNG, stpRNG2, stpRNG3, stpRNG4, stpRNG5) when API returns these instead of 1HZ*V. */
  stepApi: ['stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5'],
} as const;

/** Group names for Deriv synthetic indices (for validation informatics). */
export type DerivSyntheticGroup = 'Volatility' | 'Crash/Boom' | 'Jump' | 'Step' | 'Range Break' | 'World' | 'Uncategorized';

const SYNTHETIC_GROUP_PATTERNS: { group: DerivSyntheticGroup; test: (s: string) => boolean }[] = [
  { group: 'Volatility', test: (s) => /^R_\d+$/i.test(s) },
  { group: 'Crash/Boom', test: (s) => /^(Crash|Boom)\s*\d+/i.test(s) || /^(crash|boom)_\d+/i.test(s) || /^CRASH\d+N?$/i.test(s) || /^BOOM\d+N?$/i.test(s) },
  { group: 'Jump', test: (s) => /^Jump\s*\d+/i.test(s) || /^jump_\d+/i.test(s) || /^JD\d+$/i.test(s) },
  { group: 'Step', test: (s) => /^1HZ\d+V$/i.test(s) || /^1hz\d+v$/i.test(s) || /^Step\s/i.test(s) || /^stpRNG\d*$/i.test(s) },
  { group: 'Range Break', test: (s) => /^Range\s*Break\s*\d+/i.test(s) || /^range_break_\d+/i.test(s) || /^RB\d+$/i.test(s) || /^RDBULL$/i.test(s) || /^RDBEAR$/i.test(s) || /^range_break_rdbull$/i.test(s) || /^range_break_rdbear$/i.test(s) },
  { group: 'World', test: (s) => /^WLD[A-Z0-9]+$/i.test(s) },
];

/** Canonical forms (lowercase) for matching; derived from DERIV_SYNTHETIC_UNDERLYING_SYMBOLS. */
const REGISTRY_CANONICAL_FORMS = new Set<string>(
  [
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.volatility,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.jump,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.rangeBreak,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.rangeBreakRdBull,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.rangeBreakRdBear,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.step,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.crashBoom,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.world,
    ...DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.stepApi,
  ].map((s) => s.toLowerCase())
);

/**
 * Map: registry symbol -> possible API strings (official underlying_symbol first; display variants for validation).
 * Built from DERIV_SYNTHETIC_UNDERLYING_SYMBOLS. Primary form is the short code used by ticks_history/active_symbols.
 */
function buildRegistryToDerivApiMap(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (official: string, displayVariants: string[] = []) => {
    const forms = [official, ...displayVariants];
    m.set(official, forms);
    m.set(official.toLowerCase(), forms);
  };
  for (const sym of DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.volatility) {
    add(sym);
  }
  for (const sym of DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.jump) {
    const n = sym.replace(/^jump_/, '');
    add(sym, [`Jump ${n} Index`, `Jump ${n}`, `JD${n}`]);
  }
  for (const sym of DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.rangeBreak) {
    const n = sym.replace(/^range_break_/, '');
    const rbApi = `RB${n}`;
    add(sym, [`Range Break ${n} Index`, `Range Break ${n}`, rbApi]);
  }
  add('range_break_rdbull', ['RDBULL']);
  add('range_break_rdbear', ['RDBEAR']);
  for (const sym of DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.step) {
    const stepApi = sym === '1HZ150V' ? ['stpRNG'] : sym === '1HZ200V' ? ['stpRNG2'] : [];
    add(sym, [sym.toLowerCase(), ...stepApi]);
  }
  for (const sym of DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.stepApi) {
    add(sym, [sym.toLowerCase()]);
  }
  for (const sym of DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.crashBoom) {
    add(sym, [sym.toLowerCase()]);
  }
  for (const sym of DERIV_SYNTHETIC_UNDERLYING_SYMBOLS.world) {
    add(sym, [sym.toLowerCase()]);
  }
  return m;
}

const REGISTRY_TO_DERIV_API = buildRegistryToDerivApiMap();

/** Get possible API symbol forms for ticks/ticks_history. Try each until one works. */
function getPossibleApiSymbolsForTicks(registrySymbol: string): string[] {
  const lookupKey = registrySymbol.trim().toLowerCase().replace(/\s+/g, '_');
  const possible =
    REGISTRY_TO_DERIV_API.get(registrySymbol) ??
    REGISTRY_TO_DERIV_API.get(lookupKey) ??
    [registrySymbol];
  return [...possible];
}

/** Normalise an API symbol for set membership: trim, lowercase, collapse spaces to single space. */
function normaliseApiSymbolForMatch(s: string): string[] {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  const u = t.replace(/\s+/g, '_');
  return [s.trim(), t, u];
}

/** Set of every possible API symbol string we expect (from registry map), plus normalised variants, so we never drop a matching item. */
function buildAllPossibleDerivApiForms(): Set<string> {
  const set = new Set<string>();
  for (const forms of REGISTRY_TO_DERIV_API.values()) {
    for (const f of forms) {
      set.add(f);
      for (const n of normaliseApiSymbolForMatch(f)) {
        set.add(n);
      }
    }
  }
  return set;
}
const ALL_POSSIBLE_DERIV_API_FORMS = buildAllPossibleDerivApiForms();

/** Normalize string for matching: unicode whitespace/punctuation -> ascii, lowercase, single spaces. */
function normalizeForCanonical(s: string): string {
  return s
    .replace(/[\s\u00A0\u2000-\u200B\u202F\u205F\u3000]+/g, ' ')
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Map an API symbol string to the exact canonical form(s) that match our registry (lowercase for set matching).
 * Used when building apiSet so validation always finds a match regardless of API formatting.
 */
function apiSymbolToCanonicalForms(apiSymbol: string): string[] {
  const raw = normalizeForCanonical(apiSymbol);
  const t = raw.replace(/\s+/g, ' ');
  const tNoSpaces = t.replace(/\s/g, '');
  const tUnderscore = t.replace(/\s+/g, '_');
  const out: string[] = [];

  // Fallback: exact registry match (API returns "jump_10", "R_10", etc.)
  if (REGISTRY_CANONICAL_FORMS.has(tUnderscore)) {
    out.push(tUnderscore);
    return out;
  }
  const rawTrim = apiSymbol.trim();
  // Deriv API alternate codes (from active_symbols): JD*=Jump, RB*=Range Break, RDBULL/RDBEAR=Range Break, stpRNG=Step
  const jdMatch = /^JD(\d+)$/i.exec(rawTrim);
  if (jdMatch && REGISTRY_CANONICAL_FORMS.has(`jump_${jdMatch[1]}`)) {
    out.push(`jump_${jdMatch[1]}`);
    return out;
  }
  const rbMatch = /^RB(\d+)$/i.exec(rawTrim);
  if (rbMatch && REGISTRY_CANONICAL_FORMS.has(`range_break_${rbMatch[1]}`)) {
    out.push(`range_break_${rbMatch[1]}`);
    return out;
  }
  if (/^RDBULL$/i.test(rawTrim)) {
    out.push('range_break_rdbull');
    return out;
  }
  if (/^RDBEAR$/i.test(rawTrim)) {
    out.push('range_break_rdbear');
    return out;
  }
  if (/^stpRNG\d*$/i.test(rawTrim)) {
    const stepMap: Record<string, string> = { stpRNG: '1hz150v', stpRNG2: '1hz200v', stpRNG3: 'stprng3', stpRNG4: 'stprng4', stpRNG5: 'stprng5' };
    const c = stepMap[rawTrim] ?? rawTrim.toLowerCase();
    out.push(REGISTRY_CANONICAL_FORMS.has(c) ? c : rawTrim.toLowerCase());
    return out;
  }
  if (/^WLD[A-Z0-9]+$/i.test(rawTrim) && REGISTRY_CANONICAL_FORMS.has(rawTrim.toLowerCase())) {
    out.push(rawTrim.toLowerCase());
    return out;
  }

  // Volatility (R_ index): R_10, R_25, R_50, R_75, R_100
  const rIndex = /^r_(\d+)$/i.exec(apiSymbol.trim());
  if (rIndex) {
    out.push(`r_${rIndex[1]}`);
    return out;
  }
  // Crash/Boom: BOOM50, CRASH150N, etc.
  const crashBoom = /^(crash|boom)(\d+)(n?)$/i.exec(t);
  if (crashBoom) {
    out.push(`${crashBoom[1]}${crashBoom[2]}${crashBoom[3]}`);
    return out;
  }
  // Jump: "Jump 10 Index", "jump_10", "Jump 10"
  const jump = /jump[_\s]*(\d+)/i.exec(t);
  if (jump) {
    out.push(`jump_${jump[1]}`);
    return out;
  }
  // Range Break: "Range Break 100 Index", "range_break_100"
  const rb = /range[_\s]*break[_\s]*(\d+)/i.exec(t);
  if (rb) {
    out.push(`range_break_${rb[1]}`);
    return out;
  }
  // Step: "1HZ150V", "1HZ 150 V", "1hz150v"
  const step = /1hz(\d+)v/i.exec(tNoSpaces);
  if (step) {
    out.push(`1hz${step[1]}v`);
    return out;
  }

  // Loose fallback: string contains key parts -> try known canonical
  const jumpLoose = /jump[^a-z0-9]*(\d+)/i.exec(apiSymbol.trim());
  if (jumpLoose && REGISTRY_CANONICAL_FORMS.has(`jump_${jumpLoose[1]}`)) {
    out.push(`jump_${jumpLoose[1]}`);
    return out;
  }
  const rbLoose = /range[^a-z0-9]*break[^a-z0-9]*(\d+)/i.exec(apiSymbol.trim());
  if (rbLoose && REGISTRY_CANONICAL_FORMS.has(`range_break_${rbLoose[1]}`)) {
    out.push(`range_break_${rbLoose[1]}`);
    return out;
  }
  return out;
}

function normalizeDerivSymbol(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Get the primary symbol from an active_symbols item (underlying_symbol preferred). */
function getSymbolFromItem(item: DerivActiveSymbol): string | null {
  const raw = (item.underlying_symbol ?? item.symbol) as string | undefined;
  if (!raw || typeof raw !== 'string') return null;
  return normalizeDerivSymbol(raw);
}

/** Collect all symbol strings from an item (both symbol and underlying_symbol) for matching. */
function getSymbolsFromItem(item: DerivActiveSymbol): string[] {
  const out: string[] = [];
  const u = (item.underlying_symbol as string | undefined)?.trim();
  const s = (item.symbol as string | undefined)?.trim();
  if (u) out.push(normalizeDerivSymbol(u));
  if (s && s !== u) out.push(normalizeDerivSymbol(s));
  return out;
}

/** Cache for active_symbols to avoid rate limit. TTL from config. */
let activeSymbolsCache: { data: { symbols: string[]; byGroup: Record<DerivSyntheticGroup, string[]> }; expiresAt: number } | null = null;
let activeSymbolsBackoffUntil = 0;
let ticksHistoryBackoffUntil = 0;
let ticksHistoryWarnedAt = 0;
const DERIV_TICKS_HISTORY_RATE_LIMIT_COOLDOWN_MS = 120_000;

export function clearActiveSymbolsCache(): void {
  activeSymbolsCache = null;
}

/**
 * Fetch only synthetic indices from Deriv active_symbols.
 * Cached to avoid rate limit; invalidated on disconnect.
 * Requires Deriv to be connected. Returns list of symbols and by group for validation informatics.
 */
export async function getActiveSyntheticSymbols(): Promise<{
  symbols: string[];
  byGroup: Record<DerivSyntheticGroup, string[]>;
}> {
  const now = Date.now();
  if (activeSymbolsCache && activeSymbolsCache.expiresAt > now) {
    return activeSymbolsCache.data;
  }
  if (activeSymbolsCache && now < activeSymbolsBackoffUntil) {
    return activeSymbolsCache.data;
  }
  let res: DerivMessage;
  try {
    res = await getActiveSymbols();
  } catch (e) {
    const message = getDerivErrorMessage(e);
    if (isDerivRateLimit(message) && activeSymbolsCache) {
      activeSymbolsBackoffUntil = now + DERIV_TICKS_HISTORY_RATE_LIMIT_COOLDOWN_MS;
      return activeSymbolsCache.data;
    }
    throw e;
  }
  const list = (res.active_symbols as DerivActiveSymbol[] | undefined) ?? [];
  const symbols: string[] = [];
  const byGroup: Record<DerivSyntheticGroup, string[]> = {
    Volatility: [],
    'Crash/Boom': [],
    Jump: [],
    Step: [],
    'Range Break': [],
    World: [],
    Uncategorized: [],
  };

  for (const item of list) {
    const syms = getSymbolsFromItem(item);
    if (syms.length === 0) continue;
    const primary = syms[0];
    // Include if: (1) market/submarket/subgroup contains "synthetic", or (2) any symbol matches our registry→API map, or (3) symbol parses to a known canonical form
    const marketStr = [item.market, item.submarket, item.subgroup].filter(Boolean).join(' ');
    const isSyntheticMarket = /synthetic/i.test(marketStr);
    const matchesOurMap = syms.some((sym) =>
      ALL_POSSIBLE_DERIV_API_FORMS.has(sym) ||
      normaliseApiSymbolForMatch(sym).some((n) => ALL_POSSIBLE_DERIV_API_FORMS.has(n))
    );
    const parsesToCanonical = syms.some((sym) => apiSymbolToCanonicalForms(sym).some((c) => REGISTRY_CANONICAL_FORMS.has(c)));
    const isSynthetic = isSyntheticMarket || matchesOurMap || parsesToCanonical;
    if (!isSynthetic) continue;
    for (const sym of syms) {
      if (!symbols.includes(sym)) symbols.push(sym);
    }
    for (const { group, test } of SYNTHETIC_GROUP_PATTERNS) {
      if (test(primary)) {
        for (const sym of syms) {
          if (!byGroup[group].includes(sym)) byGroup[group].push(sym);
        }
        break;
      }
    }
  }

  activeSymbolsCache = {
    data: { symbols, byGroup },
    expiresAt: now + DERIV_ACTIVE_SYMBOLS_CACHE_MS,
  };
  return { symbols, byGroup };
}

/** Map our instrument display symbol to possible Deriv API symbols for matching. */
export function ourSymbolToDerivKeys(ourSymbol: string): string[] {
  const s = ourSymbol.trim().replace(/\s+/g, ' ');
  const keys = new Set<string>();
  keys.add(s);

  const beforeParen = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (beforeParen !== s) keys.add(beforeParen);

  // jump_10, jump_25 — API may return "Jump 10 Index", "Jump 10"
  const jumpUnderscore = /^jump_(\d+)$/i.exec(s);
  if (jumpUnderscore) {
    const n = jumpUnderscore[1];
    keys.add(s);
    keys.add(`Jump ${n} Index`);
    keys.add(`Jump ${n}`);
    keys.add(`jump_${n}`);
    return [...keys];
  }

  // range_break_rdbull, range_break_rdbear — distinct RDBULL/RDBEAR mapping
  if (/^range_break_rdbull$/i.test(s)) {
    keys.add('RDBULL');
    keys.add('range_break_rdbull');
    return [...keys];
  }
  if (/^range_break_rdbear$/i.test(s)) {
    keys.add('RDBEAR');
    keys.add('range_break_rdbear');
    return [...keys];
  }

  // range_break_100, range_break_200
  const rbUnderscore = /^range_break_(\d+)$/i.exec(s);
  if (rbUnderscore) {
    const n = rbUnderscore[1];
    keys.add(s);
    keys.add(`Range Break ${n} Index`);
    keys.add(`Range Break ${n}`);
    keys.add(`range_break_${n}`);
    return [...keys];
  }

  // R_10, R_25 (Volatility index)
  if (/^R_\d+$/i.test(beforeParen)) {
    keys.add(beforeParen);
    return [...keys];
  }

  // Crash 150 Index / Boom 150 Index — API may return "Crash 150 Index", "crash_150", "Crash 150"
  const crashBoom = /^(Crash|Boom)\s+(\d+)\s+Index$/i.exec(s);
  if (crashBoom) {
    const kind = crashBoom[1];
    const n = crashBoom[2];
    const kindLower = kind.toLowerCase();
    keys.add(`${kind} ${n} Index`);
    keys.add(`${kind} ${n}`);
    keys.add(`${kindLower}_${n}`);
    keys.add(`${kindLower}_${n}_index`);
    return [...keys];
  }

  // Jump 10 Index — API may return "Jump 10 Index", "Jump 10", "jump_10"
  const jump = /^Jump\s+(\d+)\s+Index$/i.exec(s);
  if (jump) {
    const n = jump[1];
    keys.add(`Jump ${n} Index`);
    keys.add(`Jump ${n}`);
    keys.add(`jump_${n}`);
    keys.add(`jump_${n}_index`);
    return [...keys];
  }

  // 1HZ100V, 1HZ150V, 1HZ200V — API may return same or lowercase (e.g. 1hz150v)
  if (/^1HZ\d+V$/i.test(s)) {
    keys.add(s);
    keys.add(s.toLowerCase());
    keys.add(s.toUpperCase());
    keys.add(s.replace(/\s+/g, '_'));
    return [...keys];
  }

  // Range Break 100 Index — API may return "Range Break 100 Index", "Range Break 100", "range_break_100"
  const rb = /^Range\s*Break\s+(\d+)\s+Index$/i.exec(s);
  if (rb) {
    const n = rb[1];
    keys.add(`Range Break ${n} Index`);
    keys.add(`Range Break ${n}`);
    keys.add(`range_break_${n}`);
    keys.add(`range_break_${n}_index`);
    return [...keys];
  }

  // Fallback: space and underscore variants
  keys.add(s.replace(/\s+/g, '_'));
  keys.add(s.replace(/\s+/g, '_').toLowerCase());
  return [...keys];
}

export interface DerivSyntheticValidation {
  byGroup: Record<DerivSyntheticGroup, { total: number; validated: number; missing: string[] }>;
  apiSymbolsNotInApp: string[];
  fetchedAt: number;
}

/** Instrument type for validation (need id, symbol, type). */
interface InstrumentForValidation {
  id: string;
  symbol: string;
  type: string;
  brokerId: string;
}

/** Produce normalizations of a symbol for matching (API may use spaces, underscores, "Index", etc.). */
export function symbolNormalizations(s: string): string[] {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  const out = new Set<string>();
  out.add(t);
  out.add(t.replace(/\s+/g, '_'));
  const noIndex = t.replace(/\s*index\s*/gi, ' ').trim();
  out.add(noIndex);
  out.add(noIndex.replace(/\s+/g, '_'));
  // Step: ensure 1hz150v-style is present (already in t as lowercase)
  if (/^1hz\d+v$/i.test(t)) out.add(t);

  // Explicit canonical forms so any API variant matches our registry symbols
  const jumpCanon = /jump\s*[_\s]*(\d+)/i.exec(t);
  if (jumpCanon) out.add(`jump_${jumpCanon[1]}`);
  const rbCanon = /range\s*[_\s]*break\s*[_\s]*(\d+)/i.exec(t);
  if (rbCanon) out.add(`range_break_${rbCanon[1]}`);
  const stepCanon = /1hz\s*(\d+)\s*v/i.exec(t);
  if (stepCanon) out.add(`1hz${stepCanon[1]}v`);

  return [...out];
}

/**
 * Resolve a Deriv API symbol (e.g. "Jump 10 Index", "R_10") to the registry symbol
 * so positions and execution can map to the correct instrument.
 * Returns the matching registry symbol or null if none.
 */
export function resolveDerivApiSymbolToRegistry(
  apiSymbol: string,
  registrySymbols: string[]
): string | null {
  const apiNormals = new Set(symbolNormalizations(apiSymbol));
  for (const reg of registrySymbols) {
    const keys = ourSymbolToDerivKeys(reg);
    const match = keys.some((k) => symbolNormalizations(k).some((n) => n && apiNormals.has(n)));
    if (match) return reg;
  }
  return null;
}

/**
 * Validate our synthetic_deriv instruments against Deriv API active symbols.
 * Call after getActiveSyntheticSymbols() when Deriv is connected.
 * Matching uses normalizations so API format (e.g. "Jump 10 Index" vs "jump_10") does not matter.
 */
export function validateDerivSynthetics(
  ourInstruments: InstrumentForValidation[],
  apiResult: { symbols: string[]; byGroup: Record<DerivSyntheticGroup, string[]> }
): DerivSyntheticValidation {
  const byGroup: DerivSyntheticValidation['byGroup'] = {
    Volatility: { total: 0, validated: 0, missing: [] },
    'Crash/Boom': { total: 0, validated: 0, missing: [] },
    Jump: { total: 0, validated: 0, missing: [] },
    Step: { total: 0, validated: 0, missing: [] },
    'Range Break': { total: 0, validated: 0, missing: [] },
    World: { total: 0, validated: 0, missing: [] },
    Uncategorized: { total: 0, validated: 0, missing: [] },
  };

  const synthetics = ourInstruments.filter((i) => i.type === 'synthetic_deriv' && i.brokerId === 'broker-deriv');

  // Set of API symbols as returned + normalised variants + canonical forms
  const apiSymbolsSet = new Set<string>();
  for (const s of apiResult.symbols) {
    apiSymbolsSet.add(s);
    for (const v of normaliseApiSymbolForMatch(s)) {
      apiSymbolsSet.add(v);
    }
    for (const c of apiSymbolToCanonicalForms(s)) {
      apiSymbolsSet.add(c);
    }
  }

  for (const inst of synthetics) {
    const lookupKey = inst.symbol.trim().toLowerCase().replace(/\s+/g, '_');
    const possibleApiForms =
      REGISTRY_TO_DERIV_API.get(inst.symbol) ??
      REGISTRY_TO_DERIV_API.get(lookupKey) ??
      [inst.symbol];
    const matched = possibleApiForms.some((apiForm) => {
      if (apiSymbolsSet.has(apiForm)) return true;
      for (const v of normaliseApiSymbolForMatch(apiForm)) {
        if (apiSymbolsSet.has(v)) return true;
      }
      return false;
    });
    const symForGroup = inst.symbol;
    let grouped = false;
    for (const { group, test } of SYNTHETIC_GROUP_PATTERNS) {
      if (group === 'Uncategorized') continue;
      if (test(symForGroup)) {
        byGroup[group].total += 1;
        if (matched) byGroup[group].validated += 1;
        else byGroup[group].missing.push(inst.symbol);
        grouped = true;
        break;
      }
    }
    if (!grouped) {
      byGroup.Uncategorized.total += 1;
      if (matched) byGroup.Uncategorized.validated += 1;
      else byGroup.Uncategorized.missing.push(inst.symbol);
    }
  }

  // "Not in app" = API symbols that don't match any of our registry instruments (via REGISTRY_TO_DERIV_API)
  const apiSymbolsNotInApp = apiResult.symbols.filter((apiSym) => {
    const norm = normaliseApiSymbolForMatch(apiSym);
    for (const [, possibleForms] of REGISTRY_TO_DERIV_API) {
      const found = possibleForms.some((form) =>
        norm.some((n) => n === form || normaliseApiSymbolForMatch(form).some((f) => f === n))
      );
      if (found) return false;
    }
    return true;
  });

  return { byGroup, apiSymbolsNotInApp, fetchedAt: Date.now() };
}

/**
 * Resolve our registry symbol to the symbol string to use for Deriv API (ticks_history, buy, etc.).
 * Prefer a form that appears in the API response; otherwise fall back to our registry symbol.
 */
export function getDerivApiSymbolForRequest(
  ourRegistrySymbol: string,
  apiSymbolsFromResponse: string[]
): string {
  const lookupKey = ourRegistrySymbol.trim().toLowerCase().replace(/\s+/g, '_');
  const possible =
    REGISTRY_TO_DERIV_API.get(ourRegistrySymbol) ??
    REGISTRY_TO_DERIV_API.get(lookupKey) ??
    [ourRegistrySymbol];
  const apiSet = new Set(apiSymbolsFromResponse);
  for (const form of possible) {
    if (apiSet.has(form)) return form;
    for (const v of normaliseApiSymbolForMatch(form)) {
      if (apiSet.has(v)) return form;
    }
  }
  return ourRegistrySymbol;
}

/**
 * Granularity in seconds per Deriv API.
 * Schema enum: 60,120,180,300,600,900,1800,3600,7200,14400,28800,86400 only.
 * W1 (604800) is NOT in Deriv API enum — we use D1 (86400) as approximation.
 * Backtests/live data for W1 will use daily candles; true weekly aggregation would require
 * post-processing D1 bars into weekly bars.
 */
const DERIV_GRANULARITY: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
  W1: 86400, // Deriv has no 604800; D1 used — W1 is approximated by daily candles
};

export interface DerivCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Fetch OHLC candles from Deriv (ticks_history with style=candles).
 * @param symbol - Deriv symbol (e.g. R_10, BOOM500, jump_50).
 * @param timeframe - M1, M5, M15, M30, H1, H4, D1, W1.
 * @param count - Number of candles (max 5k per Deriv API).
 * @param startEpoch - Optional: start of date range (backtest dateFrom).
 * @param endEpoch - Optional: end of date range (backtest dateTo).
 * @param adjustStartTime - When true, Deriv adjusts start if market closed at end (per API docs).
 */
export async function getTicksHistoryCandles(
  symbol: string,
  timeframe: string,
  count: number = 50_000,
  startEpoch?: number,
  endEpoch?: number,
  adjustStartTime?: boolean
): Promise<DerivCandle[]> {
  const granularity = DERIV_GRANULARITY[timeframe] ?? 300;
  const payload: Record<string, unknown> = {
    ticks_history: symbol,
    end: endEpoch != null ? String(endEpoch) : "latest",
    style: "candles",
    granularity,
    count: Math.min(count, 5_000),
  };
  if (startEpoch != null) payload.start = startEpoch;
  if (adjustStartTime) payload.adjust_start_time = 1;
  const res = await ticksHistoryRequest<{ candles?: DerivCandle[]; history?: { prices?: number[]; times?: number[] }; error?: { message: string } }>(payload);
  if (res.error?.message) {
    throw new Error(res.error.message);
  }
  if (Array.isArray(res.candles) && res.candles.length > 0) {
    const candles = res.candles.map((c) => ({ ...c }));
    // Single-tick bars are flat (O=H=L=C) → 0 volatility. Use prev close as open so we get range.
    for (let j = 1; j < candles.length; j++) {
      const cur = candles[j]!;
      if (cur.open === cur.high && cur.high === cur.low && cur.low === cur.close) {
        const prev = candles[j - 1]!;
        cur.open = prev.close;
        cur.high = Math.max(cur.open, cur.close);
        cur.low = Math.min(cur.open, cur.close);
      }
    }
    return candles;
  }
  // Some APIs return history.prices/times (tick data) - aggregate into OHLC candles.
  // Flat candles (O=H=L=C) break regime detection and signals → 0 trades. Must aggregate by period.
  const hist = res.history as { prices?: number[]; times?: number[] } | undefined;
  if (hist?.prices && hist.prices.length > 0) {
    const times = hist.times ?? hist.prices.map((_, i) => Math.floor(Date.now() / 1000) - (hist.prices!.length - i) * granularity);
    const ticks = times
      .map((t, i) => ({ epoch: t, price: hist.prices![i] ?? 0 }))
      .filter((x) => x.price > 0)
      .sort((a, b) => a.epoch - b.epoch);
    if (ticks.length === 0) return [];
    const groups = new Map<number, { open: number; high: number; low: number; close: number; epoch: number }>();
    for (const { epoch, price } of ticks) {
      const bucket = Math.floor(epoch / granularity) * granularity;
      const g = groups.get(bucket);
      if (!g) {
        groups.set(bucket, { open: price, high: price, low: price, close: price, epoch: bucket });
      } else {
        g.high = Math.max(g.high, price);
        g.low = Math.min(g.low, price);
        g.close = price;
      }
    }
    const candles = Array.from(groups.values())
      .sort((a, b) => a.epoch - b.epoch)
      .map((g) => ({ epoch: g.epoch, open: g.open, high: g.high, low: g.low, close: g.close }));
    // Single-tick bars are flat (O=H=L=C) → 0 volatility. Use prev close as open so we get range.
    for (let j = 1; j < candles.length; j++) {
      const cur = candles[j]!;
      if (cur.open === cur.high && cur.high === cur.low && cur.low === cur.close) {
        const prev = candles[j - 1]!;
        cur.open = prev.close;
        cur.high = Math.max(cur.open, cur.close);
        cur.low = Math.min(cur.open, cur.close);
      }
    }
    return candles;
  }
  return [];
}

/** Max candles per Deriv ticks_history request. API default/max is 5000 per schema. */
const DERIV_CANDLES_PER_REQUEST = 5_000;

/**
 * Token-bucket-throttled ticks_history request.
 *
 * Deriv's documented limit for `ticks_history` is **50 requests per minute**
 * per app id. The previous "min delay between requests" approach (350 ms gap)
 * allowed ~2.86 req/s — within seconds we'd accumulate >50 in any 60-s window
 * and start getting RateLimit errors. The token bucket sustains the actual
 * 0.83 req/s cap with a small burst budget.
 */
async function ticksHistoryRequest<T>(payload: Record<string, unknown>): Promise<T> {
  const maxRetries = 3;
  let lastErr: Error | null = null;
  const now = Date.now();
  if (now < ticksHistoryBackoffUntil) {
    throw new Error('Deriv ticks_history temporarily paused after rate limit');
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Wait for both a global token (overall 30 req/s ceiling) and an endpoint
    // token (50 req/min). Both are no-ops when capacity is available.
    await DERIV_GLOBAL.acquire();
    await DERIV_TICKS_HISTORY.acquire();
    try {
      return await request<T>(payload);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message.toLowerCase();
      const isRateLimit = /rate\s*limit|ticks_history/i.test(msg);
      if (isRateLimit && attempt < maxRetries) {
        // Exponential backoff layered on top of the bucket; the broker may
        // have a longer-window cap we cannot model perfectly.
        const backoffMs = 1500 * Math.pow(2, attempt + 1);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      if (isRateLimit) {
        ticksHistoryBackoffUntil = Date.now() + DERIV_TICKS_HISTORY_RATE_LIMIT_COOLDOWN_MS;
        if (typeof console !== 'undefined' && console.warn && Date.now() - ticksHistoryWarnedAt > DERIV_TICKS_HISTORY_RATE_LIMIT_COOLDOWN_MS) {
          ticksHistoryWarnedAt = Date.now();
          console.warn(`[derivApi] ticks_history rate-limited; pausing OHLCV fetches for ${Math.round(DERIV_TICKS_HISTORY_RATE_LIMIT_COOLDOWN_MS / 1000)}s`);
        }
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('ticks_history request failed');
}

/**
 * Fetch full OHLC history for a date range by chunking requests. Use when range exceeds 50k bars
 * (e.g. 1 year M5 = ~105k bars). Ensures backtest uses complete historical data.
 */
export async function getTicksHistoryCandlesFullRange(
  symbol: string,
  timeframe: string,
  startEpoch: number,
  endEpoch: number,
  signal?: AbortSignal
): Promise<DerivCandle[]> {
  const granularity = DERIV_GRANULARITY[timeframe] ?? 300;
  const totalBars = Math.ceil((endEpoch - startEpoch) / granularity);
  if (totalBars <= DERIV_CANDLES_PER_REQUEST) {
    const candles = await getTicksHistoryCandles(symbol, timeframe, totalBars, startEpoch, endEpoch, true);
    return candles;
  }
  const all: DerivCandle[] = [];
  let currentStart = startEpoch;
  while (currentStart < endEpoch) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const chunk = await getTicksHistoryCandles(
      symbol,
      timeframe,
      DERIV_CANDLES_PER_REQUEST,
      currentStart,
      endEpoch,
      true
    );
    if (chunk.length === 0) break;
    all.push(...chunk);
    const lastEpoch = chunk[chunk.length - 1]?.epoch ?? 0;
    currentStart = lastEpoch + granularity;
    if (chunk.length < DERIV_CANDLES_PER_REQUEST) break;
  }
  return all;
}

/** Portfolio contract from Deriv API (portfolio response). */
interface DerivPortfolioContract {
  contract_id?: number;
  symbol?: string;
  underlying_symbol?: string;
  contract_type?: string;
  bid_price?: number;
  ask_price?: number;
  buy_price?: number;
  sell_price?: number;
  currency?: string;
  profit?: number;
  purchase_price?: number;
  limit_order?: { stop_loss?: number; take_profit?: number };
  /** Underlying index at entry (tick contracts). Avoids using buy_price which is stake. */
  entry_spot?: number;
  entry_spot_display_value?: string;
  entry_tick?: number;
}

/** Position-like shape for display (matches app Position minus id/scope/style/botId/openedAt/riskAmount). */
export interface DerivPositionRow {
  instrumentId: string;
  instrument: string;
  type: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  stopLoss?: number;
  takeProfit?: number;
  contractId?: number;
}

let portfolioRawCache: { contracts: DerivPortfolioContract[]; at: number } | null = null;

/** Single throttled portfolio fetch. All portfolio/positions callers use this to avoid rate limit. */
async function fetchDerivPortfolioRaw(): Promise<DerivPortfolioContract[]> {
  const now = Date.now();
  if (portfolioRawCache && now - portfolioRawCache.at < DERIV_PORTFOLIO_THROTTLE_MS) {
    return portfolioRawCache.contracts;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return [];
  // portfolio is documented at 30 req/min; the bucket enforces it across all
  // callers (TickerBar + portfolio sync + bot exec).
  await DERIV_GLOBAL.acquire();
  await DERIV_PORTFOLIO.acquire();
  const res = await request<{ portfolio?: { contracts?: DerivPortfolioContract[] }; error?: { message: string } }>({
    portfolio: 1,
  });
  if (res.error?.message) throw new Error(res.error.message);
  const contracts = res.portfolio?.contracts ?? [];
  portfolioRawCache = { contracts, at: Date.now() };
  return contracts;
}

/** Closed contract from Deriv profit_table. Used for accurate P/L when reconciling. */
export interface DerivProfitTableTransaction {
  contract_id: number;
  buy_price: number;
  sell_price: number;
  profit: number;
  payout?: number;
  purchase_time: number;
  sell_time: number;
  transaction_id?: number;
}

/**
 * Fetch recent closed contracts from Deriv profit table for accurate P/L.
 * Returns last N transactions (newest first).
 *
 * Profit calculation per Deriv docs:
 * - Use explicit `profit` from API when present and finite.
 * - Fallback for binary/tick (held to expiry): win = payout - buy_price, loss = -buy_price.
 * - Fallback for early sale: profit = sell_price - buy_price.
 */
export async function getDerivProfitTable(limit = 200): Promise<DerivProfitTableTransaction[]> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return [];
  try {
    const res = await request<{
      profit_table?: { transactions?: Array<{
        contract_id?: number;
        buy_price?: number;
        sell_price?: number;
        payout?: number;
        profit?: number;
        purchase_time?: number;
        sell_time?: number;
        transaction_id?: number;
      }> };
      error?: { message: string };
    }>({ profit_table: 1, limit, sort: 'DESC', description: 1 });
    if (res.error?.message) return [];
    const tx = res.profit_table?.transactions ?? [];
    return tx
      .filter((t) => t.contract_id != null)
      .map((t) => {
        const buy = Number(t.buy_price ?? 0);
        const sell = Number(t.sell_price ?? 0);
        const payout = Number(t.payout ?? 0);
        const rawProfit = t.profit;
        const explicitProfit = typeof rawProfit === 'number' ? rawProfit : Number(rawProfit ?? NaN);
        let profit: number;
        if (Number.isFinite(explicitProfit) && explicitProfit !== 0) {
          profit = explicitProfit;
        } else if (payout > 0) {
          profit = payout - buy;
        } else if (buy > 0) {
          profit = sell - buy;
          if (!Number.isFinite(profit) || (sell === 0 && profit === 0)) profit = -buy;
        } else {
          profit = sell - buy;
        }
        return {
          contract_id: Number(t.contract_id),
          buy_price: buy,
          sell_price: sell,
          profit,
          payout: payout > 0 ? payout : undefined,
          purchase_time: Number(t.purchase_time ?? 0),
          sell_time: Number(t.sell_time ?? 0),
          transaction_id: typeof t.transaction_id === 'number' ? t.transaction_id : undefined,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Get open positions (contracts) from Deriv for display in Live Portfolio.
 */
export async function getDerivPositions(): Promise<DerivPositionRow[]> {
  const contracts = await fetchDerivPortfolioRaw();
  const out: DerivPositionRow[] = [];
  for (const c of contracts) {
    const sym = (c.underlying_symbol ?? c.symbol ?? '').trim();
    if (!sym) continue;
    const buy = Number(c.buy_price ?? c.purchase_price ?? 0);
    const sell = Number(c.sell_price ?? 0);
    const bid = Number(c.bid_price ?? c.sell_price ?? 0);
    const ask = Number(c.ask_price ?? c.buy_price ?? 0);
    const profit = Number(c.profit ?? 0);
    const entrySpot = Number(c.entry_spot ?? c.entry_tick ?? 0);
    /** For tick contracts (R_*), buy_price is stake; use entry_spot, bid/ask, or never stake as entry. */
    const bidOrAsk = bid > 0 ? bid : ask;
    const isTickLike = /^R_/.test(sym) && buy > 0 && buy < 100;
    const entryPrice = (buy > 0 && buy > 100) ? buy
      : (sell > 0 && sell > 100) ? sell
      : isTickLike ? (entrySpot > 100 ? entrySpot : (bidOrAsk > 100 ? bidOrAsk : undefined))
      : bidOrAsk || buy || sell;
    let currentPrice = bid > 0 ? bid : ask;
    if (!currentPrice && (entryPrice ?? 0) > 0) currentPrice = entryPrice ?? 0;
    const type: 'LONG' | 'SHORT' = buy > 0 ? 'LONG' : 'SHORT';
    const size = 1;
    const effectiveCurrent = currentPrice || (entryPrice ?? 0);
    const pnlPercent = entryPrice && size ? (profit / (entryPrice * size)) * 100 : 0;
    const limitOrder = c.limit_order as { stop_loss?: number; take_profit?: number } | undefined;
    const stopLoss = limitOrder?.stop_loss != null ? Number(limitOrder.stop_loss) : undefined;
    const takeProfit = limitOrder?.take_profit != null ? Number(limitOrder.take_profit) : undefined;
    out.push({
      instrumentId: sym,
      instrument: sym,
      type,
      size,
      entryPrice: entryPrice ?? 0,
      currentPrice: effectiveCurrent,
      pnl: profit,
      pnlPercent,
      stopLoss: Number.isFinite(stopLoss) ? stopLoss : undefined,
      takeProfit: Number.isFinite(takeProfit) ? takeProfit : undefined,
      contractId: c.contract_id,
    });
  }
  return out;
}

/**
 * Get a price proposal for a Deriv contract. Required before buy.
 * @param underlyingSymbol - Deriv symbol (e.g. R_10, BOOM500).
 * @param contractType - CALL (up/long) or PUT (down/short).
 * @param amount - Stake in account currency (e.g. 10 USD).
 * @param duration - Contract duration (e.g. 5 for 5 ticks or 1 for 1 minute).
 * @param durationUnit - 't' ticks, 's' seconds, 'm' minutes, 'h' hours, 'd' days.
 */
export async function getDerivProposal(
  underlyingSymbol: string,
  contractType: 'CALL' | 'PUT',
  amount: number,
  duration: number = 5,
  durationUnit: 't' | 's' | 'm' | 'h' | 'd' = 't'
): Promise<{ proposal_id: string; ask_price: number }> {
  // proposal: 100 req/min documented; bucket honours both endpoint + global caps.
  await DERIV_GLOBAL.acquire();
  await DERIV_PROPOSAL.acquire();
  // Use 'symbol' for legacy ws.derivws.com/websockets/v3; newer API uses 'underlying_symbol'.
  // "Properties not allowed: underlying_symbol" indicates legacy API in use.
  const res = await request<{
    proposal?: { id: string; ask_price: number };
    error?: { message: string };
  }>({
    proposal: 1,
    amount,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    symbol: underlyingSymbol,
    duration,
    duration_unit: durationUnit,
  });
  if (res.error?.message) throw new Error(res.error.message);
  const p = res.proposal;
  if (!p?.id) throw new Error('No proposal returned');
  const raw = Number(p.ask_price);
  const ask_price = Number.isFinite(raw) ? raw : 0;
  return { proposal_id: p.id, ask_price };
}

/**
 * Buy a Deriv contract using a proposal ID.
 */
export async function buyDerivContract(proposalId: string, price: number): Promise<{ contract_id: number }> {
  // buy / sell: 100 req/min documented.
  await DERIV_GLOBAL.acquire();
  await DERIV_BUY_SELL.acquire();
  const res = await request<{
    buy?: { contract_id: number };
    error?: { message: string };
  }>({
    buy: proposalId,
    price: String(price),
  });
  if (res.error?.message) throw new Error(res.error.message);
  const buyRes = res.buy;
  if (!buyRes?.contract_id) throw new Error('Buy failed: no contract_id');
  return { contract_id: buyRes.contract_id };
}

/** Resolve registry symbol for ticks. Forex/crypto use frx… / cry… API symbols; synthetics must appear in active_symbols. */
async function resolveSymbolForTicks(symbol: string): Promise<string | null> {
  try {
    const resolved = resolveDerivMarketDataSymbol(symbol);
    if (isDerivFiatOrCryptoApiSymbol(resolved)) return resolved;
    const { symbols } = await getActiveSyntheticSymbols();
    const apiSymbol = getDerivApiSymbolForRequest(symbol, symbols);
    const apiSet = new Set(symbols.map((s) => s.trim().toLowerCase()));
    const norm = apiSymbol.trim().toLowerCase();
    if (apiSet.has(norm)) return apiSymbol;
    for (const v of normaliseApiSymbolForMatch(apiSymbol)) {
      if (v && apiSet.has(v.toLowerCase())) return apiSymbol;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get live bid/ask for a symbol from Deriv tick stream. Returns null when no live tick or not connected.
 */
export async function getDerivSymbolQuote(symbol: string, _spreadPoints?: number): Promise<{ bid: number; ask: number } | null> {
  if (!isConnected()) return null;
  const apiSymbol = await resolveSymbolForTicks(symbol);
  if (!apiSymbol) return null;
  const tick = await getDerivTickQuote(apiSymbol);
  if (tick && tick.bid > 0 && tick.ask > 0) return { bid: tick.bid, ask: tick.ask };
  return null;
}

/** Point size from spreadUtils (known symbols only). Unknown: logs error and throws. */
function getPointSizeOrNull(symbol: string, midPrice: number): number | null {
  try {
    return inferPointSize(symbol, midPrice);
  } catch {
    return null; // Unknown symbol; use broker pip_size
  }
}

let tickQuoteCache: Map<string, { data: { bid: number; ask: number; pip_size?: number }; at: number }> = new Map();
let tickQuoteMissCache: Map<string, number> = new Map();
let tickQuoteRateLimitedUntil = 0;
let tickQuoteRateLimitWarnedAt = 0;
const DERIV_TICK_QUOTE_MISS_CACHE_MS = 60_000;
const DERIV_TICK_RATE_LIMIT_COOLDOWN_MS = 120_000;

function getDerivErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function isExpectedTickQuoteMiss(message: string): boolean {
  return /market\s+is\s+presently\s+closed|symbol\s+.+\s+is\s+invalid/i.test(message);
}

function isDerivRateLimit(message: string): boolean {
  return /rate\s+limit/i.test(message);
}

function noteDerivTickRateLimit(message: string): void {
  tickQuoteRateLimitedUntil = Date.now() + DERIV_TICK_RATE_LIMIT_COOLDOWN_MS;
  if (typeof console !== 'undefined' && console.warn && Date.now() - tickQuoteRateLimitWarnedAt > DERIV_TICK_RATE_LIMIT_COOLDOWN_MS) {
    tickQuoteRateLimitWarnedAt = Date.now();
    console.warn(`[derivApi] tick quote rate-limited; pausing spread tick probes for ${Math.round(DERIV_TICK_RATE_LIMIT_COOLDOWN_MS / 1000)}s:`, message);
  }
}

/**
 * Get one tick (bid/ask) from Deriv tick stream for a symbol. Used to derive spread when no positions.
 * Cached per symbol to avoid ticks rate limit.
 * @see https://developers.deriv.com/docs/data/ticks/
 */
async function getDerivTickQuote(symbol: string): Promise<{ bid: number; ask: number; pip_size?: number } | null> {
  const now = Date.now();
  const cached = tickQuoteCache.get(symbol);
  if (cached && now - cached.at < DERIV_TICK_QUOTE_CACHE_MS) return cached.data;
  if (now < tickQuoteRateLimitedUntil) return null;
  const missedAt = tickQuoteMissCache.get(symbol);
  if (missedAt && now - missedAt < DERIV_TICK_QUOTE_MISS_CACHE_MS) return null;
  // tick stream subscriptions don't count toward request limits, but the
  // initial subscribe call does — bucket-throttle it.
  await DERIV_GLOBAL.acquire();
  await DERIV_TICK.acquire();
  try {
    const res = await request<{
      tick?: { bid?: number; ask?: number; quote?: number; pip_size?: number };
      subscription?: { id?: string };
      error?: { message?: string };
    }>({ ticks: symbol, subscribe: 1 });
    if (res.error?.message) {
      pendingTickResolve = null;
      tickQuoteMissCache.set(symbol, Date.now());
      if (isDerivRateLimit(res.error.message)) {
        noteDerivTickRateLimit(res.error.message);
        return null;
      }
      if (!isExpectedTickQuoteMiss(res.error.message) && typeof console !== 'undefined' && console.warn) {
        console.warn('[derivApi] getDerivTickQuote error:', res.error.message, 'symbol:', symbol);
      }
      return null;
    }
    const tick = res.tick;
    if (tick) {
      const bid = Number(tick.bid ?? 0);
      const ask = Number(tick.ask ?? 0);
      if (bid > 0 && ask > 0) {
        request({ forget_all: 'ticks' }).catch(() => {});
        const out = { bid, ask, pip_size: tick.pip_size };
        tickQuoteCache.set(symbol, { data: out, at: Date.now() });
        return out;
      }
      /* Tick contracts may return only quote (no bid/ask). Do NOT estimate — broker data only. */
    }
    // First response may be subscription ack without tick; wait for first tick push (max 5s)
    const result = await new Promise<{ bid: number; ask: number; pip_size?: number } | null>((resolve) => {
      const timeout = setTimeout(() => {
        if (pendingTickResolve) {
          pendingTickResolve = null;
          resolve(null);
        }
      }, 5000);
      pendingTickResolve = (t) => {
        clearTimeout(timeout);
        pendingTickResolve = null;
        resolve(t);
      };
    });
    request({ forget_all: 'ticks' }).catch(() => {});
    if (result && result.bid > 0 && result.ask > 0) {
      tickQuoteCache.set(symbol, { data: result, at: Date.now() });
      return result;
    }
    return null;
  } catch (e) {
    pendingTickResolve = null;
    const message = getDerivErrorMessage(e);
    tickQuoteMissCache.set(symbol, Date.now());
    if (isDerivRateLimit(message)) {
      noteDerivTickRateLimit(message);
      return null;
    }
    if (!isExpectedTickQuoteMiss(message) && typeof console !== 'undefined' && console.warn) {
      console.warn('[derivApi] getDerivTickQuote failed:', e, 'symbol:', symbol);
    }
    return null;
  }
}

/**
 * Get live spread in points per symbol from Deriv.
 * 1) Portfolio bid/ask (symbols with open positions)
 * 2) Tick stream (symbols without positions) — fetches from broker
 */
export async function getDerivSymbolSpreads(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const prices = await getDerivPortfolioPrices();
    const seen = new Set<string>();
    for (const [key, q] of Object.entries(prices)) {
      const bid = q.bid;
      const ask = q.ask;
      if (bid <= 0 && ask <= 0) continue;
      const spreadPrice = ask > 0 && bid > 0 ? ask - bid : 0;
      if (spreadPrice <= 0) continue;
      const mid = (bid + ask) / 2;
      const point = getPointSizeOrNull(key, mid);
      if (point == null || point <= 0) continue; // Unknown symbol; skip (use broker pip_size)
      const spreadPoints = spreadPrice / point;
      const norm = key.replace(/\s/g, '').toUpperCase();
      if (!seen.has(norm) && spreadPoints > 0) {
        seen.add(norm);
        out[norm] = spreadPoints;
      }
    }
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[derivApi] getDerivPortfolioPrices failed:', e);
    }
  }

  return out;
}

/**
 * Get live spread for a single Deriv symbol from tick stream (broker). Use when symbol has no open position.
 * Fiat/crypto are exact frx/cry symbols. Synthetics may need alternate API forms.
 */
export async function getDerivSymbolSpreadFromTick(symbol: string): Promise<number | null> {
  if (Date.now() < tickQuoteRateLimitedUntil) return null;
  const apiSymbol = await resolveSymbolForTicks(symbol);
  if (!apiSymbol) return null;
  const toTry = isDerivFiatOrCryptoApiSymbol(apiSymbol)
    ? [apiSymbol]
    : Array.from(new Set([apiSymbol, ...getPossibleApiSymbolsForTicks(symbol).filter((s) => s !== apiSymbol)]));
  let q: { bid: number; ask: number; pip_size?: number } | null = null;
  for (const sym of toTry) {
    if (Date.now() < tickQuoteRateLimitedUntil) break;
    q = await getDerivTickQuote(sym);
    if (q && (q.bid > 0 || q.ask > 0)) break;
  }
  if (!q || (q.bid <= 0 && q.ask <= 0)) return null;
  const spreadPrice = q.ask > 0 && q.bid > 0 ? q.ask - q.bid : 0;
  if (spreadPrice <= 0) return null;
  const mid = (q.bid + q.ask) / 2;
  const point =
    q.pip_size != null ? Math.pow(10, -q.pip_size) : getPointSizeOrNull(symbol, mid);
  if (point == null || point <= 0) return null; // Unknown symbol; broker pip_size required
  const spreadPoints = spreadPrice / point;
  return spreadPoints > 0 ? spreadPoints : null;
}

let portfolioPricesCache: { data: Record<string, { bid: number; ask: number; profit?: number }>; at: number } | null = null;

/**
 * Get current bid/ask and profit per symbol from Deriv portfolio (open positions).
 * Uses broker profit for P/L — (current−entry)*size is wrong for Deriv tick contracts.
 * Throttled: shared with getDerivPositions via fetchDerivPortfolioRaw.
 * @param forceRefresh - When true, bypass cache (e.g. for explicit balance/equity sync).
 */
export async function getDerivPortfolioPrices(forceRefresh?: boolean): Promise<Record<string, { bid: number; ask: number; profit?: number }>> {
  const now = Date.now();
  if (!forceRefresh && portfolioPricesCache && now - portfolioPricesCache.at < DERIV_PORTFOLIO_THROTTLE_MS) {
    return portfolioPricesCache.data;
  }
  if (forceRefresh) {
    portfolioRawCache = null;
  }
  const contracts = await fetchDerivPortfolioRaw();
  const byKey: Record<string, { bid: number; ask: number; profit: number }> = {};
  for (const c of contracts) {
    const sym = (c.underlying_symbol ?? c.symbol ?? '').trim();
    if (!sym) continue;
    const bid = Number(c.bid_price ?? c.sell_price ?? 0);
    const ask = Number(c.ask_price ?? c.buy_price ?? 0);
    const profit = Number(c.profit ?? 0);
    const key = sym.replace(/\s+/g, ' ').trim();
    const prev = byKey[key];
    byKey[key] = {
      bid: prev ? prev.bid : bid,
      ask: prev ? prev.ask : ask,
      profit: (prev?.profit ?? 0) + profit,
    };
  }
  const out: Record<string, { bid: number; ask: number; profit?: number }> = {};
  for (const [key, v] of Object.entries(byKey)) {
    if (v.bid > 0 || v.ask > 0) {
      const value = { bid: v.bid, ask: v.ask, profit: v.profit };
      out[key] = value;
      out[key.toUpperCase()] = value;
      out[key.replace(/\s+/g, '_')] = value;
      for (const n of symbolNormalizations(key)) {
        if (n) {
          out[n] = value;
          out[n.toUpperCase()] = value;
        }
      }
    }
  }
  portfolioPricesCache = { data: out, at: Date.now() };
  return out;
}

/**
 * Fetch balance and portfolio prices in one call for consistent snapshot.
 * Use for sync so balance and equity (balance + broker profit) are from the same moment.
 */
export async function getDerivAccountSnapshot(forceRefresh?: boolean): Promise<{
  balance: number;
  prices: Record<string, { bid: number; ask: number; profit?: number }>;
}> {
  const [balance, prices] = await Promise.all([
    getBalance(),
    getDerivPortfolioPrices(forceRefresh),
  ]);
  return {
    balance: Number.isFinite(balance) ? balance : 0,
    prices,
  };
}
