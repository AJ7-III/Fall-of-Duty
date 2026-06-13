import "./style.css";
import { Game } from "./engine/Game";

let game: Game | null = null;
const gameWindow = window as unknown as { __game?: Game };

const startGame = (): void => {
  try {
    gameWindow.__game?.dispose();
    game = new Game("renderCanvas");
    if (import.meta.env.DEV) {
      // Debug handle for console inspection (FPS hitches, weapon state, etc.)
      gameWindow.__game = game;
    }
  } catch (err) {
    console.error("Failed to initialize game:", err);
  }
};

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", startGame);
} else {
  startGame();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("DOMContentLoaded", startGame);
    game?.dispose();
    if (gameWindow.__game === game) delete gameWindow.__game;
    game = null;
  });
}
