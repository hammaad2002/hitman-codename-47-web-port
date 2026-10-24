#!/bin/sh
# Regenerate the recompiled game C and build the conformance test libraries.
#   tests/conformance/build.sh            (run from the repository root)
set -e
PE="work/game/app/system.dll"
rm -rf work/gen-c
node recomp/src/cli.ts gen-c "$PE" --out work/gen-c | head -2
cp work/gen-c/blocks.bin work/conf/blocks.bin
for variant in plain trace; do
  out="work/obj-$variant"
  rm -rf "$out" && mkdir -p "$out"
  flags=""
  [ "$variant" = trace ] && flags="-DRECOMP_TRACE"
  ls work/gen-c/funcs_*.c work/gen-c/recomp_table.c | xargs -P 20 -I{} sh -c \
    "clang -c -fPIC -O1 -std=c11 -w $flags -Iruntime/include -Iwork/gen-c {} -o $out/\$(basename {} .c).o"
done
clang -shared -fPIC -O1 -w -std=c11 -D_GNU_SOURCE -Iruntime/include work/obj-plain/*.o tests/conformance/test_rt.c runtime/src/cpu_helpers.c -lm -o work/conf/libgame.so
clang -shared -fPIC -O1 -w -std=c11 -D_GNU_SOURCE -DRECOMP_TRACE -Iruntime/include work/obj-trace/*.o tests/conformance/test_rt.c runtime/src/cpu_helpers.c -lm -o work/conf/libgame_trace.so
node tests/conformance/purefuncs.ts "$PE" work/conf/pure.json
