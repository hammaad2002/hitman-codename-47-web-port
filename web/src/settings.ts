/**
 * Game settings. Hitman reads its video mode from Hitman.ini in the install (`Resolution 1024x768`);
 * the page changes only that line (the renderer line is managed by installer/src/hitman-ini.ts).
 */
import { INSTALL_DIR } from "./cache.ts";
import { KEYS } from "./keys.ts";
import { readOpfsFile, writeOpfsFile } from "./opfs-write.ts";

/** Folder of the install where the game keeps player profiles. */
export const GAME_SUBDIR = "Save";
const INI_PATH = [INSTALL_DIR, "Hitman.ini"];

export const RESOLUTIONS = ["640x480", "800x600", "1024x768", "1280x960", "1600x1200"];
export const DEFAULT_RESOLUTION = "1024x768";

export async function getResolution(): Promise<string> {
  const ini = await readOpfsFile(INI_PATH);
  const m = ini ? /^\s*Resolution\s+(\d+x\d+)/im.exec(new TextDecoder().decode(ini)) : null;
  return m ? m[1] : DEFAULT_RESOLUTION;
}

export async function setResolution(res: string): Promise<void> {
  if (!/^\d+x\d+$/.test(res)) throw new Error(`bad resolution ${res}`);
  const ini = await readOpfsFile(INI_PATH);
  const text = ini ? new TextDecoder().decode(ini) : "";
  const next = /^\s*Resolution\s+\S+/im.test(text) ? text.replace(/^(\s*Resolution\s+)\S+/im, `$1${res}`) : `${text.trimEnd()}\r\nResolution ${res}\r\n`;
  await writeOpfsFile(INI_PATH, new TextEncoder().encode(next) as Uint8Array<ArrayBuffer>);
}

/** A readable name for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Numpad ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return `${code.slice(5)} arrow`;
  return (
    ({ Backquote: "` (backtick)", Escape: "Esc", Space: "Space", Enter: "Enter", Tab: "Tab", ControlLeft: "Left Ctrl", ShiftLeft: "Left Shift", AltLeft: "Left Alt" } as Record<string, string>)[code] ?? code
  );
}

export const isGameKey = (code: string) => code in KEYS;
