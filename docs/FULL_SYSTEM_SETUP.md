# Full system setup — CICADA-5453

This guide walks you through a **complete setup** of the trading dashboard: frontend, optional backend, brokers, and how each feature uses them.

---

## 1. Do I need the backend?

| What you do | Backend required? |
|-------------|-------------------|
| **Login (demo mode)** | No |
| **Backtest** | **No** — runs in the browser. **Requires** Deriv or MT5 connected (no synthetic fallback). Uses real OHLC from Deriv (frontend) or MT5 (backend) when brokers are connected. |
| **Connect Deriv** | No — frontend talks to Deriv WebSocket directly. |
| **Connect eXness (MT5)** | **Yes** — the Python backend connects to MetaTrader 5. |
| **Bot Build (train NN)** | **Yes** — the Python backend runs PyTorch training. |
| **MT5_CONNECTION status / real MT5 OHLC** | **Yes** — backend must be running and MT5 connected. |

**Summary:** You can run the app with **frontend only** (demo mode, Deriv if you connect it). **Backtest requires a broker** (Deriv or MT5); connect one before running. Start the **backend** when you need MT5 (eXness) or **Bot Build**. **Portfolio P/L and balance** are not simulated: they start empty and show real data only after you connect MT5 (balance from account) or when live positions are available.

---

## 2. Why does the page become unresponsive when I click Run (backtest)?

**You do not need to start the backend for backtest.** The backtest runs entirely in the browser. Unresponsiveness is from **heavy CPU work** on the main thread:

- Each run runs many **jobs** (instruments × strategies × timeframes × regimes).
- Each job processes **up to 50,000 bars** (full history): regime detection, signals, trade simulation.
- The engine yields after each job so the UI can update, but a **single job** can still take several seconds on a slow device.

**What to do:**

1. **Wait** — Progress and phase text should update; give it 30–60 seconds and see if the progress bar moves.
2. **Reduce load** — Select **one instrument** in Instrument Selection, and/or disable some strategies, then run. Fewer jobs = faster and less chance of the tab freezing.
3. **Cancel** — Use **[CANCEL]** in the Backtest Engine to stop the run if it’s stuck or too slow.
4. **Backend not required** — Starting the Python backend will **not** fix backtest freezes; it only helps for MT5 and Bot Build.

---

## 3. Prerequisites

| Component | Requirement |
|-----------|-------------|
| **Frontend** | Node.js 18+ and npm (or pnpm). |
| **Backend (optional)** | Python 3.10+. |
| **MT5 / eXness (optional)** | MetaTrader 5 terminal installed on the **same machine** as the backend (Windows or Linux; no MT5 on macOS). |
| **Deriv (optional)** | Account + App ID from [api.deriv.com](https://api.deriv.com) + Personal Access Token. |

---

## 4. Step-by-step setup

### 4.1 Frontend (required)

```bash
# From project root
npm install
npm run dev
```

- Opens at `http://localhost:5173` (or the port Vite shows).
- **Production build:** `npm run build` → output in `dist/`.

### 4.2 Python backend (optional — for MT5 and Bot Build)

```bash
cd python
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**MT5 (eXness) on Windows/Linux only:**

```bash
pip install -r requirements-mt5.txt
```

Then start the API:

```bash
uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```

- Backend URL: `http://localhost:8000`.
- Endpoints: `GET /health`, `POST /mt5/connect`, `GET /mt5/status`, `GET /mt5/ohlc`, `POST /build`.

**MT5 note:** The machine where the backend runs must have the **MetaTrader 5** terminal installed (and running, if you use it for live data). On macOS, MT5 is not available; the backend still runs but MT5 connect will report “not installed”.

### 4.3 Environment variables

In the **project root** (where the frontend runs), create a `.env` if the backend is not on the default host/port:

```env
VITE_NN_API_URL=http://localhost:8000
```

- Omit this if the backend is at `http://localhost:8000`.
- For a remote backend, use that URL (e.g. `https://your-server:8000`).

### 4.4 Login

1. Open the app (e.g. `http://localhost:5173`).
2. **Demo mode:** Check **“Continue without MT5 (demo mode)”** → **INITIATE SECURE ACCESS**. No backend or credentials needed.
3. **MT5 (eXness):** Enter Login, Password, Server → submit. The frontend calls the backend `POST /mt5/connect`; the backend must be running and MT5 installed (Windows/Linux) for connection to succeed.

### 4.5 Brokers (dashboard)

After login, open **[ BROKERS ]** on the dashboard.

- **Deriv** — App ID (from [api.deriv.com](https://api.deriv.com)) + Personal Access Token. Save & Connect. No backend needed.
- **eXness (MT5)** — Same MT5 credentials as login (or set in Brokers → eXness). Backend must be running and connected to MT5.

Detailed broker setup: [docs/SETUP_LIVE.md](SETUP_LIVE.md).

---

## 5. What uses what (quick reference)

| Feature | Frontend | Backend | Deriv | MT5 |
|---------|----------|---------|-------|-----|
| Demo login | ✓ | — | — | — |
| Backtest | ✓ | Only for MT5 instruments | ✓ for Deriv instruments | ✓ via backend |
| Bot Build (train NN) | ✓ | ✓ | — | — |
| MT5 connect / status | ✓ | ✓ | — | ✓ terminal |
| Deriv connect | ✓ | — | ✓ | — |

---

## 6. Troubleshooting

| Issue | Check |
|-------|--------|
| **Page unresponsive on Run (backtest)** | Backend not needed. Reduce instruments/strategies, wait for progress, or cancel. See §2. |
| **MT5_CONNECTION: ○ INACTIVE** | Start backend; on login or Brokers → eXness enter MT5 credentials and connect. |
| **MT5_CONNECTION: ○ N/A** | Backend unreachable or MT5 not available (e.g. macOS). |
| **Deriv connect fails** | Valid App ID and token; network allows `ws.derivws.com`. |
| **Bot Build fails** | Backend running at `VITE_NN_API_URL`; backtest completed (not cancelled). |
| **Backtest fails / no data** | Connect at least one broker (Deriv or eXness). Backtest requires live OHLC; no synthetic fallback. |

---

## 7. Running on a more powerful computer (SSH)

To use a remote machine and only input **username, IP address, and password**:

```bash
REMOTE_USER=myuser REMOTE_HOST=192.168.1.10 REMOTE_PASSWORD=mypass npm run remote
```

Or run `npm run remote` and enter them when prompted. Full steps (Node launcher and shell script): [docs/REMOTE_SETUP.md](REMOTE_SETUP.md).

---

## 8. One-command recap

**Frontend only (demo; backtest requires broker):**

```bash
npm install && npm run dev
```

**Frontend + backend (for MT5 and Bot Build):**

```bash
# Terminal 1
npm install && npm run dev

# Terminal 2
cd python && source venv/bin/activate && pip install -r requirements.txt && uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```

Then open the app URL, use demo or MT5 login, and configure brokers in the dashboard as needed.
