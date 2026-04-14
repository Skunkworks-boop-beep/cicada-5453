# App can't connect to server — troubleshooting

When the app runs on your Mac and you try to connect to a remote server, it may fail. Here's what to check.

---

## Two ways to use a remote server

### Option A: SSH tunnel (recommended)

1. Run `npm run remote` from your Mac:
   ```bash
   REMOTE_USER=skunkworks REMOTE_HOST=192.168.0.101 npm run remote
   ```
2. The tunnel forwards `localhost:5173` and `localhost:8000` to the server.
3. Open the app at `http://localhost:5173`.
4. **Do not** set a Server Offload URL in the app — leave it empty. The app uses `localhost:8000` by default, which goes through the tunnel to the server.

### Option B: Direct connection (Server Offload panel)

1. Enter the server IP (e.g. `192.168.0.101`) and port `8000` in the Server Offload panel.
2. Click "Connect to server".
3. The app makes direct HTTP requests to `http://192.168.0.101:8000`.

---

## If direct connection fails (Option B)

### 1. Backend must listen on all interfaces

On the server, the backend must accept connections from other machines:

```bash
uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000
```

**Not** `--host 127.0.0.1` — that only accepts local connections.

### 2. Firewall

Ensure port 8000 is open on the server:

**Ubuntu/Debian:**
```bash
sudo ufw allow 8000
sudo ufw status
```

**macOS:** System Preferences → Security & Privacy → Firewall → Options.

### 3. Same network

Your Mac and server must be on the same network (e.g. both on 192.168.0.x). Test from your Mac:

```bash
curl http://192.168.0.101:8000/health
```

If this fails, the server is unreachable from your Mac.

### 4. Server Offload panel

- Enter only the IP (e.g. `192.168.0.101`) and port `8000`.
- Username and password are optional (Basic auth; the backend doesn't use them by default).

---

## If SSH tunnel fails (Option A)

- Port 8000 or 5173 may already be in use on your Mac. Stop the process using that port, or use `REMOTE_LOCAL_BACKEND_PORT=8001` to use a different local port.
- See [SETUP_REMOTE.md](SETUP_REMOTE.md) for SSH key setup.

---

## Quick check

From your Mac:

```bash
# Can you reach the server?
ping 192.168.0.101

# If the backend is running and reachable:
curl http://192.168.0.101:8000/health
```

If `curl` succeeds but the app fails, check the browser console (F12 → Network) for CORS or other errors.
