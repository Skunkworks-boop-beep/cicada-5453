"""Stage 6: backup / restore CLI for orders.sqlite — round-trip + verify."""

from __future__ import annotations

import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cicada_nn.order_records import OrderRecordStore, OrderStatus
import scripts.backup_orders as backup_orders  # noqa: E402  (script-style import)


def _seed_store(path: Path, n: int = 10) -> None:
    s = OrderRecordStore(path)
    for i in range(n):
        s.append_order(
            bot_id="bot",
            instrument_id="inst",
            instrument_symbol="EURUSD",
            style="day",
            side="LONG",
            size=0.1,
            entry_price=1.0,
            stop_loss=0.99,
            take_profit=1.02,
            confidence=0.7,
            status=OrderStatus.FILLED,
            ticket=i + 1,
        )
    s.close()


def test_backup_and_restore_round_trip(tmp_path: Path):
    src = tmp_path / "live" / "orders.sqlite"
    backups = tmp_path / "snapshots"
    src.parent.mkdir(parents=True)
    _seed_store(src, n=15)

    rc = backup_orders.cmd_backup(src=src, out_dir=backups, keep=30)
    assert rc == 0
    snapshots = list(backups.glob("orders-*.sqlite"))
    assert len(snapshots) == 1

    snap = snapshots[0]
    # Restore to a fresh location; verify the row count matches.
    restored = tmp_path / "restored" / "orders.sqlite"
    rc = backup_orders.cmd_restore(src=snap, dst=restored)
    assert rc == 0
    assert restored.exists()

    # Row count parity.
    s = OrderRecordStore(restored)
    assert s.order_count() == 15
    s.close()


def test_backup_refuses_corrupt_source(tmp_path: Path):
    src = tmp_path / "broken.sqlite"
    src.write_bytes(b"this is not a sqlite file")
    out = tmp_path / "snapshots"
    rc = backup_orders.cmd_backup(src=src, out_dir=out, keep=30)
    assert rc != 0
    assert not list(out.glob("*.sqlite"))


def test_rotation_keeps_only_n_most_recent(tmp_path: Path):
    src = tmp_path / "live" / "orders.sqlite"
    backups = tmp_path / "snapshots"
    src.parent.mkdir(parents=True)
    _seed_store(src, n=5)

    # Three sequential snapshots, keep=2.
    for _ in range(3):
        rc = backup_orders.cmd_backup(src=src, out_dir=backups, keep=2)
        assert rc == 0
        time.sleep(1.05)  # ensure mtime resolution distinguishes snapshots

    snapshots = list(backups.glob("orders-*.sqlite"))
    assert len(snapshots) == 2  # rotation kept 2, dropped the oldest


def test_restore_saves_pre_restore_sibling(tmp_path: Path):
    src = tmp_path / "live" / "orders.sqlite"
    src.parent.mkdir(parents=True)
    _seed_store(src, n=5)

    backups = tmp_path / "snapshots"
    rc = backup_orders.cmd_backup(src=src, out_dir=backups, keep=30)
    assert rc == 0
    snap = next(backups.glob("orders-*.sqlite"))

    # Now seed the live file with extra rows, then restore from snapshot.
    _seed_store(src, n=3)  # appends 3 more — total 8
    s = OrderRecordStore(src)
    assert s.order_count() == 8
    s.close()

    rc = backup_orders.cmd_restore(src=snap, dst=src)
    assert rc == 0
    # The pre-restore sibling exists and contains the 8-row live state.
    pre = list(src.parent.glob("orders.sqlite.pre-restore-*"))
    assert len(pre) == 1
    s_pre = sqlite3.connect(str(pre[0]))
    try:
        cur = s_pre.execute("SELECT COUNT(*) FROM orders")
        assert cur.fetchone()[0] == 8
    finally:
        s_pre.close()
    # The live file is now the 5-row snapshot.
    s = OrderRecordStore(src)
    assert s.order_count() == 5
    s.close()


def test_list_command_outputs_in_recency_order(tmp_path: Path, capsys):
    src = tmp_path / "live" / "orders.sqlite"
    src.parent.mkdir(parents=True)
    _seed_store(src, n=2)
    backups = tmp_path / "snapshots"
    backup_orders.cmd_backup(src=src, out_dir=backups, keep=30)
    time.sleep(1.05)
    backup_orders.cmd_backup(src=src, out_dir=backups, keep=30)
    capsys.readouterr()  # discard prior output

    rc = backup_orders.cmd_list(out_dir=backups)
    assert rc == 0
    captured = capsys.readouterr()
    lines = [l for l in captured.out.splitlines() if l.strip()]
    # 2 snapshots → 2 lines, newest first.
    assert len(lines) == 2
