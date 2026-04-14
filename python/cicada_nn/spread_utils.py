"""
Instrument-specific spread and point size utilities.
Known symbols only. Unknown symbols: log error and raise — use broker pip_size.
"""

import logging
import math
import re

logger = logging.getLogger(__name__)


def infer_point_size(symbol: str, mid_price: float = 1.0) -> float:
    """
    Return point/pip size for known symbol patterns only. No inference for unknowns.
    Known: JPY pairs, synthetics (R_, CRASH, BOOM, etc.), indices (US30, AUS200, etc.).
    Unknown symbols: log error and raise — use broker pip_size.
    """
    sym = symbol.upper().replace(" ", "")
    if "JPY" in sym or re.search(
        r"USDJPY|EURJPY|GBPJPY|AUDJPY|NZDJPY|CADJPY|CHFJPY", sym, re.I
    ):
        return 0.01
    if re.search(r"^R_|^CRASH|^BOOM|^1HZ|^JUMP_|^RANGE_BREAK|^WLD|^STPRNG", sym):
        return 0.01
    if re.search(r"^(US|AU|EU|UK|DE|JP|CH)\d{2,3}$|^[A-Z]{2,4}\d{2,}$", sym):
        return 0.01
    err = f"Unknown symbol for point size: {symbol}. Use broker pip_size; no inference."
    logger.error("[spread_utils] %s", err)
    raise ValueError(err)


def spread_points_to_fraction(
    spread_points: float,
    instrument_symbol: str,
    mid_price: float = 1.0,
) -> float:
    """
    Convert spread from points/pips to price fraction.
    Uses instrument-specific point size — no generic 1 pip = 1e-4 assumption.
    """
    pts = spread_points if isinstance(spread_points, (int, float)) and not math.isnan(spread_points) else 0.0
    point_size = infer_point_size(instrument_symbol, mid_price)
    raw = pts * point_size
    result = min(0.01, max(0.0, raw))
    return result if not math.isnan(result) else 0.0
