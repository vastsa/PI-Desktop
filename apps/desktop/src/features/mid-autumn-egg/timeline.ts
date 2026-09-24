/**
 * Timeline, easing helpers and tuning constants for the Mid-Autumn easter egg.
 *
 * This is a faithful port of the hand-verified standalone animation: the same
 * timeline, the same physics, the same shapes and the same poem scheduling.
 * Every magic number of that animation lives here with a name, so the scene
 * module stays readable and nothing drifts while the port is reviewed.
 */

/** Tunable knobs of the animation. The defaults are the verified baseline. */
export type MidAutumnEggConfig = {
  /** Baseline duration in seconds. Only the moon rise scales with it. */
  duration: number;
  /** Moon rise slowdown factor (1.5 = the moon rises 1.5x slower than the baseline). */
  moonSpeed: number;
  /** Sky opacity: below 1 the overlay canvas lets the application shine through. */
  skyAlpha: number;
  /** Total number of mooncakes; also the pixel density of the assembled text. */
  cakes: number;
  /** Text assembled out of mooncakes (on-screen artwork, intentionally Chinese). */
  text: string;
  /**
   * Vertical poem pairs. Within a pair the right column is the leading line and
   * the left column answers it (vertical text reads right to left).
   */
  poemPairs: readonly (readonly [string, string])[];
  /** How many poem pairs may float on screen at the same time. */
  poemMax: number;
  /** Spark bursts when the moon arrives and when the text is assembled. */
  sparkle: boolean;
  /** Closing caption in the top-right corner. */
  caption: boolean;
};

/** The configuration the standalone animation was verified with. */
export const DEFAULT_MID_AUTUMN_EGG_CONFIG: MidAutumnEggConfig = {
  duration: 5.0,
  moonSpeed: 1.5,
  skyAlpha: 0.9,
  cakes: 520,
  text: "中秋快乐",
  poemPairs: [
    ["明月几时有", "把酒问青天"],
    ["不知天上宫阙", "今夕是何年"],
    ["我欲乘风归去", "又恐琼楼玉宇"],
    ["高处不胜寒", "起舞弄清影"],
    ["何似在人间", "转朱阁低绮户"],
    ["照无眠", "不应有恨"],
    ["何事长向别时圆", "人有悲欢离合"],
    ["月有阴晴圆缺", "此事古难全"],
    // The most famous pair opens the animation.
    ["但愿人长久", "千里共婵娟"],
  ],
  poemMax: 4,
  sparkle: true,
  caption: true,
};

/** Absolute timeline of one run, in seconds. */
export type MidAutumnEggPhases = {
  /** Moon rise along the bezier curve. */
  rise: number;
  /** Short hold in the top-right corner after the rise. */
  hold: number;
  /** First fallen mooncake. */
  rainStart: number;
  /** Window during which mooncakes are spawned. */
  spawnDuration: number;
  /** End of the falling window. */
  rainEnd: number;
  /** Mooncakes take off to assemble the text. */
  flyStart: number;
  /** Left-to-right stagger of the take-off. */
  flyStagger: number;
  /** Flight time of a single mooncake. */
  flyDuration: number;
  /** The text is fully assembled. */
  done: number;
  /** Background poem pairs start fading in. */
  poemStart: number;
  /** Fade-in duration of the whole poem layer. */
  poemFade: number;
  /** Night sky fade-in. */
  skyIn: number;
  /** Mooncakes spawned per second during the spawn window. */
  rainRate: number;
};

/**
 * Derive the timeline from the config.
 *
 * The rise scales with `duration * 0.21 * moonSpeed`; every later phase is a
 * fixed offset from `rainStart`, so the mooncake rain keeps its own rhythm no
 * matter how slow the moon is.
 */
