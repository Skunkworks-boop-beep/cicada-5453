# MT5 Bridge — KVM Windows VM Setup Runbook

> One-time operator runbook for the spec's Execution Architecture
> (lines 894-1224). Sets up a Windows VM running MT5 + the FastAPI
> bridge so the Ubuntu trading host can talk to MT5 over HTTP.
>
> When this is done, `mt5_bridge.is_reachable()` returns `True` and the
> dashboard's `MT5 BRIDGE` pill flips to green.

---

## Architecture at a glance

```
┌──────────────────────────── Ubuntu host ─────────────────────────────┐
│                                                                      │
│   React (vite, :5173) ──► FastAPI (uvicorn, :8000) ──► mt5_bridge.py │
│                                                              │       │
│                                                              ▼       │
│                                              http://localhost:5000   │
└──────────────────────────────────────┬───────────────────────────────┘
                                       │ DNAT or ssh -L
                                       ▼
┌────────────────────── KVM Windows VM (libvirt) ──────────────────────┐
│                                                                      │
│   Task Scheduler / NSSM ──► uvicorn (bridge.server, :5000)           │
│                                       │                              │
│                                       ▼                              │
│                              MetaTrader5 Python ──► MT5 terminal     │
│                                                          │           │
│                                                          ▼           │
│                                              broker servers (Equinix │
│                                              LD4, NY4, etc.)         │
└──────────────────────────────────────────────────────────────────────┘
```

The bridge is the **only** process that imports `MetaTrader5`. The
Ubuntu trading code never sees that package — it only knows how to
HTTP-call `localhost:5000`. This isolation is enforced by
`python/tests/test_mt5_abstraction.py`.

---

## Prerequisites

- Ubuntu host with at least 16 GB RAM, 4 cores, 40 GB free disk
  (the VM eats 4 GB / 2 cores / 60 GB; the rest is for backtest +
  Parquet history).
- A Windows ISO (10 22H2 or 11 23H2). Activated or unactivated — both
  work; the VM is headless, so the watermark is irrelevant.
- A broker account (live or broker-side demo) with MT5 credentials.
  **Use the broker's MT5 build, not the generic MetaQuotes one** —
  symbols, trading hours, and routing are broker-specific.
- An hour of operator time. Most of it is waiting on Windows.

---

## Step 1 — Install KVM/QEMU on the host

```bash
sudo apt update
sudo apt install qemu-kvm libvirt-dev libvirt-daemon-system \
                 virtinst virt-manager bridge-utils
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt $(whoami)
# Log out and back in for the group change to take effect.
```

Verify KVM is operational:

```bash
kvm-ok       # should print "KVM acceleration can be used"
virsh list   # should print an empty list (no error)
```

If `kvm-ok` reports "KVM acceleration can NOT be used", check that
virtualisation is enabled in BIOS (Intel VT-x / AMD-V).

---

## Step 2 — Create the Windows VM

```bash
virt-install \
  --name cicada-mt5 \
  --memory 4096 \
  --vcpus 2,sockets=1,cores=2 \
  --cpu host-passthrough \
  --disk size=60,format=qcow2,bus=virtio,cache=none,io=threads \
  --cdrom /path/to/Windows.iso \
  --os-variant win10 \
  --network bridge=virbr0,model=virtio \
  --graphics spice \
  --boot uefi
```

Sizing notes:
- **4 GB RAM** is enough for MT5 + Python; bump to 6 GB if you run
  multiple MT5 terminals (multi-account).
- **2 vCPUs** with `host-passthrough` is fastest. Don't allocate
  all your host's cores to the VM — the trading code on the host
  competes for them.
- **60 GB qcow2** with `cache=none,io=threads` keeps random IO fast
  for tick logs.
- **virtio drivers** (`virtio-win` ISO from Fedora) cut disk + network
  latency by ~3x over emulated. Install them after Windows is up:
  ```bash
  sudo apt install virtio-win   # or download virtio-win.iso manually
  virsh attach-disk cicada-mt5 /usr/share/virtio-win/virtio-win.iso \
        sda --type cdrom --mode readonly
  ```

