#!/usr/bin/env bash
# RespiTrack // One-Command Public HTTPS Live Deployment
# Launches the Flask server and a secure Cloudflare tunnel to stream your physical belt anywhere.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=========================================================="
echo " RespiTrack // Live Physical Belt Streaming Deployment"
echo "=========================================================="

# Check if Flask app is already running
if ! curl -s http://127.0.0.1:5001/api/status > /dev/null 2>&1; then
  echo "[1/2] Starting Flask backend server on port 5001..."
  "./.venv/bin/python" app.py &
  sleep 2
else
  echo "[1/2] Flask backend is already active on port 5001."
fi

echo "[2/2] Launching secure public HTTPS tunnel..."
echo "----------------------------------------------------------"
"./.venv/bin/cloudflared" tunnel --url http://127.0.0.1:5001
