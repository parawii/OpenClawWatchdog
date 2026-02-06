#!/bin/bash
# Wrapper script for OpenClaw Watchdog launchd service

WATCHDOG_DIR="/Users/pi/.openclaw/workspace/watchdog"
NODE_PATH="/opt/homebrew/bin"
export PATH="$NODE_PATH:$PATH"

cd "$WATCHDOG_DIR"

# Run watchdog in start mode
# We use tsx directly to avoid global install issues
exec /opt/homebrew/bin/npx tsx src/watchdog.ts run
