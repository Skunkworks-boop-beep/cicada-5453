# Multi-timeframe (HTF + LTF)

## Behavior

- **HTF mapping** (`src/app/core/multiTimeframe.ts`, `python/cicada_nn/multi_timeframe.py`): e.g. M5→M15, M15→H1, H1→H4.
- **Regime filter (optional slow filter)**: When `preferHtfRegime` is auto/true and HTF bars are loaded (`instrumentId|HTF` key), `detectRegimeSeries` runs on **HTF** and the regime at each LTF bar is taken from the aligned HTF bar. Set `preferHtfRegime: false` to keep LTF-only regime. Research `regimeTunes` still uses **LTF** regime (regime_config) when provided.
- **Signals**: `pa-htf-bias`, `pa-multi-tf-alignment`, `pa-ltf-trigger` use **real HTF OHLC** when context is passed; otherwise they fall back to the legacy single-series EMA proxy.

## Client / server data

- **Local backtest**: Fetches HTF automatically when LTF jobs need it; `runSingleBacktest` receives `mtf` with `htfBars` + index map.
- **Server backtest**: Send bars for both LTF and HTF keys, e.g. `inst-eurusd|M5` and `inst-eurusd|M15`. The server loads HTF from `bars` when present.

## API

- `preferHtfRegime` on `BacktestRunRequest` / POST `/backtest` body (`prefer_htf_regime`).

## Fetch errors

- **Research** and **server backtest**: every selected timeframe must fetch successfully (enough bars) or the run **stops** with a **research log / backtest error** line and **`console.error`** (`[research]` / `[backtest]` prefix).
- **HTF** (higher timeframe for MTF): each **distinct** HTF needed for the selected TFs is fetched per instrument; failures are **errors** (not silently ignored): `console.error`, UI failure message, process halted.
- **Local client backtest** (`runBacktest` in browser): `getBars` failures are logged the same way; the engine logs `[backtest] OHLCV fetch failed for SYMBOL TF`.
