/**
 * Mid-Autumn easter egg — Three.js + GSAP scene engine.
 *
 * GPU-accelerated 3D night sky with twinkling star particles, a glowing moon
 * rising on a bezier path, mooncake sprite rain, text assembly via arc
 * trajectories, floating poem overlay, spark bursts, ambient firefly
 * particles, and subtle camera breathing.
 *
 * The scene uses the provided canvas for Three.js WebGLRenderer and creates
 * a DOM decoration layer (veil, caption, sparks) inside the canvas' parent.
 * Everything is torn down in `destroy()`.
 */
import * as THREE from "three";
import gsap from "gsap";
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
  MOON_GLOW_OUTER_RATIO,
  MOON_PATH_END_MIN_RATIO,
  MOON_PATH_START_OFFSET,
  MOON_RADIUS_MAX,
  MOON_RADIUS_MIN,
  MOON_RADIUS_RATIO,
  MOON_SPARK_COUNT,
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
  ORIENTATION_DEBOUNCE_MS,
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


/* ------------------------------------------------------------------ *
 * Public API (unchanged)
 * ------------------------------------------------------------------ */

export type MidAutumnEggSceneOptions = {
  canvas: HTMLCanvasElement;
  moonImageUrl: string;
  cakeImageUrl: string;
  seekSeconds?: number;
  onError?: (error: unknown) => void;
};

export type MidAutumnEggScene = { start(): void; destroy(): void };

/* ------------------------------------------------------------------ *
 * Three.js shader sources for star twinkling
 * ------------------------------------------------------------------ */

const STAR_VERTEX = /* glsl */ `
  attribute float aAlpha;
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aSize;
  varying float vAlpha;
  uniform float uTime;
  uniform float uSkyAlpha;
  void main() {
    float twinkle = 0.5 + 0.5 * sin(uTime * aSpeed + aPhase);
    vAlpha = aAlpha * (0.3 + 0.7 * twinkle) * uSkyAlpha;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mvPos.z);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(0.86, 0.91, 1.0, vAlpha * glow);
  }
`;

/* ------------------------------------------------------------------ *
 * Firefly shader (ambient golden particles)
 * ------------------------------------------------------------------ */

const FIREFLY_VERTEX = /* glsl */ `
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aDrift;
  varying float vAlpha;
  uniform float uTime;
  void main() {
    vec3 pos = position;
    pos.x += sin(uTime * aSpeed * 0.3 + aPhase) * aDrift;
    pos.y += cos(uTime * aSpeed * 0.2 + aPhase * 1.3) * aDrift * 0.6;
    pos.y += uTime * aSpeed * 0.02;
    float twinkle = 0.5 + 0.5 * sin(uTime * aSpeed + aPhase);
    vAlpha = twinkle * 0.6;
    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = 3.0 * (300.0 / -mvPos.z);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FIREFLY_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(1.0, 0.88, 0.55, vAlpha * glow);
  }
`;


/* ------------------------------------------------------------------ *
 * Internal types
 * ------------------------------------------------------------------ */

type CakeLifecycle = "falling" | "landed" | "placed";

type Cake = {
  x: number; y: number;
  vx: number; vy: number;
  rot: number; rot0: number; spin: number;
  state: CakeLifecycle;
  targetX: number; targetY: number;
  originX: number; originY: number;
  controlX: number; controlY: number;
  delay: number;
  /** Index in the InstancedMesh */
  idx: number;
};

type SparkHandle = { element: HTMLElement; timer: number };
type MoonPath = { start: Vec2; control1: Vec2; control2: Vec2; end: Vec2 };
type TextRect = { x: number; y: number; w: number; h: number };

/* ------------------------------------------------------------------ *
 * Scene factory
 * ------------------------------------------------------------------ */

