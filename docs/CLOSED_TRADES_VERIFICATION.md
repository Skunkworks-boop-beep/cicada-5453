# Closed Trades Display — Verification (No Hardcoded Values)

## Verification Result: **No hardcoded P/L or simplification logic**

### Display Path

| Step | File | Code | Source |
|------|------|------|--------|
| Render | `LivePortfolio.tsx` | `(t.pnl ?? 0).toFixed(2)` | Uses `t.pnl` from `ClosedTrade` directly |
| Store | `TradingStore.tsx` | `closedTradesByBot` | Populated by `recordClosedTrade` |
| Record | `TradingStore.tsx` | `recordClosedTrade`, `reconcileClosedPositions` | See below |

### P/L Source by Broker

| Broker | P/L source | Code path |
|--------|------------|-----------|
| **Deriv** | `row.profit` from `getDerivProfitTable()` | `reconcileClosedPositions` → `derivMap.get(contractId)` → `row.profit` |
| **MT5** | `calcPnl` or `getBrokerProfit` | `reconcileClosedPositions` → `pnlOverride` or `(exitPrice - entryPrice) * size` |
| **eXness** | `calcPnl` or `getBrokerProfit` | Same as MT5 |

### Why $2.86 for All Trades?

For **Deriv tick contracts** (R_10, R_100, etc.):

- Each contract has a **fixed payout** per tick based on stake
- If you stake $3 and win 1 tick, profit ≈ $2.85–2.86 (payout ~0.95)
- **Same stake + same outcome → same profit per contract**
- That is broker data, not code logic

### No Hardcoded Values

- `grep` for `2.86`, `2.85`, `2.87` in `src/` → **no matches**
- P/L display: `t.pnl` only, no constants
- `recordClosedTrade`: uses `brokerData.profit` or `pnlOverride` or `calcPnl` — all from broker or calculated

### No Simplification Logic

- No logic that forces all trades to the same P/L
- Each contract maps to its own `profit_table` row (Deriv) or own position (MT5/eXness)
- `contractId` / `brokerKey` uniquely identifies each trade
