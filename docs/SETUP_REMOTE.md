# Remote server setup guide

Push the codebase to a remote machine and run the app there. No git required.

---

## Prerequisites on the server

Before running `npm run setup-remote`, the server must have:

- **Node.js** 20+ and npm (18 works but react-router prefers 20)
- **Python** 3.10+ with venv support

**Debian/Ubuntu:** Install the Python venv package:
```bash
sudo apt install python3-venv
# or for Python 3.12: sudo apt install python3.12-venv
```

If you use **nvm** (Node Version Manager), ensure it’s loaded in your shell profile (`.bashrc`, `.profile`). The setup script uses a login shell so nvm is available.

---

## Do this first: SSH key setup (recommended)

**Set up SSH keys before running `setup-remote`** so you are not prompted for a password every time.

### 1. Copy your SSH key to the server (one-time)

```bash
ssh-copy-id user@192.168.0.101
```

Enter your SSH password **once**. After this, you won’t need the password for SSH.

If you see “All keys were skipped because they already exist” — your key is already installed; skip to step 3.

### 2. One-time: add your key to the agent (if it has a passphrase)

If your SSH key has a passphrase, add it to the agent so you’re not prompted repeatedly:

```bash
ssh-add ~/.ssh/id_ed25519
```

Enter your passphrase once. The agent will remember it for this session.

### 3. Run setup without password prompts

```bash
REMOTE_USER=user REMOTE_HOST=192.168.0.101 npm run setup-remote
```

When prompted for a password, **leave it empty** (press Enter). The script will use your SSH key from the agent.

---

## If you don't have an SSH key yet

```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

Press Enter to accept the default path. Optionally set a passphrase. Then run step 1 above.

---

## Prerequisites on the server

Before running `npm run setup-remote`, the server must have:

- **Node.js** 20+ and npm (18 works but react-router prefers 20)
- **Python** 3.10+ with venv support

**Debian/Ubuntu:** `sudo apt install python3-venv` (or `python3.12-venv` for Python 3.12).  
If using **nvm**, ensure it's in `.bashrc` / `.profile`. See [troubleshooting](#troubleshooting) for Node.js install.

---

## Start the app on the server

SSH into the server and run in two terminals:

```bash
# Terminal 1 — frontend
ssh user@192.168.0.101
cd cicada-5453 && npm run dev

# Terminal 2 — backend
ssh user@192.168.0.101
cd cicada-5453/python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000
```

### 4. Connect from your Mac

```bash
REMOTE_USER=user REMOTE_HOST=192.168.0.101 npm run remote
```

Browser opens to `http://localhost:5173` — you’re using the app on the remote server.

---

## Password auth (no SSH keys)

If you prefer password auth:

### 1. Install sshpass

```bash
brew install sshpass   # macOS
```

### 2. Run setup with password

```bash
REMOTE_USER=user REMOTE_HOST=192.168.0.101 REMOTE_PASSWORD=yourpassword npm run setup-remote
```

**Note:** Passwords with special characters (`()/\` etc.) can cause issues. SSH keys are more reliable.

---

## Environment variables

| Variable         | Default       | Description                    |
|------------------|---------------|--------------------------------|
| `REMOTE_USER`    | (prompted)    | SSH username on the server     |
| `REMOTE_HOST`    | (prompted)    | Server IP or hostname          |
| `REMOTE_PASSWORD`| (optional)    | SSH password (requires sshpass)|
| `REMOTE_PORT`    | `22`          | SSH port                       |
| `REMOTE_PATH`    | `cicada-5453` | Path on the server             |

---

## Troubleshooting

### “Cannot connect to user@host”

- **SSH keys:** Run `ssh-copy-id user@host` and enter your password once.
- **Password auth:** Install `sshpass` and set `REMOTE_PASSWORD`.
- **Network:** Ensure your Mac can reach the server (`ping 192.168.0.101`).
- **Port:** If SSH uses a different port, set `REMOTE_PORT=2222`.

### “Enter passphrase for key” (repeated prompts)

Add your key to the agent first:

```bash
ssh-add ~/.ssh/id_ed25519
```

Enter the passphrase once. Subsequent SSH/rsync calls will use the agent.

### “rsync: unrecognized option”

The script uses `--progress` (compatible with macOS rsync). If you see other rsync errors, ensure you’re on a recent macOS or have rsync from Homebrew.

### Password with special characters doesn’t work

Use SSH keys instead:

```bash
ssh-copy-id user@host
```

### “npm: command not found” on the server

Node.js is not installed or not in PATH. On the server:

1. **Install Node.js** (e.g. via nvm):
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   source ~/.bashrc
   nvm install 18
   nvm use 18
   ```

2. **If using nvm:** Ensure it’s in your profile so it loads in non-interactive shells:
   ```bash
   echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
   echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc
   ```

3. **Verify:** `ssh user@host "bash -lc 'which npm'"` should print the path to npm.

### “ensurepip is not available” / Python venv fails

On Debian/Ubuntu, install the venv package:

```bash
sudo apt install python3-venv
```

For Python 3.12 specifically:

```bash
sudo apt install python3.12-venv
```

---

## Full workflow summary

| Step | Where    | Command |
|------|----------|---------|
| 1. Copy SSH key (one-time) | Mac | `ssh-copy-id user@host` |
| 2. Add key to agent (if passphrase) | Mac | `ssh-add ~/.ssh/id_ed25519` |
| 3. Push + install | Mac | `REMOTE_USER=... REMOTE_HOST=... npm run setup-remote` (leave password empty) |
| 4. Start app | Server | `npm run dev` + `uvicorn ...` |
| 5. Connect | Mac | `npm run remote` |

---

See also:
- [REMOTE_SETUP.md](REMOTE_SETUP.md) for the SSH tunnel and connection options.
- [CONNECTION_TROUBLESHOOTING.md](CONNECTION_TROUBLESHOOTING.md) if the app can't connect to the server.
