# Running the app on a more powerful computer (SSH tunnel)

You can run the frontend and backend on a **remote machine** (e.g. a desktop or server) and use the app from your laptop via an **SSH tunnel**.

- **Bot training (NN)** always runs on the **backend**. When you use the remote and the backend is there, Rebuild/Build already offloads training to the server.
- **Backtest** runs in the **browser**. So for true CPU offload of backtest you run the app on the remote and open it in a browser **on the remote** (e.g. via VNC/remote desktop). If you only use the tunnel from your laptop, the browser runs locally and backtest uses your laptop’s CPU.

Two ways to automate the connection: **Node launcher** (username, IP, password) or **shell script** (SSH keys or sshpass).

---

## One-command setup (push code + install deps)

**Full guide:** [SETUP_REMOTE.md](SETUP_REMOTE.md) — SSH keys, ssh-add, troubleshooting.

From your **local** machine, push the codebase to the server and install dependencies (no git required):

```bash
REMOTE_USER=user REMOTE_HOST=192.168.1.10 REMOTE_PASSWORD=secret npm run setup-remote
```

Or run the script directly (prompts for credentials if not set):

```bash
./scripts/setup-remote.sh
```

**Optional env vars:** `REMOTE_PORT` (default 22), `REMOTE_PATH` (default `cicada-5453`).  
**Note:** For password auth, install `sshpass` (e.g. `brew install sshpass` on macOS). Or use SSH keys (`ssh-copy-id user@host`).

---

## Prerequisites on the remote machine

1. **Get the code** — either run `npm run setup-remote` from your local machine (above), or **clone the repo** and install dependencies:
   ```bash
   git clone <repo-url> cicada-5453   # or copy the project
   cd cicada-5453
   npm install
   cd python && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt && cd ..
   ```
2. **Start the app on the remote** (in two terminals, or in background):
   ```bash
   # Terminal 1
   npm run dev
   # Terminal 2
   cd python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000
   ```
   Leave these running. The tunnel will forward your local 5173 and 8000 to the remote’s 5173 and 8000.

---

## Option 1: Node launcher (username, IP, password)

On your **local** machine (laptop):

1. Install dependencies once (includes `ssh2`):
   ```bash
   npm install
   ```
2. Set **username**, **IP address**, and **password** (or leave password empty to use SSH keys via your SSH agent — same as terminal `ssh`), then run:
   ```bash
   REMOTE_USER=myuser REMOTE_HOST=192.168.1.10 REMOTE_PASSWORD=mypass npm run remote
   ```
   Or run without env and you’ll be prompted:
   ```bash
   npm run remote
   ```
   You’ll be asked for: Remote username, Remote host (IP or hostname), Password (leave empty for SSH key).

3. The script will:
   - Connect over SSH using the credentials you provided.
   - Forward **localhost:5173** → remote:5173 and **localhost:8000** → remote:8000.
   - Open your browser to `http://localhost:5173`.

4. Use the app as usual. When you’re done, press **Ctrl+C** in the terminal to close the tunnel.

**Optional env vars:**

| Variable           | Meaning |
|--------------------|--------|
| `REMOTE_USER`      | SSH username on the remote. |
| `REMOTE_HOST`      | Remote IP or hostname. |
| `REMOTE_PASSWORD`  | SSH password (omit to use SSH keys via agent — same as terminal). |
| `REMOTE_PORT`      | SSH port (default `22`). |
| `REMOTE_APP_PATH`  | Path to the app on the remote (used only if `REMOTE_START=1`). |
| `REMOTE_START`     | Set to `1` to try starting the app on the remote (optional; you can start it yourself). |

---

## Option 2: Shell script (SSH keys or sshpass)

On your **local** machine:

1. **Using SSH keys (recommended):** Copy your key to the remote once:
   ```bash
   ssh-copy-id user@192.168.1.10
   ```
   Then run:
   ```bash
   REMOTE_USER=user REMOTE_HOST=192.168.1.10 ./scripts/remote-connect.sh
   ```
   No password needed each time.

2. **Using password:** Install `sshpass` (e.g. `brew install sshpass` on macOS, `apt install sshpass` on Linux), then:
   ```bash
   REMOTE_USER=user REMOTE_HOST=192.168.1.10 REMOTE_PASSWORD=secret ./scripts/remote-connect.sh
   ```

3. The script forwards ports 5173 and 8000 and opens the browser. **Start the app on the remote** (npm run dev and uvicorn) before or in another SSH session. Press **Ctrl+C** to stop the tunnel.

Make the script executable once: `chmod +x scripts/remote-connect.sh`.

---

## Summary

| Goal                         | What to do |
|-----------------------------|------------|
| **Only input username, IP, password** | Use **Option 1**: `REMOTE_USER=... REMOTE_HOST=... REMOTE_PASSWORD=... npm run remote`. |
| **No Node, use SSH only**   | Use **Option 2**: set `REMOTE_USER` and `REMOTE_HOST`, use keys or `sshpass` for password, run `./scripts/remote-connect.sh`. |
| **Offload heavy work**      | Run the app on the powerful machine and connect with the tunnel. **Note:** The backtest runs in your local browser’s JavaScript. To use the remote CPU for backtest, open the app in a browser **on the remote** (e.g. VNC/remote desktop) so the whole UI runs there. |

After the tunnel is up, open **http://localhost:5173** (or let the script open it). The app and API are served from the remote; the tunnel just forwards traffic.