export function createMidAutumnEggScene(
  options: MidAutumnEggSceneOptions,
): MidAutumnEggScene {
  const canvas = options.canvas;
  const config: MidAutumnEggConfig = DEFAULT_MID_AUTUMN_EGG_CONFIG;
  const phases: MidAutumnEggPhases = createMidAutumnEggPhases(config);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const seekSeconds =
    typeof options.seekSeconds === "number" && Number.isFinite(options.seekSeconds)
      ? Math.max(0, options.seekSeconds)
      : null;

  /* ---- DOM decoration layer (veil, caption, sparks) ---- */
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

  /* ---- Three.js core ---- */
  let width = window.innerWidth;
  let height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height);
  renderer.setClearColor(0x02040f, 1);

  const scene3d = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / height, 1, 2000);
  camera.position.set(0, 0, 500);

  /* ---- Layout state ---- */
  let cakeRadius = 9;
  let groundY = 0;
  let columnWidth = 16;
  let columnCount = 0;
  let columnHeights = new Float32Array(0);
  let moonRadius = 60;
  let moonPath: MoonPath = createMoonPathLayout(0, 0, 0);


  /* ---- Mooncake instance pool ---- */
  const MAX_CAKES = config.cakes + 50;
  const cakeSpriteGeo = new THREE.PlaneGeometry(1, 1);
  const cakeInstanceMat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const cakeInstanceMesh = new THREE.InstancedMesh(cakeSpriteGeo, cakeInstanceMat, MAX_CAKES);
  cakeInstanceMesh.count = 0;
  cakeInstanceMesh.frustumCulled = false;
  scene3d.add(cakeInstanceMesh);

  const tmpMatrix = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);

  /* ---- Scene state ---- */
  let cakes: Cake[] = [];
  let poem: PoemSchedule | null = null;
  let textRect: TextRect | null = null;
  let sparks: SparkHandle[] = [];
  let sparkFrames: number[] = [];

  let elapsed = 0;
  let startTime = 0;
  let lastFrameTime = 0;
  let spawnAccumulator = 0;
  let skyProgress = 0;
  let textTargetsBuilt = false;
  let poemBuilt = false;
  let moonSparkDone = false;
  let textSparkDone = false;
  let started = false;
  let destroyed = false;
  let resizeTimer: number | null = null;

  /* ---- GSAP master timeline ---- */
  const masterTL = gsap.timeline({ paused: true });

  /* ---- Stars (Three.js Points) ---- */
  let starPoints: THREE.Points | null = null;
  let starUniforms = {
    uTime: { value: 0 },
    uSkyAlpha: { value: 0 },
  };

  /* ---- Moon objects ---- */
  let moonGroup: THREE.Group | null = null;
  let moonSprite: THREE.Sprite | null = null;
  let moonGlow: THREE.Sprite | null = null;
  let moonMesh: THREE.Mesh | null = null;

  /* ---- Fireflies ---- */
  let fireflyPoints: THREE.Points | null = null;
  let fireflyUniforms = { uTime: { value: 0 } };

  /* ---- Poem canvas overlay (2D canvas rendered as texture) ---- */
  let poemCanvas: HTMLCanvasElement | null = null;
  let poemContext: CanvasRenderingContext2D | null = null;
  let poemTexture: THREE.CanvasTexture | null = null;
  let poemPlane: THREE.Mesh | null = null;


  /* ================================================================ *
   * Layout helpers
   * ================================================================ */

  function createMoonPathLayout(vw: number, vh: number, r: number): MoonPath {
    return {
      start: {
        x: -r * MOON_PATH_START_OFFSET,
        y: vh + r * MOON_PATH_START_OFFSET,
      },
      control1: { x: vw * 0.05, y: vh * 0.7 },
      control2: { x: vw * 0.33, y: vh * 0.04 },
      end: {
        x: vw * 0.78,
        y: Math.max(r * MOON_PATH_END_MIN_RATIO, vh * 0.16),
      },
    };
  }

  /** Convert screen coords (origin top-left) to Three.js world coords. */
  function screenToWorld(sx: number, sy: number): THREE.Vector3 {
    return new THREE.Vector3(
      sx - width / 2,
      -(sy - height / 2),
      0,
    );
  }

  function columnIndexOf(x: number): number {
    return clamp(Math.floor(x / columnWidth), 0, columnCount - 1);
  }

  /* ================================================================ *
   * Build stars
   * ================================================================ */

  function buildStars(): void {
    if (starPoints) {
      scene3d.remove(starPoints);
      starPoints.geometry.dispose();
      (starPoints.material as THREE.ShaderMaterial).dispose();
    }

    const count = clamp(
      Math.round((width * height) / STAR_DENSITY),
      STAR_COUNT_MIN,
      STAR_COUNT_MAX,
    );

    const positions = new Float32Array(count * 3);
    const alphas = new Float32Array(count);
    const phases = new Float32Array(count);
    const speeds = new Float32Array(count);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * width;
      positions[i * 3 + 1] = (Math.random() * height * STAR_BAND_RATIO) - height / 2;
      positions[i * 3 + 2] = -100 - Math.random() * 400;
      alphas[i] = STAR_ALPHA_MIN + Math.random() * STAR_ALPHA_RANGE;
      phases[i] = Math.random() * Math.PI * 2;
      speeds[i] = STAR_SPEED_MIN + Math.random() * STAR_SPEED_RANGE;
      sizes[i] = STAR_RADIUS_MIN + Math.random() * STAR_RADIUS_RANGE;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: starUniforms,
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    starPoints = new THREE.Points(geo, mat);
    starPoints.frustumCulled = false;
    scene3d.add(starPoints);
  }


  /* ================================================================ *
   * Build moon (sprite + glow)
   * ================================================================ */

  function buildMoon(moonTexture: THREE.Texture): void {
    moonGroup = new THREE.Group();

    // Outer glow sprite
    const glowCanvas = document.createElement("canvas");
    const gs = 256;
    glowCanvas.width = gs;
    glowCanvas.height = gs;
    const gCtx = glowCanvas.getContext("2d");
    if (gCtx) {
      const gradient = gCtx.createRadialGradient(gs / 2, gs / 2, gs * 0.1, gs / 2, gs / 2, gs / 2);
      gradient.addColorStop(0, "rgba(255,238,175,0.35)");
      gradient.addColorStop(0.3, "rgba(255,220,140,0.12)");
      gradient.addColorStop(0.6, "rgba(255,205,120,0.04)");
      gradient.addColorStop(1, "rgba(255,200,110,0)");
      gCtx.fillStyle = gradient;
      gCtx.fillRect(0, 0, gs, gs);
    }
    const glowTexture = new THREE.CanvasTexture(glowCanvas);
    const glowMat = new THREE.SpriteMaterial({
      map: glowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
    });
    moonGlow = new THREE.Sprite(glowMat);
    moonGlow.scale.set(moonRadius * MOON_GLOW_OUTER_RATIO * 2, moonRadius * MOON_GLOW_OUTER_RATIO * 2, 1);
    moonGroup.add(moonGlow);

    // Moon body sprite
    const bodyMat = new THREE.SpriteMaterial({
      map: moonTexture,
      transparent: true,
      depthTest: false,
    });
    moonSprite = new THREE.Sprite(bodyMat);
    moonSprite.scale.set(moonRadius * 2.2, moonRadius * 2.2, 1);
    moonGroup.add(moonSprite);

    // Start at the beginning of the path
    const startPos = screenToWorld(moonPath.start.x, moonPath.start.y);
    moonGroup.position.copy(startPos);
    scene3d.add(moonGroup);
  }

  /* ================================================================ *
   * Build fireflies
   * ================================================================ */

  function buildFireflies(): void {
    if (fireflyPoints) {
      scene3d.remove(fireflyPoints);
      fireflyPoints.geometry.dispose();
      (fireflyPoints.material as THREE.ShaderMaterial).dispose();
    }

    const count = 60;
    const positions = new Float32Array(count * 3);
    const ffPhases = new Float32Array(count);
    const ffSpeeds = new Float32Array(count);
    const ffDrifts = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * width * 0.9;
      positions[i * 3 + 1] = (Math.random() - 0.5) * height * 0.8;
      positions[i * 3 + 2] = -50 + Math.random() * 100;
      ffPhases[i] = Math.random() * Math.PI * 2;
      ffSpeeds[i] = 0.3 + Math.random() * 0.8;
      ffDrifts[i] = 10 + Math.random() * 30;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(ffPhases, 1));
    geo.setAttribute("aSpeed", new THREE.BufferAttribute(ffSpeeds, 1));
    geo.setAttribute("aDrift", new THREE.BufferAttribute(ffDrifts, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: fireflyUniforms,
      vertexShader: FIREFLY_VERTEX,
      fragmentShader: FIREFLY_FRAGMENT,
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    fireflyPoints = new THREE.Points(geo, mat);
    fireflyPoints.frustumCulled = false;
    scene3d.add(fireflyPoints);
  }


  /* ================================================================ *
   * Build poem overlay (2D canvas → texture on a plane)
   * ================================================================ */

  function buildPoemOverlay(): void {
    poemCanvas = document.createElement("canvas");
    poemCanvas.width = Math.round(width * dpr);
    poemCanvas.height = Math.round(height * dpr);
    poemContext = poemCanvas.getContext("2d");
    if (!poemContext) return;

    poemTexture = new THREE.CanvasTexture(poemCanvas);
    poemTexture.minFilter = THREE.LinearFilter;
    const poemMat = new THREE.MeshBasicMaterial({
      map: poemTexture,
      transparent: true,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const poemGeo = new THREE.PlaneGeometry(width, height);
    poemPlane = new THREE.Mesh(poemGeo, poemMat);
    poemPlane.position.set(0, 0, 10);
    scene3d.add(poemPlane);
  }

  /* ================================================================ *
   * Horizon glow (static background plane)
   * ================================================================ */

  function buildHorizon(): void {
    const horizonCanvas = document.createElement("canvas");
    horizonCanvas.width = 2;
    horizonCanvas.height = 256;
    const hCtx = horizonCanvas.getContext("2d");
    if (!hCtx) return;

    const gradient = hCtx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, "rgba(255,190,110,0)");
    gradient.addColorStop(0.4, "rgba(255,172,92,0.055)");
    gradient.addColorStop(0.7, "rgba(255,152,70,0.10)");
    gradient.addColorStop(1, "rgba(255,140,60,0.16)");
    hCtx.fillStyle = gradient;
    hCtx.fillRect(0, 0, 2, 256);

    const tex = new THREE.CanvasTexture(horizonCanvas);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const geo = new THREE.PlaneGeometry(width * 1.2, height * 0.4);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, -height * 0.3, -200);
    scene3d.add(mesh);
  }


  /* ================================================================ *
   * Setup / reset / layout
   * ================================================================ */

  function setup(): void {
    width = window.innerWidth;
    height = window.innerHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

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
    moonPath = createMoonPathLayout(width, height, moonRadius);

    buildStars();
    buildFireflies();
    buildHorizon();
    buildPoemOverlay();
    reset();
  }

  function reset(): void {
    cakes = [];
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
    cakeInstanceMesh.count = 0;
    caption.classList.remove("show");
    clearSparks();
  }

  /* ================================================================ *
   * Mooncake spawn / physics
   * ================================================================ */

  function spawnCake(): void {
    const pad = cakeRadius * CAKE_SPAWN_PAD_RATIO;
    const idx = cakes.length;
    if (idx >= MAX_CAKES) return;

    cakes.push({
      x: pad + Math.random() * Math.max(1, width - pad * 2),
      y: -cakeRadius * 2 - Math.random() * CAKE_SPAWN_ABOVE_RANGE,
      vx: rand(-CAKE_SPAWN_VX, CAKE_SPAWN_VX),
      vy: rand(CAKE_SPAWN_VY_MIN, CAKE_SPAWN_VY_MIN + CAKE_SPAWN_VY_RANGE),
      rot: Math.random() * Math.PI * 2,
      rot0: 0,
      spin: rand(-CAKE_SPIN_RANGE, CAKE_SPIN_RANGE),
      state: "falling",
      targetX: 0, targetY: 0,
      originX: 0, originY: 0,
      controlX: 0, controlY: 0,
      delay: 0,
      idx,
    });
    cakeInstanceMesh.count = cakes.length;
  }


  /* ================================================================ *
   * Text assembly (same pixel-sampling approach)
   * ================================================================ */

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


  /* ================================================================ *
   * Poem layer drawing (2D canvas → texture)
   * ================================================================ */

  function drawPoem(): void {
    if (!poem || !poem.items.length || !poemContext || !poemCanvas || !poemTexture) return;

    const local = elapsed - phases.poemStart;
    if (local <= 0) return;

    const ctx = poemContext;
    const scale = dpr;
    ctx.clearRect(0, 0, poemCanvas.width, poemCanvas.height);

    const time = local % poem.cycle;
    const intro = clamp(local / phases.poemFade, 0, 1);

    ctx.save();
    ctx.scale(scale, scale);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

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
      ctx.font = `500 ${item.fontSize.toFixed(1)}px ${SERIF_FONT_STACK}`;

      for (let column = 0; column < 2; column++) {
        const glyphs = lines[column];
        const columnX =
          item.centerX +
          (column === 0
            ? item.fontSize * POEM_COLUMN_GAP_RATIO
            : -item.fontSize * POEM_COLUMN_GAP_RATIO) +
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

          ctx.shadowColor = `rgba(255,226,160,${(alpha * POEM_GLOW_ALPHA_SCALE).toFixed(4)})`;
          ctx.shadowBlur = POEM_GLOW_BLUR;
          ctx.fillStyle = `rgba(255,238,196,${alpha.toFixed(4)})`;
          ctx.fillText(glyphs[index], columnX, y);
        }
      }
    }
    ctx.restore();
    poemTexture.needsUpdate = true;
  }


  /* ================================================================ *
   * Update simulation
   * ================================================================ */

  function update(dt: number): void {
    /* Phase 1: the moon */
    if (elapsed <= phases.rise && moonGroup) {
      const progress = clamp(elapsed / phases.rise, 0, 1);
      const pos2d = cubicPoint(
        moonPath.start, moonPath.control1, moonPath.control2, moonPath.end,
        easeInOutQuad(progress),
      );
      const worldPos = screenToWorld(pos2d.x, pos2d.y);
      moonGroup.position.set(worldPos.x, worldPos.y, 0);
    } else if (!moonSparkDone) {
      moonSparkDone = true;
      burst(moonPath.end.x, moonPath.end.y, MOON_SPARK_COUNT);
    }

    /* Moon breathing */
    if (moonGroup && moonSprite && moonGlow) {
      const breathScale = 1 + Math.sin(elapsed * MOON_BREATH_SPEED) * MOON_BREATH_AMPLITUDE;
      moonSprite.scale.set(moonRadius * 2.2 * breathScale, moonRadius * 2.2 * breathScale, 1);
      moonGlow.scale.set(
        moonRadius * MOON_GLOW_OUTER_RATIO * 2 * breathScale,
        moonRadius * MOON_GLOW_OUTER_RATIO * 2 * breathScale,
        1,
      );
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
        columnHeights[column] +=
          cakeRadius * CAKE_COLUMN_GROWTH + Math.random() * cakeRadius * CAKE_COLUMN_GROWTH_RANDOM;
        if (column > 0) columnHeights[column - 1] += cakeRadius * CAKE_COLUMN_SPREAD;
        if (column < columnCount - 1) columnHeights[column + 1] += cakeRadius * CAKE_COLUMN_SPREAD;
      }
    }

    /* Phase 3: take off and assemble text */
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

    /* Phase 4: poem layer */
    if (elapsed >= phases.poemStart && !poemBuilt) {
      poem = createPoemSchedule({
        width,
        height,
        maxPairs: config.poemMax,
        pairs: config.poemPairs,
      });
      poemBuilt = true;
    }

    /* Update cake instance transforms */
    const cakeSize = cakeRadius * 2.2;
    for (const cake of cakes) {
      const world = screenToWorld(cake.x, cake.y);
      tmpQuat.setFromAxisAngle(zAxis, -cake.rot);
      tmpScale.set(cakeSize, cakeSize, 1);
      tmpMatrix.compose(world, tmpQuat, tmpScale);
      cakeInstanceMesh.setMatrixAt(cake.idx, tmpMatrix);
    }
    if (cakes.length > 0) {
      cakeInstanceMesh.instanceMatrix.needsUpdate = true;
    }
  }


  /* ================================================================ *
   * Render
   * ================================================================ */

  function render(): void {
    starUniforms.uTime.value = elapsed;
    starUniforms.uSkyAlpha.value = config.skyAlpha * skyProgress;
    fireflyUniforms.uTime.value = elapsed;

    /* Subtle camera drift */
    const camX = Math.sin(elapsed * 0.15) * 8;
    const camY = Math.cos(elapsed * 0.12) * 5;
    camera.position.set(camX, camY, 500);
    camera.lookAt(0, 0, 0);

    /* Poem layer */
    if (poemBuilt) drawPoem();

    renderer.render(scene3d, camera);
  }

  /* ================================================================ *
   * Sparks and caption
   * ================================================================ */

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
    void caption.offsetWidth;
    caption.classList.add("show");
  }


  /* ================================================================ *
   * Main loop, seek and static frame
   * ================================================================ */

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

  /* ================================================================ *
   * Resize
   * ================================================================ */

  let frameId: number | null = null;

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


  /* ================================================================ *
   * Asset loading and lifecycle
   * ================================================================ */

  function loadTextureFromUrl(url: string): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (texture) => resolve(texture),
        undefined,
        (error) => reject(error),
      );
    });
  }

  function start(): void {
    if (started || destroyed) return;
    started = true;

    window.addEventListener("resize", onWindowResize);
    window.addEventListener("orientationchange", onOrientationChange);
    setup();

    Promise.all([
      loadTextureFromUrl(options.moonImageUrl).catch((err) => {
        options.onError?.(err);
        return null;
      }),
      loadTextureFromUrl(options.cakeImageUrl).catch((err) => {
        options.onError?.(err);
        return null;
      }),
    ]).then(([moonTex, cakeTex]) => {
      if (destroyed) return;

      if (moonTex) buildMoon(moonTex);
      if (cakeTex) {
        cakeInstanceMat.map = cakeTex;
        cakeInstanceMat.needsUpdate = true;
      }

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

    masterTL.kill();
    clearSparks();
    caption.classList.remove("show");
    decor.remove();

    /* Dispose Three.js resources */
    renderer.dispose();
    scene3d.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
        const mat = object.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      if (object instanceof THREE.Sprite) {
        object.geometry.dispose();
        object.material.dispose();
        if (object.material.map) object.material.map.dispose();
      }
    });
    if (cakeInstanceMesh) {
      cakeInstanceMesh.geometry.dispose();
      cakeInstanceMat.dispose();
      if (cakeInstanceMat.map) cakeInstanceMat.map.dispose();
    }

    cakes = [];
    poem = null;
    columnHeights = new Float32Array(0);
    textRect = null;
    starPoints = null;
    moonGroup = null;
    moonSprite = null;
    moonGlow = null;
    moonMesh = null;
    fireflyPoints = null;
    poemCanvas = null;
    poemContext = null;
    poemTexture = null;
    poemPlane = null;
  }

  return { start, destroy };
}
