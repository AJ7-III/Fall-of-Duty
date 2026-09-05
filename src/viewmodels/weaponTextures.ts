import type { DynamicTexture, Scene } from "@babylonjs/core";
import { makeCanvasTexture, paintNoise } from "../rendering/materials/canvas";
import { cachedTexture } from "./kit";

// Painted finishes shared by the weapon viewmodels: knurled steel, stippled
// polymer, worn phosphate, laminated wartime wood, and the stock camo.

export function knurlTexture(scene: Scene): DynamicTexture {
  return cachedTexture(scene, "knurlTex", () => {
    const tex = makeCanvasTexture(scene, "knurlTex", 128, (ctx, s) => {
      ctx.fillStyle = "#131418";
      ctx.fillRect(0, 0, s, s);
      for (let x = 0; x < s; x += 8) {
        ctx.fillStyle = "#373b42"; // lit ridge
        ctx.fillRect(x, 0, 2, s);
        ctx.fillStyle = "#07080a"; // groove
        ctx.fillRect(x + 4, 0, 2, s);
      }
      paintNoise(ctx, s, ["#23252b"], 40, 2, 6, 0.18);
    });
    tex.uScale = 8;
    return tex;
  });
}

export function stippleTexture(scene: Scene): DynamicTexture {
  return cachedTexture(scene, "uspStippleTex", () => {
    return makeCanvasTexture(scene, "uspStippleTex", 256, (ctx, s) => {
      ctx.fillStyle = "#191a1d";
      ctx.fillRect(0, 0, s, s);
      // staggered raised dots: lit crown upper-left, shadow lower-right
      const step = 14;
      for (let row = 0; row * step < s + step; row++) {
        const xOff = (row % 2) * (step / 2);
        for (let col = -1; col * step < s + step; col++) {
          const x = col * step + xOff;
          const y = row * step;
          ctx.fillStyle = "#08090b";
          ctx.beginPath();
          ctx.arc(x + 1.4, y + 1.4, 4.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#33363c";
          ctx.beginPath();
          ctx.arc(x, y, 3.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#4a4e55";
          ctx.beginPath();
          ctx.arc(x - 1.1, y - 1.1, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // border band so panel edges read as a frame
      ctx.strokeStyle = "#0c0d0f";
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, s - 10, s - 10);
      // wear: dots polished shiny where the palm rides
      paintNoise(ctx, s, ["#565a61"], 26, 3, 9, 0.18);
    });
  });
}

export function polymerTexture(scene: Scene): DynamicTexture {
  return cachedTexture(scene, "uspPolymerTex", () => {
    return makeCanvasTexture(scene, "uspPolymerTex", 256, (ctx, s) => {
      ctx.fillStyle = "#222428";
      ctx.fillRect(0, 0, s, s);
      paintNoise(ctx, s, ["#1c1e22", "#282b30", "#1f2125"], 240, 4, 18, 0.4);
      paintNoise(ctx, s, ["#383c43", "#15161a"], 500, 1, 2, 0.3);
      // mold parting lines
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = "#0f1013";
      ctx.lineWidth = 2;
      for (const y of [s * 0.3, s * 0.72]) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(s, y);
        ctx.stroke();
      }
      // scuffs
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = "#3f444b";
      ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const x = Math.random() * s,
          y = Math.random() * s,
          a = Math.random() * Math.PI;
        const len = 8 + Math.random() * 30;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  });
}

export function mp44MetalTexture(scene: Scene): DynamicTexture {
  return cachedTexture(scene, "mp44MetalTex", () => {
    return makeCanvasTexture(scene, "mp44MetalTex", 512, (ctx, s) => {
      ctx.fillStyle = "#111519";
      ctx.fillRect(0, 0, s, s);
      paintNoise(ctx, s, ["#0b0e11", "#171c21", "#20262c", "#090b0d"], 360, 5, 28, 0.38);
      paintNoise(ctx, s, ["#2b3239", "#38414a"], 80, 2, 9, 0.16);

      // long stamped flats and folded seams
      ctx.globalAlpha = 0.32;
      for (const y of [74, 132, 246, 308, 388]) {
        const grad = ctx.createLinearGradient(0, y - 7, 0, y + 7);
        grad.addColorStop(0, "#07090b");
        grad.addColorStop(0.48, "#313840");
        grad.addColorStop(1, "#07090b");
        ctx.fillStyle = grad;
        ctx.fillRect(0, y - 2, s, 4);
      }
      ctx.globalAlpha = 1;

      // edge chips and handling scratches
      ctx.strokeStyle = "rgba(180,188,188,0.34)";
      ctx.lineCap = "round";
      for (let i = 0; i < 48; i++) {
        const x = Math.random() * s;
        const y = Math.random() * s;
        const len = 8 + Math.random() * 42;
        const a = (Math.random() - 0.5) * 0.5;
        ctx.globalAlpha = 0.12 + Math.random() * 0.24;
        ctx.lineWidth = 1 + Math.random() * 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  });
}

export function mp44WoodTexture(scene: Scene): DynamicTexture {
  return cachedTexture(scene, "mp44WoodTex", () => {
    return makeCanvasTexture(scene, "mp44WoodTex", 512, (ctx, s) => {
      const base = ctx.createLinearGradient(0, 0, s, 0);
      base.addColorStop(0, "#24170e");
      base.addColorStop(0.45, "#3b2414");
      base.addColorStop(0.7, "#1f130b");
      base.addColorStop(1, "#4a2e19");
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);

      for (let i = 0; i < 26; i++) {
        const y = Math.random() * s;
        const wobble = 10 + Math.random() * 30;
        ctx.strokeStyle = i % 3 === 0 ? "rgba(95,58,28,0.5)" : "rgba(18,10,5,0.42)";
        ctx.lineWidth = 1.2 + Math.random() * 3.2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= s; x += 36) {
          ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * wobble + (Math.random() - 0.5) * 10);
        }
        ctx.stroke();
      }
      paintNoise(ctx, s, ["#120a05", "#5a351a", "#2b180b"], 180, 3, 20, 0.28);

      // pressure dents and gouges
      ctx.strokeStyle = "rgba(8,5,3,0.45)";
      for (let i = 0; i < 20; i++) {
        const x = Math.random() * s,
          y = Math.random() * s;
        ctx.lineWidth = 1 + Math.random() * 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 12 + Math.random() * 35, y + (Math.random() - 0.5) * 9);
        ctx.stroke();
      }
    });
  });
}

export function camoTexture(scene: Scene): DynamicTexture {
  return cachedTexture(scene, "camoTex", () => {
    return makeCanvasTexture(scene, "camoTex", 256, (ctx) => {
      ctx.fillStyle = "#b1a384";
      ctx.fillRect(0, 0, 256, 256);

      const blotchColors = ["#8d7f63", "#75705a", "#a09a7e", "#5f5c4a", "#c2b694"];
      for (let i = 0; i < 55; i++) {
        ctx.fillStyle = blotchColors[i % blotchColors.length];
        ctx.beginPath();
        ctx.ellipse(
          Math.random() * 256,
          Math.random() * 256,
          8 + Math.random() * 26,
          6 + Math.random() * 18,
          Math.random() * Math.PI,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      // fine speckle grain
      for (let i = 0; i < 350; i++) {
        ctx.fillStyle = i % 2 === 0 ? "rgba(60,56,44,0.35)" : "rgba(205,196,168,0.3)";
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
    });
  });
}
