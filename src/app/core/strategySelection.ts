/**
 * Robust detection of strategy selections.
 * Single source of truth for backtest/build: validates against registry, filters stale/invalid,
 * and ensures only enabled strategies with valid signal definitions are used.
 */

import type { AnyStrategyDef } from './types';
import { getAllStrategies } from './registries';
import { hasSignalForStrategy } from './signals';

export interface StrategySelectionResult {
  /** Valid strategy IDs for backtest/build (enabled + in registry + has signal). */
  strategyIds: string[];
  /** Strategy definitions for the selected IDs. */
  strategies: AnyStrategyDef[];
  /** IDs that were requested but not found in registry (stale/removed). */
  invalidIds: string[];
  /** IDs that have no signal implementation (e.g. strategy removed from signals.ts). */
  missingSignalIds: string[];
  /** Whether any issues were detected. */
  hasWarnings: boolean;
}

/** Registry strategy IDs for fast lookup. */
let _registryIds: Set<string> | null = null;

function getRegistryIds(): Set<string> {
  if (_registryIds == null) {
    _registryIds = new Set(getAllStrategies().map((s) => s.id));
  }
  return _registryIds;
}

/** Call when registry may have changed (e.g. after hot reload). */
export function invalidateStrategySelectionCache(): void {
  _registryIds = null;
}

/**
 * Get selected strategy IDs from Strategy Library state.
 * Validates against registry, filters invalid/stale IDs, and checks for signal implementation.
 */
export function getSelectedStrategyIds(
  stateStrategies: AnyStrategyDef[],
  options?: { instrumentId?: string; instrumentSymbol?: string }
): StrategySelectionResult {
  const registryIds = getRegistryIds();
  const enabled = stateStrategies.filter((s) => s.enabled);
  const invalidIds: string[] = [];
  const missingSignalIds: string[] = [];
  const valid: AnyStrategyDef[] = [];

  for (const s of enabled) {
    if (!registryIds.has(s.id)) {
      invalidIds.push(s.id);
      continue;
    }
    const def = getAllStrategies().find((r) => r.id === s.id);
    if (!def) continue;
    const hasSignal = hasSignalForStrategy(s.id);
    if (!hasSignal) {
      missingSignalIds.push(s.id);
      continue;
    }
    valid.push(def);
  }

  return {
    strategyIds: valid.map((s) => s.id),
    strategies: valid,
    invalidIds,
    missingSignalIds,
    hasWarnings: invalidIds.length > 0 || missingSignalIds.length > 0,
  };
}

/**
 * Validate strategy IDs from a request (e.g. backtest, bot).
 * Returns only IDs that exist in registry and have signal definitions.
 */
export function validateStrategyIds(
  ids: string[],
  options?: { instrumentId?: string; instrumentSymbol?: string }
): StrategySelectionResult {
  const registryIds = getRegistryIds();
  const invalidIds: string[] = [];
  const missingSignalIds: string[] = [];
  const valid: AnyStrategyDef[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!registryIds.has(id)) {
      invalidIds.push(id);
      continue;
    }
    const def = getAllStrategies().find((r) => r.id === id);
    if (!def) continue;
    const hasSignal = hasSignalForStrategy(id);
    if (!hasSignal) {
      missingSignalIds.push(id);
      continue;
    }
    valid.push(def);
  }

  return {
    strategyIds: valid.map((s) => s.id),
    strategies: valid,
    invalidIds,
    missingSignalIds,
    hasWarnings: invalidIds.length > 0 || missingSignalIds.length > 0,
  };
}

/**
 * Canonical strategy IDs for backtest. Use this instead of ad-hoc filtering.
 */
export function getStrategyIdsForBacktest(stateStrategies: AnyStrategyDef[]): string[] {
  return getSelectedStrategyIds(stateStrategies).strategyIds;
}

/**
 * Canonical strategy IDs for build. Same as backtest (Strategy Library enabled only).
 */
export function getStrategyIdsForBuild(stateStrategies: AnyStrategyDef[]): string[] {
  return getSelectedStrategyIds(stateStrategies).strategyIds;
}
