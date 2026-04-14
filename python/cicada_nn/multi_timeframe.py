"""Map LTF bar timestamps to HTF bar indices for real multi-timeframe signals."""

from __future__ import annotations

HIGHER_TIMEFRAME: dict[str, str | None] = {
    "M1": "M5",
    "M5": "M15",
    "M15": "H1",
    "M30": "H1",
    "H1": "H4",
    "H4": "D1",
    "D1": "W1",
    "W1": None,
}


def get_higher_timeframe(tf: str) -> str | None:
    return HIGHER_TIMEFRAME.get(tf.upper(), None)


def build_htf_index_for_each_ltf_bar(
    ltf_bars: list[dict], htf_bars: list[dict]
) -> list[int]:
    """For each LTF bar index i, HTF bar index j with htf_bars[j]['time'] <= ltf_bars[i]['time'] (latest such j)."""
    if not htf_bars:
        return [-1] * len(ltf_bars)
    out: list[int] = []
    for lb in ltf_bars:
        t = float(lb.get("time", 0))
        lo, hi = 0, len(htf_bars) - 1
        best = -1
        while lo <= hi:
            mid = (lo + hi) // 2
            mt = float(htf_bars[mid].get("time", 0))
            if mt <= t:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        out.append(best)
    return out
