# CICADA-5453 Neural Network (Python)

Python backend for the algorithmic trading system: **neural network model** that learns from backtest results (200+ strategies × chart/candlestick patterns × instruments × timeframes × regimes) and powers **instrument-specific bots** (scalping, day, medium swing, swing, sniper) across market regimes.

## Setup

```bash
cd python
python -m venv venv
source venv/bin/activate   # or venv\Scripts\activate on Windows
pip install -r requirements.txt
pip install -e .   # if using as package
```

**Optional (MT5):** On Windows/Linux only, to enable MT5 login from the app run `pip install -r requirements-mt5.txt`. MetaTrader5 has no macOS wheel; the API still runs without it (MT5 connect will return "not installed").

## Model

- **`cicada_nn/model.py`**: PyTorch `InstrumentBotNN` — takes backtest-derived features (strategy performance per timeframe/regime) and instrument type; outputs action logits (long/short/neutral) per trade style.
- **`cicada_nn/train.py`**: Converts backtest result rows to feature vectors, trains the model. **One instrument = one model**: saves to `checkpoints/instrument_bot_nn_{instrument_id}.pt` (no sharing).

## API

Run the FastAPI service:

```bash
uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```

- **GET /health** — Health check.
- **POST /build** — **Real bot build**: train the PyTorch model from backtest results (no dummy). Body:
  - `results`: array of `{ instrumentId, strategyId, timeframe, regime, winRate, profit, trades?, maxDrawdown?, profitFactor? }`
  - `instrument_types`: optional map `instrumentId -> "fiat" | "crypto" | "synthetic_deriv" | "indices_exness"`
  - `epochs`, `lr`: optional training params.
- **POST /mt5/connect** — Connect to MT5 with login-page credentials. Body: `login`, `password`, `server`. Requires MT5 terminal and `MetaTrader5` package.
- **GET /mt5/status** — Returns `mt5_available` and `connected`.
- **GET /mt5/ohlc** — OHLCV bars for backtesting (query: `symbol`, `timeframe`, `count`).
- **GET /mt5/prices** — Current bid/ask per symbol for live position P/L (query: `symbols=SYM1,SYM2`).
- **POST /backtest** — Run backtest on the server using MT5 OHLC. Body: `instrumentIds`, `strategyIds`, `timeframes`, `regimes`, `dateFrom`, `dateTo`, optional `instrument_symbols`, `strategy_names`. Returns `{ results, status }` (same shape as frontend backtest results). When MT5 is not connected, returns placeholder rows so the app can fall back to client-side backtest.

The login page sends credentials to **POST /mt5/connect**; on success the backend is connected to the MT5 account. The frontend can call **POST /build** when the user clicks “Rebuild” in Bot Builder, passing the current backtest results and instrument types; the Python service trains the NN and returns the checkpoint path (real training, not a dummy).

## Train from CLI

With no backtest file, training uses synthetic data:

```bash
python -m cicada_nn.train --output checkpoints --epochs 50
```

With a JSON file of backtest results (same shape as `/build` body’s `results`):

```bash
python -m cicada_nn.train --backtest path/to/backtest_results.json --output checkpoints --epochs 100
```

## Instrument classifications

- **fiat** — Major forex pairs (e.g. EUR/USD, GBP/JPY).
- **crypto** — Crypto (e.g. BTC/USD, ETH/USD).
- **synthetic_deriv** — Deriv synthetic indices: Volatility (R_10–R_100, Vol 15/30/90), Crash/Boom (150–1000), Jump (10–100).
- **indices_exness** — eXness **real** stock index CFDs (AUS200, US30, US500, USTEC, UK100, DE30, FR40, JP225, HK50, STOXX50). eXness does not offer synthetic indices like Deriv.

These are used as embeddings in the NN so the model can specialize per instrument type.

## Connectivity: Deriv vs eXness

- **Deriv**: Has a **direct WebSocket API** (e.g. `python_deriv_api`). You can fetch instruments via `active_symbols` and execute via `proposal` / `buy`. The app can connect and execute on Deriv directly (no MT5 required for Deriv).
- **eXness**: No public retail API; supports **MT5**, FIX API, and TradingView. Use **MT5** (login with eXness credentials) to connect and execute. Fetching instruments from the platform is done via MT5 symbol list when connected.