Walk through the Windows installer normally. **Do not skip the
networking step** — the VM needs internet to install MT5 + Python.

After install, inside Windows:
- Disable Windows Update auto-restart (Settings → Update → Advanced
  → "Pause updates" or use Group Policy "No auto-restart with logged
  on users"). A reboot during a trading session kills the bridge.
- Disable Windows Defender real-time scans on `C:\cicada\` and the
  MT5 install path — it adds 100-300ms per file write.
- Set the Power plan to "High performance" so the CPU doesn't park
  during low-tick periods.

---

## Step 3 — Inside the VM: install MT5

1. Download the broker's MT5 installer **from the broker's site**
   (Exness, IC Markets, Pepperstone, Deriv MT5, etc.). The generic
   MetaQuotes build doesn't know your broker's symbols.
2. Install MT5 normally.
3. Log into your trading account inside MT5. Confirm:
   - Account number and server are correct.
   - Symbols you intend to trade are visible in **Market Watch**
     (right-click → "Show All" if not).
   - Tick volume is non-zero on those symbols (MT5 needs the
     market-data subscription active for the broker).
   - **For synthetic indices** (Volatility/Boom/Crash etc., e.g. Deriv
     MT5): symbol names contain spaces ("Volatility 10 Index", "Boom
     1000 Index"). The bridge URL-encodes these correctly; verify by
     browsing to `http://<VM-IP>:5000/ticks?symbol=Volatility%2010%20Index&from_ts=…`
     after Step 4.
4. Open `Tools → Options → Expert Advisors` and tick:
   - "Allow algorithmic trading"
   - "Allow DLL imports" (the Python integration uses one)
5. **Verify clock sync.** MT5 timestamps are server time. If the VM's
   clock drifts more than a few seconds, every order record's
   `execution_delta_ms` is corrupt. Enable Windows Time service:
   ```cmd
   w32tm /config /manualpeerlist:"time.windows.com" /syncfromflags:manual /update
   net stop w32time && net start w32time
   w32tm /resync
   ```

---

## Step 4 — Inside the VM: install Python + the bridge

Install Python 3.11 from python.org (use the all-users installer; tick
"Add to PATH"). Verify:

```cmd
python --version    REM should be 3.11.x
```

Install the bridge dependencies. Pin versions so a future point-release
doesn't break ordering semantics:

```cmd
pip install "MetaTrader5==5.0.45" "fastapi==0.115.0" "uvicorn[standard]==0.32.0"
```

Copy the repo's `bridge/` directory into the VM at `C:\cicada\bridge\`.
Three options:

- **Shared folder** (`virtio-9p` from libvirt) — fastest, lets you
  iterate without copying.
- **scp** from the Ubuntu host (after installing OpenSSH server in the
  VM — see Step 6 Option B).
- **Download + unzip** via the VM's browser from the repo's web view.

Test the server manually first:

```cmd
cd C:\cicada
python -m uvicorn bridge.server:app --host 0.0.0.0 --port 5000
```

From the Ubuntu host:

```bash
curl http://192.168.122.NN:5000/health   # NN = the VM's libvirt IP
```

Should return `{"status":"ok","mt5_connected":true,"account":"…"}`.

If `mt5_connected` is `false`, check the bridge logs in the VM
console — usually means MT5 isn't running or isn't logged in.

---

## Step 5 — Run the bridge as a Windows service (NSSM)

Task Scheduler works but doesn't restart on crash. Use **NSSM** instead
— it wraps the bridge as a real Windows service.

1. Download NSSM from <https://nssm.cc/download> (extract the 64-bit
   `nssm.exe` to `C:\Windows\System32\` or `C:\nssm\`).
2. From an **elevated** `cmd`:
   ```cmd
   nssm install CicadaMt5Bridge "C:\Python311\python.exe"
   ```
3. NSSM opens a GUI. Fill in:
   - **Path**: `C:\Python311\python.exe`
   - **Startup directory**: `C:\cicada`
   - **Arguments**: `-m uvicorn bridge.server:app --host 0.0.0.0 --port 5000`
   - **Details tab → Display name**: `Cicada MT5 Bridge`
   - **Log on tab**: tick "This account" and use the same Windows
     user that's logged into MT5 (the Python `MetaTrader5` package
     attaches to MT5 via the running terminal, which lives in that
     user's session).
   - **I/O tab**: redirect stdout / stderr to e.g.
     `C:\cicada\logs\bridge.out.log` / `bridge.err.log`. Tick
     "Rotate files" → 10 MB.
   - **Exit actions tab**: Restart action = "Restart application",
     Delay restart by = 5000 ms, Throttle restarts faster than = 60
     seconds. This handles transient crashes without a tight loop.
4. Click **Install service**, then start it:
   ```cmd
   nssm start CicadaMt5Bridge
   sc query CicadaMt5Bridge        REM should show STATE: 4 RUNNING
   ```
5. Reboot the VM. After login completes (MT5 must be running for
   the bridge to find a connected terminal), the service auto-starts.
   Verify from the host: `curl http://<VM-IP>:5000/health`.

If you'd rather use Task Scheduler, the legacy recipe is in
[Appendix A](#appendix-a--task-scheduler-fallback).

---

## Step 6 — Networking: expose the bridge on host `localhost:5000`

Pick one of two options. **Both keep the bridge unreachable from the
public internet** — only the Ubuntu host can talk to it.

### Option A — virbr0 + DNAT (preferred, no SSH dependency)

```bash
# Find the VM's libvirt IP:
virsh net-dhcp-leases default
# example output: ipv4 192.168.122.137/24

# Forward host:5000 -> VM:5000.
VM_IP=192.168.122.137
sudo iptables -t nat -A OUTPUT -d 127.0.0.1 -p tcp --dport 5000 \
    -j DNAT --to-destination $VM_IP:5000

# Make it persistent:
sudo apt install iptables-persistent
sudo netfilter-persistent save
```

### Option B — SSH port forward (simpler, no iptables)

In the VM, install OpenSSH server (Optional Features → Add a feature
→ OpenSSH Server). On the Ubuntu host:

```bash
# Generate a host-only keypair if you don't have one:
ssh-keygen -t ed25519 -f ~/.ssh/cicada_vm -N ''
ssh-copy-id -i ~/.ssh/cicada_vm.pub user@$VM_IP

# Start the tunnel as a systemd unit so it auto-restarts:
cat > ~/.config/systemd/user/cicada-bridge-tunnel.service <<EOF
[Unit]
Description=SSH tunnel to MT5 bridge
After=network.target

[Service]
ExecStart=/usr/bin/ssh -N -L 5000:localhost:5000 \\
  -i %h/.ssh/cicada_vm \\
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \\
  user@${VM_IP}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now cicada-bridge-tunnel
```

### Verify either option

```bash
curl http://localhost:5000/health
# {"status":"ok","mt5_connected":true,"account":"…"}
```

Either way, the Ubuntu trading code calls `localhost:5000` — it never
needs to know the VM's internal IP.

### Security boundary

- **Do NOT** add a `--network bridge=br0` or expose port 5000 to your
  LAN — the bridge has no auth and ships plaintext credentials. It is
  designed to be reachable **only** from the Ubuntu host.
- If you need remote operator access, SSH into the Ubuntu host and
  use the `localhost:5000` forward — never expose the VM's IP outside
  the host.
- `/login` accepts MT5 credentials in clear over HTTP. This is
  acceptable inside `localhost`; never run this bridge over an
  untrusted network without TLS + auth.

---

## Step 7 — Benchmark RTT before going live on SCALP

From the Ubuntu host (bridge running):

```bash
for i in $(seq 1 100); do
  curl -o /dev/null -s -w "%{time_total}\n" \
    -X GET localhost:5000/health
done | awk '{sum+=$1; count++; if ($1>max) max=$1; samples[count]=$1}
            END {
              n=asort(samples); printf "p50: %.2fms  p95: %.2fms  max: %.2fms\n",
                samples[int(n*0.5)]*1000, samples[int(n*0.95)]*1000, max*1000
            }'
```

Acceptable thresholds by trade mode (spec lines 1505-1508):

| Mode | p95 RTT | Verdict |
|------|---------|---------|
| SCALP  | < 50ms   | Proceed. |
| SCALP  | 50-100ms | Borderline — consider a VPS near the broker for SCALP only. |
| SCALP  | > 100ms  | Don't trade SCALP from this host. SWING + SNIPER are fine. |
| DAY    | < 100ms  | No concern. |
| SWING  | < 200ms  | No concern. |
| SNIPER | < 200ms  | No concern. |

Run the benchmark **during your target trading session**, not during
off-hours. RTT during the LONDON_NY_OVERLAP can be 3-5x off-hours
baseline; the latency model already segments SCALP gates by session,
but you want to know the real numbers before placing a SCALP bot.

Repeat the benchmark once a month and after any broker server change.

---

## Step 8 — Verify from the trading host

On the Ubuntu host, with the FastAPI backend running:

```bash
curl http://localhost:8000/bridge/health
# {"reachable":true,"mt5_connected":true,"account":"12345678","error":null}

curl http://localhost:8000/latency/status
# After ~5 minutes of monitor sampling:
# {"current_rtt_ms":12.3,"baseline_p95_ms":18.1,"baseline_valid":true,…}

curl "http://localhost:8000/mt5/ohlc?symbol=EURUSD&timeframe=M1&limit=10"
# 10 OHLC bars with non-null open/high/low/close
```

For synthetic indices, URL-encode the spaces:

```bash
curl "http://localhost:8000/mt5/ohlc?symbol=Volatility%2010%20Index&timeframe=M1&limit=10"
```

Open the dashboard at `http://localhost:5173`, log in with your MT5
credentials. The `MT5 BRIDGE` pill in `BrokersManager` should be
green; `ProcessMonitor`'s latency strip should show non-null RTT and
session-aware p95.

---

## Maintenance

- **Restart the VM monthly** to pick up Windows Update + MT5 patches.
  Schedule it for the weekend (markets closed).
- **Re-run Step 7 (RTT benchmark) after every broker server change** —
  routing changes can move latency 50ms in either direction.
- **Snapshot the qcow2 disk weekly**:
  ```bash
  virsh snapshot-create-as --domain cicada-mt5 \
    --name "$(date +%F)" --description "weekly snapshot"
  virsh snapshot-list cicada-mt5
  ```
  This lets you roll back from a bad Windows update without
  reinstalling MT5.
- **Pin Python deps**. The `pip install "MetaTrader5==5.0.45"` in
  Step 4 isn't decoration — MetaQuotes ships breaking changes in
  point releases. Bump only after testing on a snapshot.
- **Watch `GET /reconcile/status`** on the dashboard. Discrepancies
  here are the canary for "something opened a position outside our
  system" or "the broker closed a position without notifying us".
- **Rotate the bridge log** (NSSM does this if you ticked the box in
  Step 5; otherwise add a scheduled task to truncate
  `C:\cicada\logs\*.log` weekly).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `BRIDGE UNREACHABLE` pill on dashboard | VM down, port-forward broken, or NSSM service crashed | `curl localhost:5000/health` from the host. If empty: VM is unreachable (check `virsh list`, restart the tunnel). If 200 but pill still red: restart the FastAPI backend. |
| `MT5 OFFLINE INSIDE VM` pill | MT5 inside the VM is closed or not logged in | RDP / VNC into the VM, restart MT5, verify it's logged in. The bridge cannot launch MT5 — it can only attach to a running terminal. |
| Reconciler keeps logging `GHOST` discrepancies | Someone is opening positions in MT5 manually, or another EA is talking to the same account | Either stop the manual / EA activity, or accept the ghosts and adjust your reconciler thresholds. |
| Latency monitor stays `BASELINE_NOT_ESTABLISHED` past 10 minutes | Bridge is reachable but the monitor isn't running | Backend logs should say `latency_monitor not started` if `CICADA_LATENCY_MONITOR=0`. Unset and restart uvicorn. |
| RTT spikes during London/NY overlap | Normal — spec lines 1322-1324 call this out | The latency model already segments SCALP gates by session. If sustained > 200ms on SCALP, consider a VPS. |
| Synthetic symbols return 500 from `/ticks` | Symbol name has spaces and was passed unencoded | The repo's `mt5_bridge.get_ticks` URL-encodes — check there's no in-flight client bypassing it. Tested in `python/tests/test_mt5_bridge.py`. |
| `pip install MetaTrader5` fails on Linux/macOS | MetaTrader5 is Windows-only | Correct — that's why the bridge runs in the VM. The `bridge/dev_stub.py` provides a Linux-runnable fake for UI work. |
| All orders rejected with `BASELINE_NOT_ESTABLISHED` | Bridge unreachable or monitor hasn't sampled enough yet | Wait 5-10 minutes after first launch. Check `/latency/status`. |
| Bridge service crashes on startup, log says "MT5 init failed" | NSSM is running as the wrong user; the MT5 terminal is in a different user's session | NSSM tab → "Log on" → set to the same user that's logged into MT5. |
| `execution_delta_ms` consistently negative | Clock skew between VM and broker server | Re-run the `w32tm` sync from Step 3 step 5. If it persists, install `w32tm /config /manualpeerlist:` pointing at the broker's NTP server. |
| VM eats 100% host CPU | Likely a runaway in MT5 (charts open with heavy indicators) | Close all MT5 charts; bridge does not need any chart open. Drop chart count to zero. |

---

## Disaster recovery

- **Bridge dies during trading**: the daemon's drift monitor sees
  `BRIDGE UNREACHABLE` and refuses new orders within one tick.
  Existing positions stay open — the broker's server-side SL/TP is
  still in force (this is the whole reason we register hard SLs
  with the broker, per spec Section 8).
- **VM disk corrupts**: roll back to the most recent
  `virsh snapshot-revert` taken in maintenance.
- **Broker changes account / server**: re-run Step 3 (re-login MT5
  inside the VM), then `POST /login` from the host with the new
  credentials. No service restart needed.
- **Operator forgets MT5 password**: the bridge cannot recover this
  — reset via the broker's web portal, then update through the
  dashboard's `BrokersManager` (which calls `/login`).

---

## Appendix A — Task Scheduler fallback

If you can't or won't install NSSM, Windows Task Scheduler works for
basic auto-start (no crash-restart):

- **Create Basic Task**, name `cicada-mt5-bridge`.
- **Trigger**: At log-on (or At startup if MT5 starts headlessly).
- **Action**: Start a program.
- **Program/script**: `C:\Python311\python.exe`
- **Add arguments**: `-m uvicorn bridge.server:app --host 0.0.0.0 --port 5000`
- **Start in**: `C:\cicada`
- **Conditions** tab: untick "Start the task only if the computer is on
  AC power".
- **Settings** tab: tick "If the task is already running, do not start
  a new instance"; set "If the task fails, restart every: 1 minute /
  attempt to restart up to: 99".

Reboot the VM. Verify on the host: `curl http://<VM-IP>:5000/health`.

---

## Appendix B — Going from dev-stub to real bridge

For development without a VM, the repo ships
`python -m bridge.dev_stub --port 5000`. It provides the same HTTP
surface as the real bridge but with synthetic ticks + fake fills.

To migrate to the real VM:

1. Stop the dev-stub: `pkill -f bridge.dev_stub`.
2. Bring up the VM (Steps 1-7 above).
3. The Ubuntu host's `mt5_bridge.is_reachable()` switches from "stub
   ok" to "real ok" with no code change — the URL is identical.
4. Live trades now hit your broker. **Stop here and verify on a demo
   account first.**

The end-to-end Playwright suite (`e2e/*.spec.ts`) targets the dev-stub
on purpose so it stays runnable in CI. The real-VM equivalent is the
`Step 7 / Step 8` benchmarks in this runbook.
