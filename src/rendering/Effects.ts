import {
  Scene,
  Vector3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  PointLight,
  Quaternion,
  Matrix,
  DynamicTexture,
} from "@babylonjs/core";

export class Effects {
  private audioCtx: AudioContext | null = null;
  private hitMarkerEl: HTMLElement | null = null;
  private hitMarkerTimeout: ReturnType<typeof setTimeout> | null = null;

  // --- Pooled muzzle flashes ---
  // The light lives forever at intensity 0: adding/removing a light at
  // runtime changes every material's shader defines (recompile hitch on the
  // first shot, dirty-flag sweeps on every shot). Pooling keeps the scene's
  // light count constant. Each flash is two additive billboard quads
  // (star burst + hot core) animated per frame — they bloom outward and die
  // over ~85ms instead of blinking off. Only mesh-level properties
  // (scaling/visibility) and the light intensity animate, so the frozen
  // material never needs rebinding. A small round-robin pool lets the player
  // and several bots flash in the same instant; the single light rides the
  // newest flash (a second light would change every material's defines).
  private static readonly FLASH_POOL = 3;
  private static readonly FLASH_TIME = 0.085;
  private flashLight: PointLight;
  private flashes: Array<{ star: Mesh; core: Mesh; life: number; scale: number }> = [];
  private flashCursor = 0;

  // --- Pooled tracers (incoming bot fire) ---
  // A thin additive cylinder stretched muzzle-to-impact, fading over ~80ms.
  // Hitscan means the whole streak exists at once; the fade sells the motion.
  private static readonly TRACER_POOL = 10;
  private static readonly TRACER_TIME = 0.08;
  private static readonly Y_AXIS = new Vector3(0, 1, 0);
  private tracers: Array<{ mesh: Mesh; life: number }> = [];
  private tracerCursor = 0;
  private tmpDir = new Vector3();

  // --- Pooled explosions (airstrike bombs) ---
  // Same recipe as the muzzle flashes, scaled up: an additive fire-blob
  // billboard that blooms and dies in half a second, under a column of
  // alpha-blended smoke puffs that rise and fade. The explosion light is
  // created at startup (intensity 0) for the same reason the flash light is:
  // adding a light at runtime would recompile every frozen material.
  private static readonly FIRE_POOL = 5;
  private static readonly FIRE_TIME = 0.5;
  private static readonly SMOKE_POOL = 12;
  private explosionLight!: PointLight;
  private fireballs: Array<{ mesh: Mesh; life: number }> = [];
  private fireCursor = 0;
  private smokes: Array<{ mesh: Mesh; life: number; max: number; vy: number; grow: number }> = [];
  private smokeCursor = 0;

  // --- Apache rotor loop ---
  // One looping chopped-noise patch, started lazily, volume driven per-frame
  // by the helicopter's distance to the player and muted while paused.
  private rotorNodes: { src: AudioBufferSourceNode; lfo: OscillatorNode; gain: GainNode } | null = null;
  private rotorVol = 0;
  private rotorMuted = false;

  // --- Persistent bullet holes (thin instances) ---
  // Every hole in the world is a thin instance of one flat disc: one mesh,
  // one material, one draw call no matter how many shots have landed, and
  // the holes never expire. Past MAX_HOLES the ring buffer recycles the
  // oldest hole, so memory stays bounded for arbitrarily long sessions.
  private static readonly MAX_HOLES = 512;
  private holeMesh: Mesh;
  private holeBuffer = new Float32Array(Effects.MAX_HOLES * 16);
  private holeCursor = 0;
  private holeCount = 0;

  // Scratch objects reused across shots — no per-shot allocations
  private static readonly DISC_AXIS = new Vector3(0, 0, 1);
  private static readonly UNIT_SCALE = new Vector3(1, 1, 1);
  private tmpQuat = new Quaternion();
  private tmpMat = new Matrix();
  private tmpPos = new Vector3();

  // Gunshot noise — generated once, reused for every shot (the buffer is
  // 24k random samples; rebuilding it per trigger pull is pure GC churn)
  private noiseBuffer: AudioBuffer | null = null;

