#!/usr/bin/env bash
# Verify frontend + backend wiring. Run from project root.
# Parts requiring MT5/Deriv/eXness are left to you.

set -e
cd "$(dirname "$0")/.."

echo "=== 1. Frontend build ==="
npm run build
echo "OK"

echo ""
echo "=== 2. Python API import ==="
cd python && source venv/bin/activate && python -c "from cicada_nn.api import app; print('OK')" && cd ..
echo "OK"

echo ""
echo "=== 3. Backend health (start server in background) ==="
cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 127.0.0.1 --port 8000 &
UVICORN_PID=$!
cd ..
sleep 3
if curl -sf http://127.0.0.1:8000/health > /dev/null; then
  echo "GET /health OK"
else
  echo "GET /health FAILED"
  kill $UVICORN_PID 2>/dev/null || true
  exit 1
fi

echo ""
echo "=== 4. POST /backtest (no MT5 - expect failed placeholder rows) ==="
RES=$(curl -sf -X POST http://127.0.0.1:8000/backtest \
  -H "Content-Type: application/json" \
  -d '{"instrumentIds":["inst-eurusd"],"strategyIds":["ind-rsi-div"],"timeframes":["M5"],"regimes":["ranging"],"instrument_symbols":{"inst-eurusd":"EURUSD"},"strategy_names":{"ind-rsi-div":"RSI"}}')
if echo "$RES" | grep -q '"results"'; then
  echo "POST /backtest OK (returns results)"
else
  echo "POST /backtest FAILED"
  echo "$RES"
  kill $UVICORN_PID 2>/dev/null || true
  exit 1
fi

kill $UVICORN_PID 2>/dev/null || true
echo ""
echo "=== All automated checks passed ==="
echo ""
echo "Broker → OHLC data flow:"
echo "  - Deriv (broker-deriv): fetchOHLCV uses ticks_history when Deriv connected"
echo "  - MT5 (broker-exness): fetchOHLCV uses backend /mt5/ohlc when MT5 connected"
echo "  - eXness API (broker-exness-api): fetchOHLCV uses MT5 when MT5 add-on connected"
echo "  - Server backtest: frontend fetches bars from above, sends to POST /backtest"
echo ""
echo "Left for you (require live access):"
echo "  - MT5: Connect via Login or Brokers, then run backtest for live OHLC"
echo "  - Deriv: Connect with App ID + token, run backtest for synthetic indices"
echo "  - eXness: Connect with API key + MT5 add-on for forex/crypto OHLC"
echo "  - Build: Run backtest (with live data), then Build in Bot Builder"
echo "  - Deploy: Build bot, deploy, verify predict + execution"
