# Connectivity: Deriv vs eXness vs MT5

## Multi-broker design

The app supports **multiple brokers** so you can execute on both Deriv and eXness (and others):

- **Default brokers**: **Deriv** and **eXness** are pre-configured. You can add more brokers from the dashboard.
- **Per-instrument routing**: Each instrument has a `brokerId`. Execution for that instrument is sent to that broker. So synthetic indices (Deriv) execute on Deriv; forex and eXness indices execute on eXness (MT5).
- **Brokers panel**: Dashboard → **[ BROKERS ]** — connect/disconnect each broker, set MT5 credentials for eXness, add custom brokers (MT5 or Deriv API).
- **Persistence**: Broker list and connection config are saved; credentials are stored in localStorage (use secure storage in production).

## Can we connect and execute on Deriv and eXness directly?

### Deriv — **Yes, direct API**

- **Deriv** exposes a **WebSocket API** (and a Python client: `python_deriv_api`).
- You can:
  - **Fetch instruments** from the platform via the **active_symbols** call (returns all available symbols, including synthetic indices).
  - **Execute trades** via **proposal** (get price) and **buy** (execute); manage positions via **sell** / **cancel**.
- **No MT5 required** for Deriv. The app can connect to Deriv directly, fetch the instrument list, and execute.

### eXness — **Use MT5 (no direct retail API)**

- **eXness** does **not** offer a public REST/WebSocket API for retail clients.
- Supported programmatic access:
  - **MetaTrader 5 (MT5)** — primary way; connect with eXness account credentials, then use MT5 terminal/API to get symbols and trade.
  - **FIX API** — for institutional clients (approval required).
  - **TradingView** — webhooks / automation.
- So for eXness: **MT5 is sufficient and intended**. Login with eXness credentials in the app; the backend uses the MT5 Python package to connect. Instruments can be fetched from the MT5 symbol list once connected.

## Summary

| Platform | Connect & execute | Fetch instruments |
|----------|-------------------|--------------------|
| **Deriv** | **Implemented:** WebSocket client in frontend (`src/app/core/derivApi.ts`). Connect with App ID (api.deriv.com) + Personal Access Token. | Yes — `getActiveSymbols()` calls `active_symbols` |
| **eXness** | Via **MT5** (eXness credentials; backend) | Yes — from MT5 symbol list when connected |

The current app uses **MT5** for login (eXness or any MT5 broker). Adding a **Deriv API** connection in parallel is possible so that:
- Deriv instruments and execution go through the Deriv API.
- eXness (and other MT5 brokers) keep using the existing MT5 backend.

## Instrument classification (fixed)

- **eXness “indices”** are **real stock index CFDs** (e.g. AUS200 = ASX 200, US30 = Dow, US500 = S&P 500, USTEC, UK100, DE30, FR40, JP225, HK50, STOXX50). They are **not** synthetic indices like Deriv’s Volatility/Crash/Boom.
- **Deriv synthetic indices** are algorithm-generated (Volatility R_10–R_100, Vol 15/30/90, Crash/Boom 150–1000, Jump 10–100).
- In the app, eXness indices use type **`indices_exness`**; Deriv synthetics use **`synthetic_deriv`**.
