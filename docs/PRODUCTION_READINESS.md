# Production Readiness

## Deploy Button Activation

**When is Deploy enabled?**

| Condition | Deploy (selected) | Deploy all |
|-----------|-------------------|------------|
| No instrument selected | Disabled | — |
| Selected instrument has no bot | Disabled | — |
| Bot status = **outdated** (not built) | Disabled | — |
| Bot status = **building** | Disabled | — |
| Bot status = **ready** (built, not deployed) | **Enabled** | Enabled if any ready |
| Bot status = **deployed** | Disabled (already deployed) | — |

**Flow:** Backtest → [ BUILD ] → Bot becomes `ready` → Deploy enabled.

---

## BOT EXECUTION ON/OFF

| Control | What it does |
|---------|--------------|
| **Deploy** | Adds a bot to the execution pool (it will run when execution is ON) |
| **Undeploy** | Removes a bot from the execution pool |
| **BOT EXECUTION ON** | All *deployed* bots run (tickBotExecution every 15–120s) |
| **BOT EXECUTION OFF** | No bots execute; deployed bots are paused |

**Summary:** Deploy/Undeploy = *which* bots are active. BOT EXECUTION ON/OFF = *whether* they run.

---

## Bot Registry Display

**Only built bots are shown.** Bots with status `outdated` (never built or build failed) do not appear. Empty state: "No built bots yet. In Bot Builder: select instrument, run backtest, then [ BUILD ]."

---

## Production Checklist

- [ ] **Backend running** — Python API on port 8000 (or remote URL)
- [ ] **Broker connected** — Deriv or MT5 for live data and execution
- [ ] **Backtest completed** — Full run (no cancel) before build
- [ ] **Bots built** — At least one instrument built (status `ready`)
- [ ] **Deploy** — Deploy desired bots
- [ ] **BOT EXECUTION ON** — Enable when ready to trade
- [ ] **Risk limits** — Review default risk params (max drawdown, exposure)
- [ ] **Paper trade first** — Consider demo/paper account before live

## Known Limitations

- MT5 requires Windows/Linux (no macOS wheel)
- Deriv requires App ID and token
- Backtest requires broker connection for OHLCV
- NN build requires completed backtest with live data
