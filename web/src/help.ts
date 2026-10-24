/**
 * The controls list: what the game's keys and the mouse do, plus the browser's own keys. Shown
 * once before the first start, then from the play panel's Controls button or with F1 / the HUD's Controls button in game.
 */
import type { Prefs } from "./prefs.ts";
import { keyLabel } from "./settings.ts";

const SEEN = "hitman.controlsSeen";

export class Help {
  isOpen = false;
  private closeHandler: (() => void) | null = null;
  private readonly prefs: Prefs;
  private readonly el: HTMLElement;

  constructor(prefs: Prefs) {
    this.prefs = prefs;
    this.el = document.getElementById("help")!;
    document.getElementById("help-close")!.addEventListener("click", () => this.hide());
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
    // Capture phase: F1 / Esc close the list before the game's input handler sees them.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.isOpen || (e.code !== "Escape" && e.code !== "F1")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) this.hide(); // a held key toggles once
      },
      true,
    );
  }

  get seen(): boolean {
    try {
      return localStorage.getItem(SEEN) === "1";
    } catch {
      return true;
    }
  }

  /**
   * Show the list; `onClose` runs when this showing of it is closed. (A handler kept across
   * showings was consumed by the first close, so the game, paused while the list is open, never
   * resumed after the second.)
   */
  async show(closeLabel = "Close", onClose: (() => void) | null = null): Promise<void> {
    if (this.isOpen) return;
    this.isOpen = true;
    this.closeHandler = onClose;
    this.render(closeLabel);
    // In fullscreen only the fullscreen element's subtree is visible.
    (document.fullscreenElement ?? document.body).append(this.el);
    this.el.hidden = false;
    document.getElementById("help-close")!.focus();
    try {
      localStorage.setItem(SEEN, "1");
    } catch {
      // Shown again next time.
    }
  }

  hide(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.isOpen = false;
    const done = this.closeHandler;
    this.closeHandler = null;
    done?.();
  }

  private render(closeLabel: string): void {
    document.getElementById("help-close")!.textContent = closeLabel;
    const alias = this.prefs.pauseAlias;
    const other: [string, string][] = [
      ["F1", "Show or hide this controls list (the game pauses meanwhile)"],
      ["Arrow keys / numpad / WASD", "Move (the key scheme is set in the game's Options → Controls; the default scheme uses the numeric keypad)"],
      ["Space", "Use / open doors and pick things up; confirm choices in menus"],
      ["Mouse", "Menus and aiming; click the game first to capture the mouse"],
      ["Esc", "Pause and open the in-game menu"],
      ["Arrow keys, Enter, Esc", "Navigate menus when a list or dialog is open"],
    ];
    if (alias) other.push([keyLabel(alias), "Works as Esc where the browser keeps Esc (fullscreen, captured mouse)"]);
    other.push(["Fullscreen", "Button at the top right of the game (move the mouse to show it); in Chrome and Edge hold Esc to leave"]);
    list("help-other", other);
  }
}

function list(id: string, items: [string, string][]): void {
  document.getElementById(id)!.replaceChildren(
    ...items.map(([k, v]) => {
      const li = document.createElement("li");
      const b = document.createElement("strong");
      b.textContent = k;
      li.append(b, ` — ${v}`);
      return li;
    }),
  );
}
