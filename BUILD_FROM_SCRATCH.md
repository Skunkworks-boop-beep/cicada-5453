# CICADA-5453 — Build from Scratch

Complete guide to set up the project from zero: frontend and backend.

---

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| **Node.js** | 18+ (20+ recommended for react-router) |
| **npm** | Comes with Node.js |
| **Python** | 3.10+ with venv support |
| **Git** | Optional (for cloning) |

**macOS:**
```bash
# Node.js (via Homebrew or nvm)
brew install node
# or: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash && nvm install 20

# Python (usually pre-installed; 3.10+)
python3 --version
```

**Debian/Ubuntu:**
```bash
sudo apt update
sudo apt install nodejs npm python3 python3-venv
# For Python 3.12: sudo apt install python3.12 python3.12-venv
```

**Windows:**
- Install [Node.js](https://nodejs.org/) (LTS)
- Install [Python 3.10+](https://www.python.org/downloads/)

---

## Step 1: Get the project

```bash
# Option A: Clone (if using git)
git clone <repo-url> cicada-5453
cd cicada-5453

# Option B: You already have the project
cd cicada-5453
```

---

## Step 2: Frontend setup

```bash
# Install dependencies
npm install

# Verify
npm run build
```

**Output:** `dist/` folder with built assets.

---

## Step 3: Backend setup

```bash
cd python

# Create virtual environment
python3 -m venv venv

# Activate (macOS/Linux)
source venv/bin/activate

# Activate (Windows)
# venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Optional: MT5 support (Windows/Linux only; no macOS wheel)
# pip install -r requirements-mt5.txt
# Requires MetaTrader 5 terminal installed

# Verify
python -c "from cicada_nn.api import app; print('OK')"
```

---

## Step 4: Environment (optional)

Create `.env` in the project root if the backend is not at `http://localhost:8000`:

```env
VITE_NN_API_URL=http://localhost:8000
```

For a remote backend:
```env
VITE_NN_API_URL=https://your-server:8000
```

---

## Step 5: Run

### Development

**Terminal 1 — Frontend:**
```bash
npm run dev
```
Opens at `http://localhost:5173`

**Terminal 2 — Backend:**
```bash
cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000
```
API at `http://localhost:8000`

### Production

**Build frontend:**
```bash
npm run build
```

**Serve frontend** (choose one):
```bash
# Simple static server
npx serve -s dist -l 5173

# Or use nginx, Caddy, etc.
```

**Run backend:**
```bash
cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000
```

---

## Quick reference

| Command | Purpose |
|---------|---------|
| `npm install` | Install frontend deps |
| `npm run dev` | Start frontend dev server |
| `npm run build` | Build frontend for production |
| `npm run remote` | SSH tunnel to remote server |
| `npm run setup-remote` | Push code + install on remote |
| `pip install -r requirements.txt` | Install backend deps |
| `uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000` | Start backend |

---

## Verification

Run the wiring check:

```bash
bash scripts/verify-wiring.sh
```

This builds the frontend, imports the Python API, and hits `/health` and `/backtest`.

---

## Remote server (optional)

To run the app on a remote machine and connect from your Mac:

### 1. One-time: SSH key setup (avoids password prompts)

```bash
# Copy your key to the server (enter password once)
ssh-copy-id user@192.168.0.101

# If your key has a passphrase, add it to the agent
ssh-add ~/.ssh/id_ed25519
```

### 2. Push code and install on remote

```bash
REMOTE_USER=user REMOTE_HOST=192.168.0.101 npm run setup-remote
```

Leave the password prompt **empty** (press Enter) — it will use your SSH key.

### 3. Start the app on the server, then connect from Mac

See [docs/SETUP_REMOTE.md](docs/SETUP_REMOTE.md) for full details. If the app can't connect, see [docs/CONNECTION_TROUBLESHOOTING.md](docs/CONNECTION_TROUBLESHOOTING.md).

---

## Brokers (after setup)

- **Demo mode:** No backend or brokers needed. Check "Continue without MT5" on login.
- **Deriv:** App ID + token from [api.deriv.com](https://api.deriv.com)
- **eXness:** API key from Personal Area → API; MT5 add-on for OHLC
- **MT5:** Login credentials; requires MT5 terminal on the backend machine (Windows/Linux)

See [docs/FULL_SYSTEM_SETUP.md](docs/FULL_SYSTEM_SETUP.md) for full broker setup.
