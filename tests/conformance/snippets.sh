#!/bin/sh
# Differential conformance test: build a synthetic PE of one-instruction snippets from the game,
# recompile it with gen-c, build libconf.so and compare each snippet against Unicorn.
#   tests/conformance/snippets.sh [pe-path] [vectors-per-snippet]   (run from the repository root)
# Default PE: work/game/app/system.dll (Hitman code module; hitman.exe is only the loader).
set -e
PE="${1:-work/game/app/system.dll}"
VECTORS="${2:-48}"
CONF=work/conf-snippets
GEN="$CONF/gen-c"
VENV="${HITMAN_CONF_VENV:-work/venv-conf}"

rm -rf "$CONF"
mkdir -p "$CONF"
node tests/conformance/snippets.ts "$PE" "$CONF"
node recomp/src/cli.ts gen-c "$CONF/snippets.exe" --out "$GEN" --hints "$CONF/hints.json" | head -2
mkdir -p "$CONF/obj"
ls "$GEN"/funcs_*.c "$GEN"/recomp_table.c | xargs -P 20 -I{} sh -c \
  "clang -c -fPIC -O1 -std=c11 -w -Iruntime/include -I$GEN {} -o $CONF/obj/\$(basename {} .c).o"
clang -shared -fPIC -O1 -w -std=c11 -D_GNU_SOURCE -Iruntime/include "$CONF"/obj/*.o tests/conformance/test_rt.c runtime/src/cpu_helpers.c -lm -o "$CONF/libconf.so"
"$VENV/bin/python" -I tests/conformance/run.py "$PE" "$CONF" "$VECTORS"
