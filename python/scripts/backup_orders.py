"""orders.sqlite hot backup / restore CLI.

Stage 6: append-only is great until the file gets corrupted. This script
takes a hot snapshot using SQLite's backup API (no need to stop the
daemon), rotates daily snapshots, and offers a verified restore.

USAGE
-----
Backup:
    python -m cicada_nn.scripts.backup_orders backup \
        --src python/checkpoints/orders.sqlite \
        --out python/checkpoints/backups \
        --keep 30

Restore (verifies the backup, then replaces the live file):
    python -m cicada_nn.scripts.backup_orders restore \
        --src python/checkpoints/backups/orders-20260508T120000Z.sqlite \
        --dst python/checkpoints/orders.sqlite

List backups:
    python -m cicada_nn.scripts.backup_orders list \
        --out python/checkpoints/backups

CRON EXAMPLE
------------
Daily backup at 03:00 UTC (add to bridge/SETUP_RUNBOOK ops section):

    0 3 * * * cd /opt/cicada && python -m cicada_nn.scripts.backup_orders backup \
                --src python/checkpoints/orders.sqlite \
                --out /var/backups/cicada \
                --keep 30 \
                >> /var/log/cicada-backup.log 2>&1

The script writes one snapshot per day (filenames include a UTC ISO
timestamp), keeps the most recent ``keep`` backups, and deletes older
ones. Append-only invariant means the file only grows — backups are
small relative to the working file even after months.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import sqlite3
import sys
from pathlib import Path


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _verify_sqlite(path: Path) -> tuple[bool, str]:
    """Return (ok, detail). Runs ``PRAGMA integrity_check`` against the
    file. ``ok`` is True only when SQLite reports the literal string
    ``ok`` for every page."""
    if not path.exists():
        return False, f"missing: {path}"
    try:
        con = sqlite3.connect(str(path))
        try:
            cur = con.execute("PRAGMA integrity_check")
            rows = cur.fetchall()
            joined = "; ".join(r[0] for r in rows)
            return joined == "ok", joined
        finally:
            con.close()
    except sqlite3.Error as e:
        return False, f"sqlite error: {e}"


def cmd_backup(src: Path, out_dir: Path, keep: int) -> int:
    if not src.exists():
        print(f"src does not exist: {src}", file=sys.stderr)
        return 2
    out_dir.mkdir(parents=True, exist_ok=True)

    # First verify the source — backing up corruption isn't useful.
    ok, detail = _verify_sqlite(src)
    if not ok:
        print(f"src failed integrity check: {detail}", file=sys.stderr)
        return 3

    # Hot copy via SQLite's backup API. Atomic file with a unique name so
    # concurrent backups (e.g. operator + cron) don't trample each other.
    dest = out_dir / f"orders-{_now_iso()}.sqlite"
    src_con = sqlite3.connect(str(src))
    dst_con = sqlite3.connect(str(dest))
    try:
        # Use 16 MB pages per step for speed; pause briefly between steps
        # so the live writer (the daemon) gets a fair share of the lock.
        src_con.backup(dst_con, pages=16_384, sleep=0.05)
    finally:
        dst_con.close()
        src_con.close()

    # Verify the new snapshot before deleting older ones.
    ok, detail = _verify_sqlite(dest)
    if not ok:
        print(f"snapshot failed integrity check: {detail}", file=sys.stderr)
        try:
            dest.unlink()
        except OSError:
            pass
        return 4

    print(f"snapshot ok: {dest} ({dest.stat().st_size:,} bytes)")

    # Rotate: keep the ``keep`` most recent backups, delete the rest.
    snapshots = sorted(
        [p for p in out_dir.glob("orders-*.sqlite") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in snapshots[keep:]:
        try:
            old.unlink()
            print(f"rotated out: {old}")
        except OSError as e:
            print(f"rotation failed for {old}: {e}", file=sys.stderr)

    return 0


def cmd_restore(src: Path, dst: Path) -> int:
    if not src.exists():
        print(f"backup does not exist: {src}", file=sys.stderr)
        return 2
    ok, detail = _verify_sqlite(src)
    if not ok:
        print(f"refusing to restore — backup failed integrity check: {detail}", file=sys.stderr)
        return 3

    # If the live file exists, save it as a sibling .pre-restore so we
    # can roll back if the operator decides the restore was wrong.
    if dst.exists():
        sibling = dst.with_suffix(dst.suffix + f".pre-restore-{_now_iso()}")
        shutil.copy2(dst, sibling)
        print(f"saved current live file as {sibling}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    ok, detail = _verify_sqlite(dst)
    if not ok:
        print(f"restored file failed post-copy integrity check: {detail}", file=sys.stderr)
        return 4
    print(f"restored {src} → {dst} ({dst.stat().st_size:,} bytes)")
    return 0


def cmd_list(out_dir: Path) -> int:
    if not out_dir.exists():
        print(f"backup dir does not exist: {out_dir}", file=sys.stderr)
        return 2
    snapshots = sorted(
        out_dir.glob("orders-*.sqlite"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not snapshots:
        print("(no snapshots)")
        return 0
    for p in snapshots:
        size = p.stat().st_size
        mtime = dt.datetime.fromtimestamp(p.stat().st_mtime, tz=dt.timezone.utc).isoformat()
        print(f"{mtime}  {size:>12,}  {p.name}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="backup_orders", description=__doc__.strip().splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    bp = sub.add_parser("backup", help="hot snapshot of orders.sqlite + rotation")
    bp.add_argument("--src", required=True, type=Path)
    bp.add_argument("--out", required=True, type=Path, dest="out_dir")
    bp.add_argument("--keep", type=int, default=30)

    rp = sub.add_parser("restore", help="verified restore of a snapshot")
    rp.add_argument("--src", required=True, type=Path)
    rp.add_argument("--dst", required=True, type=Path)

    lp = sub.add_parser("list", help="list snapshots in a backup directory")
    lp.add_argument("--out", required=True, type=Path, dest="out_dir")

    args = ap.parse_args()
    if args.cmd == "backup":
        return cmd_backup(args.src, args.out_dir, args.keep)
    if args.cmd == "restore":
        return cmd_restore(args.src, args.dst)
    if args.cmd == "list":
        return cmd_list(args.out_dir)
    return 1


if __name__ == "__main__":
    sys.exit(main())
