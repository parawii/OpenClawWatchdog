#!/bin/bash
# Start OpenClaw Watchdog in background

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🐕 Starting OpenClaw Watchdog v1.1.0 (Phase 2)"
echo "   Mode: Monitoring + Gateway Restart"
echo "   Config: config/watchdog.json"
echo "   Logs: logs/watchdog.log (coming soon)"
echo "   Reports: reports/"
echo ""

# Create required directories
mkdir -p logs reports

# Run with tsx (no build required)
npx tsx src/watchdog.ts run "$@"
