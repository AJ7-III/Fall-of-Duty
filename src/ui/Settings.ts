// Persisted client-side game settings (localStorage-backed). Kept tiny and
// dependency-free so both the UI layer (which toggles a setting) and the
// systems that consume it (e.g. RivalVoice reading its initial mute state)
// can share one source of truth without a circular import.

const TRASH_TALK_KEY = "fallOfDuty.muteTrashTalk";
const GRAPHICS_KEY = "fallOfDuty.graphics";

export type GraphicsQuality = "high" | "balanced" | "performance";
const GRAPHICS_LEVELS: ReadonlyArray<GraphicsQuality> = ["high", "balanced", "performance"];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage disabled (private mode / blocked) — use defaults
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage disabled — the setting simply won't persist across reloads
  }
}

export const Settings = {
  getTrashTalkMuted(): boolean {
    const v = read(TRASH_TALK_KEY);
    return v === null ? true : v === "1";
  },
  setTrashTalkMuted(muted: boolean): void {
    write(TRASH_TALK_KEY, muted ? "1" : "0");
  },
  getGraphicsQuality(): GraphicsQuality {
    const v = read(GRAPHICS_KEY) as GraphicsQuality | null;
    return v && GRAPHICS_LEVELS.includes(v) ? v : "high";
  },
  setGraphicsQuality(q: GraphicsQuality): void {
    write(GRAPHICS_KEY, q);
  },
};
