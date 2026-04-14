#!/usr/bin/env bash
# SSH tunnel to a more powerful machine. Usage:
#   REMOTE_USER=user REMOTE_HOST=192.168.1.10 REMOTE_PASSWORD=secret ./scripts/remote-connect.sh
#   ./scripts/remote-connect.sh   # prompts for user, host, password (if sshpass installed)
#
# With SSH keys (no password): just set REMOTE_USER and REMOTE_HOST.

set -e
REMOTE_USER=${REMOTE_USER:-}
REMOTE_HOST=${REMOTE_HOST:-}
REMOTE_PORT=${REMOTE_PORT:-22}
REMOTE_PASSWORD=${REMOTE_PASSWORD:-}

if [[ -z "$REMOTE_USER" ]]; then
  read -p "Remote username: " REMOTE_USER
fi
if [[ -z "$REMOTE_HOST" ]]; then
  read -p "Remote host (IP or hostname): " REMOTE_HOST
fi
if [[ -z "$REMOTE_USER" || -z "$REMOTE_HOST" ]]; then
  echo "Set REMOTE_USER and REMOTE_HOST (or enter when prompted)."
  exit 1
fi

echo "Connecting to $REMOTE_USER@$REMOTE_HOST (ports 5173 and 8000 forwarded)."
echo "Start the app on the remote first (npm run dev and uvicorn)."
echo "Then open http://localhost:5173 in your browser. Press Ctrl+C to stop."
echo ""

OPEN_CMD=""
case "$(uname -s)" in
  Darwin)  OPEN_CMD="open";;
  Linux)   OPEN_CMD="xdg-open";;
  MINGW*)  OPEN_CMD="start";;
esac

if [[ -n "$REMOTE_PASSWORD" && -n "$(command -v sshpass 2>/dev/null)" ]]; then
  ( sleep 2; "$OPEN_CMD" "http://localhost:5173" 2>/dev/null ) &
  export SSHPASS="$REMOTE_PASSWORD"
  sshpass -e ssh -o StrictHostKeyChecking=accept-new -L 5173:127.0.0.1:5173 -L 8000:127.0.0.1:8000 -p "$REMOTE_PORT" -N "$REMOTE_USER@$REMOTE_HOST"
else
  ( sleep 2; "$OPEN_CMD" "http://localhost:5173" 2>/dev/null ) &
  ssh -o StrictHostKeyChecking=accept-new -L 5173:127.0.0.1:5173 -L 8000:127.0.0.1:8000 -p "$REMOTE_PORT" -N "$REMOTE_USER@$REMOTE_HOST"
fi
