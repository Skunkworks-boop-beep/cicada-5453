# CICADA-5453 — Complete Setup Guide

End-to-end guide: local setup, remote server, brokers, and troubleshooting.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Get the project](#2-get-the-project)
3. [Local setup (one machine)](#3-local-setup-one-machine)
4. [Run locally](#4-run-locally)
5. [Remote server (run on server, use from Mac)](#5-remote-server-run-on-server-use-from-mac)
6. [Production build](#6-production-build)
7. [Brokers](#7-brokers)
8. [Troubleshooting](#8-troubleshooting)
9. [Quick reference](#9-quick-reference)

---

## 1. Prerequisites

| Component | Requirement |
|-----------|-------------|
| **Node.js** | 18+ (20+ recommended) |
| **npm** | Comes with Node.js |
| **Python** | 3.10+ with venv support |
| **Git** | Optional (for cloning) |

### macOS

```bash
brew install node
python3 --version   # usually pre-installed
```

### Debian/Ubuntu (e.g. server)

```bash
sudo apt update
sudo apt install nodejs npm python3 python3-venv
# Python 3.12: sudo apt install python3.12 python3.12-venv
```

### Windows

- [Node.js](https://nodejs.org/) (LTS)
- [Python 3.10+](https://www.python.org/downloads/)

---

## 2. Get the project

```bash
# Clone (if using git)
git clone <repo-url> cicada-5453
cd cicada-5453

# Or you already have it
cd cicada-5453
```

---

## 3. Local setup (one machine)

### Frontend

```bash
npm install
npm run build   # verify
```

### Backend

```bash
cd python
python3 -m venv venv

# macOS/Linux
source venv/bin/activate

# Windows
# venv\Scripts\activate

pip install -r requirements.txt

# Optional: MT5 (Windows/Linux only)
# pip install -r requirements-mt5.txt

python -c "from cicada_nn.api import app; print('OK')"
```

---

## 4. Run locally

**Terminal 1 — Frontend:**
```bash
npm run dev
```
→ `http://localhost:5173`

**Terminal 2 — Backend:**
```bash
cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```
→ `http://localhost:8000`

**Login:** Check "Continue without MT5 (demo mode)" for quick access.

---

## 5. Remote server (run on server, use from Mac)

Run the app on a remote machine and use it from your Mac via SSH tunnel.

### 5.1 SSH keys (do this first)

**Create a key (if needed):**
```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

**Copy key to server (one-time):**
```bash
ssh-copy-id user@192.168.0.101
```
Enter your SSH password once.

**Add key to agent (if passphrase):**
```bash
ssh-add ~/.ssh/id_ed25519
```

### 5.2 Push code to server

```bash
REMOTE_USER=user REMOTE_HOST=192.168.0.101 npm run setup-remote
```
Leave the password prompt **empty** (press Enter) to use your SSH key.

**Server must have:** Node.js 20+, Python 3.10+, `python3-venv`.

### 5.3 Start the app on the server

SSH into the server and run in **two terminals**:

**Terminal 1:**
```bash
ssh user@192.168.0.101
cd cicada-5453 && npm run dev
```

**Terminal 2:**
```bash
ssh user@192.168.0.101
cd cicada-5453/python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000
```

### 5.4 Connect from your Mac

**Option A — Shell script (recommended; uses SSH agent):**
```bash
chmod +x scripts/remote-connect.sh
REMOTE_USER=user REMOTE_HOST=192.168.0.101 ./scripts/remote-connect.sh
```

**Option B — npm run remote:**
```bash
REMOTE_USER=user REMOTE_HOST=192.168.0.101 npm run remote
```
*Note: If this fails with "All configured authentication methods failed", use the shell script (Option A).*

Browser opens at `http://localhost:5173`. **Do not** set a Server Offload URL in the app — the tunnel handles it.

---

## 6. Production build

**Build frontend:**
```bash
npm run build
```

**Serve frontend:**
```bash
npx serve -s dist -l 5173
```

**Run backend:**
```bash
cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000
```

**Environment:** Create `.env` in project root if backend is not at `http://localhost:8000`:
```env
VITE_NN_API_URL=http://localhost:8000
```

---

## 7. Brokers

| Broker | Purpose | Setup |
|--------|---------|-------|
| **Demo mode** | No backend or brokers | Check "Continue without MT5" on login |
| **Deriv** | Synthetic indices | App ID from [api.deriv.com](https://api.deriv.com) + Personal Access Token |
| **eXness API** | Account, positions | API key from Personal Area → API |
| **MT5 add-on** | OHLC for forex/crypto | MT5 terminal on backend machine (Windows/Linux) |

**Brokers panel:** Dashboard → [ BROKERS ] — connect each broker. For OHLC from eXness instruments, connect the MT5 add-on (eXness uses MT5 for market data).

---

## 8. Troubleshooting

### App can't connect to server

- **Use SSH tunnel:** Run `./scripts/remote-connect.sh` — do not use the Server Offload panel.
- **Direct connection:** Backend must use `--host 0.0.0.0`. Open port 8000 on the server firewall. Test: `curl http://192.168.0.101:8000/health`

### SSH "All configured authentication methods failed"

- Use the shell script: `./scripts/remote-connect.sh` (uses system SSH and agent).
- Or set `REMOTE_PASSWORD` and install `sshpass` for password auth.

### SSH prompts for passphrase every time

```bash
ssh-add ~/.ssh/id_ed25519
```

### Port 8000 or 5173 already in use

```bash
# Find process
lsof -i :8000

# Kill it
kill <PID>

# Or use different port for tunnel
REMOTE_LOCAL_BACKEND_PORT=8001 ./scripts/remote-connect.sh
```

### Backend returns "Not Found" at root

The root `/` returns API info. Use `/health` for status. The app uses `/health`, `/backtest`, `/build`, etc.

### npm: command not found on server

Install Node.js via nvm:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20
```

### Python venv fails (ensurepip not available)

```bash
sudo apt install python3-venv
```

---

## 9. Quick reference

| Command | Purpose |
|---------|---------|
| `npm install` | Install frontend deps |
| `npm run dev` | Start frontend |
| `npm run build` | Build frontend for production |
| `npm run setup-remote` | Push code + install on remote |
| `./scripts/remote-connect.sh` | SSH tunnel to remote (use with REMOTE_USER, REMOTE_HOST) |
| `npm run remote` | SSH tunnel (Node script; may need shell script fallback) |
| `bash scripts/build-from-scratch.sh` | One-command local setup |
| `bash scripts/verify-wiring.sh` | Verify frontend + backend wiring |

| Backend | Purpose |
|---------|---------|
| `uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000` | Start API |
| `http://localhost:8000/health` | Health check |
| `http://localhost:8000/docs` | API docs |

---

## 10. Lot size and risk limits (current system)

### Smallest tradable lot size

| Broker / instrument | Min lot | Step | Notes |
|---------------------|---------|------|-------|
| **MT5 / eXness forex** | 0.01 | 0.01 | Default; can go down to 0.01 |
| **MT5 / eXness indices** (AUS200, US30, etc.) | 0.5 | 0.01 | When target &lt; 0.5: open min+target, partial close min, leave target (e.g. 0.07) |
| **Deriv synthetics** | Stake 1–100 | — | Uses stake (USD); min stake 1, max 100 |

### Dynamic lot logic (MT5 add-on)

When the risk engine computes a size **smaller than the instrument minimum**:

1. **Open** `min + target` (e.g. target 0.07, min 0.5 → open 0.57)
2. **Partial close** `min` (close 0.5)
3. **Leave** `target` (0.07)

This runs automatically via the MT5 add-on when connected.

### Risk management defaults

| Parameter | Default | Override |
|-----------|---------|----------|
| Risk per trade | 1% of equity | Bot risk level |
| Stop loss | 2% of entry | Bot config |
| Take profit | 2× stop distance | Bot config |
| Max drawdown | 15% | Bot config |
| Kelly sizing | Off (level 1–3), on (level 4+) | Bot risk level |

Position size: `size = (equity × riskPerTradePct) / (|entry − stopLoss| × pipValue)`.

### Confidence-based multiple entries

The system allows **multiple positions per instrument** when regime confidence is high:

| Regime confidence | Max positions per instrument |
|-------------------|------------------------------|
| &lt; 70% | 1 |
| ≥ 70% | 2 |
| ≥ 85% | 3 |

Config (in `DEFAULT_SCOPE_SELECTOR_CONFIG`): `confidenceForSecondEntry: 0.7`, `confidenceForThirdEntry: 0.85`, `maxPositionsPerInstrument: 3`.

---

## 11. Research grid (large search)

The [GRID] button in Backtest Engine exposes regime configs, strategy params, and risk configs.

**Central limits** (same defaults in app + API): `src/app/core/gridConfig.ts` and `python/cicada_nn/grid_config.py`.

| Setting | Default | Env (frontend / Python) |
|---------|---------|---------------------------|
| Param combos per strategy (backtest iterative sweeps) | 12 | `VITE_PARAM_COMBOS_LIMIT` / `CICADA_PARAM_COMBOS_LIMIT` |
| Regime configs per instrument (research) | 9 | `VITE_RESEARCH_REGIME_GRID_MAX` / `CICADA_RESEARCH_REGIME_GRID_MAX` |
| Strategy param combos per regime (tune) | 2 | `VITE_RESEARCH_PARAM_TUNE_MAX_STRAT` / `CICADA_RESEARCH_PARAM_TUNE_MAX_STRAT` |
| Risk configs per tune | 6 | `VITE_RESEARCH_PARAM_TUNE_MAX_RISK` / `CICADA_RESEARCH_PARAM_TUNE_MAX_RISK` |

Use **`paramCombosLimit <= 0`** (or API `param_combos_limit <= 0`) for the **full** Cartesian strategy grid (can be **~500k+** combos per family for large `STRATEGY_PARAM_RANGES` — very slow). See `docs/PARAM_ITERATION.md`.

**Expanded grids (built-in, ~500k each to match regime scale):**
- Regime: ~512k (forex) / ~538k (volatility) combos
- Strategy: ~500k combos per family (RSI, MACD, structure, stoch, etc.)
- Risk: ~512k combos (stop/risk/target)

For **500k+ regime/risk configs**, set env before starting the API (defaults are 600k each):

```bash
export CICADA_RESEARCH_MAX_REGIME_CONFIGS=600000
export CICADA_RESEARCH_MAX_RISK_CONFIGS=600000
uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000
```

Large grids increase research time; robust mode uses successive halving to reduce runtime.

---

## Related docs

- [BUILD_FROM_SCRATCH.md](BUILD_FROM_SCRATCH.md) — Minimal build steps
- [docs/SETUP_REMOTE.md](docs/SETUP_REMOTE.md) — Remote setup details
- [docs/CONNECTION_TROUBLESHOOTING.md](docs/CONNECTION_TROUBLESHOOTING.md) — App connection issues
- [docs/FULL_SYSTEM_SETUP.md](docs/FULL_SYSTEM_SETUP.md) — Full broker and system setup
