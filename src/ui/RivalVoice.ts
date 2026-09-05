import { MatchEvents } from "./MatchEvents";
import { RIVAL_DISPLAY_NAME } from "./MatchNames";
import { Settings } from "./Settings";

const MATCH_TALK_EVENTS = 10;
const VOICE_VOLUME = 0.602;

// The rival's voice lines, bundled from src/assets/voice by Vite: the ones
// they play over your corpse, the ones they spit when you drop them, and
// the opening line as the match goes live
const clipUrls = (glob: Record<string, string>): string[] =>
  Object.keys(glob)
    .sort()
    .map((k) => glob[k]);
const KILL_CLIPS = clipUrls(
  import.meta.glob("../assets/voice/taunt-victory-*.wav", { eager: true, query: "?url", import: "default" })
);
const DEATH_CLIPS = clipUrls(
  import.meta.glob("../assets/voice/taunt-kill-*.wav", { eager: true, query: "?url", import: "default" })
);
const START_CLIPS = clipUrls(
  import.meta.glob("../assets/voice/match-start-*.wav", { eager: true, query: "?url", import: "default" })
);

export class RivalVoice {
  private indicatorEl = document.getElementById("voice-comms");
  private nameEl = document.getElementById("voice-name");
  private deathDeck: string[] = [];
  private victoryDeck: string[] = [];
  private deathTalkGate: boolean[] = [];
  private victoryTalkGate: boolean[] = [];
  private currentAudio: HTMLAudioElement | null = null;
  private playToken = 0;
  private muted = Settings.getTrashTalkMuted();

  constructor() {
    if (this.nameEl) this.nameEl.innerText = RIVAL_DISPLAY_NAME;
    this.resetMatch();

    // "kill" is the player scoring: the rival curses. "playerDeath" is the
    // rival scoring: they gloat.
    MatchEvents.on("kill", () => this.maybePlay(this.deathDeck, this.deathTalkGate));
    MatchEvents.on("playerDeath", (e) => {
      if (!e.self) this.maybePlay(this.victoryDeck, this.victoryTalkGate);
    });
  }

  public resetMatch(): void {
    this.stop();
    this.deathDeck = this.shuffled(DEATH_CLIPS);
    this.victoryDeck = this.shuffled(KILL_CLIPS);
    this.deathTalkGate = this.shuffledTalkGate(MATCH_TALK_EVENTS);
    this.victoryTalkGate = this.shuffledTalkGate(MATCH_TALK_EVENTS);
  }

  // The opening line as the match goes live
  public matchStart(): void {
    if (this.muted) return;
    this.playFrom(this.shuffled(START_CLIPS));
  }

  public dispose(): void {
    this.stop();
  }

  // "Mute Trash Talk" toggle: silence the rival's voice comms and cut off
  // anything mid-sentence the moment it's switched on.
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  private maybePlay(deck: string[], talkGate: boolean[] = []): void {
    if (this.muted) return;
    if (!talkGate.pop()) return;
    this.playFrom(deck);
  }

  private playFrom(deck: string[]): void {
    if (this.currentAudio || deck.length === 0) return;
    const src = deck.pop();
    if (!src) return;

    const audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = VOICE_VOLUME;
    const token = ++this.playToken;

    const finish = (): void => {
      if (this.currentAudio !== audio || this.playToken !== token) return;
      this.currentAudio = null;
      this.hide();
    };

    audio.addEventListener("ended", finish, { once: true });
    audio.addEventListener("error", finish, { once: true });
    audio.addEventListener("abort", finish, { once: true });
    this.currentAudio = audio;
    this.show();
    void audio.play().catch(finish);
  }

  private stop(): void {
    const audio = this.currentAudio;
    this.playToken++;
    this.currentAudio = null;
    if (audio) {
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // Some browsers reject seeks before metadata is ready.
      }
    }
    this.hide();
  }

  private show(): void {
    this.indicatorEl?.classList.add("speaking");
    this.indicatorEl?.setAttribute("aria-hidden", "false");
  }

  private hide(): void {
    this.indicatorEl?.classList.remove("speaking");
    this.indicatorEl?.setAttribute("aria-hidden", "true");
  }

  private shuffled(urls: readonly string[]): string[] {
    const deck = [...urls];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  private shuffledTalkGate(eventCount: number): boolean[] {
    const gate: boolean[] = [];
    for (let i = 0; i < eventCount; i += 2) {
      if (Math.random() < 0.5) gate.push(true, false);
      else gate.push(false, true);
    }
    return gate.slice(0, eventCount).reverse();
  }
}
