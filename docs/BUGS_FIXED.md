# Bugs Fixed (Audit)

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
