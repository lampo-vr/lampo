#!/bin/bash
# Server scenario: transcribe.cpp's Linux prebuilt (npm `transcribe-cpp`) in node:24-slim, capped at 4 CPUs and 6 GB,
# no GPU. Host paths are mounted at the same paths so the manifest's absolute paths work unchanged.
#
# Usage: docker_cpu.sh <node_modules dir with transcribe-cpp for linux> <manifest> <results dir> <label> <model.gguf> [extra run_node args…]
set -euo pipefail
MODS="$1"; MAN="$2"; OUT="$3"; LABEL="$4"; MODEL="$5"; shift 5
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$(dirname "$MAN")"
# Hugging Face snapshots are symlinks into ../../blobs, so mount the whole cache (MODEL_ROOT) when models live there.
MODEL_ROOT="${MODEL_ROOT:-$(dirname "$MODEL")}"
mkdir -p "$OUT"
docker run --rm --cpus 4 --memory 6g \
  -v "$MODS:/opt/tc/node_modules:ro" -v "$HERE:$HERE:ro" -v "$DATA:$DATA" -v "$MODEL_ROOT:$MODEL_ROOT:ro" -v "$OUT:$OUT" \
  node:24-slim node "$HERE/run_node.mjs" --module /opt/tc/node_modules/transcribe-cpp --cpu --threads 4 \
  --model "$MODEL" --manifest "$MAN" --out "$OUT/$(echo "$LABEL" | tr ' ·/' '__-').jsonl" --name "$LABEL" "$@"
