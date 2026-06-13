// Minimal typed pub/sub between gameplay code and the match UI. The hitscan
// helper and the bots emit; MatchUI listens. Keeps Bot/WeaponTypes free of
// any DOM knowledge and avoids import cycles through the UI layer.

export interface KillEvent {
  headshot: boolean;
  cause: "player" | "airstrike" | "apache"; // kill-feed attribution: your gun, or your streak
}

export interface PlayerDeathEvent {
  weaponId: string; // bot weapon profile id (or streak name) that landed the killing round
  self?: boolean; // true when the player's own airstrike got them
}

interface EventMap {
  kill: KillEvent;
  playerDeath: PlayerDeathEvent;
}

class MatchEventBus {
  // Values are heterogenous per key; the generic accessors below restore type
  // safety at the call sites
  private handlers = new Map<keyof EventMap, Array<(e: never) => void>>();

  public on<K extends keyof EventMap>(type: K, fn: (e: EventMap[K]) => void): void {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(fn as (e: never) => void);
  }

  public emit<K extends keyof EventMap>(type: K, e: EventMap[K]): void {
    const list = this.handlers.get(type) as Array<(e: EventMap[K]) => void> | undefined;
    if (!list) return;
    for (const fn of list) fn(e);
  }

  public clear(): void {
    this.handlers.clear();
  }
}

export const MatchEvents = new MatchEventBus();
