"""
Safe math utilities to avoid division by zero and distorted relative comparisons.
Aligns with TypeScript mathUtils.ts.
"""

MIN_DIVISOR = 1e-10


def safe_div(a: float, b: float, eps: float = MIN_DIVISOR) -> float:
    """
    Safe division: a / b, using eps when b is 0 or not finite.
    For relative comparisons (e.g. |a-b|/b), use this to avoid division by zero.
    """
    divisor = b if (b and b == b) else eps  # b == b checks for NaN
    return a / divisor


def relative_diff(a: float, b: float) -> float:
    """
    Relative difference |a - b| / b for tolerance checks.
    Returns 0 when b is 0 or not finite (no meaningful relative comparison).
    """
    if not b or b != b:  # b != b checks for NaN
        return 0.0
    return abs(a - b) / b
