# Broker-Specific Instrument Symbols

Spread and price data are fetched from brokers using their native symbol formats. No estimated or synthetic values — broker data only.

## Deriv (synthetic indices)

- **Source**: `active_symbols` API → `underlying_symbol` field
- **Ticks**: Pass exact `underlying_symbol` from active_symbols (e.g. `R_10`, `1HZ100V`, `jump_10`, `BOOM500`)
- **No estimation**: When tick returns only `quote` (no bid/ask), spread is not shown — broker data only
- **Reference**: [Deriv API active_symbols](https://developers.deriv.com/docs/data/active-symbols), [ticks](https://developers.deriv.com/docs/data/ticks/)

### Tick contracts (R_10, R_100, etc.) — entry, exit, and P/L

- **Duration**: Contracts have a fixed duration (e.g. 5 ticks). The broker closes them automatically when the duration ends.
- **No predicted close**: The app does not send a close order. Exit is determined by the broker when the contract expires. Stop/target from the strategy are not applied to tick contracts.
- **profit_table**: `buy_price` and `sell_price` are stake/payout, not underlying index levels. Do not use them as entry/exit. P/L % = `profit / buy_price` (stake).
- **Profit calculation** (per Deriv docs): Use explicit `profit` when present; else win = `payout - buy_price`, loss = `-buy_price` (payout 0). Fetches last 200 transactions; retries once if closed positions detected but profit_table empty.

## Exness / MT5

- **Source**: MT5 `symbol_info` / `symbol_info_tick` — real broker data
- **Symbol suffixes** (Exness account type): Pro (none), Standard (`m`), Standard Cent (`c`), Raw Spread (`r`), Zero (`z`)
- **Resolution**: Tries base symbol then suffixes (`EURUSD`, `EURUSDm`, `EURUSDc`, `EURUSDr`, `EURUSDz`) until one returns data
- **Reference**: [Exness account type suffixes](https://get.exness.help/hc/en-us/articles/360014560220-Account-type-suffixes)
