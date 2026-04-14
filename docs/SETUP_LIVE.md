# Setting up live accounts and connections

This guide walks you through connecting **Deriv** and **eXness (MT5)** so the app can use **live data** for backtesting and (when wired) execution. Until at least one broker is connected, the dashboard shows **DISCONNECTED**; backtest will fail (no synthetic fallback). After connecting, it shows **LIVE** and backtests use live candles.

---

## 1. What “LIVE” means in the app

- **Header badge**  
  - **LIVE** (green) = at least one broker is connected. Backtest and data can use live candles/prices where the instrument’s broker is connected.  
  - **DISCONNECTED** (orange) = no broker connected. Backtest requires a broker; connect Deriv or MT5 first.

- **Backtest**  
  - With a broker connected: instruments that belong to that broker use **real OHLC** from the API (Deriv or MT5).
  - With no broker: backtest fails — connect Deriv or MT5 first.

- **Portfolio / prices**  
  - “Prices: LIVE” when any broker is connected; “Prices: synthetic” when none are.

---

## 2. Deriv (synthetic indices, API)

Deriv is used for **synthetic indices** (Volatility, Crash/Boom, Jump, Step, etc.). Connection is via **WebSocket API** with an **App ID** and **token**.

### Step 1: Deriv account

1. Sign up at [deriv.com](https://deriv.com) if you don’t have an account.
2. Log in to the Deriv client area.

### Step 2: App ID

1. Go to [api.deriv.com](https://api.deriv.com).
2. Log in with your Deriv credentials.
3. **Register a new app** (or use an existing one).
4. Copy the **App ID** (e.g. `12345`). You’ll paste this in the app under Brokers → Deriv.

### Step 3: Token (OAuth or Personal Access Token)

**Option A — OAuth (browser flow)**  
- Use Deriv’s OAuth flow to get a short‑lived token. The app can be extended to use this; for a simple setup, many users use a **Personal Access Token** instead.

**Option B — Personal Access Token (recommended for testing)**  
1. In the Deriv client area, open **Account** → **API token** (or the equivalent token page).
2. Create a **Personal Access Token** with the scopes you need (e.g. read, trade).
3. Copy the token and store it securely. You’ll paste it in the app as the “token” (or password field) for Deriv.

### Step 4: Connect in the app

1. Open the **Dashboard**.
2. In the **[ BROKERS ]** panel, find **Deriv**.
3. Click the **gear/settings** (or “Connect”) to open the form.
4. Enter:
   - **App ID** — from Step 2.
   - **Token** — from Step 3 (often entered in the “Password” or “Token” field in the form).
5. Click **Save & Connect**.

If the connection succeeds, the Deriv row shows **CONNECTED** and the header badge switches to **LIVE** (when it’s the first/only broker). Backtests for Deriv synthetic instruments will then use **live candles** from the Deriv API.

---

## 3. eXness (forex, indices) via MT5

eXness is used for **forex**, **crypto**, and **real index CFDs** (e.g. US30, AUS200). Connection is via **MetaTrader 5**. The app sends your MT5 credentials to the **Python backend**, which uses the `MetaTrader5` package to connect.

### Step 1: eXness account and MT5 credentials

1. Open an account at [exness.com](https://www.exness.com) (or your regional eXness site).
2. In the client area, create or select an **MT5** account and note:
   - **Login** (account number)
   - **Password**
   - **Server** (e.g. `Exness-MT5Trial7` or the server name shown for your account)

### Step 2: MetaTrader 5 terminal (for the machine running the backend)

- **Windows / Linux**  
  - Install the [MetaTrader 5](https://www.metatrader5.com/) terminal (eXness usually provides a download link).  
  - The **Python backend** that connects to MT5 must run on a machine where MT5 is installed and can be started (or is already running).

- **macOS**  
  - There is **no official MT5 for macOS** and no `MetaTrader5` Python wheel. The backend will run but MT5 connect will report “not installed”. Use a Windows/Linux machine or VM for MT5 + backend if you need eXness live data.

### Step 3: Python backend with MT5 (optional package)

On the machine where MT5 is installed:

```bash
cd python
source venv/bin/activate   # or venv\Scripts\activate on Windows
pip install -r requirements.txt
pip install -r requirements-mt5.txt   # installs MetaTrader5 (Windows/Linux only)
uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```

Ensure the frontend can reach this backend (e.g. `VITE_NN_API_URL=http://<that-machine>:8000` if not on localhost).

### Step 4: Connect in the app (via Brokers panel)

1. **Login (optional but recommended for MT5)**  
   - On the **login page**, you can enter MT5 **Login**, **Password**, and **Server** and submit (without “demo mode”). The frontend calls the backend’s `/mt5/connect` so the backend connects to MT5.  
   - Alternatively, you can leave login in demo and configure MT5 only under Brokers.

2. **Brokers panel**  
   - In the **[ BROKERS ]** section, find **eXness**.  
   - Click the gear/Connect and enter:
     - **Login** — MT5 account number  
     - **Password** — MT5 password  
     - **Server** — MT5 server name (optional if already set on the backend)  
   - Click **Save & Connect**.

The app sends these credentials to the backend; the backend uses `MetaTrader5` to connect. If successful, eXness shows **CONNECTED** and the header shows **LIVE**. Backtests for instruments that use eXness (forex, indices) will then use **real OHLC** from MT5 when the backend and MT5 are on the same machine.

---

## 4. Quick reference

| Broker   | Used for                    | Where to get credentials              | Connect in app          |
|----------|-----------------------------|---------------------------------------|-------------------------|
| **Deriv**| Synthetic indices           | api.deriv.com → App ID; account → token | Brokers → Deriv → App ID + Token |
| **eXness** | Forex, crypto, indices   | eXness client area → MT5 login/server | Brokers → eXness → Login, Password, Server |

- **LIVE** = at least one of these is connected; backtest/portfolio can use real data where applicable.  
- **DISCONNECTED** = no broker connected; backtest requires a broker.

For more on the API and NN backend, see the main [README](../README.md) and [python/README.md](../python/README.md).