  constructor(scene: Scene) {
    this.hitMarkerEl = document.getElementById("hit-marker");

    // Muzzle flash pool: one light + two billboard quads, parked until a shot
    this.flashLight = new PointLight("muzzleFlashLight", Vector3.Zero(), scene);
    this.flashLight.diffuse = new Color3(1, 0.7, 0.2);
    this.flashLight.intensity = 0;
    this.flashLight.range = 10;

    // Star-burst texture: hot white core, amber halo, eight tapered spikes.
    // Black background + additive blending means no alpha channel needed.
    const flashTex = new DynamicTexture("muzzleFlashTex", { width: 128, height: 128 }, scene, true);
    const fctx = flashTex.getContext() as CanvasRenderingContext2D;
    fctx.fillStyle = "#000000";
    fctx.fillRect(0, 0, 128, 128);
    fctx.save();
    fctx.translate(64, 64);
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8 + (i % 2) * 0.18;
      const len = i % 2 === 0 ? 58 : 36; // long/short alternating spikes
      fctx.save();
      fctx.rotate(a);
      const spike = fctx.createLinearGradient(0, 0, len, 0);
      spike.addColorStop(0, "rgba(255, 214, 130, 0.95)");
      spike.addColorStop(0.5, "rgba(255, 158, 64, 0.45)");
      spike.addColorStop(1, "rgba(120, 50, 10, 0)");
      fctx.fillStyle = spike;
      fctx.beginPath();
      fctx.moveTo(2, -4.5);
      fctx.lineTo(len, 0);
      fctx.lineTo(2, 4.5);
      fctx.closePath();
      fctx.fill();
      fctx.restore();
    }
    fctx.restore();
    const core = fctx.createRadialGradient(64, 64, 2, 64, 64, 26);
    core.addColorStop(0, "#fff8e6");
    core.addColorStop(0.4, "#ffd07a");
    core.addColorStop(1, "rgba(110, 45, 8, 0)");
    fctx.fillStyle = core;
    fctx.beginPath();
    fctx.arc(64, 64, 26, 0, Math.PI * 2);
    fctx.fill();
    flashTex.update();

    const flashMat = new StandardMaterial("flashMat", scene);
    flashMat.emissiveTexture = flashTex;
    flashMat.diffuseColor = Color3.Black();
    flashMat.specularColor = Color3.Black();
    flashMat.disableLighting = true;
    flashMat.alpha = 0.99; // engage blending; additive mode ignores the value
    flashMat.alphaMode = 1; // ALPHA_ADD: black pixels contribute nothing
    flashMat.disableDepthWrite = true;

    for (let i = 0; i < Effects.FLASH_POOL; i++) {
      const star = MeshBuilder.CreatePlane(`muzzleFlashStar${i}`, { size: 0.55 }, scene);
      star.billboardMode = Mesh.BILLBOARDMODE_ALL;
      star.material = flashMat;
      star.isPickable = false;
      star.setEnabled(false);

      const core = MeshBuilder.CreatePlane(`muzzleFlashCore${i}`, { size: 0.24 }, scene);
      core.billboardMode = Mesh.BILLBOARDMODE_ALL;
      core.material = flashMat;
      core.isPickable = false;
      core.setEnabled(false);

      this.flashes.push({ star, core, life: 0, scale: 1 });
    }

    // Compile the flash shader now instead of stuttering on the first shot
    flashMat.forceCompilation(this.flashes[0].star);

    // Tracer pool: shared emissive material, one thin cylinder per slot
    const tracerMat = new StandardMaterial("tracerMat", scene);
    tracerMat.emissiveColor = new Color3(1.0, 0.83, 0.55);
    tracerMat.diffuseColor = Color3.Black();
    tracerMat.specularColor = Color3.Black();
    tracerMat.disableLighting = true;
    tracerMat.alpha = 0.99;
    tracerMat.alphaMode = 1; // ALPHA_ADD
    tracerMat.disableDepthWrite = true;
    for (let i = 0; i < Effects.TRACER_POOL; i++) {
      const mesh = MeshBuilder.CreateCylinder(`tracer${i}`, { height: 1, diameter: 0.018, tessellation: 5 }, scene);
      mesh.material = tracerMat;
      mesh.isPickable = false;
      mesh.rotationQuaternion = new Quaternion();
      mesh.setEnabled(false);
      this.tracers.push({ mesh, life: 0 });
    }

    // Explosion pools: fire-blob billboards (additive, like the flashes) and
    // soft smoke puffs (alpha-blended), plus the always-resident light
    this.explosionLight = new PointLight("explosionLight", Vector3.Zero(), scene);
    this.explosionLight.diffuse = new Color3(1, 0.6, 0.25);
    this.explosionLight.intensity = 0;
    this.explosionLight.range = 22;

