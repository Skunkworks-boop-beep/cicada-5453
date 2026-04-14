#!/usr/bin/env bash
# Build CICADA-5453 from scratch: frontend + backend setup.
# Run from project root: bash scripts/build-from-scratch.sh

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "=== CICADA-5453 Build from Scratch ==="
echo ""

# Prerequisites
echo "--- 1. Prerequisites ---"
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 18+ (https://nodejs.org)"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "WARN: Node.js 18+ recommended (you have $(node -v))"
fi
echo "  Node: $(node -v)"

if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
  echo "ERROR: Python not found. Install Python 3.10+"
  exit 1
fi
PY=$(command -v python3 2>/dev/null || command -v python)
PY_VER=$($PY -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "?")
echo "  Python: $PY_VER"
echo ""

# Frontend
echo "--- 2. Frontend ---"
npm install
npm run build
echo "  Frontend built -> dist/"
echo ""

# Backend
echo "--- 3. Backend ---"
cd "$ROOT/python"
if [ ! -d venv ]; then
  $PY -m venv venv
  echo "  Created venv"
fi
if [ -f venv/bin/activate ]; then
  source venv/bin/activate
elif [ -f venv/Scripts/activate ]; then
  source venv/Scripts/activate
else
  echo "  WARN: Could not activate venv; using system python"
fi
pip install -q -r requirements.txt
echo "  Backend deps installed"
python -c "from cicada_nn.api import app; print('  API import OK')"
cd "$ROOT"
echo ""

echo "=== Build complete ==="
echo ""
echo "Run:"
echo "  Terminal 1: npm run dev"
echo "  Terminal 2: cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --reload --host 0.0.0.0 --port 8000"
echo ""
echo "Then open http://localhost:5173 and use demo mode or connect brokers."
