/**
 * Stage 8: extracted slice — broker state hydration + migration.
 *
 * The TradingStore mega-store (3,935 LOC) is being progressively
 * decomposed into focused slices that can be tested + reasoned about
 * independently. This is the first extraction: broker hydration from
 * persisted state with the Stage 7 migration that drops deprecated
 * broker types (deriv_api, exness_api).
 *
 * Caller pattern:
 *
 *   import { hydrateBrokers } from './slices/brokerHydration';
 *   brokers = hydrateBrokers(loaded.brokers, DEFAULT_BROKERS);
 *
 * Pure function — no global state mutation, no I/O. Tested in
 * src/app/store/slices/brokerHydration.test.ts.
 */

import type { BrokerConfig } from '../../core/types';

/** Broker types that still have a live data path. As of Stage 7,
 *  Deriv WebSocket and eXness REST were removed; the only supported
 *  type is the MT5 bridge. Adding `'fix'` here when we ship the
 *  prime-broker FIX backend is a one-line change. */
export const SUPPORTED_BROKER_TYPES: ReadonlySet<string> = new Set(['mt5']);

/**
 * Merge persisted broker state with the registry defaults, dropping
 * deprecated broker types and any 'connecting' status (websocket
 * sessions are lost on reload — must reset to disconnected).
 */
export function hydrateBrokers(
  persisted: BrokerConfig[] | undefined | null,
  defaults: BrokerConfig[],
): BrokerConfig[] {
  if (!persisted?.length) {
    return [...defaults];
  }

  // Stage 7 migration: drop entries with deprecated broker types so the
  // dashboard doesn't show "Deriv: ○ error" / "eXness: ○ disconnected"
  // pills for paths that no longer exist.
  const live = persisted.filter((b) => SUPPORTED_BROKER_TYPES.has(b.type));

  const byId = new Map(live.map((b) => [b.id, b]));
  const merged: BrokerConfig[] = defaults.map((d) => {
    const p = byId.get(d.id);
    if (!p) return d;
    return {
      ...d,
      ...p,
      config: p.config && Object.keys(p.config).length ? p.config : d.config,
    };
  });

  // Preserve any persisted brokers that aren't in the defaults (e.g.
  // operator-added broker rows). Same migration applies — only live
  // types come through.
  for (const b of live) {
    if (!defaults.some((d) => d.id === b.id)) merged.push(b);
  }

  // Order + drop stuck 'connecting' status.
  merged.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  return merged.map((b) =>
    b.status === 'connecting' ? { ...b, status: 'disconnected' as const } : b,
  );
}
