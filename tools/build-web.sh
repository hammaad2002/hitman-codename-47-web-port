#!/bin/bash
# Build the web runtime and stage the deployable player engine for the shell.
#   tools/build-web.sh          (run from anywhere)
# - work/build-web-W/hitman_player.{js,wasm}: runtime without game code -> web/public/engine/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Emscripten lives in the sibling Shrek port tree (not copied into this repo).
TOOLCHAIN="${HITMAN_WEB_TOOLCHAIN:-$ROOT/../shrek2-team-action-web}"
BUILD="${HITMAN_BUILD_WEB:-$ROOT/work/build-web-W}"
source "$TOOLCHAIN/work/tools/emsdk/emsdk_env.sh" > /dev/null 2>&1
emcmake cmake -S "$ROOT/runtime" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release -DGEN_OPT=-O2 > /dev/null
ninja -C "$BUILD" hitman_player
mkdir -p "$ROOT/web/public/engine"
cp "$BUILD/hitman_player.js" "$BUILD/hitman_player.wasm" "$ROOT/web/public/engine/"
echo "player engine staged in web/public/engine"
