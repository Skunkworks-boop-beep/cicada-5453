"""Stage 4 (review §4.1): _INSTRUMENT_SYMBOL_MAP atomic-swap.

The previous clear-then-populate pattern briefly exposed an empty map to
worker threads reading it during a tick. The new code builds the map
locally and binds it under a lock; readers always see either the old
or new map, never a torn intermediate.

This test smashes set + get from many threads simultaneously and asserts
that no reader ever observes a missing key for a value that was set
before the read started.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.daemon_runtime import (
    get_instrument_symbol_map,
    set_instrument_symbol_map,
)


def test_set_then_get_round_trip():
    set_instrument_symbol_map({"inst-eurusd": "EURUSDm", "inst-usdjpy": "USDJPYm"})
    m = get_instrument_symbol_map()
    assert m == {"inst-eurusd": "EURUSDm", "inst-usdjpy": "USDJPYm"}


def test_get_returns_a_copy():
    set_instrument_symbol_map({"a": "X"})
    m = get_instrument_symbol_map()
    m["a"] = "MUTATED"
    assert get_instrument_symbol_map()["a"] == "X"


def test_blank_value_filtered():
    set_instrument_symbol_map({"a": "  ", "b": "VALID"})
    assert get_instrument_symbol_map() == {"b": "VALID"}


def test_full_replace_drops_old_keys():
    set_instrument_symbol_map({"a": "1", "b": "2"})
    set_instrument_symbol_map({"c": "3"})
    assert get_instrument_symbol_map() == {"c": "3"}


def test_concurrent_writers_dont_tear_readers():
    """Hammer set + get from 16 threads. Every read must observe a fully-
    populated map (no missing keys for a write that completed before the
    read), or the previous fully-populated map. Atomic-swap guarantee."""
    full_a = {"k1": "A1", "k2": "A2", "k3": "A3"}
    full_b = {"k1": "B1", "k2": "B2", "k3": "B3"}
    set_instrument_symbol_map(full_a)
    stop = threading.Event()
    failures: list[str] = []

    def writer(toggle_state: dict) -> None:
        i = 0
        while not stop.is_set():
            set_instrument_symbol_map(full_a if i % 2 == 0 else full_b)
            i += 1

    def reader() -> None:
        while not stop.is_set():
            m = get_instrument_symbol_map()
            # Either fully A or fully B — never a partial fragment.
            if m == full_a or m == full_b:
                continue
            failures.append(f"torn map: {m}")
            return

    writers = [threading.Thread(target=writer, args=({},)) for _ in range(4)]
    readers = [threading.Thread(target=reader) for _ in range(12)]
    for t in writers + readers:
        t.start()
    # Run for 0.3s — plenty of writes/reads to surface a race.
    import time
    time.sleep(0.3)
    stop.set()
    for t in writers + readers:
        t.join(timeout=2.0)
    assert failures == [], failures


def test_clear_via_empty_dict():
    set_instrument_symbol_map({"a": "X"})
    set_instrument_symbol_map({})
    assert get_instrument_symbol_map() == {}


def test_none_input_clears():
    set_instrument_symbol_map({"a": "X"})
    set_instrument_symbol_map(None)  # type: ignore[arg-type]
    assert get_instrument_symbol_map() == {}
