# Strategy parameter iteration (backtest / server)

**Central config:** `src/app/core/gridConfig.ts` and `python/cicada_nn/grid_config.py` (keep defaults aligned).

| Meaning | Notes |
|--------|--------|
| **~500k “full grid” scale** | `APPROX_FULL_GRID_COMBOS_PER_FAMILY` — theoretical size for the largest 2-axis families (e.g. structure `708×708`). Not a runtime cap. |
| **Default run cap** | `DEFAULT_PARAM_COMBOS_LIMIT` = **12** unless overridden (iterative sweeps). |
| **True full Cartesian** | `paramCombosLimit <= 0` (TS) / `param_combos_limit <= 0` (API) — can match the ~500k+ grid; very slow. |

**Env (optional):**

| Variable | Where | Effect |
|----------|--------|--------|
| `VITE_PARAM_COMBOS_LIMIT` | Frontend build | Default `paramCombosLimit` for client + POST bodies using `gridConfig`. |
| `CICADA_PARAM_COMBOS_LIMIT` | Python API | Default for `BacktestRunRequest.param_combos_limit`. |
| `VITE_RESEARCH_REGIME_GRID_MAX` / `CICADA_RESEARCH_REGIME_GRID_MAX` | FE / Python | Max regime configs per instrument in grid research (default **9**). |
| `VITE_RESEARCH_PARAM_TUNE_MAX_STRAT` / `CICADA_RESEARCH_PARAM_TUNE_MAX_STRAT` | FE / Python | Strategy param combos per regime when tuning (default **2**). |
| `VITE_RESEARCH_PARAM_TUNE_MAX_RISK` / `CICADA_RESEARCH_PARAM_TUNE_MAX_RISK` | FE / Python | Risk grid size per tune (default **6**). |

When `paramCombosLimit` (default from env, else **12**) is **smaller** than the full Cartesian grid:

- The system uses **iterative axis sweeps**, **not** random or arbitrary Cartesian subsampling.
- **Order** is defined in `PARAM_KEY_ORDER` / `PARAM_KEY_ORDER` (TS/Python) — e.g. for **structure**: `lookback` first, then `donchianPeriod`.
- **Defaults** always come first (family defaults, e.g. `lookback: 10`, `donchianPeriod: 20`).
- Remaining budget is **split across axes** (first axes get +1 slot when budget doesn’t divide evenly).
- Along **each axis**, values are chosen at **evenly spaced indices** from min→max in that parameter’s candidate list (708 points for lookback from 3 toward 711, etc.), **holding other params at defaults** for that sweep.

Example (`cp-*` / structure, limit 12): **1** default + **6** lookback sweeps (donchian at default) + **5** donchian sweeps (lookback at default) = **12** distinct configs.

Set `paramCombosLimit <= 0` to request the **full** Cartesian product (can be huge / slow).
