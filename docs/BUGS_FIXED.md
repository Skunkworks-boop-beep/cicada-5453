# Bugs Fixed (Audit)

## Stage 1 — Geometric refactor (cicada-5453)

13. **Immediate close on entry bar** — The execution daemon could exit a position on the same bar it opened it. Fixed: `python/cicada_nn/sl_tp_manager.py:can_exit` and the per-mode `min_hold_bars` in `trade_modes.TRADE_MODES` gate signal-driven exits until the bar count clears. SCALPING = 3, DAY = 6, MED_SWING = 8, SWING = 12, SNIPER = 6.

14. **No dynamic SL** — Orders were placed with an initial SL/TP and never modified after entry, even for SWING bots that should breakeven-trail at +1R. Fixed: `python/cicada_nn/sl_tp_manager.evaluate_sl/evaluate_tp` runs every tick from `execution_daemon._advance_open_positions`; every move is a NEW row in `sl_tp_events`, and (when MT5 is connected) pushed via `mt5_client.modify_sl`.

15. **Modes share validation logic** — One risk-engine call validated every signal regardless of the bot's trade style. Fixed: `python/cicada_nn/trade_modes.validate_order` is the single per-mode gate; rejections write a `REJECTED` row to `orders` with the reject reason and never coerce parameters.

16. **Incomplete order records (paper trades)** — Order lifecycle was JSON with overwrites; modifications and rejections vanished from the audit trail. Fixed: `python/cicada_nn/order_records.OrderRecordStore` (SQLite WAL, append-only) — every status transition and every SL/TP modification is a new row, never an update. Verified by `python/tests/test_order_records.py`.

17. **MT5-only execution narrowing** — Order placement is now MT5-only; Deriv and Exness are read-only data sources. `src/app/core/brokerExecution.ts` rejects Deriv-routed orders with a `data-only` reason. `BrokersManager` UI labels Deriv and eXness as `(data-only)`.

## Critical

1. **Python backtest: no regime filtering** — Server produced identical rows for every regime. Fixed: added `regime_detection.py`, only enter when `regime_at_bar === job_regime`.

2. **Python backtest: ignored strategy selection** — Server used hardcoded momentum regardless of RSI/MACD/etc. Known limitation: server still uses momentum; for full strategy fidelity run client-side (clear Server Offload URL).

3. **Docs: wrong "synthetic data" claim** — FULL_SYSTEM_SETUP, SETUP_LIVE, DATA_FLOW said backtest uses synthetic data when no broker. Reality: backtest requires Deriv or MT5; throws if not connected. Fixed all docs.

4. **Training cutoff: rows without dataEndTime** — `filterResultsByTrainingCutoff` and `splitBacktestResultsForOOS` could include rows with no `dataEndTime`, risking leakage. Fixed: exclude rows without `dataEndTime` or `completedAt`.

5. **postBuild: send rows without dataEndTime** — Build payload could include rows missing `dataEndTime`. Fixed: filter to only rows with `dataEndTime ?? completedAt`.

## Alignment

6. **Python strategy_params vs frontend** — Structure had only `lookback`; frontend has `lookback`, `donchianPeriod`, etc. Missing `cp-*` and `cs-*` prefix handling. Fixed: aligned structure params, added candlestick family, cp-/cs- prefix handling.

## Oversights (Audit 2025-03)

9. **cp-tweezer-tops/bottoms used generic candlestick** — Both used `signalCandlestick` instead of pattern-specific `signalTweezerTop`/`signalTweezerBottom`. Fixed: mapped to distinct functions.

10. **ind-mfi used RSI** — Money Flow Index is volume-weighted; was incorrectly using RSI. Fixed: added `mfi()` indicator and `signalMfi`; Python parity.

11. **Python cs-* parity** — 32 cs-* patterns fell back to generic candlestick. Fixed: added 32 pattern-specific implementations to `candlestick_signals.py` (morning-star, evening-star, harami-cross, three-inside, stick-sandwich, marubozu, kicking, abandoned-baby, northern/southern-doji, three-line-strike, etc.).

12. **Proxy indicators undocumented** — ind-cmf, ind-cmo, ind-tsi, ind-ultimate-osc use RSI proxy. Documented in `SIGNAL_PROXY_AND_LIMITATIONS.md`.

## ETA (previous session)

7. **ETA display when eta=0** — Showed "~0s remaining" while still running. Fixed: show "— estimating" or "— finishing soon".

8. **Fallback ETA formula** — Didn't account for bar-fetch phase. Fixed: added 90s base, raised cap to 900s.
