/**
 * @deprecated Stage 4 — Deriv symbol maps removed.
 *
 * MT5-bridge-only pipeline. Functions return passthrough / false so
 * existing imports keep building until Stage 5 prunes the call sites.
 */

export function resolveDerivMarketDataSymbol(registrySymbol: string): string {
  return registrySymbol;
}

export function isDerivFiatOrCryptoApiSymbol(_resolved: string): boolean {
  return false;
}
