#!/bin/bash
# Test script for Watchdog restart functionality
# Run this from a separate terminal

set -e

WATCHDOG_DIR="/Users/pi/.openclaw/workspace/watchdog"

echo "🧪 OpenClaw Watchdog Restart Test"
echo "=================================="
echo ""

# Step 1: Check current status
echo "📊 Step 1: Current Gateway status"
ps -eo pid,comm | grep openclaw || echo "No openclaw processes"
echo ""

# Step 2: Kill Gateway
echo "🔪 Step 2: Killing Gateway..."
pkill -9 "openclaw-gateway" 2>/dev/null || true
pkill -9 -f "openclaw gateway" 2>/dev/null || true
sleep 2

echo "   After kill:"
ps -eo pid,comm | grep openclaw || echo "   No openclaw processes (expected)"
echo ""

# Step 3: Run Watchdog check
echo "🐕 Step 3: Running Watchdog check..."
cd "$WATCHDOG_DIR"
npx tsx src/watchdog.ts check 2>&1

echo ""
echo "📊 Step 4: Final Gateway status"
ps -eo pid,comm | grep openclaw || echo "No openclaw processes"
lsof -i :18789 2>/dev/null | head -3 || echo "Port 18789 not in use"

echo ""
echo "✅ Test complete!"
