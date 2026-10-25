/**
 * Browser-only preferences (the game's own settings live in Hitman.ini). Kept in this
 * site's localStorage; every access tolerates storage being unavailable.
 */
export interface Prefs {
  /** KeyboardEvent.code that the game also receives as Escape. */
  pauseAlias: string;
  /** Unused (kept so stored preferences keep loading). */
  autoResolution: boolean;
  /** Gain on mouse motion. The game moves its cursor by 0.4 of the motion it receives; 2.5 makes it follow the hand. */
  mouseSpeed: number;
}

const KEY = "hitman.prefs";
export const DEFAULT_PREFS: Prefs = { pauseAlias: "Backquote", autoResolution: false, mouseSpeed: 2.5 };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private windows may refuse storage; the defaults apply next time.
  }
}
