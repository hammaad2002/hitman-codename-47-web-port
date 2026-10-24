# Hitman: Codename 47 — in your browser (bring your own installer)

Play your own copy of *Hitman: Codename 47* (PC, 2000) in a desktop browser.

This repository and the site built from it contain **no game files and no game code**. Each player
chooses a disc image (`.iso`) that holds their own copy of the GOG offline installer
(`setup_hitman_codename_47_b192_(17919).exe`); the browser unpacks the installer's data into its private
storage and translates the game's x86 programs (`hitman.exe` and its DLLs) to WebAssembly on the player's
own machine. The translated code runs on a re-implementation of the Windows, OpenGL 1.x, DirectSound and
DirectInput-free input interfaces the game uses.

Not affiliated with or endorsed by IO Interactive, Eidos, Square Enix or GOG.

## Playing
- **Your disc image:** put the GOG installer `.exe` into an .iso (Linux: `genisoimage -o hitman.iso <exe>`;
  Windows: a free tool such as AnyBurn; Mac: `hdiutil makehybrid -iso -o hitman.iso <folder>`). The image
  never leaves your computer.
- **Browsers:** current desktop Chrome or Edge in a normal (not private) window; about 1 GB of storage.
  Unpacking takes about half a minute and happens once; translating takes a few seconds the first time.
- **Controls:** the game's own (Options → Controls). Press F1 for the list, Esc pauses; the substitute key
  (` by default) works as Esc where the browser keeps Esc. Click the game once to capture the mouse
  while playing (the game hides its cursor in missions); the menus use the plain pointer.
- **Saves** stay in the browser that made them (`Hitman.sav` and the `Save/` folder). **Back up saves**
  downloads them as a ZIP; **Restore saves** reads that ZIP or a `Hitman.sav`.
- **Resolution** (Settings) is written to `Hitman.ini` and applies at the next start.

## How it works
1. `installer/` reads the ISO 9660 image, finds the Inno Setup installer on it (5.5.7, LZMA/LZMA2) and
   writes the files listed in `installer/manifest.json` into the Origin Private File System, checking every
   file against its SHA-1. The manifest holds only destination names and checksums.
2. `recomp/` translates the ten game modules (`hitman.exe`, `system.dll`, `gsc.dll`, `HitmanDlc.dlc`, …)
   into one WebAssembly module, cached in OPFS (`metadata/` holds address-only analysis hints for the
   supported build; see `docs/ARCH.md` for the module layout).
3. `runtime/` (C++, Emscripten) provides the Windows API, OpenGL 1.1 on WebGL 2 (`runtime/src/hle/opengl32.cpp`
   records a command stream, `runtime/src/gles/gl1_exec.cpp` replays it) and DirectSound. The game runs
   on worker threads; the page renders and handles input.
4. `web/` is the page: install, settings, saves, controls, fullscreen.

`docs/JOURNAL.md` records how the port was built.

## Building
Requirements: Node.js 24, Emscripten at `../shrek2-team-action-web/work/tools/emsdk` (or set
`HITMAN_WEB_TOOLCHAIN`), clang for the native syntax checks.

```sh
npm install
tools/build-web.sh                       # engine -> web/public/engine
cd web && npx vite                       # development server on http://localhost:5173
REPO_URL=<repository URL> tools/build-release.sh   # deployable site in web/dist, with release checks
```

Development (needs the installer ISO as `Hitman_Codename_47.iso` and its extracted tree in `work/game/app`,
made with `innoextract`): `work/`-based helpers `tools/web-smoke.mjs` (scripted session with frame captures)
and `tools/hitman-play.mjs` (menu clicks, typing, screenshots); the dev server's `?devGame` query copies
the extracted tree instead of running the installer and `?devIso` runs the installer on the local ISO.
`node recomp/src/cli-set.ts metadata work/game/app` regenerates `metadata/<key>.json`. Tests: `npx vitest run`.

## Licence
MIT for this repository's code (see LICENSE). Third-party notices are listed in `web/public/licenses.html`.
