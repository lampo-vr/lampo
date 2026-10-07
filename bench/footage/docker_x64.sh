#!/bin/bash
# The CPU server's platform: the bench's npm packages installed for linux/amd64 inside node:24-slim (into a Docker
# volume laid over bench/footage/node_modules), then linux_check.ts --check against the frames and vectors
# linux_check.ts --dump wrote on the Mac. Prints the install weight per package, with onnxruntime-node's GPU
# providers skipped (ONNXRUNTIME_NODE_INSTALL=skip) as a CPU server would.
# On Apple Silicon the container runs emulated: this checks that the x86-64 prebuilts load and agree, not their speed.
#
# Usage: node bench/footage/linux_check.ts --dump && bench/footage/docker_x64.sh [--with-lancedb]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="${LAMPO_FOOTAGE_CACHE:-$ROOT/cache/footage}"
VOL=lampo-footage-bench-x64
PKGS="@huggingface/transformers@4.3.0 onnxruntime-node@1.30.0 sqlite-vec@0.1.9"
[ "${1:-}" = "--with-lancedb" ] && PKGS="$PKGS @lancedb/lancedb@0.39.0 apache-arrow@18.1.0"
docker volume rm "$VOL" >/dev/null 2>&1 || true
docker volume create "$VOL" >/dev/null
docker run --rm --platform linux/amd64 -e ONNXRUNTIME_NODE_INSTALL=skip -v "$VOL:/mods" node:24-slim sh -c "
  mkdir -p /tmp/i && cd /tmp/i && npm init -y >/dev/null && npm install --no-audit --no-fund $PKGS >/dev/null 2>&1
  cp -a node_modules/. /mods/
  echo 'install weight (linux/amd64):'; du -sh /mods; du -sh /mods/* /mods/@*/* 2>/dev/null | sort -h | tail -8
  echo 'onnxruntime-node binaries kept for linux/x64:'; du -sh /mods/onnxruntime-node/bin/napi-v6/linux/x64"
docker run --rm --platform linux/amd64 --cpus 4 --memory 6g \
  -v "$ROOT:$ROOT:ro" -v "$VOL:$HERE/node_modules:ro" -v "$CACHE/work/linux:$CACHE/work/linux" \
  -e LAMPO_FOOTAGE_CACHE="$CACHE" node:24-slim node "$HERE/linux_check.ts" --check