export function createMidAutumnEggPhases(
  config: MidAutumnEggConfig,
): MidAutumnEggPhases {
  const rise = config.duration * 0.21 * config.moonSpeed;
  const hold = 0.25;
  const rainStart = rise + hold;
  const spawnDuration = 1.2;
  const flyStart = rainStart + 2.2;
  const flyStagger = 0.5;
  const flyDuration = 0.8;
  return {
    rise,
    hold,
    rainStart,
    spawnDuration,
    rainEnd: rainStart + 1.75,
    flyStart,
    flyStagger,
    flyDuration,
    done: flyStart + flyStagger + flyDuration,
    poemStart: rainStart + 3.15,
    poemFade: 0.75,
    skyIn: 0.9,
    rainRate: config.cakes / spawnDuration,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export type Vec2 = { x: number; y: number };

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Point on a cubic bezier curve at `t` in 0..1. */
export function cubicPoint(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  t: number,
): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/* ------------------------------------------------------------------ *
 * Fonts and sprite geometry
 * ------------------------------------------------------------------ */

export const TEXT_FONT_STACK =
  '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif';
export const SERIF_FONT_STACK =
  '"Songti SC","STSong","SimSun","Noto Serif SC",serif';

/** Share of the moon/cake sprite that is the solid body (the images carry a glow). */
export const MOON_FILL = 0.86;
export const CAKE_FILL = 0.87;
/** Supersampling factor of the cached mooncake sprite, plus its glow padding. */
export const CAKE_SPRITE_SUPERSAMPLE = 2;
export const CAKE_SPRITE_PADDING_RATIO = 1.36;
export const CAKE_SPRITE_LIFT_RATIO = 0.015;

/* ------------------------------------------------------------------ *
 * Layout ratios (resolution independent)
 * ------------------------------------------------------------------ */

export const CAKE_RADIUS_RATIO = 0.012;
export const CAKE_RADIUS_MIN = 5;
export const CAKE_RADIUS_MAX = 11;
export const GROUND_INSET_RATIO = 0.06;
export const GROUND_INSET_MIN = 26;
/** Stacking column width as a multiple of the mooncake radius. */
export const CAKE_COLUMN_WIDTH_RATIO = 1.6;
export const MOON_RADIUS_RATIO = 0.075;
export const MOON_RADIUS_MIN = 34;
export const MOON_RADIUS_MAX = 88;
export const MOON_PATH_START_OFFSET = 1.8;
export const MOON_PATH_END_MIN_RATIO = 1.9;
export const STAR_DENSITY = 9000;
export const STAR_COUNT_MIN = 80;
export const STAR_COUNT_MAX = 320;
export const STAR_BAND_RATIO = 0.88;
export const STAR_RADIUS_MIN = 0.35;
export const STAR_RADIUS_RANGE = 1.3;
export const STAR_ALPHA_MIN = 0.2;
export const STAR_ALPHA_RANGE = 0.65;
export const STAR_SPEED_MIN = 0.5;
export const STAR_SPEED_RANGE = 1.9;

/* ------------------------------------------------------------------ *
 * Physics and rain
 * ------------------------------------------------------------------ */

/** Gravity = screen height * this factor, so the fall time is resolution independent. */
export const GRAVITY_K = 3.2;
export const GRAVITY_MIN = 1500;
export const CAKE_SPAWN_PAD_RATIO = 2.2;
export const CAKE_SPAWN_ABOVE_RANGE = 80;
export const CAKE_SPAWN_VX = 27;
export const CAKE_SPAWN_VY_MIN = 50;
export const CAKE_SPAWN_VY_RANGE = 110;
export const CAKE_SPIN_RANGE = 2.5;
export const CAKE_BOUNCE_DAMPING = 0.5;
/** Contact offset of the cake centre above the floor and the pile top. */
export const CAKE_CONTACT_RATIO = 0.82;
export const CAKE_COLUMN_GROWTH = 1.5;
export const CAKE_COLUMN_GROWTH_RANDOM = 0.3;
export const CAKE_COLUMN_SPREAD = 0.12;
export const RAIN_SPAWN_GUARD = 24;

/* ------------------------------------------------------------------ *
 * Text assembly
 * ------------------------------------------------------------------ */

export const TEXT_RECT_MAX_WIDTH = 1100;
export const TEXT_RECT_WIDTH_RATIO = 0.88;
export const TEXT_RECT_ASPECT = 4.6;
export const TEXT_RECT_MAX_HEIGHT_RATIO = 0.38;
export const TEXT_RECT_CENTER_Y_RATIO = 0.47;
/** Stacked mooncakes (more cakes than sampled points) scatter by this much. */
export const TEXT_STACK_JITTER_RATIO = 0.6;
export const TEXT_CONTROL_SPREAD = 60;
export const TEXT_ARC_LIFT = 80;
export const TEXT_ARC_LIFT_RANDOM = 110;
export const TEXT_DELAY_RANDOM = 0.12;

/* ------------------------------------------------------------------ *
 * Moon
 * ------------------------------------------------------------------ */

export const MOON_BREATH_SPEED = 1.7;
export const MOON_BREATH_AMPLITUDE = 0.012;
export const MOON_GLOW_INNER_RATIO = 0.6;
export const MOON_GLOW_OUTER_RATIO = 3.2;
export const MOON_TRAIL_MAX = 70;
export const TRAIL_LIFETIME = 0.7;
export const TRAIL_GLOW_INNER_BASE = 14;
export const TRAIL_GLOW_INNER_LIFE = 18;
export const TRAIL_RADIUS_BASE = 18;
export const TRAIL_RADIUS_LIFE = 16;

/* ------------------------------------------------------------------ *
 * Sparks and caption
 * ------------------------------------------------------------------ */

export const MOON_SPARK_COUNT = 18;
export const TEXT_SPARK_COUNT = 22;
export const SPARK_DISTANCE_MIN = 18;
export const SPARK_DISTANCE_RANGE = 42;
export const SPARK_DELAY_RANGE_MS = 180;
export const SPARK_LIFETIME_MS = 1900;
/** Caption copy: artwork content, not UI chrome. */
export const CAPTION_TITLE = "月满 · 团圆";
export const CAPTION_SUBTITLE = "AIUO · PI-DESKTOP";

/* ------------------------------------------------------------------ *
 * Loop, resize and fast-forward
 * ------------------------------------------------------------------ */

export const MAX_FRAME_STEP_SECONDS = 0.05;
export const SIMULATION_STEP_SECONDS = 1 / 60;
/** Upper bound of fast-forward steps, so a hostile seek value cannot hang the renderer. */
export const MAX_FAST_FORWARD_STEPS = 60 * 600;
export const STATIC_FRAME_TAIL_SECONDS = 0.8;
export const RESIZE_DEBOUNCE_MS = 160;
export const ORIENTATION_DEBOUNCE_MS = 260;

/* ------------------------------------------------------------------ *
 * Poem layer tuning
 * ------------------------------------------------------------------ */

export const POEM_SEED = 20260924;
/** The schedule is precomputed for 30 minutes and then loops. */
export const POEM_HORIZON_SECONDS = 1800;
export const POEM_SCHEDULE_GUARD = 5000;
export const POEM_GAP_BASE_SECONDS = 0.6;
export const POEM_GAP_RANDOM_SECONDS = 3.2;
export const POEM_LIFE_BASE_SECONDS = 8;
export const POEM_LIFE_RANDOM_SECONDS = 6;
export const POEM_FONT_RATIO = 0.03;
export const POEM_FONT_MIN = 13;
export const POEM_FONT_MAX = 34;
export const POEM_FONT_SCALE_MIN = 0.72;
export const POEM_FONT_SCALE_RANGE = 0.62;
export const POEM_LINE_HEIGHT_RATIO = 1.12;
export const POEM_HALF_HEIGHT_PAD_RATIO = 0.62;
/** Horizontal half-extent of a two-column pair, in font sizes. */
export const POEM_HALF_WIDTH_RATIO = 1.35;
export const POEM_COLUMN_GAP_RATIO = 0.82;
export const POEM_EDGE_PADDING = 12;
export const POEM_VERTICAL_MARGIN = 14;
export const POEM_DRIFT_MIN = 20;
export const POEM_DRIFT_RANGE = 45;
export const POEM_SWAY_MIN = 4;
export const POEM_SWAY_RANGE = 9;
export const POEM_SWAY_SPEED_MIN = 0.16;
export const POEM_SWAY_SPEED_RANGE = 0.22;
export const POEM_WOBBLE_MIN = 0.55;
export const POEM_WOBBLE_RANGE = 0.4;
export const POEM_PHASE_RANGE = 6.283;
export const POEM_CYCLE_TAIL_SECONDS = 0.3;
export const POEM_FADE_IN_FRACTION = 0.16;
export const POEM_FADE_OUT_FRACTION = 0.28;
export const POEM_MIN_ENVELOPE = 0.002;
export const POEM_ALPHA_BASE = 0.042;
export const POEM_ALPHA_RANGE = 0.062;
export const POEM_GLOW_ALPHA_SCALE = 1.5;
export const POEM_GLOW_BLUR = 12;
export const POEM_COLUMN_STAGGER = 0.9;
export const POEM_CHAR_STAGGER = 0.5;
export const POEM_CHAR_WOBBLE_SPEED = 0.7;
export const POEM_CHAR_WOBBLE_AMPLITUDE = 3.4;
export const POEM_BREATHE_SPEED = 0.6;
