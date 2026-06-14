export class Input {
  private canvas: HTMLCanvasElement;
  private keys: Map<string, boolean> = new Map();
  private mouseDeltaX: number = 0;
  private mouseDeltaY: number = 0;
  private mouseButtons: Map<number, boolean> = new Map();
  private isPointerLocked: boolean = false;

  // Track single-frame triggers (e.g., just pressed this frame)
  private keysPressedThisFrame: Set<string> = new Set();
  private keysReleasedThisFrame: Set<string> = new Set();
  private mouseButtonsPressedThisFrame: Set<number> = new Set();

  // Keys the game consumes — suppress their browser default while pointer-locked
  private static readonly GAME_KEYS = new Set([
    "KeyW", "KeyA", "KeyS", "KeyD",
    "Space", "KeyZ", "ShiftLeft", "ShiftRight", "KeyC", "ControlLeft", "ControlRight",
    "KeyR", "KeyX", "KeyP", "Digit4", "Numpad4",
  ]);

  // Reused result object so multiple readers per frame see the same delta without allocating
  private frameDelta = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.setupListeners();
  }

  private setupListeners(): void {
    // Keyboard
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    // Right-click is ADS, never a context menu
    this.canvas.addEventListener("contextmenu", this.onContextMenu);

    // Mouse Lock & Buttons
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);

    // Mouse Move (only if pointer is locked)
    window.addEventListener("mousemove", this.onMouseMove);

    // Pointer Lock Change
    document.addEventListener("pointerlockchange", this.onPointerLockChange);

    // Clear inputs when the page loses focus or is being replaced by Vite.
    window.addEventListener("blur", this.onClearInputs);
    window.addEventListener("pagehide", this.onClearInputs);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // While playing, game keys must not scroll the page or trigger buttons
    if (this.isPointerLocked && Input.GAME_KEYS.has(e.code)) {
      e.preventDefault();
    }
    if (!this.keys.get(e.code)) {
      this.keysPressedThisFrame.add(e.code);
    }
    this.keys.set(e.code, true);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.set(e.code, false);
    this.keysReleasedThisFrame.add(e.code);
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.isPointerLocked) {
      this.requestPointerLock();
      return;
    }
    if (!this.mouseButtons.get(e.button)) {
      this.mouseButtonsPressedThisFrame.add(e.button);
    }
    this.mouseButtons.set(e.button, true);
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.mouseButtons.set(e.button, false);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.isPointerLocked) {
      this.mouseDeltaX += e.movementX;
      this.mouseDeltaY += e.movementY;
    }
  };

  private onPointerLockChange = (): void => {
    this.isPointerLocked = document.pointerLockElement === this.canvas;
    if (!this.isPointerLocked) {
      this.clearAllInputs();
    }
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) this.clearAllInputs();
  };

  private onClearInputs = (): void => {
    this.clearAllInputs();
  };

  // Browsers enforce a cooldown after Escape exits pointer lock; the request
  // can reject or throw, which must not surface as a console error.
  public requestPointerLock(): void {
    try {
      const result = this.canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) {
        result.catch(() => {});
      }
    } catch {
      // ignore — user can simply click again after the cooldown
    }
  }

  // Mouse delta accumulated this frame. Non-destructive: every system reads the
  // same value, and the accumulator is reset once per frame in postUpdate().
  public getMouseDelta(): { x: number; y: number } {
    this.frameDelta.x = this.mouseDeltaX;
    this.frameDelta.y = this.mouseDeltaY;
    return this.frameDelta;
  }

  public isKeyDown(code: string): boolean {
    return !!this.keys.get(code);
  }

  public isKeyPressed(code: string): boolean {
    return this.keysPressedThisFrame.has(code);
  }

  public isKeyReleased(code: string): boolean {
    return this.keysReleasedThisFrame.has(code);
  }

  public isMouseButtonDown(button: number): boolean {
    return !!this.mouseButtons.get(button);
  }

  public isMouseButtonPressed(button: number): boolean {
    return this.mouseButtonsPressedThisFrame.has(button);
  }

  public getIsPointerLocked(): boolean {
    return this.isPointerLocked;
  }

  public clearAllInputs(): void {
    this.keys.clear();
    this.mouseButtons.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.keysPressedThisFrame.clear();
    this.keysReleasedThisFrame.clear();
    this.mouseButtonsPressedThisFrame.clear();
  }

  public dispose(): void {
    this.clearAllInputs();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    window.removeEventListener("blur", this.onClearInputs);
    window.removeEventListener("pagehide", this.onClearInputs);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  // Clear single-frame states at the end of the update loop
  public postUpdate(): void {
    this.keysPressedThisFrame.clear();
    this.keysReleasedThisFrame.clear();
    this.mouseButtonsPressedThisFrame.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }
}
