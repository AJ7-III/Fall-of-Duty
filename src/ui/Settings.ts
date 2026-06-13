// Persisted client-side game settings (localStorage-backed). Kept tiny and
// dependency-free so both the UI layer (which toggles a setting) and the
// systems that consume it (e.g. RivalVoice reading its initial mute state)
// can share one source of truth without a circular import.

const TRASH_TALK_KEY = "cod420.muteTrashTalk";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback; // storage disabled (private mode / blocked) — use default
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // storage disabled — the setting simply won't persist across reloads
  }
}

export const Settings = {
  getTrashTalkMuted(): boolean {
    return readBool(TRASH_TALK_KEY, true);
  },
  setTrashTalkMuted(muted: boolean): void {
    writeBool(TRASH_TALK_KEY, muted);
  },
};
