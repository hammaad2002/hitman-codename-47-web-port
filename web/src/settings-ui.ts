/**
 * The settings panel: video resolution (written to Hitman.ini, applied the next time the game starts)
 * and the browser's substitute-Esc key.
 */
import { savePrefs, type Prefs } from "./prefs.ts";
import { RESOLUTIONS, getResolution, isGameKey, keyLabel, setResolution } from "./settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class SettingsPanel {
  private capturing = false;
  private readonly prefs: Prefs;

  constructor(prefs: Prefs) {
    this.prefs = prefs;
    const res = $<HTMLSelectElement>("set-resolution");
    for (const r of RESOLUTIONS) res.add(new Option(r.replace("x", " × "), r));
    res.addEventListener("input", () => {
      $("set-status").textContent = "Saving…";
      setResolution(res.value).then(
        () => ($("set-status").textContent = "Saved. Changes apply the next time you press Play."),
        (err: unknown) => ($("set-status").textContent = `Could not save: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    const mouse = $<HTMLInputElement>("set-mouse");
    mouse.addEventListener("input", () => {
      this.prefs.mouseSpeed = Number(mouse.value);
      $("set-mouse-value").textContent = `${mouse.value}×`;
      savePrefs(this.prefs);
    });
    $("settings-close").addEventListener("click", () => this.close());
    $("set-alias").addEventListener("click", () => this.startCapture());
    window.addEventListener("keydown", (e) => this.onKey(e), true);
    document.addEventListener("pointerdown", (e) => {
      if (this.capturing && e.target !== $("set-alias")) this.stopCapture();
    });
  }

  async open(): Promise<void> {
    const res = $<HTMLSelectElement>("set-resolution");
    const cur = await getResolution();
    if (![...res.options].some((o) => o.value === cur)) res.add(new Option(cur.replace("x", " × "), cur));
    res.value = cur;
    $("set-alias").textContent = keyLabel(this.prefs.pauseAlias);
    $<HTMLInputElement>("set-mouse").value = String(this.prefs.mouseSpeed);
    $("set-mouse-value").textContent = `${this.prefs.mouseSpeed}×`;
    $("set-status").textContent = "";
    $("settings-panel").hidden = false;
    $("play-panel").hidden = true;
  }

  close(): void {
    this.stopCapture();
    $("settings-panel").hidden = true;
    $("play-panel").hidden = false;
  }

  private startCapture(): void {
    this.capturing = true;
    $("set-alias").classList.add("capturing");
    $("set-alias").textContent = "Press a key…";
  }

  private stopCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    $("set-alias").classList.remove("capturing");
    $("set-alias").textContent = keyLabel(this.prefs.pauseAlias);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") return this.stopCapture();
    if (!isGameKey(e.code)) return; // a key the game cannot see; keep waiting
    this.prefs.pauseAlias = e.code;
    savePrefs(this.prefs);
    this.stopCapture();
  }
}
