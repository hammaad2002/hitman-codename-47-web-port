#!/bin/sh
# Differential conformance test: build a synthetic PE of one-instruction snippets from the game,
# recompile it with gen-c, build libconf.so and compare each snippet against Unicorn.
#   tests/conformance/snippets.sh [vectors-per-snippet]   (run from the repository root)
set -e
EXE="${BELLASARA_EXE:-work/ref/BellaSara.exe}"
HINTS="${BELLASARA_HINTS:-research/ghidra-functions.json}"
CONF=work/conf-snippets
GEN="$CONF/gen-c"
VECTORS="${1:-48}"

rm -rf "$CONF"
mkdir -p "$CONF"
node tests/conformance/snippets.ts "$EXE" "$HINTS" "$CONF"
node recomp/src/cli.ts gen-c "$CONF/snippets.exe" --out "$GEN" --hints "$CONF/hints.json" | head -2
mkdir -p "$CONF/obj"
ls "$GEN"/funcs_*.c "$GEN"/recomp_table.c | xargs -P 20 -I{} sh -c \
  "clang -c -fPIC -O1 -std=c11 -w -Iruntime/include -I$GEN {} -o $CONF/obj/\$(basename {} .c).o"
clang -shared -fPIC -O1 -w -std=c11 -Iruntime/include "$CONF"/obj/*.o tests/conformance/test_rt.c runtime/src/cpu_helpers.c -lm -o "$CONF/libconf.so"
.venv/bin/python -I tests/conformance/run.py "$EXE" "$CONF" "$VECTORS"
