#!/usr/bin/env bash
# Host-side VM watchdog — hard-resets the VirtualBox VM when the bridge
# inside it stops responding for too long.
#
# Complements bridge/watchdog.py which restarts uvicorn from inside the
# guest — that one is useless when the guest OS itself is hung (kernel
# stall, frozen Defender scan, MT5 COM deadlock under sustained load).
# This script runs on the Ubuntu host, polls /health, and yanks the VM
# via `VBoxManage controlvm reset` if it doesn't recover.
#
# Why "reset" and not "poweroff + start": reset is equivalent to a hardware
# reset button — Windows boots fresh. poweroff + start adds ~5s of
# orchestration delay we don't need; recovery should be as fast as possible
# because the daemon's reconciler will start seeing "BRIDGE UNREACHABLE"
# within seconds.
#
# Run as a systemd --user service so it survives login (see comments at
# bottom for the unit file).
#
# Configurable via env vars; defaults match this deployment:
#   VM_UUID                — the VirtualBox VM UUID (default: V10 setup)
#   BRIDGE_HEALTH_URL      — http URL to poll (default: http://localhost:5000/health)
#   POLL_INTERVAL_S        — seconds between probes (default: 15)
#   FAILURE_THRESHOLD      — consecutive misses before reset (default: 4 → ~60s)
#   COOLDOWN_AFTER_RESET_S — wait after reset before resuming polls (default: 120)
#   LOG                    — log file (default: /tmp/cicada-vm-watchdog.log)

set -u

VM_UUID="${VM_UUID:-5319a60f-6ab8-41a3-a0ba-ee9159193113}"
BRIDGE_HEALTH_URL="${BRIDGE_HEALTH_URL:-http://localhost:5000/health}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-15}"
FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-4}"
COOLDOWN_AFTER_RESET_S="${COOLDOWN_AFTER_RESET_S:-120}"
LOG="${LOG:-/tmp/cicada-vm-watchdog.log}"

log() {
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "[$ts] $*" | tee -a "$LOG"
}

probe() {
  # 200 + status:"ok" → alive.  Anything else (timeout, non-200, empty) → dead.
  local body
  body="$(curl -sS -m 5 "$BRIDGE_HEALTH_URL" 2>/dev/null)" || return 1
  echo "$body" | grep -q '"status":"ok"'
}

reset_vm() {
  log "RESET: $FAILURE_THRESHOLD consecutive misses; VBoxManage controlvm $VM_UUID reset"
  if VBoxManage controlvm "$VM_UUID" reset 2>>"$LOG"; then
    log "RESET: issued; cooldown ${COOLDOWN_AFTER_RESET_S}s while VM boots"
    sleep "$COOLDOWN_AFTER_RESET_S"
  else
    log "RESET: VBoxManage failed — VM may already be off; trying startvm"
    VBoxManage startvm "$VM_UUID" --type headless 2>>"$LOG" || true
    sleep "$COOLDOWN_AFTER_RESET_S"
  fi
}

log "watchdog start: vm=$VM_UUID url=$BRIDGE_HEALTH_URL poll=${POLL_INTERVAL_S}s threshold=$FAILURE_THRESHOLD cooldown=${COOLDOWN_AFTER_RESET_S}s"

consecutive_misses=0
while true; do
  if probe; then
    if [ "$consecutive_misses" -gt 0 ]; then
      log "RECOVERED: bridge responded after $consecutive_misses miss(es)"
    fi
    consecutive_misses=0
  else
    consecutive_misses=$((consecutive_misses + 1))
    log "MISS: $consecutive_misses/$FAILURE_THRESHOLD"
    if [ "$consecutive_misses" -ge "$FAILURE_THRESHOLD" ]; then
      reset_vm
      consecutive_misses=0
    fi
  fi
  sleep "$POLL_INTERVAL_S"
done

# ──────────────────────────────────────────────────────────────────────────────
# Install as a systemd --user service so it auto-starts on login and the
# user doesn't need a shell open:
#
#   cat > ~/.config/systemd/user/cicada-vm-watchdog.service <<EOF
#   [Unit]
#   Description=Cicada VM watchdog (host-side bridge reset on hang)
#   After=default.target
#
#   [Service]
#   ExecStart=%h/Projects/cicada-5453/scripts/vm_watchdog.sh
#   Restart=on-failure
#   RestartSec=10
#
#   [Install]
#   WantedBy=default.target
#   EOF
#   systemctl --user daemon-reload
#   systemctl --user enable --now cicada-vm-watchdog.service
#   journalctl --user -u cicada-vm-watchdog -f   # tail
# ──────────────────────────────────────────────────────────────────────────────
