import { test as base, expect } from "@playwright/test";

// Native pointer lock can capture the desktop cursor even in a hidden browser.
// Require an explicit opt-in; CI workflows enable it in their isolated runners.
const nativeCapture = process.env.FOD_REAL_POINTER_LOCK === "1";

export const test = base.extend({
  runtimeDiagnostics: [
    async ({ page }, use, testInfo) => {
      const messages = [];
      const record = (entry) => {
        if (messages.length === 100) messages.shift();
        messages.push(entry);
      };
      page.on("console", (message) => record({ kind: "console", type: message.type(), text: message.text().slice(0, 2000) }));
      page.on("pageerror", (error) => record({ kind: "pageerror", text: error.message, stack: error.stack }));
      page.on("requestfailed", (request) =>
        record({ kind: "requestfailed", url: request.url(), resourceType: request.resourceType(), failure: request.failure() })
      );
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      let startup;
      try {
        startup = await Promise.race([
          page.evaluate(() => ({
            url: location.href,
            message: document.getElementById("startup-message")?.textContent,
            status: document.getElementById("startup-status")?.getAttribute("role"),
            startDisabled: document.getElementById("btn-start")?.disabled,
            readyState: document.readyState,
            visibility: document.visibilityState,
            gamePresent: Boolean(window.__game),
            toolsPresent: Boolean(window.fod),
          })),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Startup snapshot timed out")), 2000)),
        ]);
      } catch (error) {
        startup = { url: page.url(), snapshotError: error.message };
      }
      const diagnostics = { test: testInfo.title, status: testInfo.status, startup, messages };
      await testInfo.attach("startup-diagnostics", {
        body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
        contentType: "application/json",
      });
      const failures = messages.filter((entry) => entry.kind !== "console" || entry.type === "error").slice(-6);
      console.error(`[startup diagnostics] ${JSON.stringify({ test: testInfo.title, startup, failures })}`);
    },
    { auto: true },
  ],
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

export async function waitForStartup(page) {
  await page.waitForFunction(
    () => {
      const button = document.getElementById("btn-start");
      return (button && !button.disabled) || document.getElementById("startup-status")?.getAttribute("role") === "alert";
    },
    null,
    { timeout: 185000 }
  );
  const message = await page.locator("#startup-message").textContent();
  await expect(page.locator("#btn-start"), `Startup did not become ready: ${message}`).toBeEnabled({ timeout: 1000 });
}
