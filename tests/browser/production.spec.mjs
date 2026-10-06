import { mkdirSync } from "node:fs";
import { test, expect, waitForStartup } from "./fixtures.mjs";

test("production game works under the GitHub Pages base path", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.addInitScript(() => localStorage.setItem("fallOfDuty.graphics", "performance"));
  await page.goto("http://127.0.0.1:4173/Fall-of-Duty/");
  await waitForStartup(page);
  expect(await page.evaluate(() => ({ game: typeof window.__game, tools: typeof window.fod }))).toEqual({
    game: "undefined",
    tools: "undefined",
  });
  await page.evaluate(() => {
    window.__captureReady = new Promise((resolve) => {
      document.addEventListener("pointerlockchange", () => resolve(Boolean(document.pointerLockElement)), { once: true });
    });
  });
  await page.locator("#btn-start").click();
  expect(await page.evaluate(() => window.__captureReady)).toBe(true);
  // Firefox's automation protocol cannot send mouse events while native
  // pointer lock is active. Dispatch the input events to its captured canvas.
  await page.locator("#renderCanvas").dispatchEvent("mousedown", { button: 0 });
  await page.locator("#renderCanvas").dispatchEvent("mouseup", { button: 0 });
  await expect(page.locator("#ammo-clip")).not.toHaveText("30");
  await page.keyboard.press("KeyR");
  await expect(page.locator("#ammo-clip")).toHaveText("30");
  if (process.env.FOD_CAPTURE_DOCS && testInfo.project.name === "chromium") {
    mkdirSync("docs/images", { recursive: true });
    await page.screenshot({ path: "docs/images/gameplay.png" });
  }
  await page.keyboard.press("KeyP");
  await expect(page.locator("#menu-overlay")).toBeVisible();
  await page.locator("#btn-end").click();
  await expect(page.locator("#end-overlay")).toBeVisible();
  await page.locator("#btn-again").click();
  await expect(page.locator("#end-overlay")).toBeHidden();
  expect(errors).toEqual([]);
});
