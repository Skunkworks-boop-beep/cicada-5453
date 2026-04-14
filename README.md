# CICADA-5453 — Algorithmic Trading System

Algorithmic trading dashboard: backtest 200+ strategies across instruments (forex, crypto, Deriv synthetics, eXness indices), build neural-network bots per instrument, connect to **Deriv** (WebSocket API) and **MT5 add-on** (or eXness API), view positions from each broker, and manage portfolio and execution.

---

## Quick start (frontend only)

You can run the app and use **demo mode** without any backend or broker accounts.

```bash
npm install
npm run dev
```

Open the URL shown (e.g. `http://localhost:5173`). On the login page, check **“Continue without MT5 (demo mode)”** and click **INITIATE SECURE ACCESS**. You’ll land on the dashboard with instruments, strategies, backtest, bots, and portfolio (simulated).

---

## Full setup (optional backend + brokers)

**Complete setup guide:** [COMPLETE_SETUP_GUIDE.md](COMPLETE_SETUP_GUIDE.md) — end-to-end: local, remote, brokers, troubleshooting  
**Build from scratch:** [BUILD_FROM_SCRATCH.md](BUILD_FROM_SCRATCH.md) — minimal steps + script  
**Full system setup:** [docs/FULL_SYSTEM_SETUP.md](docs/FULL_SYSTEM_SETUP.md)  
**Push code to remote server (no git):** [docs/SETUP_REMOTE.md](docs/SETUP_REMOTE.md)  
**Run on a more powerful computer (SSH tunnel):** [docs/REMOTE_SETUP.md](docs/REMOTE_SETUP.md)

### Where resource-intensive work runs

| Task | Where it runs | Offload |
|------|----------------|--------|
| **Bot training (NN)** | **Backend (Python)**. When you click Rebuild in Bot Builder, the app sends backtest results to **POST /build**; the server trains the PyTorch model and returns the checkpoint. | Already on server when the backend is used. |
| **Backtest** | **Browser (frontend)** or **Backend (Python)**. When the backend is available, the app tries **POST /backtest** first (uses MT5 OHLC on the server); otherwise backtest runs in the client. | Server offload: set the backend URL (local or remote); backtest runs on the server when the API is reachable. |

All resource-intensive tasks should be offloaded to the remote server when possible: run the backend on the remote and use it for **bot build**; run the full app (and browser) on the remote for **backtest** offload.

### GPU / hardware recommendation (e.g. 32GB RAM + RTX 2070)

**Where to run the backend:** Run the Python backend on the machine that has the GPU (e.g. your desktop with the RTX 2070). The backend automatically uses **CUDA** when available for both training and inference; otherwise it falls back to CPU.

- **32GB RAM** — Plenty for the frontend, backend, and MT5. No changes needed.
- **RTX 2070 (8GB VRAM)** — More than enough for the NN model. Training and inference will use the GPU when PyTorch detects CUDA.
- **Setup:** Install `torch` with CUDA support (`pip install torch` — the default wheel includes CUDA for most platforms, or use `pip install torch --index-url https://download.pytorch.org/whl/cu118` for a specific CUDA version). Run `uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000` on the GPU machine; the frontend can run on the same machine or elsewhere and point `VITE_NN_API_URL` to it.

### 1. Prerequisites

- **Node.js** 18+ and npm (for the frontend)
- **Python** 3.10+ (optional; for NN bot training and MT5 connection)
- **MetaTrader 5** terminal (optional; only if you want to use the MT5 add-on)
- **Deriv account** (optional; for Deriv API and synthetic indices)

### 2. Frontend

```bash
npm install
npm run dev
```

- Dev server runs at `http://localhost:5173` (or the port Vite prints).
- Build for production: `npm run build` → output in `dist/`.

### 3. Python backend (optional)

Used for:

- **Bot build** — trains the PyTorch NN from backtest results when you click Rebuild in Bot Builder.
- **MT5 connection** — login-page credentials (when not in demo mode) are sent here to connect to your MT5 account.

```bash
cd python
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```

- API base URL is `http://localhost:8000` by default.
- If the backend runs on another host/port, set **`VITE_NN_API_URL`** (e.g. in `.env`) to that URL so the frontend can call `/health`, `/build`, and `/mt5/connect`.

**MT5 add-on:**  
To use MT5 login from the app, the machine running the Python backend must have the **MetaTrader 5** terminal installed (and the `MetaTrader5` Python package is already in `requirements.txt`). The backend connects to MT5 with the credentials you enter on the login page.

### 4. Environment variables

| Variable | Purpose |
|----------|---------|
| `VITE_NN_API_URL` | Backend API base URL (e.g. `http://localhost:8000`). Defaults to same host as frontend with port 8000. |

Create a `.env` in the project root if needed:

```env
VITE_NN_API_URL=http://localhost:8000
```

### 5. Login

- **Demo mode** — Check “Continue without MT5 (demo mode)” and submit. No credentials or backend required; you go straight to the dashboard.
- **MT5 add-on** — Enter MT5 account number (User identifier), password (Pass key), and optionally Server. Leave demo mode unchecked and submit. The frontend calls the backend’s `/mt5/connect`; if the Python server and MT5 are set up, the backend connects to your MT5 account.

### 6. Brokers (dashboard)

