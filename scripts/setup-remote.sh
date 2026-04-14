#!/usr/bin/env bash
#
# CICADA-5453 — Push code to remote server and run setup.
# Usage:
#   REMOTE_USER=user REMOTE_HOST=192.168.1.10 REMOTE_PASSWORD=secret ./scripts/setup-remote.sh
#   ./scripts/setup-remote.sh   # prompts for user, host, password (optional)
#
# Optional: REMOTE_PORT=22  REMOTE_PATH=~/cicada-5453
#

set -e

# Project root (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE_USER="${REMOTE_USER:-}"
REMOTE_HOST="${REMOTE_HOST:-}"
REMOTE_PASSWORD="${REMOTE_PASSWORD:-}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_PATH="${REMOTE_PATH:-cicada-5453}"

ssh_args=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p "$REMOTE_PORT" -l "$REMOTE_USER")

# When using password, force password auth (some servers use keyboard-interactive which sshpass struggles with)
run_ssh() {
  if [[ -n "$REMOTE_PASSWORD" && -n "$(command -v sshpass 2>/dev/null)" ]]; then
    SSHPASS="$REMOTE_PASSWORD" sshpass -e ssh \
      -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no \
      "${ssh_args[@]}" "$REMOTE_HOST" "$@"
  else
    ssh "${ssh_args[@]}" "$REMOTE_HOST" "$@"
  fi
}

run_rsync() {
  local exclude=(
    --exclude 'node_modules'
    --exclude 'python/venv'
    --exclude '.git'
    --exclude 'dist'
    --exclude '__pycache__'
    --exclude '*.pyc'
  )
  # --progress shows transfer progress (macOS rsync doesn't support --info=progress2)
  local rsync_opts=(-avz --progress "${exclude[@]}")
  local ssh_cmd="ssh -p $REMOTE_PORT -o StrictHostKeyChecking=accept-new"
  if [[ -n "$REMOTE_PASSWORD" && -n "$(command -v sshpass 2>/dev/null)" ]]; then
    # rsync spawns ssh; we need sshpass to wrap it so password is passed
    ssh_cmd="sshpass -e ssh -p $REMOTE_PORT -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no"
    SSHPASS="$REMOTE_PASSWORD" rsync "${rsync_opts[@]}" \
      -e "$ssh_cmd" \
      "$PROJECT_ROOT/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/"
  else
    rsync "${rsync_opts[@]}" \
      -e "$ssh_cmd" \
      "$PROJECT_ROOT/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/"
  fi
}

echo "[CICADA-5453] Remote setup"
echo ""

if [[ -z "$REMOTE_USER" ]]; then
  read -p "Remote username: " REMOTE_USER
fi
if [[ -z "$REMOTE_HOST" ]]; then
  read -p "Remote host (IP or hostname): " REMOTE_HOST
fi
if [[ -z "$REMOTE_PASSWORD" ]]; then
  if command -v sshpass &>/dev/null; then
    read -sp "Password (leave empty for SSH key): " REMOTE_PASSWORD
    echo ""
  else
    echo "Tip: For password auth, install sshpass (brew install sshpass) and run:"
    echo "  REMOTE_PASSWORD=yourpass npm run setup-remote"
    echo "Or set up SSH keys: ssh-copy-id $REMOTE_USER@$REMOTE_HOST"
  fi
fi

# Password auth requires sshpass
if [[ -n "$REMOTE_PASSWORD" ]] && ! command -v sshpass &>/dev/null; then
  echo "Error: REMOTE_PASSWORD is set but sshpass is not installed."
  echo "  Install it: brew install sshpass"
  echo "  Then run: REMOTE_USER=$REMOTE_USER REMOTE_HOST=$REMOTE_HOST REMOTE_PASSWORD=xxx npm run setup-remote"
  exit 1
fi

if [[ -z "$REMOTE_USER" || -z "$REMOTE_HOST" ]]; then
  echo "Error: Set REMOTE_USER and REMOTE_HOST."
  exit 1
fi

echo ""
echo "0. Testing SSH connection..."
if ! run_ssh "echo OK" >/dev/null 2>&1; then
  echo "Error: Cannot connect to $REMOTE_USER@$REMOTE_HOST"
  echo "  - If the server asks for a password: install sshpass (brew install sshpass) and run:"
  echo "    REMOTE_PASSWORD=yourpassword npm run setup-remote"
  echo "  - Or set up SSH keys: ssh-copy-id $REMOTE_USER@$REMOTE_HOST"
  echo "  - Check host, port ($REMOTE_PORT), and network."
  exit 1
fi
echo "  SSH OK."

echo ""
echo "1. Syncing project to $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH ..."
run_ssh "mkdir -p $REMOTE_PATH"
run_rsync

echo ""
echo "2. Installing dependencies on remote server (npm install can take 5–15 min on first run)..."
# Login shell; source nvm if present
install_cmd='[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"; cd '"$REMOTE_PATH"' && npm install --loglevel=info && cd python && (python3 -m venv venv 2>/dev/null || python -m venv venv) && source venv/bin/activate && pip install -r requirements.txt && cd .. && echo "  Done."'
if ! run_ssh "bash -lc \"$install_cmd\""; then
  echo ""
  echo "Install failed. Common fixes:"
  echo ""
  echo "  Node.js: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
  echo "           source ~/.bashrc && nvm install 20 && nvm use 20"
  echo ""
  echo "  Python venv (Debian/Ubuntu): sudo apt install python3-venv"
  echo "  or for Python 3.12:          sudo apt install python3.12-venv"
  echo ""
  echo "  Then re-run: REMOTE_USER=$REMOTE_USER REMOTE_HOST=$REMOTE_HOST npm run setup-remote"
  exit 1
fi

echo ""
echo "3. Setup complete."
echo ""
echo "To start the app on the server, run in two terminals:"
echo "  ssh $REMOTE_USER@$REMOTE_HOST"
echo "  cd $REMOTE_PATH && npm run dev"
echo ""
echo "  ssh $REMOTE_USER@$REMOTE_HOST"
echo "  cd $REMOTE_PATH/python && source venv/bin/activate && uvicorn cicada_nn.api:app --host 0.0.0.0 --port 8000"
echo ""
echo "Then from your Mac: npm run remote"
echo ""