    const fireTex = new DynamicTexture("fireBlobTex", { width: 128, height: 128 }, scene, true);
    const fireCtx = fireTex.getContext() as CanvasRenderingContext2D;
    fireCtx.fillStyle = "#000000";
    fireCtx.fillRect(0, 0, 128, 128);
    const blast = fireCtx.createRadialGradient(64, 64, 4, 64, 64, 60);
    blast.addColorStop(0, "#fff6df");
    blast.addColorStop(0.25, "#ffd27a");
    blast.addColorStop(0.55, "#ff7a26");
    blast.addColorStop(0.8, "rgba(140, 40, 8, 0.5)");
    blast.addColorStop(1, "rgba(0, 0, 0, 0)");
    fireCtx.fillStyle = blast;
    fireCtx.beginPath();
    fireCtx.arc(64, 64, 60, 0, Math.PI * 2);
    fireCtx.fill();
    // ragged hot lobes so the bloom isn't a perfect ball
    for (let i = 0; i < 7; i++) {
      const a = (Math.PI * 2 * i) / 7 + 0.4;
      const lobe = fireCtx.createRadialGradient(
        64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30, 2,
        64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30, 22
      );
      lobe.addColorStop(0, "rgba(255, 196, 110, 0.85)");
      lobe.addColorStop(1, "rgba(0, 0, 0, 0)");
      fireCtx.fillStyle = lobe;
      fireCtx.beginPath();
      fireCtx.arc(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30, 22, 0, Math.PI * 2);
      fireCtx.fill();
    }
    fireTex.update();
    const fireMat = new StandardMaterial("fireBlobMat", scene);
    fireMat.emissiveTexture = fireTex;
    fireMat.diffuseColor = Color3.Black();
    fireMat.specularColor = Color3.Black();
    fireMat.disableLighting = true;
    fireMat.alpha = 0.99;
    fireMat.alphaMode = 1; // ALPHA_ADD
    fireMat.disableDepthWrite = true;
    for (let i = 0; i < Effects.FIRE_POOL; i++) {
      const mesh = MeshBuilder.CreatePlane(`fireball${i}`, { size: 1 }, scene);
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.material = fireMat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.fireballs.push({ mesh, life: 0 });
    }

    const smokeTex = new DynamicTexture("smokePuffTex", { width: 128, height: 128 }, scene, true);
    const smokeCtx = smokeTex.getContext() as CanvasRenderingContext2D;
    smokeCtx.clearRect(0, 0, 128, 128);
    for (const [px, py, r, a] of [[64, 64, 52, 0.5], [44, 50, 30, 0.4], [86, 56, 28, 0.4], [60, 86, 30, 0.35]] as const) {
      const puff = smokeCtx.createRadialGradient(px, py, 2, px, py, r);
      puff.addColorStop(0, `rgba(70, 66, 60, ${a})`);
      puff.addColorStop(1, "rgba(70, 66, 60, 0)");
      smokeCtx.fillStyle = puff;
      smokeCtx.beginPath();
      smokeCtx.arc(px, py, r, 0, Math.PI * 2);
      smokeCtx.fill();
    }
    smokeTex.update();
    smokeTex.hasAlpha = true;
    const smokeMat = new StandardMaterial("smokePuffMat", scene);
    smokeMat.diffuseTexture = smokeTex;
    smokeMat.useAlphaFromDiffuseTexture = true;
    smokeMat.emissiveColor = new Color3(0.32, 0.31, 0.29); // self-lit ash gray
    smokeMat.diffuseColor = Color3.Black();
    smokeMat.specularColor = Color3.Black();
    smokeMat.disableLighting = true;
    smokeMat.disableDepthWrite = true;
    for (let i = 0; i < Effects.SMOKE_POOL; i++) {
      const mesh = MeshBuilder.CreatePlane(`smokePuff${i}`, { size: 1.6 }, scene);
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.material = smokeMat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.smokes.push({ mesh, life: 0, max: 1, vy: 1, grow: 1 });
    }

    scene.onBeforeRenderObservable.add(() => {
      this.updateTransients(scene.getEngine().getDeltaTime() / 1000);
    });