After login, open the **[ BROKERS ]** section on the dashboard. **Full live-account setup:** [docs/SETUP_LIVE.md](docs/SETUP_LIVE.md).

- **Deriv**
  - Get an **App ID** from [api.deriv.com](https://api.deriv.com) (register an app).
  - In your Deriv account, create a **Personal Access Token**.
  - In the app: Brokers → Deriv → Connect (or gear icon). Enter **App ID** and **Token** → Save & Connect. The app opens a WebSocket to Deriv and authorizes with the token.
- **eXness (API)** — primary way to connect to eXness
  - In Exness **Personal Area** → **API**, create an API key.
  - In the app: Brokers → eXness API → Connect (or gear). Enter **API key** and optionally **Base URL** (default `https://api.exness.com`) → Save & Connect. Balance, equity, and positions are loaded from the eXness API.
- **MT5 add-on** — Use the same MT5 credentials as on the login page (or set them in Brokers → MT5 add-on → gear). Connect uses the backend’s MT5 connection (backend must be running with MT5 terminal available).

### 7. Typical workflow

1. **Login** — Demo or MT5.
2. **Brokers** — Connect Deriv and/or MT5 add-on (or eXness API) as needed.
3. **Instruments** — Toggle active/inactive; each instrument is tied to a broker (Deriv, MT5, or eXness API).
4. **Strategies** — Enable/disable from the strategy library.
5. **Backtest** — Run backtest (uses synthetic OHLCV if no live feed yet).
6. **Bots** — Select an instrument, get/create a bot, run **Rebuild** then **Build** (sends backtest results to Python to train the NN). Deploy the bot and turn on **Bot execution** if you want simulated execution.
7. **Portfolio** — View positions and P&amp;L. When connected to Deriv, eXness API, or MT5 add-on, use **Sync positions** to load open positions from the broker; balance/equity reflect the connected account.

---

## Project layout

| Path | Description |
|------|-------------|
| `src/app/` | React app: pages (Login, Dashboard), store, routes, components. |
| `src/app/core/` | Types, registries (instruments, strategies), backtest, bot, portfolio, risk, **riskLibrary** (50+ rules), Deriv API client, MT5 API client, persistence. |
| `src/app/core/riskLibrary/` | Risk library: drawdown, position limits, exposure, volatility, time, concentration, capital, daily loss, correlation, sizing, regime/instrument, compliance/liquidity. Filtered by trade scope (scalp/day/swing/position); evaluated in `tryOpenPosition`. |
| `python/` | Python backend: NN model, training script, FastAPI (`/health`, `/build`, `/predict`, `/mt5/connect`). |
| `CONNECTIVITY.md` | Deriv vs eXness connectivity and instrument classification. |
| `python/README.md` | Python API and model details. |

### Risk and validation

- **Execution:** Any path that opens a bot-driven position should use **`addPositionWithRiskCheck`** (in `portfolio.ts`). It calls **`tryOpenPosition`** in `risk.ts`, which runs core limits (drawdown, correlated exposure, position per instrument) and the **risk library**: all rules applicable to the trade scope are evaluated; if any fails, the position is blocked.
- **Regime at inference:** The NN accepts regime and timeframe one-hot at inference. Use **POST `/predict`** with `feature_vector` (from build response), `instrument_type`, `regime`, and `timeframe`; get regime from `detectRegime(bars)` on the frontend and pass it so decisions are regime-aware.
- **Out-of-sample:** Strategy selection and NN training use only the **train** slice (e.g. first 80% of results by time); the validation slice is reserved for future validation metrics.
- **Automatic drift detection:** When a position is closed (stop/target hit on tick), the app records it in `closedTradesByBot`. Once a bot has ≥10 closed trades, live win rate and profit factor are compared to backtest; if live win rate is ≥15 pp below backtest or live profit factor drops below 0.7 (with backtest ≥1.2), `setDriftDetected(botId, reason)` is called and an early rebuild is scheduled.

### Production readiness (audit)

- **Risk/portfolio:** Zero or invalid position size after Kelly/warmup is rejected; `addPositionWithRiskCheck` only adds when `result.size` is finite and &gt; 0. Concentration rule “max single 20%” is skipped for the first position to avoid blocking all opens.
- **API:** Build and predict use timeouts and error handling; `/predict` validates non-empty `feature_vector` and returns 400/503/500 with clear messages; checkpoint load and inference are wrapped in try/except.
- **Build:** Frontend uses train slice only for `getBestResultsForBuild` and `postBuild`; no validation data is sent to training to avoid leakage.
- **Broker sync:** Only `setPositions` is used when syncing from Deriv, MT5 add-on, or eXness API; bot-driven opens must go through `addPositionWithRiskCheck`.
- **Instrument registry:** Deriv synthetics in the app are Volatility (R_*), Crash/Boom, Jump, Step, Range Break, World. Volatility 1s, DEX, and Drift were removed (not returned by API for this account). Registry is in `registries.ts`; API mapping in `derivApi.ts`. On load, persisted bots and backtest results are migrated: bots with removed instrument IDs are reassigned to the first valid instrument; backtest rows for removed instruments are dropped.

---

## Running the code (summary)

```bash
# Frontend
npm install
npm run dev

# Backend (optional)
cd python && pip install -r requirements.txt && uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```

Then open the dev server URL, use **demo mode** or MT5 login, and configure brokers on the dashboard as needed.
