# Hitman: Codename 47 web port: architecture contract

Fork of the sibling ports (the Bella Sara and Shrek 2 web ports, read-only references). Pipeline: ISO -> Inno Setup installer parser -> files in OPFS -> static x86->wasm recompiler -> C++/Emscripten runtime (Win32 HLE, OpenGL 1.1 -> WebGL2, DirectSound) -> Vite page.

Game files (read-only, never copy into tracked dirs): `work/game/app/` (GOG build 17919, extracted with innoextract).

## Module set (one wasm module, one guest address space, identity-mapped)
Order matters (it defines HLE import numbering):

| # | file | preferred base | role |
|---|------|----------------|------|
| 0 | hitman.exe | 0x00400000 | 44 KB loader, imports kernel32 + Globals.dll |
| 1 | Globals.dll | 0x0fff0000 | data exports (g_pSys*) |
| 2 | system.dll | 0x0ffa0000 | engine core (exports RunEngine) |
| 3 | EngineData.dll | 0x0ff60000 | |
| 4 | gsc.dll | 0x0fbf0000 | script engine |
| 5 | Sound.dll | 0x0ff30000 | DirectSound via EAX.dll (HLE'd, not lifted) |
| 6 | Locale.dll | 0x0fbd0000 | |
| 7 | RenderOpenGL.dll | 0x0fb70000 | chosen renderer (Hitman.ini `DrawDll RenderOpenGL.dll`) |
| 8 | xmlparse.dll | **rebased** to 0x0fb50000 (preferred 0x20000000 collides with the heap) | expat |
| 9 | HitmanDlc.dlc | **rebased** to 0x0f800000 (preferred 0x0fcc0000 overlaps Sound.dll) | the game logic (2 MB code; a PE DLL with a .dlc extension, loaded with LoadLibrary) |

Not lifted: EAX.dll (HLE `eax.dll!EAXDirectSoundCreate` -> DirectSound), RenderD3D/Render3DFX (unused).

- Rebasing: apply the PE base-relocation directory (IMAGE_REL_BASED_HIGHLOW) with delta = newBase - preferredBase. The recompiler (`recomp/src/peset.ts`) and the runtime loader (`runtime/src/core/modules.cpp`) implement the same algorithm; the recompiler lifts the *rebased* bytes.
- Imports of DLLs that are inside the set (Globals.dll, xmlparse.dll, system.dll, ...) are **not** HLE imports. The runtime loader writes the real export address into the IAT slot (by name or ordinal) before running any DllMain, in module-set order dependencies (Globals first). The lifter sees `call [iat]` as an ordinary indirect call.
- All other imports are HLE imports. **HLE import index** = position in the list formed by walking modules in the table order, each module's import descriptors in file order, thunks in order, skipping imports whose DLL is in the set. Recompiler (`PeSet.imports`) and runtime (`g_imports`) must agree.
- `LoadLibraryA("RenderOpenGL.dll")` etc. return the (already mapped) module base and run its DllMain(DLL_PROCESS_ATTACH) once; `GetProcAddress` reads the guest export table (names and ordinals); unknown system DLLs fall back to the existing fake-handle table + `hle_find`. `GetModuleHandleA(NULL)` = hitman.exe base.
- Module bytes are read at start-up from the install dir (`/opfs/hitman/<name>`), not embedded.

## Guest memory
Existing layout in `runtime/src/core/rt.h`. Every module image is registered with `vm_reserve_image(base,size)` so first-fit VirtualAlloc/stack allocation skips it. No module may live in 0x18000000+ (heap).

## Metadata (offline-generated, address-only; no code bytes)
`metadata/<key>.json` with `format: 2`: `{ format, modules:[{name,sha256,size,base}], entries:number[], noreturn:number[], jumpTargets:[at, targets[]][] }` (all addresses absolute guest VAs, rebased). `<key>` = first 16 hex chars of sha256 over the concatenation of the per-module sha256 strings in table order.

## Dispatch
`rt_dispatch(c, target)` maps a guest address to a lifted function. The wasm emitter's dense index must cover every executable range of every module (`ranges: {lo,hi}[]` instead of one textLo/textHi).

## OpenGL path
`hle/opengl32.cpp` (guest thread): keeps GL state/matrix stacks, expands Begin/End and client-array draws into flat vertex lists, converts all texture uploads to RGBA8, and records the `runtime/src/gl1/gl1_cmd.h` stream; SwapBuffers submits it with `web::submit(words, true)`. `gles/gl1_exec.cpp` (page main thread) replays it with GLES3/WebGL2 using one generated fixed-function shader (texture MODULATE/REPLACE/DECAL/BLEND, fog, alpha test). The existing D3D executor is unused for Hitman; `web_main.cpp` routes a batch whose first word is `gl1::kMagic` to `gl1::execute`.