    // Bullet-hole pool: a doubly-sided octagon disc matching the silhouette
    // of the old per-shot cylinder decal
    this.holeMesh = MeshBuilder.CreateDisc(
      "bulletHoles",
      { radius: 0.04, tessellation: 8, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    this.holeMesh.isPickable = false; // follow-up shots must hit the surface, not old decals
    this.holeMesh.alwaysSelectAsActiveMesh = true; // skip culling: instance bounds are never recomputed
    const holeMat = new StandardMaterial("impactMat", scene);
    holeMat.diffuseColor = new Color3(0.1, 0.1, 0.1);
    holeMat.specularColor = new Color3(0, 0, 0);
    this.holeMesh.material = holeMat;
    this.holeMesh.thinInstanceSetBuffer("matrix", this.holeBuffer, 16, false);
    this.holeMesh.thinInstanceCount = 0;

    // Lazy initialize AudioContext on first user interaction
    const initAudio = () => {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      window.removeEventListener("click", initAudio);
      window.removeEventListener("keydown", initAudio);
    };
    window.addEventListener("click", initAudio);
    window.addEventListener("keydown", initAudio);
  }

  // Visual Effects
  // scale: weapon-specific flash size (the pistol throws a smaller bloom)
  public createMuzzleFlash(barrelEndPosition: Vector3, scale: number = 1): void {
    const flash = this.flashes[this.flashCursor];
    this.flashCursor = (this.flashCursor + 1) % Effects.FLASH_POOL;
    flash.life = Effects.FLASH_TIME;
    flash.scale = scale * (0.85 + Math.random() * 0.35); // per-shot variance
    flash.star.position.copyFrom(barrelEndPosition);
    flash.core.position.copyFrom(barrelEndPosition);
    flash.star.setEnabled(true);
    flash.core.setEnabled(true);
    this.flashLight.position.copyFrom(barrelEndPosition); // light rides the newest flash
    this.updateTransients(0);
  }

  // Streak from a bot's muzzle to wherever the round stopped
  public createTracer(from: Vector3, to: Vector3): void {
    this.tmpDir.copyFrom(to).subtractInPlace(from);
    const length = this.tmpDir.length();
    if (length < 0.5) return;
    this.tmpDir.scaleInPlace(1 / length);

    const tracer = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % Effects.TRACER_POOL;
    Quaternion.FromUnitVectorsToRef(Effects.Y_AXIS, this.tmpDir, tracer.mesh.rotationQuaternion!);
    tracer.mesh.position.copyFrom(from).addInPlace(to).scaleInPlace(0.5);
    tracer.mesh.scaling.set(1, length, 1);
    tracer.mesh.setEnabled(true);
    tracer.life = Effects.TRACER_TIME;
  }

  // Blooms flashes outward while they fade and burns down the tracers;
  // runs from onBeforeRender
  private updateTransients(deltaTime: number): void {
    let lightIntensity = 0;
    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life -= deltaTime;
      if (flash.life <= 0) {
        flash.star.setEnabled(false);
        flash.core.setEnabled(false);
        continue;
      }
      const t = flash.life / Effects.FLASH_TIME; // 1 -> 0 over the burn
      const grow = 1 + (1 - t) * 0.75;
      flash.star.scaling.setAll(flash.scale * grow);
      flash.core.scaling.setAll(flash.scale * (0.7 + (1 - t) * 0.25));
      flash.star.visibility = t * t; // spikes die fast
      flash.core.visibility = Math.min(1, t * 1.5); // core lingers a touch
      lightIntensity = Math.max(lightIntensity, 3.4 * t * t);
    }
    this.flashLight.intensity = lightIntensity;

    for (const tracer of this.tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= deltaTime;
      if (tracer.life <= 0) {
        tracer.mesh.setEnabled(false);
        continue;
      }
      tracer.mesh.visibility = (tracer.life / Effects.TRACER_TIME) * 0.85;
    }

    // Explosions: the fire blob blooms hard and dies fast...
    let boomLight = 0;
    for (const fire of this.fireballs) {
      if (fire.life <= 0) continue;
      fire.life -= deltaTime;
      if (fire.life <= 0) {
        fire.mesh.setEnabled(false);
        continue;
      }
      const t = fire.life / Effects.FIRE_TIME; // 1 -> 0
      fire.mesh.scaling.setAll(1.2 + (1 - t) * 5.4);
      fire.mesh.visibility = t * t;
      boomLight = Math.max(boomLight, 55 * t * t);
    }
    this.explosionLight.intensity = boomLight;

    // ...while the smoke column rises, swells and thins out above it
    for (const smoke of this.smokes) {
      if (smoke.life <= 0) continue;
      smoke.life -= deltaTime;
      if (smoke.life <= 0) {
        smoke.mesh.setEnabled(false);
        continue;
      }
      const t = smoke.life / smoke.max; // 1 -> 0
      smoke.mesh.position.y += smoke.vy * deltaTime;
      smoke.mesh.scaling.setAll(1 + (1 - t) * smoke.grow);
      smoke.mesh.visibility = Math.min(1, t * 1.6) * 0.85;
    }
  }

