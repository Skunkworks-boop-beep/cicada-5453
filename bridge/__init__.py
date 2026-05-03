"""CICADA-5453 MT5 bridge.

Lives inside the Windows VM. The Ubuntu trading system never imports anything
from this package — it talks to ``server.py`` over HTTP at ``localhost:5000``.
This is the ONE place in the repo where ``import MetaTrader5`` is allowed.
"""
