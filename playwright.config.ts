import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.mjs",
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1, // GPU-heavy scenes compete when several browsers run together.
  maxFailures: process.env.CI ? 1 : 0, // Stop a runner after a confirmed failure; keep its diagnostics.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:3001", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium", // Full headless Chromium supports real pointer lock.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      command: "npm run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:3001",
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: "npm run build:pages && npm run preview -- --host 127.0.0.1 --port 4173 --base=/Fall-of-Duty/",
      url: "http://127.0.0.1:4173/Fall-of-Duty/",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