  // One bomb going off: flash + fire blob + a short column of smoke.
  // Damage and camera shake are the caller's business — this is the show.
  public createExplosion(position: Vector3): void {
    const fire = this.fireballs[this.fireCursor];
    this.fireCursor = (this.fireCursor + 1) % Effects.FIRE_POOL;
    fire.life = Effects.FIRE_TIME;
    fire.mesh.position.copyFrom(position);
    fire.mesh.position.y += 0.9;
    fire.mesh.setEnabled(true);
    this.explosionLight.position.copyFrom(position);
    this.explosionLight.position.y += 1.5;

    for (let i = 0; i < 3; i++) {
      const smoke = this.smokes[this.smokeCursor];
      this.smokeCursor = (this.smokeCursor + 1) % Effects.SMOKE_POOL;
      smoke.max = 1.2 + Math.random() * 0.6;
      smoke.life = smoke.max;
      smoke.vy = 1.1 + Math.random() * 0.9;
      smoke.grow = 2.2 + Math.random() * 1.4;
      smoke.mesh.position.copyFrom(position);
      smoke.mesh.position.x += (Math.random() - 0.5) * 1.4;
      smoke.mesh.position.y += 0.6 + Math.random() * 0.8;
      smoke.mesh.position.z += (Math.random() - 0.5) * 1.4;
      smoke.mesh.scaling.setAll(1);
      smoke.mesh.setEnabled(true);
    }

    this.updateTransients(0);
  }

  public createBulletImpact(position: Vector3, normal: Vector3): void {
    const idx = this.holeCursor;
    this.holeCursor = (this.holeCursor + 1) % Effects.MAX_HOLES;
    this.holeCount = Math.min(this.holeCount + 1, Effects.MAX_HOLES);

    // Disc +z axis aligned to the hit normal, offset to prevent z-fighting
    this.tmpPos.copyFrom(position);
    normal.scaleAndAddToRef(0.01, this.tmpPos);
    Quaternion.FromUnitVectorsToRef(Effects.DISC_AXIS, normal, this.tmpQuat);
    Matrix.ComposeToRef(Effects.UNIT_SCALE, this.tmpQuat, this.tmpPos, this.tmpMat);
    this.tmpMat.copyToArray(this.holeBuffer, idx * 16);

    this.holeMesh.thinInstanceCount = this.holeCount;
    this.holeMesh.thinInstanceBufferUpdated("matrix");
  }

  // kill: a bigger marker held a beat longer for the Fall of Duty confirm.
  // headshot: the same swell in gold.
  public showHitMarker(kill: boolean = false, headshot: boolean = false): void {
    if (!this.hitMarkerEl) return;

    this.hitMarkerEl.classList.remove("hidden");
    this.hitMarkerEl.classList.toggle("kill", kill);
    this.hitMarkerEl.classList.toggle("headshot", headshot);
    this.hitMarkerEl.style.opacity = "1.0";

    // Play hit beep
    this.playHitSound();

    // One live timer: a stale fade from a previous rapid-fire hit must not
    // cut a fresh marker (especially a kill confirm) short
    if (this.hitMarkerTimeout !== null) clearTimeout(this.hitMarkerTimeout);
    this.hitMarkerTimeout = setTimeout(() => {
      this.hitMarkerTimeout = null;
      if (this.hitMarkerEl) {
        this.hitMarkerEl.style.opacity = "0.0";
      }
    }, kill ? 320 : 150);
  }

