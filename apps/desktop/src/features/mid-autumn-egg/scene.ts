/**
 * Mid-Autumn easter egg engine.
 *
 * Owns the canvas, the timeline loop, the resize re-layout, the sparkle bursts
 * and the caption. The sky, stars, horizon glow, rising moon, mooncake rain and
 * column piling, the pixel-sampled text assembly and the vertical poem layer are
 * a faithful port of the verified standalone animation.
 *
 * The scene also creates and owns the small DOM decoration layer (veil, caption,
 * sparks) inside the canvas' parent, and tears it down in `destroy()`.
 */
import {
  CAKE_BOUNCE_DAMPING,
  CAKE_COLUMN_GROWTH,
  CAKE_COLUMN_GROWTH_RANDOM,
  CAKE_COLUMN_SPREAD,
  CAKE_COLUMN_WIDTH_RATIO,
  CAKE_CONTACT_RATIO,
  CAKE_FILL,
  CAKE_RADIUS_MAX,
  CAKE_RADIUS_MIN,
  CAKE_RADIUS_RATIO,
  CAKE_SPAWN_ABOVE_RANGE,
  CAKE_SPAWN_PAD_RATIO,
  CAKE_SPAWN_VX,
  CAKE_SPAWN_VY_MIN,
  CAKE_SPAWN_VY_RANGE,
  CAKE_SPIN_RANGE,
  CAKE_SPRITE_LIFT_RATIO,
  CAKE_SPRITE_PADDING_RATIO,
  CAKE_SPRITE_SUPERSAMPLE,
  CAPTION_SUBTITLE,
  CAPTION_TITLE,
  DEFAULT_MID_AUTUMN_EGG_CONFIG,
  GRAVITY_K,
  GRAVITY_MIN,
  GROUND_INSET_MIN,
  GROUND_INSET_RATIO,
  MAX_FAST_FORWARD_STEPS,
  MAX_FRAME_STEP_SECONDS,
  MOON_BREATH_AMPLITUDE,
  MOON_BREATH_SPEED,
  MOON_FILL,
  MOON_GLOW_INNER_RATIO,
  MOON_GLOW_OUTER_RATIO,
  MOON_PATH_END_MIN_RATIO,
  MOON_PATH_START_OFFSET,
  MOON_RADIUS_MAX,
  MOON_RADIUS_MIN,
  MOON_RADIUS_RATIO,
  MOON_SPARK_COUNT,
  MOON_TRAIL_MAX,
  ORIENTATION_DEBOUNCE_MS,
  POEM_ALPHA_BASE,
  POEM_ALPHA_RANGE,
  POEM_BREATHE_SPEED,
  POEM_CHAR_WOBBLE_AMPLITUDE,
  POEM_CHAR_WOBBLE_SPEED,
  POEM_COLUMN_GAP_RATIO,
  POEM_FADE_IN_FRACTION,
  POEM_FADE_OUT_FRACTION,
  POEM_GLOW_ALPHA_SCALE,
  POEM_GLOW_BLUR,
  POEM_MIN_ENVELOPE,
  RAIN_SPAWN_GUARD,
  RESIZE_DEBOUNCE_MS,
  SERIF_FONT_STACK,
  SIMULATION_STEP_SECONDS,
  SPARK_DELAY_RANGE_MS,
  SPARK_DISTANCE_MIN,
  SPARK_DISTANCE_RANGE,
  SPARK_LIFETIME_MS,
  STAR_ALPHA_MIN,
  STAR_ALPHA_RANGE,
  STAR_BAND_RATIO,
  STAR_COUNT_MAX,
  STAR_COUNT_MIN,
  STAR_DENSITY,
  STAR_RADIUS_MIN,
  STAR_RADIUS_RANGE,
  STAR_SPEED_MIN,
  STAR_SPEED_RANGE,
  STATIC_FRAME_TAIL_SECONDS,
  TEXT_ARC_LIFT,
  TEXT_ARC_LIFT_RANDOM,
  TEXT_CONTROL_SPREAD,
  TEXT_DELAY_RANDOM,
  TEXT_RECT_ASPECT,
  TEXT_RECT_CENTER_Y_RATIO,
  TEXT_RECT_MAX_HEIGHT_RATIO,
  TEXT_RECT_MAX_WIDTH,
  TEXT_RECT_WIDTH_RATIO,
  TEXT_SPARK_COUNT,
  TEXT_STACK_JITTER_RATIO,
  TRAIL_GLOW_INNER_BASE,
  TRAIL_GLOW_INNER_LIFE,
  TRAIL_LIFETIME,
  TRAIL_RADIUS_BASE,
  TRAIL_RADIUS_LIFE,
  clamp,
  createMidAutumnEggPhases,
  cubicPoint,
  easeInOutCubic,
  easeInOutQuad,
  rand,
  type MidAutumnEggConfig,
  type MidAutumnEggPhases,
  type Vec2,
} from "./timeline";
import { glyphPhase, createPoemSchedule, type PoemSchedule } from "./poem-schedule";
import { sampleTextPoints, type TextSamplePoint } from "./text-sampling";

