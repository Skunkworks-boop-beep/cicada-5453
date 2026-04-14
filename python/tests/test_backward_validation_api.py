"""
API and research integration tests for backward validation.
Run: cd python && python -m pytest tests/test_backward_validation_api.py -v
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

# Import app after path is set
from cicada_nn.api import app


def _make_bars(n: int, base_price: float = 100.0, base_ts: int = 1700000000) -> list[dict]:
    bars = []
    for i in range(n):
        p = base_price + (i * 0.1)
        bars.append({"time": base_ts + i * 300, "open": p, "high": p + 0.5, "low": p - 0.5, "close": p + 0.2})
    return bars


class TestBackwardValidateEndpoint:
    def test_empty_trades_returns_200(self):
        client = TestClient(app)
        r = client.post(
            "/research/backward-validate",
            json={
                "closed_trades": [],
                "bars": {},
                "instrument_symbols": {},
                "strategy_ids": [],
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "validatedTrades" in data
        assert "calibrationHints" in data
        assert data["summary"]["total"] == 0

    def test_missing_strategy_ids_returns_error_in_summary(self):
        client = TestClient(app)
        r = client.post(
            "/research/backward-validate",
            json={
                "closed_trades": [{"instrumentId": "i1", "type": "LONG", "pnl": 10, "closedAt": "2024-01-01T12:00:00Z"}],
                "bars": {},
                "instrument_symbols": {"i1": "SYM"},
                "strategy_ids": [],
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "error" in data
        assert "strategy_ids" in data["error"].lower() or "required" in data["error"].lower()

    def test_valid_request_returns_structure(self):
        bars = _make_bars(100)
        bar_50_ts = bars[50]["time"]
        client = TestClient(app)
        r = client.post(
            "/research/backward-validate",
            json={
                "closed_trades": [{
                    "instrumentId": "inst-1",
                    "botId": "bot-1",
                    "type": "LONG",
                    "pnl": 50.0,
                    "entryPrice": 105.0,
                    "openedAt": datetime.fromtimestamp(bar_50_ts, tz=timezone.utc).isoformat(),
                    "closedAt": datetime.fromtimestamp(bars[51]["time"], tz=timezone.utc).isoformat(),
                    "scope": "day",
                }],
                "bars": {"inst-1|H1": bars},
                "instrument_symbols": {"inst-1": "SYM1"},
                "strategy_ids": ["ind-rsi-overbought"],
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "validatedTrades" in data
        assert "calibrationHints" in data
        assert "summary" in data
        assert "total" in data["summary"]
        assert "verified" in data["summary"]
        assert "skipped" in data["summary"]


class TestResearchCalibrationHintsIntegration:
    """Verify research accepts calibration_hints."""
    def test_research_grid_accepts_calibration_hints(self):
        client = TestClient(app)
        r = client.post(
            "/research/grid",
            json={
                "instrumentIds": ["inst-1"],
                "strategyIds": ["ind-rsi-overbought"],
                "dateFrom": "2020-01-01",
                "dateTo": "2024-01-01",
                "bars": {"inst-1|M5": _make_bars(500)},
                "instrument_symbols": {"inst-1": "SYM1"},
                "calibration_hints": {
                    "inst-1": {
                        "regimeConfig": {"lookback": 50, "trend_threshold": 0.00015, "volatility_high": 0.02, "volatility_low": 0.004, "donchian_boundary_frac": 0.998},
                        "strategyId": "ind-rsi-overbought",
                        "score": 3,
                    },
                },
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "regimeTunes" in data
        assert "paramTunes" in data
        assert "skippedInstruments" in data
        assert data["skippedInstruments"] == []

    def test_research_grid_returns_skipped_instruments(self):
        """Non-stream /research/grid returns skippedInstruments when instruments skipped."""
        client = TestClient(app)
        r = client.post(
            "/research/grid",
            json={
                "instrumentIds": ["inst-skip"],
                "strategyIds": ["ind-rsi-overbought"],
                "dateFrom": "2020-01-01",
                "dateTo": "2024-01-01",
                "bars": {"inst-skip|M5": _make_bars(50)},
                "instrument_symbols": {"inst-skip": "SKIP"},
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "skippedInstruments" in data
        assert len(data["skippedInstruments"]) == 1
        assert data["skippedInstruments"][0]["reason"] == "insufficient_bars"
        assert data["regimeTunes"] == []
        assert data["paramTunes"] == []


class TestResearchGridStream:
    """Verify research grid stream endpoint yields progress and done chunks."""

    def test_stream_returns_progress_and_done(self):
        client = TestClient(app)
        r = client.post(
            "/research/grid/stream",
            json={
                "instrumentIds": ["inst-1"],
                "strategyIds": ["ind-rsi-overbought"],
                "timeframes": ["M5"],
                "dateFrom": "2020-01-01",
                "dateTo": "2024-01-01",
                "bars": {"inst-1|M5": _make_bars(500)},
                "instrument_symbols": {"inst-1": "SYM1"},
                "regime_grid_max": 3,
                "param_tune_max_strat": 1,
                "param_tune_max_risk": 2,
            },
        )
        assert r.status_code == 200
        lines = [line for line in r.text.strip().split("\n") if line]
        assert len(lines) >= 2
        chunks = [json.loads(line) for line in lines]
        progress_chunks = [c for c in chunks if c.get("type") == "progress"]
        done_chunks = [c for c in chunks if c.get("type") == "done"]
        assert len(progress_chunks) >= 1
        assert len(done_chunks) == 1
        done = done_chunks[0]
        assert "regimeTunes" in done
        assert "paramTunes" in done
        assert "baselineResults" in done
        # Progress should include phase and message
        assert any("currentPhase" in c or "phase" in c for c in progress_chunks)

    def test_stream_insufficient_bars_halts_with_error(self):
        """Insufficient bars (< 200): process halts with 400, no inference or skip."""
        client = TestClient(app)
        r = client.post(
            "/research/grid/stream",
            json={
                "instrumentIds": ["inst-skip"],
                "strategyIds": ["ind-rsi-overbought"],
                "timeframes": ["M5"],
                "dateFrom": "2020-01-01",
                "dateTo": "2024-01-01",
                "bars": {"inst-skip|M5": _make_bars(50)},  # < 200 bars
                "instrument_symbols": {"inst-skip": "SKIP"},
                "regime_grid_max": 2,
                "param_tune_max_strat": 1,
                "param_tune_max_risk": 2,
            },
        )
        assert r.status_code == 400
        data = r.json()
        detail = data.get("detail", "")
        assert "Missing" in detail or "Insufficient" in detail
        assert "Process halted" in detail or "no inference" in detail.lower()

    def test_stream_no_symbol_halts_with_error(self):
        """No symbol (instrument_symbols missing or empty): process halts with 400."""
        client = TestClient(app)
        r = client.post(
            "/research/grid/stream",
            json={
                "instrumentIds": ["inst-"],
                "strategyIds": ["ind-rsi-overbought"],
                "dateFrom": "2020-01-01",
                "dateTo": "2024-01-01",
                "bars": {},
                "instrument_symbols": {},
                "regime_grid_max": 2,
                "param_tune_max_strat": 1,
                "param_tune_max_risk": 2,
            },
        )
        assert r.status_code == 400
        data = r.json()
        assert "Missing" in data.get("detail", "") or "no symbol" in data.get("detail", "").lower()

    def test_stream_progress_reaches_100_when_complete(self):
        """Progress bar reaches 100% when research completes successfully."""
        client = TestClient(app)
        r = client.post(
            "/research/grid/stream",
            json={
                "instrumentIds": ["inst-1"],
                "strategyIds": ["ind-rsi-overbought"],
                "timeframes": ["M5"],
                "dateFrom": "2020-01-01",
                "dateTo": "2024-01-01",
                "bars": {"inst-1|M5": _make_bars(500)},
                "instrument_symbols": {"inst-1": "SYM1"},
                "regime_grid_max": 2,
                "param_tune_max_strat": 1,
                "param_tune_max_risk": 2,
            },
        )
        assert r.status_code == 200
        lines = [line for line in r.text.strip().split("\n") if line]
        chunks = [json.loads(line) for line in lines]
        done = [c for c in chunks if c.get("type") == "done"][0]
        progress_chunks = [c for c in chunks if c.get("type") == "progress" and "progress" in c]
        assert len(progress_chunks) >= 1
        final_progress = progress_chunks[-1]
        assert final_progress.get("progress") == 100.0
        assert done["regimeTunes"]
        assert done["paramTunes"]

    def test_stream_mixed_insufficient_halts_with_error(self):
        """One instrument with insufficient bars: process halts with 400, no partial run."""
        client = TestClient(app)
        r = client.post(
            "/research/grid/stream",
            json={
                "instrumentIds": ["inst-skip", "inst-ok"],
                "strategyIds": ["ind-rsi-overbought"],
                "timeframes": ["M5"],
                "dateFrom": "2020-01-01",
                "dateTo": "2024-01-01",
                "bars": {"inst-skip|M5": _make_bars(50), "inst-ok|M5": _make_bars(500)},
                "instrument_symbols": {"inst-skip": "SKIP", "inst-ok": "OK"},
                "regime_grid_max": 2,
                "param_tune_max_strat": 1,
                "param_tune_max_risk": 2,
            },
        )
        assert r.status_code == 400
        data = r.json()
        detail = data.get("detail", "")
        assert "Missing" in detail or "Insufficient" in detail or "SKIP" in detail


class TestRegimeConfig:
    """Unit tests for RegimeConfig."""

    def test_from_dict_empty_uses_defaults(self):
        from cicada_nn.regime_detection import RegimeConfig
        rc = RegimeConfig.from_dict({})
        assert rc.lookback == 50
        assert rc.trend_threshold == 0.00015
        assert rc.volatility_high == 0.02
        assert rc.volatility_low == 0.004
