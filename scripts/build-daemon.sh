#!/bin/bash
# Build cross-compiled daemon binaries for remote Linux hosts.
# Requires Bun (https://bun.sh).
#
# Usage:
#   bash scripts/build-daemon.sh
#   npm run build:daemon
#
# Output:
#   dist/daemon-binaries/daemon-linux-x64
#   dist/daemon-binaries/daemon-linux-arm64
set -e

VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
OUTDIR="dist/daemon-binaries"
mkdir -p "$OUTDIR"

echo "Building daemon binaries (version: walnut-daemon-$VERSION)..."

bun build --compile --target=bun-linux-x64 --minify \
  --define "process.env.DAEMON_VERSION='walnut-daemon-$VERSION'" \
  --outfile "$OUTDIR/daemon-linux-x64" \
  src/providers/daemon-standalone.ts
echo "walnut-daemon-$VERSION" > "$OUTDIR/daemon-linux-x64.version"

bun build --compile --target=bun-linux-arm64 --minify \
  --define "process.env.DAEMON_VERSION='walnut-daemon-$VERSION'" \
  --outfile "$OUTDIR/daemon-linux-arm64" \
  src/providers/daemon-standalone.ts
echo "walnut-daemon-$VERSION" > "$OUTDIR/daemon-linux-arm64.version"

echo "Done. Binaries:"
ls -lh "$OUTDIR"/daemon-linux-*
