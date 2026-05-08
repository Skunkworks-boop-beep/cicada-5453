# MT5 Bridge — KVM Windows VM Setup Runbook

> One-time operator runbook for the spec's Execution Architecture
> (lines 894-1224). Sets up a Windows VM running MT5 + the FastAPI
> bridge so the Ubuntu trading host can talk to MT5 over HTTP.
>
> When this is done, `mt5_bridge.is_reachable()` returns `True` and the
> dashboard's `MT5 BRIDGE` pill flips to green.

## Prerequisites

- Ubuntu host with at least 8 GB RAM and 20 GB free disk.
- A Windows ISO (10 or 11). Activated or unactivated — both work; the
  VM is headless, so the watermark is irrelevant.
- A broker account (live or broker-side demo) with MT5 credentials.

## Step 1 — Install KVM/QEMU on the host

```bash
sudo apt update
sudo apt install qemu-kvm libvirt-dev libvirt-daemon-system virtinst virt-manager bridge-utils
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt $(whoami)
# Log out and back in for the group change to take effect.
```

Verify KVM is operational:

```bash
kvm-ok       # should print "KVM acceleration can be used"
virsh list   # should print an empty list (no error)
```

## Step 2 — Create the Windows VM

Launch `virt-manager` (GUI) or use `virt-install` (CLI):

```bash
virt-install \
  --name cicada-mt5 \
  --memory 4096 \
  --vcpus 2 \
  --disk size=60,format=qcow2 \
  --cdrom /path/to/Windows.iso \
  --os-variant win10 \
  --network bridge=virbr0 \
  --graphics spice
```

Defaults that matter:
- 4 GB RAM minimum (MT5 + Python is enough; bump if you need it).
- 60 GB disk (Windows + MT5 + a few months of tick parquet).
- `bridge=virbr0` — KVM's default virtual network. The VM gets an IP
  on `192.168.122.0/24`.

Walk through the Windows installer normally. **Do not skip the
networking step** — the VM needs internet to install MT5 + Python deps.

## Step 3 — Inside the VM: install MT5

1. Download the broker's MT5 installer from the broker's site (Exness,
   IC Markets, etc. — the broker's own MT5 build, not the generic
   MetaQuotes one, so symbols and connection routing are correct).
2. Install MT5 normally.
3. Log into your trading account inside MT5. Confirm:
   - Account number and server are correct.
   - Symbols you intend to trade are visible in Market Watch.
   - Tick volume is non-zero on those symbols (MT5 must have the
     market-data subscription active).

## Step 4 — Inside the VM: install Python + the bridge

Install Python 3.11 from python.org. Verify in `cmd`:

```cmd
python --version    REM should be 3.11.x
```

Install the bridge package:

```cmd
pip install MetaTrader5 fastapi uvicorn
```

Copy `bridge/server.py` (this directory) into the VM at e.g.
`C:\cicada\bridge\server.py`. You can use a shared folder, scp from
the host, or download via the VM's browser — pick whichever fits your
ops flow.

Test the server manually first:

```cmd
cd C:\cicada
python -m uvicorn bridge.server:app --host 0.0.0.0 --port 5000
```

From the Ubuntu host:

```bash
curl http://192.168.122.NN:5000/health   # NN = the VM's libvirt IP
```

Should return `{"status": "ok", "mt5_connected": true, "account": "..."}`.

## Step 5 — Auto-start the bridge on Windows boot

Windows Task Scheduler → Create Basic Task:

- **Name**: `cicada-mt5-bridge`
- **Trigger**: At log-on (or at startup if the broker's MT5 starts
  without an interactive login).
- **Action**: Start a program.
- **Program/script**: `C:\Python311\python.exe`
- **Add arguments**: `-m uvicorn bridge.server:app --host 0.0.0.0 --port 5000`
- **Start in**: `C:\cicada`
- Conditions tab: untick "Start the task only if the computer is on AC
  power" so a desktop without a UPS still auto-runs.
- Settings tab: tick "If the task is already running, do not start a
  new instance" so reboots don't double-spawn.

Reboot the VM. Verify on the host: `curl http://<VM-IP>:5000/health`.

## Step 6 — Networking: expose the bridge on host `localhost:5000`

Two options. Pick one.

**Option A — virbr0 + DNAT** (preferred, no SSH dependency):

```bash
# On the host, forward host:5000 -> VM:5000.
sudo iptables -t nat -A OUTPUT -d 127.0.0.1 -p tcp --dport 5000 \
    -j DNAT --to-destination 192.168.122.NN:5000
# (replace NN with the VM's libvirt IP from `virsh net-dhcp-leases default`)
```

**Option B — SSH port forward** (simpler, works without iptables):

Inside the VM, install OpenSSH server, then on the host:

```bash
ssh -fN -L 5000:localhost:5000 user@<VM-IP>
```

Verify:

```bash
curl http://localhost:5000/health
```

Either way, the Ubuntu trading code calls `localhost:5000` — it never
needs to know the VM's internal IP.

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

**Acceptable thresholds by mode** (spec lines 1505-1508):

| Mode | p95 RTT | Verdict |
|------|---------|---------|
| SCALP  | < 50ms   | Proceed. |
| SCALP  | 50-100ms | Borderline — consider a VPS near the broker for SCALP only. |
| SCALP  | > 100ms  | Don't trade SCALP from this host. SWING + SNIPER are fine. |
| SWING  | < 200ms  | No concern. |
| SNIPER | < 200ms  | No concern. |

Run the benchmark during your target trading session, not during
off-hours. Repeat it once a month.

## Step 8 — Verify from the trading host

On the Ubuntu host, with the FastAPI backend running:

```bash
curl http://localhost:8000/bridge/health
# {"reachable": true, "mt5_connected": true, "account": "12345678", "error": null}

curl http://localhost:8000/latency/status
# After ~5 minutes of monitor sampling:
# {"current_rtt_ms": 12.3, "baseline_p95_ms": 18.1, "baseline_valid": true, ...}
```

Open the dashboard at `http://localhost:5173`, log in with your MT5
credentials. The `MT5 BRIDGE` pill in `BrokersManager` should be green;
the `ProcessMonitor` latency strip should show non-null RTT and
session-aware p95.

## Maintenance

- **Restart the VM monthly** to pick up Windows Update + MT5 patches.
- **Re-run Step 7 (RTT benchmark) after every broker server change** —
  routing changes can move latency 50ms in either direction.
- **Watch `GET /reconcile/status`** on the dashboard — discrepancies
  here are the canary for "something opened a position outside our
  system" or "the broker closed a position without notifying us".

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `BRIDGE UNREACHABLE` pill on dashboard | VM down / firewall / port forward broken | Verify `curl localhost:5000/health` from host. If empty, VM is unreachable; if 200 but pill still red, restart the FastAPI backend. |
| `MT5 OFFLINE INSIDE VM` pill | MT5 inside VM is closed or not logged in | RDP / VNC into the VM, check MT5 is running and logged in. |
| Reconciler keeps logging `GHOST` discrepancies | Someone is opening positions in MT5 manually, or another client (e.g. an EA) is talking to the same account | Either stop the manual / EA activity, or accept the ghosts and adjust your reconciler thresholds. |
| Latency monitor stays `BASELINE_NOT_ESTABLISHED` past 10 minutes | Bridge is reachable but the monitor isn't running | Check the backend logs for `latency_monitor not started` — if `CICADA_LATENCY_MONITOR=0` is set, unset it. |
| RTT spikes during London/NY overlap | Normal — spec lines 1322-1324 call this out. The latency model already segments SCALP gates by session. | If sustained > 200ms on SCALP, consider a VPS. |