export type MidAutumnEggSceneOptions = {
  canvas: HTMLCanvasElement;
  moonImageUrl: string;
  cakeImageUrl: string;
  /** When set, freeze the timeline at this many seconds and render one frame instead of animating (used by QA screenshots). */
  seekSeconds?: number;
  /** Called for a non-fatal failure (e.g. an asset failed to decode) instead of silently swallowing it. */
  onError?: (error: unknown) => void;
};

export type MidAutumnEggScene = { start(): void; destroy(): void };

type CakeLifecycle = "falling" | "landed" | "placed";

type Cake = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rot0: number;
  spin: number;
  state: CakeLifecycle;
  targetX: number;
  targetY: number;
  originX: number;
  originY: number;
  controlX: number;
  controlY: number;
  delay: number;
};

type Star = {
  x: number;
  y: number;
  r: number;
  alpha: number;
  phase: number;
  speed: number;
};

type TrailSample = { x: number; y: number; bornAt: number };

type SparkHandle = { element: HTMLElement; timer: number };

type MoonPath = { start: Vec2; control1: Vec2; control2: Vec2; end: Vec2 };

type TextRect = { x: number; y: number; w: number; h: number };

export function createMidAutumnEggScene(
  options: MidAutumnEggSceneOptions,
): MidAutumnEggScene {
  const canvas = options.canvas;
  const context = canvas.getContext("2d");
  if (!context) {
    options.onError?.(new Error("Mid-Autumn easter egg: no 2D canvas context"));
    return { start: () => {}, destroy: () => {} };
  }

  const config: MidAutumnEggConfig = DEFAULT_MID_AUTUMN_EGG_CONFIG;
  const phases: MidAutumnEggPhases = createMidAutumnEggPhases(config);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const seekSeconds =
    typeof options.seekSeconds === "number" && Number.isFinite(options.seekSeconds)
      ? Math.max(0, options.seekSeconds)
      : null;

  /* ---- decoration layer owned by the scene (veil, caption, sparks) ---- */
  const container = canvas.parentElement ?? canvas.ownerDocument.body;
  const decor = document.createElement("div");
  decor.className = "mid-autumn-egg-decor";
  decor.setAttribute("aria-hidden", "true");
  const veil = document.createElement("div");
  veil.className = "mid-autumn-egg-veil";
  const caption = document.createElement("div");
  caption.className = "mid-autumn-egg-caption";
  const captionTitle = document.createElement("div");
  captionTitle.className = "mid-autumn-egg-caption-title";
  captionTitle.textContent = CAPTION_TITLE;
  const captionSubtitle = document.createElement("div");
  captionSubtitle.className = "mid-autumn-egg-caption-sub";
  captionSubtitle.textContent = CAPTION_SUBTITLE;
  caption.append(captionTitle, captionSubtitle);
  decor.append(veil, caption);
  container.appendChild(decor);

  /* ---- layout state, rebuilt by setup() ---- */
  let width = 0;
  let height = 0;
  let dpr = 1;
  let cakeRadius = 9;
  let groundY = 0;
  let columnWidth = 16;
  let columnCount = 0;
  let columnHeights = new Float32Array(0);
  let moonRadius = 60;
  let moonPath: MoonPath = createMoonPath(0, 0, 0);

  /* ---- scene state ---- */
  let stars: Star[] = [];
  let cakes: Cake[] = [];
  let trail: TrailSample[] = [];
  let poem: PoemSchedule | null = null;
  let moonImage: HTMLImageElement | null = null;
  let cakeImage: HTMLImageElement | null = null;
  let cakeSprite: HTMLCanvasElement | null = null;
  let cakeSpriteScale = 1;
  let textRect: TextRect | null = null;
  let sparks: SparkHandle[] = [];

  let elapsed = 0;
  let startTime = 0;
  let lastFrameTime = 0;
  let spawnAccumulator = 0;
  let skyProgress = 0;
  let textTargetsBuilt = false;
  let poemBuilt = false;
  let moonSparkDone = false;
  let textSparkDone = false;

  let frameId: number | null = null;
  let sparkFrames: number[] = [];
  let resizeTimer: number | null = null;
  let started = false;
  let destroyed = false;

  /* ------------------------------------------------------------------ *
   * Layout
   * ------------------------------------------------------------------ */

  function createMoonPath(viewWidth: number, viewHeight: number, radius: number): MoonPath {
    return {
      start: {
        x: -radius * MOON_PATH_START_OFFSET,
        y: viewHeight + radius * MOON_PATH_START_OFFSET,
      },
      control1: { x: viewWidth * 0.05, y: viewHeight * 0.7 },
      control2: { x: viewWidth * 0.33, y: viewHeight * 0.04 },
      end: {
        x: viewWidth * 0.78,
        y: Math.max(radius * MOON_PATH_END_MIN_RATIO, viewHeight * 0.16),
      },
    };
  }

  function setup(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    cakeRadius = clamp(
      Math.min(width, height) * CAKE_RADIUS_RATIO,
      CAKE_RADIUS_MIN,
      CAKE_RADIUS_MAX,
    );
    groundY = height - Math.max(GROUND_INSET_MIN, height * GROUND_INSET_RATIO);
    columnWidth = cakeRadius * CAKE_COLUMN_WIDTH_RATIO;
    columnCount = Math.ceil(width / columnWidth) + 2;
    columnHeights = new Float32Array(columnCount);

    moonRadius = clamp(
      Math.min(width, height) * MOON_RADIUS_RATIO,
      MOON_RADIUS_MIN,
      MOON_RADIUS_MAX,
    );
    moonPath = createMoonPath(width, height, moonRadius);

    buildStars();
    if (cakeImage) buildCakeSprite();
    reset();
  }

  function reset(): void {
    cakes = [];
    trail = [];
    poem = null;
    columnHeights.fill(0);
    spawnAccumulator = 0;
    elapsed = 0;
    startTime = 0;
    lastFrameTime = 0;
    skyProgress = 0;
    textTargetsBuilt = false;
    poemBuilt = false;
    moonSparkDone = false;
    textSparkDone = false;
    textRect = null;
    caption.classList.remove("show");
    clearSparks();
  }

  function columnIndexOf(x: number): number {
    return clamp(Math.floor(x / columnWidth), 0, columnCount - 1);
  }

  /* ------------------------------------------------------------------ *
   * Stars and horizon glow
   * ------------------------------------------------------------------ */

  function buildStars(): void {
    stars = [];
    const count = clamp(Math.round((width * height) / STAR_DENSITY), STAR_COUNT_MIN, STAR_COUNT_MAX);
    for (let index = 0; index < count; index++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height * STAR_BAND_RATIO,
        r: Math.random() * STAR_RADIUS_RANGE + STAR_RADIUS_MIN,
        alpha: STAR_ALPHA_MIN + Math.random() * STAR_ALPHA_RANGE,
        phase: Math.random() * Math.PI * 2,
        speed: STAR_SPEED_MIN + Math.random() * STAR_SPEED_RANGE,
      });
    }
  }

  function drawStars(skyAlpha: number): void {
    if (skyAlpha <= 0) return;
    for (const star of stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(elapsed * star.speed + star.phase);
      context.globalAlpha = star.alpha * (0.3 + 0.7 * twinkle) * skyAlpha;
      context.fillStyle = "#dbe7ff";
      context.beginPath();
      context.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function drawHorizon(skyAlpha: number): void {
    if (skyAlpha <= 0) return;
    context.globalAlpha = skyAlpha;

    const glow = context.createLinearGradient(0, height * 0.68, 0, height);
    glow.addColorStop(0, "rgba(255,190,110,0)");
    glow.addColorStop(0.6, "rgba(255,172,92,0.055)");
    glow.addColorStop(1, "rgba(255,152,70,0.14)");
    context.fillStyle = glow;
    context.fillRect(0, height * 0.68, width, height * 0.32);

    const pool = context.createRadialGradient(
      width * 0.5,
      height * 1.06,
      0,
      width * 0.5,
      height * 1.06,
      width * 0.72,
    );
    pool.addColorStop(0, "rgba(255,186,104,0.11)");
    pool.addColorStop(0.5, "rgba(255,170,90,0.04)");
    pool.addColorStop(1, "rgba(255,170,90,0)");
    context.fillStyle = pool;
    context.fillRect(0, height * 0.55, width, height * 0.45);

    context.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ *
   * Mooncake sprite: the asset is scaled once into an offscreen canvas,
   * because 500+ cakes per frame would be too slow to scale every time.
   * ------------------------------------------------------------------ */

  function buildCakeSprite(): void {
    if (!cakeImage) return;
    const supersample = CAKE_SPRITE_SUPERSAMPLE;
    const body = (cakeRadius * 2) / CAKE_FILL * supersample;
    const size = Math.ceil(body * CAKE_SPRITE_PADDING_RATIO);

    const sprite = document.createElement("canvas");
    sprite.width = size;
    sprite.height = size;
    const spriteContext = sprite.getContext("2d");
    if (!spriteContext) {
      options.onError?.(new Error("Mid-Autumn easter egg: cake sprite context unavailable"));
      return;
    }
    spriteContext.imageSmoothingEnabled = true;
    spriteContext.imageSmoothingQuality = "high";

    const glow = spriteContext.createRadialGradient(
      size / 2,
      size / 2,
      body * 0.42,
      size / 2,
      size / 2,
      size * 0.5,
    );
    glow.addColorStop(0, "rgba(255,204,116,0.32)");
    glow.addColorStop(0.5, "rgba(255,178,88,0.10)");
    glow.addColorStop(1, "rgba(255,168,76,0)");
    spriteContext.fillStyle = glow;
    spriteContext.fillRect(0, 0, size, size);

    // The body sits slightly high to cancel the baked-in drop shadow.
    spriteContext.drawImage(
      cakeImage,
      (size - body) / 2,
      (size - body) / 2 - body * CAKE_SPRITE_LIFT_RATIO,
      body,
      body,
    );

    cakeSprite = sprite;
    cakeSpriteScale = 1 / supersample;
  }

  /* ------------------------------------------------------------------ *
   * Moon
   * ------------------------------------------------------------------ */

  function moonPosition(): Vec2 {
    const progress = clamp(elapsed / phases.rise, 0, 1);
    return cubicPoint(
      moonPath.start,
      moonPath.control1,
      moonPath.control2,
      moonPath.end,
      easeInOutQuad(progress),
    );
  }

  function drawMoon(): void {
    if (!moonImage) return;
    const position = moonPosition();
    // Breathing once the moon has arrived.
    const radius =
      moonRadius * (1 + Math.sin(elapsed * MOON_BREATH_SPEED) * MOON_BREATH_AMPLITUDE);

    const glow = context.createRadialGradient(
      position.x,
      position.y,
      radius * MOON_GLOW_INNER_RATIO,
      position.x,
      position.y,
      radius * MOON_GLOW_OUTER_RATIO,
    );
    glow.addColorStop(0, "rgba(255,238,175,0.28)");
    glow.addColorStop(0.32, "rgba(255,220,140,0.10)");
    glow.addColorStop(0.66, "rgba(255,205,120,0.03)");
    glow.addColorStop(1, "rgba(255,200,110,0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(position.x, position.y, radius * MOON_GLOW_OUTER_RATIO, 0, Math.PI * 2);
    context.fill();

    const diameter = (radius * 2) / MOON_FILL;
    context.drawImage(
      moonImage,
      position.x - diameter / 2,
      position.y - diameter / 2,
      diameter,
      diameter,
    );
  }

  function drawTrail(): void {
    if (!trail.length) return;
    for (let index = trail.length - 1; index >= 0; index--) {
      const sample = trail[index];
      const age = elapsed - sample.bornAt;
      if (age > TRAIL_LIFETIME || age < 0) {
        trail.splice(index, 1);
        continue;
      }
      const life = 1 - age / TRAIL_LIFETIME;
      const glow = context.createRadialGradient(
        sample.x,
        sample.y,
        0,
        sample.x,
        sample.y,
        TRAIL_GLOW_INNER_BASE + life * TRAIL_GLOW_INNER_LIFE,
      );
      glow.addColorStop(0, `rgba(255,238,192,${(0.15 * life).toFixed(4)})`);
      glow.addColorStop(0.28, `rgba(255,211,133,${(0.09 * life).toFixed(4)})`);
      glow.addColorStop(1, "rgba(255,190,92,0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(sample.x, sample.y, TRAIL_RADIUS_BASE + life * TRAIL_RADIUS_LIFE, 0, Math.PI * 2);
      context.fill();
    }
  }

  /* ------------------------------------------------------------------ *
   * Mooncake rain
   * ------------------------------------------------------------------ */

  function spawnCake(): void {
    const pad = cakeRadius * CAKE_SPAWN_PAD_RATIO;
    cakes.push({
      x: pad + Math.random() * Math.max(1, width - pad * 2),
      y: -cakeRadius * 2 - Math.random() * CAKE_SPAWN_ABOVE_RANGE,
      vx: rand(-CAKE_SPAWN_VX, CAKE_SPAWN_VX),
      vy: rand(CAKE_SPAWN_VY_MIN, CAKE_SPAWN_VY_MIN + CAKE_SPAWN_VY_RANGE),
      rot: Math.random() * Math.PI * 2,
      rot0: 0,
      spin: rand(-CAKE_SPIN_RANGE, CAKE_SPIN_RANGE),
      state: "falling",
      targetX: 0,
      targetY: 0,
      originX: 0,
      originY: 0,
      controlX: 0,
      controlY: 0,
      delay: 0,
    });
  }

  /**
   * Pair every mooncake with a sampled pixel of the target text.
   *
   * The sampler may return up to 15% more points than there are mooncakes; the
   * points are sorted by x and thinned evenly, so the whole line stays covered
   * instead of the surplus piling up on the right-hand glyph.
   */
  function buildTextTargets(): void {
    const count = cakes.length;
    if (!count) return;

    let rectWidth = Math.min(width * TEXT_RECT_WIDTH_RATIO, TEXT_RECT_MAX_WIDTH);
    let rectHeight = rectWidth / TEXT_RECT_ASPECT;
    const maxRectHeight = height * TEXT_RECT_MAX_HEIGHT_RATIO;
    if (rectHeight > maxRectHeight) {
      rectHeight = maxRectHeight;
      rectWidth = rectHeight * TEXT_RECT_ASPECT;
    }
    const rectX = (width - rectWidth) / 2;
    const rectY = height * TEXT_RECT_CENTER_Y_RATIO - rectHeight * 0.5;

    const raw = sampleTextPoints(config.text, count, rectWidth, rectHeight);
    if (!raw.length) return;
    textRect = { x: rectX, y: rectY, w: rectWidth, h: rectHeight };

    raw.sort((left, right) => left.x - right.x);
    const points: TextSamplePoint[] = [];
    if (raw.length > count) {
      const last = raw.length - 1;
      for (let index = 0; index < count; index++) {
        points.push(raw[Math.round((index * last) / Math.max(1, count - 1))]);
      }
    } else {
      for (const point of raw) points.push(point);
    }

    // Left cakes fly to the left points, which produces the sweeping stagger.
    const ordered = cakes.slice().sort((left, right) => left.x - right.x);
    const total = Math.max(1, points.length);

    for (let index = 0; index < ordered.length; index++) {
      const cake = ordered[index];
      const point = points[index % total];
      const stacked = index >= total;
      const jitter = cakeRadius * TEXT_STACK_JITTER_RATIO;
      cake.targetX = rectX + point.x + (stacked ? rand(-jitter, jitter) : 0);
      cake.targetY = rectY + point.y + (stacked ? rand(-jitter, jitter) : 0);
      cake.originX = cake.x;
      cake.originY = cake.y;
      cake.controlX = (cake.originX + cake.targetX) * 0.5 + rand(-TEXT_CONTROL_SPREAD, TEXT_CONTROL_SPREAD);
      cake.controlY =
        Math.min(cake.originY, cake.targetY) - TEXT_ARC_LIFT - Math.random() * TEXT_ARC_LIFT_RANDOM;
      cake.delay =
        (cake.originX / Math.max(1, width)) * phases.flyStagger + Math.random() * TEXT_DELAY_RANDOM;
      cake.rot0 = cake.rot;
    }
  }

  /* ------------------------------------------------------------------ *
   * Poem layer
   * ------------------------------------------------------------------ */

  function drawPoem(): void {
    if (!poem || !poem.items.length) return;

    const local = elapsed - phases.poemStart;
    if (local <= 0) return;

    const time = local % poem.cycle;
    const intro = clamp(local / phases.poemFade, 0, 1);

    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";

    for (const item of poem.items) {
      if (time < item.start || time >= item.end) continue;

      const progress = (time - item.start) / (item.end - item.start);
      const envelope =
        intro *
        easeInOutQuad(clamp(progress / POEM_FADE_IN_FRACTION, 0, 1)) *
        easeInOutQuad(clamp((1 - progress) / POEM_FADE_OUT_FRACTION, 0, 1));
      if (envelope <= POEM_MIN_ENVELOPE) continue;

      const lines = poem.columns[item.pair];
      const rise = progress * item.drift;
      const sway = Math.sin(elapsed * item.swaySpeed + item.phase) * item.swayAmplitude;

      context.font = `500 ${item.fontSize.toFixed(1)}px ${SERIF_FONT_STACK}`;

      for (let column = 0; column < 2; column++) {
        const glyphs = lines[column];
        // Right column carries the leading line, left column the answer.
        const columnX =
          item.centerX +
          (column === 0 ? item.fontSize * POEM_COLUMN_GAP_RATIO : -item.fontSize * POEM_COLUMN_GAP_RATIO) +
          sway;
        for (let index = 0; index < glyphs.length; index++) {
          const phase = glyphPhase(item, column, index);
          const y =
            item.centerY +
            (index - (glyphs.length - 1) / 2) * item.lineHeight +
            rise +
            Math.sin(elapsed * POEM_CHAR_WOBBLE_SPEED * item.wobble + phase) *
              POEM_CHAR_WOBBLE_AMPLITUDE;
          const breathe = 0.5 + 0.5 * Math.sin(elapsed * POEM_BREATHE_SPEED + phase * 0.8);
          const alpha = envelope * (POEM_ALPHA_BASE + POEM_ALPHA_RANGE * breathe);

          context.shadowColor = `rgba(255,226,160,${(alpha * POEM_GLOW_ALPHA_SCALE).toFixed(4)})`;
          context.shadowBlur = POEM_GLOW_BLUR;
          context.fillStyle = `rgba(255,238,196,${alpha.toFixed(4)})`;
          context.fillText(glyphs[index], columnX, y);
        }
      }
    }
    context.restore();
  }

  /* ------------------------------------------------------------------ *
   * Update
   * ------------------------------------------------------------------ */

  function update(dt: number): void {
    /* Phase 1: the moon */
    if (elapsed <= phases.rise) {
      const position = moonPosition();
      trail.push({ x: position.x, y: position.y, bornAt: elapsed });
      if (trail.length > MOON_TRAIL_MAX) trail.shift();
    } else if (!moonSparkDone) {
      moonSparkDone = true;
      burst(moonPath.end.x, moonPath.end.y, MOON_SPARK_COUNT);
    }

    /* Phase 2: the mooncake rain */
    if (elapsed >= phases.rainStart && elapsed < phases.rainStart + phases.spawnDuration) {
      spawnAccumulator += dt * phases.rainRate;
      let guard = 0;
      while (spawnAccumulator >= 1 && guard++ < RAIN_SPAWN_GUARD) {
        spawnAccumulator -= 1;
        spawnCake();
      }
    }

    const gravity = Math.max(GRAVITY_MIN, height * GRAVITY_K);
    for (const cake of cakes) {
      if (cake.state !== "falling") continue;

      cake.vy += gravity * dt;
      cake.x += cake.vx * dt;
      cake.y += cake.vy * dt;
      cake.rot += cake.spin * dt;

      if (cake.x < cakeRadius) {
        cake.x = cakeRadius;
        cake.vx = Math.abs(cake.vx) * CAKE_BOUNCE_DAMPING;
      }
      if (cake.x > width - cakeRadius) {
        cake.x = width - cakeRadius;
        cake.vx = -Math.abs(cake.vx) * CAKE_BOUNCE_DAMPING;
      }

      const column = columnIndexOf(cake.x);
      const floorY = groundY - columnHeights[column];

      if (cake.y + cakeRadius * CAKE_CONTACT_RATIO >= floorY) {
        cake.y = floorY - cakeRadius * CAKE_CONTACT_RATIO;
        cake.vy = 0;
        cake.state = "landed";
        cake.rot0 = cake.rot;

        // Column piling: the column grows and spreads slightly into its
        // neighbours, which keeps the pile from looking like a wall.
        columnHeights[column] +=
          cakeRadius * CAKE_COLUMN_GROWTH + Math.random() * cakeRadius * CAKE_COLUMN_GROWTH_RANDOM;
        if (column > 0) columnHeights[column - 1] += cakeRadius * CAKE_COLUMN_SPREAD;
        if (column < columnCount - 1) columnHeights[column + 1] += cakeRadius * CAKE_COLUMN_SPREAD;
      }
    }

    /* Phase 3: take off and assemble the text */
    if (elapsed >= phases.flyStart && !textTargetsBuilt) {
      for (const cake of cakes) {
        if (cake.state === "falling") {
          cake.state = "landed";
          cake.vy = 0;
          cake.rot0 = cake.rot;
        }
      }
      buildTextTargets();
      textTargetsBuilt = true;
    }

    if (textTargetsBuilt) {
      for (const cake of cakes) {
        if (cake.state !== "landed") continue;

        const local = elapsed - phases.flyStart - cake.delay;
        if (local <= 0) continue;

        const progress = Math.min(1, local / phases.flyDuration);
        const eased = easeInOutCubic(progress);
        const inverse = 1 - eased;

        cake.x = inverse * inverse * cake.originX + 2 * inverse * eased * cake.controlX + eased * eased * cake.targetX;
        cake.y = inverse * inverse * cake.originY + 2 * inverse * eased * cake.controlY + eased * eased * cake.targetY;
        cake.rot = cake.rot0 * (1 - eased);

        if (progress >= 1) {
          cake.state = "placed";
          cake.x = cake.targetX;
          cake.y = cake.targetY;
          cake.rot = 0;
        }
      }
    }

    if (!textSparkDone && elapsed >= phases.done) {
      textSparkDone = true;
      if (textRect) burst(textRect.x + textRect.w / 2, textRect.y + textRect.h / 2, TEXT_SPARK_COUNT);
      showCaption();
    }

    /* Phase 4: the background poem layer */
    if (elapsed >= phases.poemStart && !poemBuilt) {
      poem = createPoemSchedule({
        width,
        height,
        maxPairs: config.poemMax,
        pairs: config.poemPairs,
      });
      poemBuilt = true;
    }
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  function drawCakes(): void {
    if (!cakeSprite) return;
    const spriteWidth = cakeSprite.width * cakeSpriteScale;
    const spriteHeight = cakeSprite.height * cakeSpriteScale;

    for (const cake of cakes) {
      if (cake.y < -60) continue;
      context.save();
      context.translate(cake.x, cake.y);
      if (cake.rot) context.rotate(cake.rot);
      context.drawImage(cakeSprite, -spriteWidth / 2, -spriteHeight / 2, spriteWidth, spriteHeight);
      context.restore();
    }
  }

  function render(): void {
    const skyAlpha = config.skyAlpha * skyProgress;
    context.clearRect(0, 0, width, height);

    context.globalAlpha = skyAlpha;
    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0.0, "#02040f");
    sky.addColorStop(0.35, "#061024");
    sky.addColorStop(0.7, "#0a1730");
    sky.addColorStop(1.0, "#10203d");
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;

    drawStars(skyAlpha);
    drawHorizon(skyAlpha);

    // The poem layer stays at the very back so it never fights the text.
    if (poemBuilt) drawPoem();

    drawTrail();
    drawMoon();
    drawCakes();
  }

  /* ------------------------------------------------------------------ *
   * Sparks and caption
   * ------------------------------------------------------------------ */

  function burst(x: number, y: number, count: number): void {
    if (!config.sparkle) return;
    for (let index = 0; index < count; index++) {
      const spark = document.createElement("i");
      spark.className = "mid-autumn-egg-spark";
      const angle = Math.random() * Math.PI * 2;
      const distance = SPARK_DISTANCE_MIN + Math.random() * SPARK_DISTANCE_RANGE;
      spark.style.left = `${x}px`;
      spark.style.top = `${y}px`;
      spark.style.setProperty("--mid-autumn-egg-spark-dx", `${Math.cos(angle) * distance}px`);
      spark.style.setProperty("--mid-autumn-egg-spark-dy", `${Math.sin(angle) * distance}px`);
      spark.style.animationDelay = `${Math.random() * SPARK_DELAY_RANGE_MS}ms`;
      decor.appendChild(spark);

      const frame = window.requestAnimationFrame(() => {
        sparkFrames = sparkFrames.filter((id) => id !== frame);
        if (destroyed) return;
        spark.classList.add("play");
      });
      sparkFrames.push(frame);

      const timer = window.setTimeout(() => {
        spark.remove();
        sparks = sparks.filter((handle) => handle.element !== spark);
      }, SPARK_LIFETIME_MS);
      sparks.push({ element: spark, timer });
    }
  }

  function clearSparks(): void {
    for (const handle of sparks) {
      window.clearTimeout(handle.timer);
      handle.element.remove();
    }
    sparks = [];
    for (const frame of sparkFrames) window.cancelAnimationFrame(frame);
    sparkFrames = [];
  }

  function showCaption(): void {
    if (!config.caption) return;
    caption.classList.remove("show");
    void caption.offsetWidth; // Force a reflow so the animation can replay.
    caption.classList.add("show");
  }

  /* ------------------------------------------------------------------ *
   * Main loop, seek and static frame
   * ------------------------------------------------------------------ */

  function loop(now: number): void {
    if (destroyed) return;
    if (!lastFrameTime) lastFrameTime = now;
    let dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (dt > MAX_FRAME_STEP_SECONDS) dt = MAX_FRAME_STEP_SECONDS;
    if (dt < 0) dt = 0;

    if (!startTime) startTime = now;
    elapsed = (now - startTime) / 1000;
    skyProgress = clamp(elapsed / phases.skyIn, 0, 1);

    update(dt);
    render();

    frameId = window.requestAnimationFrame(loop);
  }

  /** Run the simulation forward in fixed steps; used by reduced motion and by QA seeks. */
  function fastForward(target: number): void {
    elapsed = 0;
    skyProgress = 1;
    const step = SIMULATION_STEP_SECONDS;
    let steps = 0;
    while (elapsed < target && steps++ < MAX_FAST_FORWARD_STEPS) {
      elapsed += step;
      update(step);
    }
    elapsed = target;
  }

  function renderStaticFrame(): void {
    fastForward(phases.done + STATIC_FRAME_TAIL_SECONDS);
    skyProgress = 1;
    render();
  }

  function renderSeekFrame(target: number): void {
    fastForward(target);
    skyProgress = clamp(target / phases.skyIn, 0, 1);
    render();
    if (target >= phases.done) showCaption();
  }

  /* ------------------------------------------------------------------ *
   * Resize
   * ------------------------------------------------------------------ */

  function onResize(): void {
    resizeTimer = null;
    setup();
    if (seekSeconds !== null) {
      renderSeekFrame(seekSeconds);
      return;
    }
    if (reduceMotion) {
      renderStaticFrame();
      showCaption();
    }
  }

  function scheduleRelayout(delay: number): void {
    if (destroyed) return;
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(onResize, delay);
  }

  function onWindowResize(): void {
    scheduleRelayout(RESIZE_DEBOUNCE_MS);
  }

  function onOrientationChange(): void {
    scheduleRelayout(ORIENTATION_DEBOUNCE_MS);
  }

  /* ------------------------------------------------------------------ *
   * Assets and lifecycle
   * ------------------------------------------------------------------ */

  function loadImage(url: string, onSettled: () => void): HTMLImageElement {
    const image = new Image();
    image.onload = onSettled;
    image.onerror = () => {
      // Non-fatal: the animation keeps running without that layer.
      options.onError?.(new Error(`Mid-Autumn easter egg: failed to load ${url}`));
      onSettled();
    };
    image.src = url;
    return image;
  }

  function loadImages(onReady: () => void): void {
    let settled = 0;
    const done = (): void => {
      if (++settled === 2) onReady();
    };
    moonImage = loadImage(options.moonImageUrl, done);
    cakeImage = loadImage(options.cakeImageUrl, done);
  }

  function releaseImages(): void {
    for (const image of [moonImage, cakeImage]) {
      if (!image) continue;
      image.onload = null;
      image.onerror = null;
    }
    moonImage = null;
    cakeImage = null;
  }

  function start(): void {
    if (started || destroyed) return;
    started = true;

    window.addEventListener("resize", onWindowResize);
    window.addEventListener("orientationchange", onOrientationChange);
    setup();

    loadImages(() => {
      if (destroyed) return;
      if (cakeImage) buildCakeSprite();
      reset();
      if (seekSeconds !== null) {
        renderSeekFrame(seekSeconds);
        return;
      }
      if (reduceMotion) {
        renderStaticFrame();
        showCaption();
        return;
      }
      frameId = window.requestAnimationFrame(loop);
    });
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;

    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (resizeTimer !== null) {
      window.clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("orientationchange", onOrientationChange);

    clearSparks();
    releaseImages();
    caption.classList.remove("show");
    decor.remove();

    cakes = [];
    stars = [];
    trail = [];
    poem = null;
    columnHeights = new Float32Array(0);
    cakeSprite = null;
    textRect = null;
  }

  return { start, destroy };
}
