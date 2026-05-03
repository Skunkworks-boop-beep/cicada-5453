# CICADA-5453 MT5 Bridge

This package runs **inside a Windows VM**, not on the Ubuntu trading host.

`server.py` is a FastAPI service that wraps the official `MetaTrader5` Python
package. The Ubuntu trading code never imports MetaTrader5 directly — every
order placement, position read, and tick fetch goes via HTTP to
`localhost:5000`. See [`../python/cicada_nn/mt5_bridge.py`](../python/cicada_nn/mt5_bridge.py)
for the host-side client.

## Quick start (inside the VM)

```powershell
pip install -r requirements.txt
uvicorn bridge.server:app --host 0.0.0.0 --port 5000
```

Set the service to auto-start via Windows Task Scheduler so the VM boots
straight into "ready to trade" state.

## Endpoints

| Method | Path             | Purpose                          |
|--------|------------------|----------------------------------|
| GET    | `/health`        | Heartbeat + MT5 connection check |
| POST   | `/order/place`   | Market order                     |
| POST   | `/order/modify_sl` | Move SL / TP                   |
| POST   | `/order/close`   | Close position                   |
| GET    | `/positions`     | All open positions               |
| GET    | `/ticks`         | Tick history                     |
| GET    | `/history`       | OHLCV bars                       |

Request and response shapes match the spec verbatim (see
`trading_system_claude_code (updated).txt` lines 1135-1199).

## Why a bridge instead of `import MetaTrader5` on Ubuntu?

The `MetaTrader5` Python package only ships Windows wheels. The trading
pipeline runs natively on Ubuntu (better KVM/PyTorch/CUDA story). Putting
MT5 inside a Windows VM and exposing it over HTTP keeps the abstraction
clean and lets us swap the bridge for a direct FIX connection later
without rewriting any pipeline code.

## Tests

`test_bridge_contract.py` runs on Linux against a stub MetaTrader5 that
mimics the surface this server uses (request/response shapes, retcodes).
The tests assert endpoint contracts; they do not exercise a real broker.
