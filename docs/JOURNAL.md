# Journal

## 2026-10-24: from an ISO to the training mission

Starting point: `Hitman_Codename_47.iso` containing one file, the GOG offline installer. Same pipeline as
the Shrek 2 and Bella Sara ports (static x86 → WebAssembly, C++ runtime, Vite page), forked from the Bella
tree, with three findings that shaped the work:

- **The game is modular.** `hitman.exe` is a 44 KB loader; the engine lives in DLLs (`Globals`, `system`,
  `EngineData`, `gsc`, `Sound`, `Locale`, a renderer DLL chosen by `Hitman.ini`) and the game logic in a
  2 MB DLL with the extension `.dlc`. The recompiler therefore lifts a *set* of PE modules into one
  wasm module (`recomp/src/peset.ts`, `translate-set.ts`): distinct bases, two modules rebased because
  their preferred bases collide with the heap / each other, imports between set modules resolved by the
  runtime loader (`runtime/src/core/modules.cpp`) instead of HLE thunks.
- **Three renderers ship with it** (D3D7 via ddraw, OpenGL 1.x, Glide). OpenGL was chosen: 67 `opengl32`
  imports, fixed function. The guest side (`hle/opengl32.cpp`) expands immediate mode and client arrays
  into flat vertex lists and records a command stream (`runtime/src/gl1/gl1_cmd.h`); the page thread replays
  it with one generated fixed-function shader (`gles/gl1_exec.cpp`).
- **The installer is Inno Setup 5.5.7**, not MSI/CAB. `installer/src/inno.ts` reads the loader table,
  the two LZMA1 header blocks (only the file-location table is needed; destination names come from
  `installer/manifest.json`) and the LZMA2 file chunks, undoes the call-instruction filter, and checks every
  file's SHA-1 (`installer/src/lzma.ts` is a streaming LZMA1/LZMA2 decoder).

Bugs worth remembering (each cost a run):
- Relocation directory read from the wrong data-directory slot (resource instead of base-reloc).
- Speculative function discovery rejected whole functions for one bad jump-table target, and treated
  `pushad`/`popad`/`fwait` as "implausible"; virtual methods reached only through vtables built at run time
  were found by 16-byte-aligned padding heuristics (`findAlignedEntries`).
- `rdtsc` needed a runtime helper (`rt_rdtsc`, appended last to the wasm import list).
- `SetFocus` recursion (its WM_SETFOCUS handler calls `SetFocus` again): Windows does nothing when the
  window already has focus.
- The game recentres the cursor with `SetCursorPos` and measures motion from the centre: the platform keeps
  a virtual cursor moved by the browser's relative motion.
- Vite does not watch `recomp/` or `runtime/`: restart it after changing translator code, and pass
  `?retranslate` to ignore the cached translation.

How the work was split: a swarm was planned (Gemini 3.8 Flash workers through `agy`), but the Gemini quota was
exhausted at launch, the free opencode and kilo tiers ran out within minutes, and four of seven fallback
Claude-subagent launches were refused by the permission classifier, so most code was written directly. The
three subagents that ran produced the multi-module loader (`core/modules.cpp`), the GL replay executor
(`gles/gl1_exec.cpp`) and the gdi32/winmm/eax stubs; the rest is hand-written.

Status: installs from the ISO in ~25 s, translates ~17,200 functions (40 MB of wasm) in ~5 s, shows the intro
logos and cinematics, the menu, and plays the training mission at 60 fps in Chrome. Not done: Firefox/Safari
passes, gamepads, audio verification by ear, mouse look in the mission, the D3D/Glide renderers.
