# Data flow: fetch → store → display

This document confirms where data is fetched, how it is stored, and where it is displayed so that all related data are properly shown.

---

## 1. Portfolio (balance, equity, P/L, positions)

| Data | Fetched from | Stored in | Displayed in |
|------|--------------|-----------|--------------|
| Balance | **Live from broker**: Deriv `balance` API; MT5 `GET /mt5/account` or `POST /mt5/connect`; eXness `getExnessAccount`. | `portfolio.ts`: `setBalance(balance, source)` → `portfolioState.balance`, `dataSource` | **Dashboard** status strip (P/L), **LivePortfolio** (BALANCE, EQUITY, OPEN P/L, DRAWDOWN, TOTAL P/L) |
| Equity | **Live from broker**: MT5/eXness: `account.equity` from API. Deriv: balance + sum(broker profit) from portfolio (no separate equity API). | MT5/eXness: `setServerEquity(equity)`. Deriv: computed as balance + totalPnl (positions use broker `profit`). | **LivePortfolio** (EQUITY), **Dashboard** (P/L uses totalPnl) |
| Total P/L | Computed in `getPortfolioState()` from `positions[].pnl` and `balance`. | `portfolio.ts`: `recalcTotals(positions, balance)` → `totalPnl`, `totalPnlPercent`, `equity`, `drawdownPct` | **Dashboard** (P/L), **LivePortfolio** (OPEN P/L, TOTAL P/L) |
| Positions | Added by app when opening trades (`addPosition`), or restored from **persistence** (load). *MT5 open positions are not yet fetched by a dedicated API.* | `portfolio.ts`: `portfolioState.positions`; persisted in `saveState` / restored in `loadPersisted` → `hydratePortfolio`. | **LivePortfolio** (table of positions) |

**Flow:** Login or Brokers connect → `postMt5Connect` → store calls `setBalance` + `setServerEquity` (and for Login, `applyMt5LoginSuccess` updates broker + portfolio). Snapshot includes `getPortfolioState()`, so Dashboard and LivePortfolio read the same portfolio. Persist saves balance, dataSource, positions; load restores them and hydrates portfolio.

---

## 2. Brokers (connection status)

| Data | Fetched from | Stored in | Displayed in |
|------|--------------|-----------|--------------|
| Broker status | Set by **frontend** when user connects/disconnects (no periodic fetch). | `TradingStore`: `brokers[].status`, `config`, `connectedAt`. Persisted. | **Dashboard** header (e.g. "Deriv: ● connected", "eXness: ○ disconnected"), **BrokersManager** (each broker card) |
| MT5 backend status | **Backend** `GET /mt5/status` (mt5_available, connected). | Fetched in **BacktestEngine** only, stored in local state `mt5Status`. | **BacktestEngine** footer: "MT5_CONNECTION: ● ACTIVE / ○ INACTIVE / ○ N/A" |

**Note:** Broker status in the header comes from the store (user actions). MT5_CONNECTION in BacktestEngine comes from the backend and is the source of truth for “is MT5 actually connected on the server”.

---

## 3. Instruments

| Data | Fetched from | Stored in | Displayed in |
|------|--------------|-----------|--------------|
| List | **Registry** `DEFAULT_INSTRUMENTS` + **persistence** (load merges/restores). **Deriv**: "Add all to Instrument Registry" adds symbols from `getActiveSyntheticSymbols()`. | `TradingStore`: `instruments`. Persisted. | **InstrumentManager**, **InstrumentSelector**, **BotBuilder**, **BacktestEngine** (counts, selection) |
| Validation | Deriv: `getActiveSyntheticSymbols()` + `validateDerivSynthetics()` when user clicks Refresh in Brokers. | Not stored; result kept in **BrokersManager** local state. | **BrokersManager** (validated counts, "On Deriv but not in app") |

---

## 4. Strategies

| Data | Fetched from | Stored in | Displayed in |
|------|--------------|-----------|--------------|
| List + enabled | **Registry** `getAllStrategies()` + **persistence** (enabled toggles). | `TradingStore`: `strategies`. Persisted (id + enabled). | **StrategyLibrary**, **Dashboard** (STRAT count), **BacktestEngine** (enabled for run), **TradingModes** |

---

## 5. Backtest

| Data | Fetched from | Stored in | Displayed in |
|------|--------------|-----------|--------------|
| OHLCV | **Deriv** (when connected) or **MT5** via backend `/mt5/ohlc` (when connected). No synthetic fallback — backtest requires a broker. `fetchOHLCV` in `ohlcvFeed.ts`. | Fetched during `runBacktest`; results stored in `backtest.ts` state. | **BacktestEngine** (results table, progress) |
| Results | Computed by `runBacktest()` in frontend. | `backtest.ts`: `getBacktestState()`. Persisted (results + runRequest). | **BacktestEngine** (table), **BotBuilder** (used for build) |

---

## 6. Bots

| Data | Fetched from | Stored in | Displayed in |
|------|--------------|-----------|--------------|
| Config / status | **Store**: created/updated by user (get or create bot, deploy, rebuild). Build progress from **backend** `POST /build`. | `TradingStore`: `bots`. Persisted. | **BotBuilder**, **Dashboard** (BOTS count, schedule) |

---

## 7. Persistence

- **Load:** On app init, `TradingStoreProvider` runs `loadPersisted()` once. Restores instruments, brokers, strategies (enabled), bots, execution, **portfolio** (balance, dataSource, positions when dataSource is mt5/deriv), backtest results, selected instrument.
- **Save:** Debounced after actions that change store (e.g. connect, setBalance, toggle strategy, run backtest). Saves the same keys; portfolio includes balance, peakEquity, dataSource, positions.

---

## Summary

- **Portfolio:** Balance and optional equity come from MT5 connect (login or Brokers); P/L and equity are computed (or use server equity when set). Shown in Dashboard strip and LivePortfolio. Positions are app-managed + persisted; MT5 open positions are not yet synced via API.
- **Brokers:** Status is store-only (from connect/disconnect). MT5 backend status is fetched separately in BacktestEngine for MT5_CONNECTION.
- **Instruments, strategies, backtest, bots:** From registry + persistence + Deriv API (instruments only). All displayed components read from the same store snapshot (`useTradingStore().state`), so data is consistent across the UI.
