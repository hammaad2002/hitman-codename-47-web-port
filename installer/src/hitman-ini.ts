/**
 * Hitman.ini selects the renderer DLL by `DrawDll` and the video mode by `Resolution`. The web port
 * only translates RenderOpenGL.dll, so the installed copy always selects it; the resolution starts at
 * 1024x768. Other lines (locale zip) are left as they are.
 */
export function patchHitmanIni(text: string, resolution = "1024x768"): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !/^\s*\/*\s*DrawDll\b/i.test(l) && !/^\s*Resolution\b/i.test(l));
  const i = lines.findIndex((l) => /^\s*Include\b/i.test(l));
  lines.splice(i < 0 ? 0 : i + 1, 0, "DrawDll RenderOpenGL.dll");
  lines.push(`Resolution ${resolution}`);
  return lines.join("\r\n") + "\r\n";
}
