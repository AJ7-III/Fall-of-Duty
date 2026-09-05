import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// Dev-only endpoint: the game's debug hook (Game.captureFrame) posts a PNG of
// the rendered frame here so a frame can be inspected at full resolution
// without a live mouse. Writes into ./.screenshots (git-ignored).
function devScreenshots(): Plugin {
  return {
    name: "fall-of-duty-dev-screenshots",
    apply: "serve",
    configureServer(server) {
      const dir = process.env.FOD_SCREENSHOT_DIR ?? join(process.cwd(), ".screenshots");
      server.middlewares.use("/__dev/screenshot", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", () => {
          try {
            const { name, dataUrl } = JSON.parse(body) as { name: string; dataUrl: string };
            const safe = String(name).replace(/[^a-z0-9_-]/gi, "_");
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `${safe}.png`);
            writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ file }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves from /<repo>/; local dev and other hosts from /
  base: process.env.FOD_BASE ?? "/",
  plugins: [devScreenshots()],
  server: {
    host: "0.0.0.0",
    port: 3001,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 3001,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
