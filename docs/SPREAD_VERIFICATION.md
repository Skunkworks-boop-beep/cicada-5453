# Instrument spread: source and usage

## Summary

| Aspect | Status | Notes |
|--------|--------|--------|
| **Source** | **Live from broker** | Registry defaults only when disconnected. When MT5 or Deriv connected, spreads are fetched from broker. |
| **MT5** | **Live** | `GET /mt5/symbols_spread` → `symbol_info(symbol).spread` or (ask-bid)/point from tick. All symbols. |
| **Deriv** | **Live** | Portfolio bid/ask (symbols with positions) + tick stream (symbols without positions, up to 10 per sync). |
| **Persistence** | Saved and loaded | Instruments (including `spread`) are persisted. Live values overwrite when broker is connected. |
| **Backtest** | **Uses instrument spread** | Client and server backtest accept `instrumentSpreads` (instrumentId → points). Uses live values when synced. |
| **Display** | Uses store value | Instrument Manager shows `instrument.spread` (live when broker connected, else static default). |

## Where spread is defined

- **`src/app/core/registries.ts`**  
  Every instrument has a numeric `spread` (e.g. 0.8 for EUR/USD). These are **default** values; overwritten by live sync when broker connected.

- **`src/app/store/TradingStore.tsx`**  
  `syncInstrumentSpreads()` fetches live spreads from MT5 (`getMt5SymbolSpreads`) or Deriv (`getDerivSymbolSpreads`) and updates `instrument.spread`.

## Where spread is used

- **Backtest (`src/app/core/backtest.ts`)**  
  Uses `instrumentSpreads` from request; converted via `spreadPointsToFraction`. Server backtest (`python/cicada_nn/backtest_server.py`) accepts `instrument_spreads` and uses per-instrument values.

- **BacktestEngine**  
  Builds `instrumentSpreads` from `state.instruments` (id → spread) and passes to both client and server backtest.

- **Instrument Manager**  
  Displays `instrument.spread` in the registry table.

## Live spread implementation

1. **MT5**: `mt5_client.get_symbol_spreads(symbols)` uses `symbol_info(symbol).spread` (points); fallback: `(ask-bid)/point` from tick.
2. **API**: `GET /mt5/symbols_spread?symbols=EURUSD,BTCUSD` returns `{ spreads: { "EURUSD": 8, ... } }`.
3. **Deriv**: `getDerivSymbolSpreads()` — (a) portfolio bid/ask for symbols with positions; (b) tick stream for symbols without positions (up to 10 per sync via `getDerivSymbolSpreadFromTick`).
4. **Sync**: Dashboard runs `syncInstrumentSpreads` every 10s when any broker is connected.
