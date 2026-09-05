import { DefaultRenderingPipeline, ImageProcessingConfiguration, SSAO2RenderingPipeline } from "@babylonjs/core";
import type { Camera, Engine, Scene } from "@babylonjs/core";
import { Settings } from "../ui/Settings";
import type { GraphicsQuality } from "../ui/Settings";

// The image pipeline: resolution, anti-aliasing, ambient occlusion,
// sharpening, tone mapping and the film look — packaged as three quality
// tiers with an automatic step-down when the frame rate can't hold.
//
//   high        native device pixels (capped at 2x), 4x MSAA, SSAO, sharpen
//   balanced    1.5x pixels max, 2x MSAA + FXAA, sharpen
//   performance 1x pixels, FXAA only
//
// FXAA alone (the old setup) softens every texel; MSAA resolves geometry
// edges without touching texture detail, and the sharpen pass restores the
// micro-contrast the tone mapper and bloom take away.

interface Tier {
  maxPixelRatio: number;
  samples: number;
  fxaa: boolean;
  ssao: boolean;
  sharpen: number;
}

const TIERS: Record<GraphicsQuality, Tier> = {
  high: { maxPixelRatio: 2, samples: 4, fxaa: false, ssao: true, sharpen: 0.32 },
  balanced: { maxPixelRatio: 1.5, samples: 2, fxaa: true, ssao: false, sharpen: 0.28 },
  performance: { maxPixelRatio: 1, samples: 1, fxaa: true, ssao: false, sharpen: 0.2 },
};

const TIER_ORDER: GraphicsQuality[] = ["high", "balanced", "performance"];

export class PostProcessing {
  private engine: Engine;
  private scene: Scene;
  private camera: Camera;
  private pipeline: DefaultRenderingPipeline;
  private ssao: SSAO2RenderingPipeline | null = null;
  private quality: GraphicsQuality;
  private autoTuned = false;

  // Adaptive step-down bookkeeping: rolling average over the last seconds
  private fpsSamples: number[] = [];
  private onQualityChange: ((q: GraphicsQuality, auto: boolean) => void) | null = null;

  constructor(engine: Engine, scene: Scene, camera: Camera) {
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.quality = Settings.getGraphicsQuality();

    const p = new DefaultRenderingPipeline("postfx", true, scene, [camera]);
    p.imageProcessing.toneMappingEnabled = true;
    p.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    p.imageProcessing.exposure = 1.18;
    p.imageProcessing.contrast = 1.14;
    p.imageProcessing.vignetteEnabled = true;
    p.imageProcessing.vignetteWeight = 1.25;
    p.imageProcessing.vignetteStretch = 0.3;
    p.bloomEnabled = true;
    p.bloomThreshold = 0.86;
    p.bloomWeight = 0.14;
    p.bloomKernel = 48;
    p.bloomScale = 0.5;
    p.grainEnabled = true;
    p.grain.intensity = 4; // a whisper of film grain — enough to break banding, not to blur
    p.grain.animated = true;
    p.chromaticAberrationEnabled = true;
    p.chromaticAberration.aberrationAmount = 3;
    p.chromaticAberration.radialIntensity = 0.8; // only the corners fringe, the center stays clean
    p.sharpenEnabled = true;
    p.sharpen.colorAmount = 1.0;
    this.pipeline = p;

    this.apply();
  }

  public get currentQuality(): GraphicsQuality {
    return this.quality;
  }

  public setOnQualityChange(cb: (q: GraphicsQuality, auto: boolean) => void): void {
    this.onQualityChange = cb;
  }

  public setQuality(q: GraphicsQuality, persist: boolean = true): void {
    if (q === this.quality) return;
    this.quality = q;
    if (persist) Settings.setGraphicsQuality(q);
    this.apply();
    this.onQualityChange?.(q, !persist);
  }

  // Feed the measured frame rate once a second while a match is live. If
  // the rig can't hold a playable rate at the chosen tier, drop one tier —
  // once per session, so a slow first second (shader warm-up) can't cascade
  // the game into the lowest setting.
  public reportFps(fps: number): void {
    if (this.autoTuned || fps <= 0) return;
    this.fpsSamples.push(fps);
    if (this.fpsSamples.length < 5) return;
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    this.fpsSamples.length = 0;
    const i = TIER_ORDER.indexOf(this.quality);
    if (avg < 45 && i < TIER_ORDER.length - 1) {
      this.autoTuned = true;
      this.setQuality(TIER_ORDER[i + 1], false);
    }
  }

  private apply(): void {
    const tier = TIERS[this.quality];
    const dpr = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio);
    this.engine.setHardwareScalingLevel(1 / dpr);

    const p = this.pipeline;
    p.samples = tier.samples;
    p.fxaaEnabled = tier.fxaa;
    p.sharpen.edgeAmount = tier.sharpen;
    // bloom is a screen-space blur: keep its footprint constant in pixels
    p.bloomKernel = Math.round(48 * Math.max(1, dpr * 0.75));

    if (tier.ssao && !this.ssao) {
      // Ambient occlusion: contact shadow where containers meet the grass,
      // crates meet the ground, the rifle meets the hands. Half-res AO
      // buffer with a bilateral blur — the "grounding" the flat ambient
      // light otherwise lacks.
      const ssao = new SSAO2RenderingPipeline("ssao", this.scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [this.camera]);
      ssao.radius = 1.4;
      ssao.totalStrength = 1.15;
      ssao.base = 0.12;
      ssao.samples = 12;
      ssao.maxZ = 60;
      ssao.minZAspect = 0.4;
      ssao.expensiveBlur = false;
      this.ssao = ssao;
    } else if (!tier.ssao && this.ssao) {
      this.ssao.dispose();
      this.ssao = null;
    }
  }

  public dispose(): void {
    this.ssao?.dispose();
    this.pipeline.dispose();
  }
}
