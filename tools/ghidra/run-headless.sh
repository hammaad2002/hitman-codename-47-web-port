#!/usr/bin/env bash
# Runs Ghidra 12.1.4 headless over the supported Bella Sara executable and exports
# research/ghidra-functions.json in the shape recomp/src/hints.ts parses.
# Resumable: the analysis lives in work/ghidra/ (git-ignored); re-runs use -process instead of
# re-importing. Headless output is teed to work/ghidra/headless.log so a crash never loses it.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

EXE=work/ref/BellaSara.exe
PROJECT_DIR=work/ghidra
PROJECT=BellaSara
OUT=research/ghidra-functions.json

# Prefer the installed copy, fall back to the download.
GHIDRA=/opt/ghidra
if [ ! -x "$GHIDRA/support/analyzeHeadless" ]; then
  GHIDRA="$HOME/Downloads/ghidra_12.1.4_PUBLIC"
fi
if [ ! -x "$GHIDRA/support/analyzeHeadless" ]; then
  echo "ghidra not found (tried /opt/ghidra and ~/Downloads/ghidra_12.1.4_PUBLIC)" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR" research

# -process skips import+analysis when the project is already populated (resume path).
if [ -f "$PROJECT_DIR/$PROJECT.gpr/BellaSara programs/" ] 2>/dev/null || ls "$PROJECT_DIR/$PROJECT.gpr" >/dev/null 2>&1; then
  echo "resuming: processing existing project $PROJECT_DIR/$PROJECT.gpr"
  set -x
  "$GHIDRA/support/analyzeHeadless" "$PROJECT_DIR" "$PROJECT" \
    -process "$EXE_FILE" -noanalysis \
    -postScript ExportFunctions.java "$OUT" -scriptPath tools/ghidra \
    2>&1 | tee "$PROJECT_DIR/headless.log"
else
  set -x
  "$GHIDRA/support/analyzeHeadless" "$PROJECT_DIR" "$PROJECT" \
    -import "$EXE" -processor x86:LE:32:default \
    -analysisTimeoutPerFile 1800 \
    -postScript ExportFunctions.java "$OUT" -scriptPath tools/ghidra \
    2>&1 | tee "$PROJECT_DIR/headless.log"
fi

echo "=== headless log tail ==="
tail -30 "$PROJECT_DIR/headless.log"
echo "=== export ==="
ls -la "$OUT"
