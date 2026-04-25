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
 *
 * Gross vs net:
 * Live PnL used to be calculated as just `(exitPrice - entryPrice) * size`,
 * which ignores commission, swap, and slippage. Backtest charges all three
 * (via `transactionCosts.ts`), so backtest-vs-live comparison drifted over
 * time. The cost-aware helpers below apply the same schedule to live trades.
 */

import type { InstrumentType, Timeframe } from './types';
import { commissionCharge, fillSlippagePct, swapAccrual } from './transactionCosts';

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

export interface CostBreakdown {
  /** Commission charged at round-trip close. Always >= 0. */
  commission: number;
  /** Swap / funding accrual over hold period. Negative when holding cost. */
  swap: number;
  /** Slippage cost applied on the exit (approx. |entry × slippage_pct|). */
  slippage: number;
  /** Sum of all deductions (positive number to deduct from gross). */
  total: number;
}

export interface LiveTradeCostInput {
  type: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  exitPrice: number;
  holdBars: number;
  timeframe: Timeframe;
  instrumentType: InstrumentType;
  /** 'signal' | 'max_hold' for market exits; 'stop' | 'target' for barrier fills. */
  exitReason?: 'signal' | 'stop' | 'target' | 'max_hold';
  /** Optional override base slippage fraction; falls back to per-type defaults. */
  baseSlippagePct?: number;
}

/**
 * Compute the three live-trade cost components consistently with the backtest.
 * Returns costs as positive deductions — the caller subtracts them from gross.
 */
export function computeLiveTradeCosts(input: LiveTradeCostInput): CostBreakdown {
  const side = input.type === 'LONG' ? 1 : -1;
  const notional = Math.abs(input.entryPrice * input.size);
  const commission = commissionCharge(notional, input.instrumentType);
  const swap = swapAccrual(
    notional,
    input.instrumentType,
    Math.max(0, Math.round(input.holdBars)),
    input.timeframe,
    side as 1 | -1
  );
  const slipPct = fillSlippagePct(
    input.baseSlippagePct ?? 5e-5,
    input.instrumentType,
    input.exitReason ?? 'signal'
  );
  // Slippage is modelled on entry price × size, mirroring the backtest engine
  // so backtest-vs-live comparisons align.
  const slippage = Math.max(0, input.entryPrice * slipPct * input.size);
  return {
    commission,
    swap: -Math.abs(Math.min(0, swap)) + Math.max(0, swap), // keep sign (neg = cost)
    slippage,
    total: commission + slippage + (swap < 0 ? -swap : 0),
  };
}

export interface NetLivePnl {
  /** PnL before any costs ((exit - entry) * size with side). */
  grossPnl: number;
  /** PnL after commission, slippage, and swap. */
  netPnl: number;
  /** Detailed breakdown. */
  costs: CostBreakdown;
  /** Net PnL as a fraction of the chosen notional basis (balance at entry preferred). */
  pnlPercent: number;
  /** The basis used for pnlPercent. */
  notional: number;
}

/**
 * Live-trade PnL that matches the backtest cost model. The ``notional`` basis
 * is computed with the same ``computePnlNotional`` rules so the percentage is
 * consistent across instruments (balance-at-entry → stake → entry value).
 */
export function computeNetLivePnl(
  costInput: LiveTradeCostInput,
  notionalInput?: Partial<PnlNotionalInput>
): NetLivePnl {
  const side = costInput.type === 'LONG' ? 1 : -1;
  const grossPnl = (costInput.exitPrice - costInput.entryPrice) * costInput.size * side;
  const costs = computeLiveTradeCosts(costInput);
  const netPnl = grossPnl - costs.total;
  const notional = computePnlNotional({
    profit: netPnl,
    entryPrice: costInput.entryPrice,
    size: costInput.size,
    ...(notionalInput ?? {}),
  });
  return {
    grossPnl,
    netPnl,
    costs,
    notional,
    pnlPercent: computePnlPercent(netPnl, notional),
  };
}
