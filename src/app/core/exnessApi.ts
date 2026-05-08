/**
 * @deprecated Stage 4 — eXness REST API removed.
 *
 * MT5-bridge-only pipeline as of Stage 2B. This file is now a
 * deprecation shim that preserves the export surface so existing
 * imports keep building. Stage 5 prunes the call sites.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

let _warned = false;
function _warnOnce(): void {
  if (_warned || typeof console === 'undefined') return;
  _warned = true;
  console.warn('[exnessApi] Deprecated since Stage 4 — MT5 bridge is the only live data path.');
}

// ── Type stubs preserved so callers compile ──────────────────────────

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

// ── Functions return null/empty/disconnected ─────────────────────────

export async function getExnessAccount(
  _apiKey: string,
  _baseUrl?: string,
): Promise<ExnessAccountInfo | null> {
  _warnOnce();
  return null;
}

export async function getExnessPositions(
  _apiKey: string,
  _baseUrl?: string,
): Promise<ExnessPositionRow[]> {
  _warnOnce();
  return [];
}

export async function testExnessConnection(
  _apiKey: string,
  _baseUrl?: string,
): Promise<{ ok: boolean; error?: string }> {
  _warnOnce();
  return { ok: false, error: 'eXness API removed in Stage 4 — use MT5 bridge' };
}
