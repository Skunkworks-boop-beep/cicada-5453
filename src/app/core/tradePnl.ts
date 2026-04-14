/**
 * MT5-style profit and loss calculation for closed trades.
 *
 * Logic (from MT5/MQL5 and NordFX):
 * - Profit (absolute) = from broker — always use broker value
 * - Profit % = (Profit ÷ Cost Price) × 100
 * - Cost Price (notional) = base for percentage; varies by instrument type
 *
 * Notional priority:
 * 1. Balance at entry — account-level return (profit / balance_at_entry)
 * 2. Stake — for tick/binary contracts (profit / stake)
 * 3. Entry value — for CFD/forex (entry_price × size)
 */

/** Detect tick contracts (Deriv R_10, R_25, etc.) by instrumentId or symbol. */
export function isTickContractInstrument(instrumentId: string, symbol?: string): boolean {
  return /inst-deriv-r\d+/i.test(instrumentId) || /^R_/.test(symbol ?? '');
}

export interface PnlNotionalInput {
  /** Broker profit in account currency */
  profit: number;
  /** Entry price (underlying) */
  entryPrice?: number;
  /** Position size (lots/volume) */
  size?: number;
  /** Balance at entry (account-level %) */
  balanceAtEntry?: number;
  /** Stake for tick contracts (from broker: payout - profit or -profit) */
  stake?: number;
  /** Broker buy_price (may be stake when < 100) */
  buyPrice?: number;
  /** Broker payout (for stake = payout - profit when winning) */
  payout?: number;
  /** Instrument id (e.g. inst-deriv-r10 for tick detection) */
  instrumentId?: string;
  /** Is tick contract (R_*, etc.) */
  isTickContract?: boolean;
}

/**
 * Compute notional (cost base) for P/L % per MT5 logic.
 * Profit % = (profit / notional) × 100
 */
export function computePnlNotional(input: PnlNotionalInput): number {
  const { profit, entryPrice, size, balanceAtEntry, stake, buyPrice, payout, isTickContract } = input;

  // 1. Balance at entry — account-level return (NordFX: "Capital at Risk")
  if (balanceAtEntry != null && balanceAtEntry > 0) {
    return balanceAtEntry;
  }

  // 2. Stake — for tick/binary contracts
  if (stake != null && stake > 0) return stake;
  if (profit < 0) return -profit; // losing: stake = amount lost
  if (payout != null && payout > 0 && profit > 0) return payout - profit; // winning: stake = payout - profit
  if (buyPrice != null && buyPrice > 0 && buyPrice < 100) return buyPrice; // buy_price is stake when small

  // 3. Entry value — for CFD/forex (MT5: Entry Price × Volume × ContractSize)
  const entryValue = (entryPrice ?? 0) * (size ?? 1);
  if (entryValue > 0) return entryValue;

  // 4. Fallback for tick contracts
  if (isTickContract) return 1;

  return 1;
}

/**
 * Compute P/L % from profit and notional.
 * Profit % = (Profit ÷ Cost Price) × 100
 */
export function computePnlPercent(profit: number, notional: number): number {
  if (notional <= 0 || !Number.isFinite(profit)) return 0;
  return (profit / notional) * 100;
}

/**
 * Full P/L calculation: notional + percent.
 */
export function computeClosedTradePnl(input: PnlNotionalInput): { notional: number; pnlPercent: number } {
  const notional = computePnlNotional(input);
  const pnlPercent = computePnlPercent(input.profit, notional);
  return { notional, pnlPercent };
}