  // Audio Synthesis via Web Audio API (100% legal, 100% asset-free)
  private getAudioContext(): AudioContext | null {
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const bufferSize = ctx.sampleRate * 0.5; // 0.5s duration
      this.noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    }
    return this.noiseBuffer;
  }

  // Shared gunshot synth: every weapon's report is the same two-layer patch —
  // a lowpass-swept noise burst (the blast) over a pitch-dropping sine thump
  // (the body) — differing only in the numbers below. Both gains decay to 0.01.
  private playGunshot(cfg: {
    filterFreq: number; // lowpass sweep start (Hz)
    filterEndFreq: number; // lowpass sweep target (Hz)
    filterSweepTime: number; // lowpass sweep length (s)
    noiseGain: number; // blast peak gain
    noiseDecayTime: number; // blast gain decay length (s)
    noiseStopTime: number; // noise source stop offset (s)
    oscFreq: number; // thump start pitch (Hz)
    oscEndFreq: number; // thump pitch-drop target (Hz)
    oscSweepTime: number; // thump pitch-drop length (s)
    oscGain: number; // thump peak gain
    oscDecayTime: number; // thump gain decay length (s)
    oscStopTime: number; // thump oscillator stop offset (s)
    click?: { delay: number; freq: number; duration: number; volume: number }; // extra mechanical click
    volume?: number; // 0..1 master scale — distant (bot) shots arrive quieter
  }): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;

    const volume = cfg.volume ?? 1;

    // Time
    const now = ctx.currentTime;

    // 1. Noise burst for the gunshot blast (shared buffer, one-shot source)
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);

    // Noise filter (lowpass to make it thumpy/gritty)
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cfg.filterFreq, now);
    filter.frequency.exponentialRampToValueAtTime(cfg.filterEndFreq, now + cfg.filterSweepTime);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(cfg.noiseGain * volume, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + cfg.noiseDecayTime);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    // 2. Bass Oscillator (sine wave thump)
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(cfg.oscFreq, now);
    osc.frequency.exponentialRampToValueAtTime(cfg.oscEndFreq, now + cfg.oscSweepTime);

    oscGain.gain.setValueAtTime(cfg.oscGain * volume, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + cfg.oscDecayTime);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);

    // Start
    noise.start(now);
    osc.start(now);

    // Stop
    noise.stop(now + cfg.noiseStopTime);
    osc.stop(now + cfg.oscStopTime);

    if (cfg.click) {
      this.playClick(ctx, now + cfg.click.delay, cfg.click.freq, cfg.click.duration, cfg.click.volume * volume);
    }
  }

  public playShootSound(volume: number = 1): void {
    this.playGunshot({
      filterFreq: 800, filterEndFreq: 10, filterSweepTime: 0.4,
      noiseGain: 0.8, noiseDecayTime: 0.3, noiseStopTime: 0.5,
      oscFreq: 120, oscEndFreq: 20, oscSweepTime: 0.15,
      oscGain: 1.0, oscDecayTime: 0.2, oscStopTime: 0.3,
      volume
    });
  }

  // Positional-ish report for bot fire: the same patch as the player's
  // weapon, scaled down with distance to the listener
  public playBotShootSound(weapon: "mp44" | "usp45" | "m40a3", distance: number): void {
    const volume = Math.min(1, 1.35 / (1 + distance * 0.12));
    if (weapon === "mp44") this.playMp44ShootSound(volume);
    else if (weapon === "usp45") this.playPistolShootSound(volume);
    else this.playShootSound(volume);
  }

  // Supersonic snap of a near miss passing the player's head
  public playBulletWhizSound(): void {
    this.playClicks([0, 3400, 0.03, 0.12], [0.012, 2200, 0.045, 0.09]);
  }

  // Dull body thud layered under the screen blood when the player is hit
  public playPlayerHitSound(): void {
    this.playClicks([0, 210, 0.07, 0.5], [0.015, 95, 0.13, 0.55]);
  }

  public playBoltCycleSound(): void {
    // bolt pulled back, then pushed forward 0.3s later
    this.playClicks([0, 800, 0.08, 0.3], [0.3, 600, 0.1, 0.4]);
  }

  public playBoltOpenSound(): void {
    // handle rotated up, bolt drawn back
    this.playClicks([0, 850, 0.07, 0.3], [0.1, 620, 0.09, 0.25]);
  }

  public playRoundInsertSound(): void {
    // round pressed in, follower spring clack
    this.playClicks([0, 950, 0.04, 0.22], [0.05, 480, 0.07, 0.3]);
  }

  public playBoltCloseSound(): void {
    // bolt run forward, handle locked down
    this.playClicks([0, 600, 0.1, 0.4], [0.12, 820, 0.08, 0.35]);
  }

  private playClick(ctx: AudioContext, time: number, freq: number, duration: number, volume: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const bandpass = ctx.createBiquadFilter();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, time);
    osc.frequency.exponentialRampToValueAtTime(freq / 2, time + duration);

    bandpass.type = "bandpass";
    bandpass.frequency.setValueAtTime(freq, time);

    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(ctx.destination);

    osc.start(time);
    osc.stop(time + duration);
  }

  // Mechanical sounds are just 1-3 playClick()s at offsets from the trigger
  // moment. Each entry: [delay (s), frequency (Hz), duration (s), volume].
  private playClicks(...clicks: [number, number, number, number][]): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [delay, freq, duration, volume] of clicks) {
      this.playClick(ctx, now + delay, freq, duration, volume);
    }
  }

  // Sharper, shorter crack than the rifle: less low-end, faster decay
  public playPistolShootSound(volume: number = 1): void {
    this.playGunshot({
      filterFreq: 2600, filterEndFreq: 80, filterSweepTime: 0.18,
      noiseGain: 0.65, noiseDecayTime: 0.16, noiseStopTime: 0.25,
      oscFreq: 170, oscEndFreq: 35, oscSweepTime: 0.09,
      oscGain: 0.75, oscDecayTime: 0.12, oscStopTime: 0.15,
      volume
    });
  }

  // Automatic rifle report: sharper than the sniper, heavier than the pistol,
  // with a short mechanical slap layered in so full-auto has a stamped-metal cadence.
  public playMp44ShootSound(volume: number = 1): void {
    this.playGunshot({
      filterFreq: 1800, filterEndFreq: 55, filterSweepTime: 0.22,
      noiseGain: 0.58, noiseDecayTime: 0.19, noiseStopTime: 0.28,
      oscFreq: 135, oscEndFreq: 38, oscSweepTime: 0.1,
      oscGain: 0.7, oscDecayTime: 0.14, oscStopTime: 0.16,
      click: { delay: 0.018, freq: 780, duration: 0.035, volume: 0.16 },
      volume
    });
  }

  public playDryFireSound(): void {
    this.playClicks([0, 700, 0.05, 0.25]); // hammer falls on nothing
  }

  public playMagOutSound(): void {
    // mag release pressed, mag slides free
    this.playClicks([0, 520, 0.06, 0.3], [0.07, 380, 0.06, 0.25]);
  }

  public playMagInSound(): void {
    // mag body seats, catch clicks over
    this.playClicks([0, 430, 0.06, 0.35], [0.06, 920, 0.05, 0.3]);
  }

  public playSlideReleaseSound(): void {
    // release lever, slide slams home
    this.playClicks([0, 760, 0.05, 0.35], [0.04, 540, 0.09, 0.45]);
  }

  // Single sharp tick as a laminated pane stars around the bullet
  public playGlassCrackSound(): void {
    this.playClicks([0, 2600, 0.05, 0.3], [0.025, 3400, 0.04, 0.2]);
  }

  // Full shatter: bright noise burst + a cascade of descending tinks
  public playGlassBreakSound(): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.setValueAtTime(2400, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.32);
    noise.connect(highpass);
    highpass.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.35);

    this.playClick(ctx, now + 0.03, 3200, 0.06, 0.3);
    this.playClick(ctx, now + 0.09, 2300, 0.07, 0.26);
    this.playClick(ctx, now + 0.16, 1700, 0.08, 0.2);
  }

  public playWeaponSwitchSound(): void {
    // gear rustle, next weapon settles
    this.playClicks([0, 320, 0.06, 0.16], [0.16, 640, 0.05, 0.18]);
  }

  public playHitSound(): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // Standard high-frequency hit indicator "tick"
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1800, now);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.06);
  }

  // --- Reward chimes (match UI) — clean sine notes, distinct from the
  // percussive weapon clicks. Each entry: [delay, freq, duration, volume].
  private playTones(...notes: Array<[number, number, number, number]>): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [delay, freq, duration, volume] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + delay);
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(volume, now + delay + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + duration + 0.02);
    }
  }

  // Two quick rising notes on a kill; headshots ring a third, higher one
  public playKillSound(headshot: boolean): void {
    this.playTones([0, 880, 0.1, 0.16], [0.07, 1175, 0.14, 0.16]);
    if (headshot) this.playTones([0.15, 1568, 0.2, 0.15]);
  }

  // Short ascending fanfare for killstreak callouts — higher tiers reach higher
  public playStreakSound(tier: number): void {
    const base: Array<[number, number, number, number]> = [
      [0, 523, 0.12, 0.14], [0.09, 659, 0.12, 0.14], [0.18, 784, 0.2, 0.15],
    ];
    if (tier >= 2) base.push([0.27, 1046, 0.26, 0.15]);
    this.playTones(...base);
  }

  public playVictorySound(): void {
    this.playTones([0, 523, 0.18, 0.16], [0.14, 659, 0.18, 0.16], [0.28, 784, 0.18, 0.16], [0.42, 1046, 0.5, 0.18]);
  }

  public playDefeatSound(): void {
    this.playTones([0, 392, 0.3, 0.16], [0.22, 311, 0.3, 0.15], [0.44, 233, 0.55, 0.15]);
  }

  // Player down: original retro-arcade "invader crumple" chirp. Bright,
  // stepped square waves over a tiny noise zap so it reads cartoonish instead
  // of like the enemy body's human death gasp.
  public playPlayerDeathSound(): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.75, now);
    master.gain.exponentialRampToValueAtTime(0.001, now + 0.72);
    master.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2600, now);
    filter.frequency.exponentialRampToValueAtTime(520, now + 0.62);
    filter.connect(master);

    const tones: Array<[number, number, number]> = [
      [0, 880, 0.08],
      [0.07, 740, 0.08],
      [0.14, 622, 0.08],
      [0.21, 466, 0.1],
      [0.32, 330, 0.16],
    ];
    for (const [delay, freq, duration] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + delay;
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(70, freq * 0.55), t + duration);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(gain);
      gain.connect(filter);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 5;
    band.frequency.setValueAtTime(1500, now);
    band.frequency.exponentialRampToValueAtTime(320, now + 0.45);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.12, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    noise.connect(band);
    band.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(now);
    noise.stop(now + 0.45);
  }

  // --- Killstreak audio ---

  // Deep boom: looped noise (the 0.5s buffer is too short for the tail
  // one-shot) swept low, under a falling sub thump and a debris click
  public playExplosionSound(distance: number): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const volume = Math.min(1, 2.4 / (1 + distance * 0.09));
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(340, now);
    filter.frequency.exponentialRampToValueAtTime(26, now + 0.95);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.15 * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.95);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 1.05);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(78, now);
    osc.frequency.exponentialRampToValueAtTime(22, now + 0.42);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(1.05 * volume, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.55);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.6);

    this.playClick(ctx, now + 0.16, 540, 0.09, 0.18 * volume);
  }

  // Fast mover overhead: a band-swept roar that swells, passes and recedes
  public playJetFlybySound(): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.1;
    band.frequency.setValueAtTime(340, now);
    band.frequency.exponentialRampToValueAtTime(1500, now + 0.8); // inbound doppler rise
    band.frequency.exponentialRampToValueAtTime(380, now + 1.7); // gone past, falling away
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.75);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.75);
    noise.connect(band);
    band.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 1.8);
  }

  // Radar pings for the UAV coming online
  public playUavOnlineSound(): void {
    this.playTones([0, 1240, 0.09, 0.13], [0.22, 1240, 0.09, 0.1], [0.44, 1560, 0.3, 0.12]);
  }

  // Radio confirm for a called strike: squelch click + affirmative beeps
  public playAirstrikeConfirmSound(): void {
    this.playClicks([0, 1900, 0.025, 0.12]);
    this.playTones([0.06, 990, 0.08, 0.12], [0.17, 990, 0.08, 0.12], [0.3, 740, 0.16, 0.12]);
  }

  public playLaptopOpenSound(): void {
    this.playClicks([0, 480, 0.05, 0.2], [0.12, 720, 0.04, 0.18]);
    this.playTones([0.22, 1180, 0.12, 0.08]);
  }

  public playLaptopCloseSound(): void {
    this.playClicks([0, 700, 0.04, 0.18], [0.08, 420, 0.06, 0.2]);
  }

  // Chin gun: short bark per round, deeper than any infantry rifle
  public playApacheGunSound(volume: number): void {
    this.playGunshot({
      filterFreq: 1100, filterEndFreq: 60, filterSweepTime: 0.12,
      noiseGain: 0.5, noiseDecayTime: 0.1, noiseStopTime: 0.16,
      oscFreq: 105, oscEndFreq: 42, oscSweepTime: 0.06,
      oscGain: 0.6, oscDecayTime: 0.09, oscStopTime: 0.12,
      volume,
    });
  }

  // The dying breath: a swell of band-filtered air falling in pitch
  public playDeathGaspSound(volume: number): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(880, now);
    band.frequency.exponentialRampToValueAtTime(360, now + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.27 * volume, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    noise.connect(band);
    band.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.6);
  }

  // Dead weight meeting the ground, gear clattering on top of it
  public playBodyFallSound(volume: number): void {
    this.playClicks(
      [0, 150, 0.08, 0.5 * volume],
      [0.06, 95, 0.13, 0.55 * volume],
      [0.14, 330, 0.05, 0.2 * volume]
    );
  }

  // --- Apache rotor loop: started lazily, volume steered every frame ---

  private startRotorLoop(ctx: AudioContext): void {
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(ctx);
    src.loop = true;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 240;
    const chop = ctx.createGain(); // blade-pass amplitude chop
    chop.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = 13;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.4;
    lfo.connect(lfoDepth);
    lfoDepth.connect(chop.gain);
    const master = ctx.createGain();
    master.gain.value = 0;
    src.connect(lowpass);
    lowpass.connect(chop);
    chop.connect(master);
    master.connect(ctx.destination);
    src.start();
    lfo.start();
    this.rotorNodes = { src, lfo, gain: master };
  }

  public setRotorVolume(volume: number): void {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    if (!this.rotorNodes) this.startRotorLoop(ctx);
    this.rotorVol = volume;
    this.rotorNodes!.gain.gain.setTargetAtTime(this.rotorMuted ? 0 : volume, ctx.currentTime, 0.12);
  }

  // Pause menu: the world freezes, the rotor must too
  public setRotorMuted(muted: boolean): void {
    this.rotorMuted = muted;
    if (this.rotorNodes && this.audioCtx) {
      this.rotorNodes.gain.gain.setTargetAtTime(muted ? 0 : this.rotorVol, this.audioCtx.currentTime, 0.08);
    }
  }

  public stopRotorLoop(): void {
    if (!this.rotorNodes) return;
    try {
      this.rotorNodes.src.stop();
      this.rotorNodes.lfo.stop();
    } catch {
      // already stopped — fine
    }
    this.rotorNodes.src.disconnect();
    this.rotorNodes.lfo.disconnect();
    this.rotorNodes.gain.disconnect();
    this.rotorNodes = null;
    this.rotorVol = 0;
  }
}
