/**
 * Stage 2B vitest contract tests for GeometricMapPanel.
 *
 * The vitest config runs in ``environment: 'node'`` (no DOM), so we don't
 * render the component — we pin the JSX module's exports + pin the
 * shape of the API helper against a fetch stub. The render-contract is
 * enforced indirectly: the module compiles, the symbols exist, and the
 * client returns ``null`` (the panel's empty-state trigger) on 404 so
 * the dashboard never throws when no map exists yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getGeometricMap } from '../core/api';

const ORIGINAL_FETCH = globalThis.fetch;

describe('getGeometricMap', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('returns null on 404 so the panel can render the empty state', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;
    const result = await getGeometricMap('EURUSD');
    expect(result).toBeNull();
  });

  it('returns null on network error (offline / bridge unreachable)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const result = await getGeometricMap('EURUSD');
    expect(result).toBeNull();
  });

  it('parses a real map payload into the typed shape', async () => {
    const payload = {
      symbol: 'EURUSD',
      bins: [1.09, 1.1, 1.11],
      volume_nodes: [{ price: 1.1, score: 1.5 }],
      swing_highs: [{ idx: 5, time: 1700000000, price: 1.105 }],
      swing_lows: [{ idx: 10, time: 1700000600, price: 1.095 }],
      support_levels: [{ price: 1.095, kind: 'support', confirmations: 2, score: 1.5 }],
      resistance_levels: [{ price: 1.105, kind: 'resistance', confirmations: 2, score: 1.6 }],
      meta: {
        version: 1,
        symbol: 'EURUSD',
        n_bars: 500,
        bar_first_time: 1_700_000_000,
        bar_last_time: 1_700_010_000,
        atr_at_build: 0.0008,
        input_sha: 'abc123',
      },
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    const result = await getGeometricMap('EURUSD');
    expect(result).not.toBeNull();
    expect(result?.symbol).toBe('EURUSD');
    expect(result?.support_levels[0].kind).toBe('support');
    expect(result?.resistance_levels[0].kind).toBe('resistance');
    expect(result?.meta.n_bars).toBe(500);
  });

  it('encodes symbols with slashes safely in the URL', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;
    globalThis.fetch = fetcher;
    await getGeometricMap('BTC/USD');
    const calledUrl = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).toContain('BTC%2FUSD');
  });
});

describe('GeometricMapPanel module', () => {
  it('exports the named React component', async () => {
    const mod = await import('./GeometricMapPanel');
    expect(typeof mod.GeometricMapPanel).toBe('function');
  });
});
