import "./style.css";
import type { Game } from "./engine/Game";

let game: Game | null = null;
let generation = 0;
let reloadOnRetry = false;
const listeners = new AbortController();
const gameWindow = window as unknown as { __game?: Game };
const startButton = document.getElementById("btn-start") as HTMLButtonElement;
const retryButton = document.getElementById("btn-retry") as HTMLButtonElement;
const status = document.getElementById("startup-status")!;
const message = document.getElementById("startup-message")!;

function setStartupState(state: "loading" | "ready" | "error", text: string): void {
  startButton.disabled = state !== "ready";
  status.classList.toggle("hidden", state === "ready");
  status.classList.toggle("startup-error", state === "error");
  status.setAttribute("role", state === "error" ? "alert" : "status");
  retryButton.classList.toggle("hidden", state !== "error");
  message.textContent = text;
}

const startGame = async (): Promise<void> => {
  const current = ++generation;
  game?.dispose();
  game = null;
  delete gameWindow.__game;
  setStartupState("loading", "Loading the yard and soldier…");
  const timer = window.setTimeout(() => {
    if (current !== generation) return;
    generation++;
    game?.dispose();
    game = null;
    setStartupState("error", "Loading timed out. Check your connection and try again.");
  }, 45000);
  try {
    if (typeof HTMLCanvasElement.prototype.requestPointerLock !== "function") {
      throw new Error("Mouse capture is unavailable. Open the game in desktop Chrome, Edge or Firefox.");
    }
    // Keep the loading UI available while the game bundle downloads. Console
    // tools are downloaded only in development builds.
    reloadOnRetry = true;
    const { Game } = await import("./engine/Game");
    if (current !== generation) return;
    reloadOnRetry = false;
    const next = new Game("renderCanvas");
    game = next;
    await next.ready;
    if (current !== generation) return;
    if (import.meta.env.DEV) {
      reloadOnRetry = true;
      const { installDevTools } = await import("./engine/DevTools");
      if (current !== generation) return;
      reloadOnRetry = false;
      gameWindow.__game = next;
      installDevTools(next);
    }
    setStartupState("ready", "Ready");
  } catch (error) {
    if (current !== generation) return;
    game?.dispose();
    game = null;
    const detail = error instanceof Error ? error.message : "Unknown loading error";
    setStartupState("error", `Could not load the game. ${detail}`);
    console.error("Failed to initialize game:", error);
  } finally {
    clearTimeout(timer);
  }
};

retryButton.addEventListener(
  "click",
  () => {
    // Browsers cache failed module imports. A fresh document can download the
    // bundle again; asset/renderer failures only need a new game instance.
    if (reloadOnRetry) window.location.reload();
    else void startGame();
  },
  { signal: listeners.signal }
);
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => void startGame(), { once: true, signal: listeners.signal });
} else {
  void startGame();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    generation++;
    listeners.abort();
    game?.dispose();
    if (gameWindow.__game === game) delete gameWindow.__game;
    game = null;
  });
}
