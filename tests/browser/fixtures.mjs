import { test as base, expect } from "@playwright/test";

// Native pointer lock can capture the desktop cursor even in a hidden browser.
// Require an explicit opt-in; CI workflows enable it in their isolated runners.
const nativeCapture = process.env.FOD_REAL_POINTER_LOCK === "1";

export const test = base.extend({
  page: async ({ page }, use) => {
    if (!nativeCapture) {
      await page.addInitScript(() => {
        let locked = null;
        Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => locked });
        HTMLCanvasElement.prototype.requestPointerLock = function () {
          locked = this;
          queueMicrotask(() => document.dispatchEvent(new Event("pointerlockchange")));
          return Promise.resolve();
        };
        document.exitPointerLock = () => {
          locked = null;
          queueMicrotask(() => document.dispatchEvent(new Event("pointerlockchange")));
        };
      });
    }
    await use(page);
  },
});

export { expect };
