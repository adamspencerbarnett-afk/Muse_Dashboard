#!/bin/sh
# Muse Dashboard - start-dashboard.sh
# Author: Adam S. Barnett
#
# Starts the dashboard on macOS and Linux (./start-dashboard.sh). On the first
# start it installs the dependencies (npm ci) and creates config.json from
# config.example.json. Settings > Restart exits with code 75; this script then
# starts the server again. Extra arguments go to server.js.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on PATH. Install Node.js 20 or newer from https://nodejs.org and try again."
  exit 1
fi
if [ ! -f node_modules/@muse-code/sdk/package.json ]; then
  echo "First start: installing the dashboard's dependencies..."
  npm ci --no-audit --no-fund || { echo "Installing the dependencies failed. See the messages above."; exit 1; }
fi
[ -f config.json ] || cp config.example.json config.json

echo "Starting Muse Dashboard... your browser will open automatically."
echo "It stops by itself a while after you close the last dashboard tab (idleShutdownSeconds in config.json)."
echo "Press Ctrl+C to stop it now."
export MUSE_DASHBOARD_SUPERVISED=1
while :; do
  node server.js "$@"
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
done
