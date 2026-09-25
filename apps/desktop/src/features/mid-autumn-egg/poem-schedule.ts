/**
 * Vertical poem layer: the pair data, the seeded schedule and the per-item
 * geometry.
 *
 * Several pairs float on screen at once. Each "lane" picks its own random gap,
 * random lifetime and random pair, so appearance time, position and font size
 * are all irregular. The schedule is precomputed once and then loops.
 */
import {
  DEFAULT_MID_AUTUMN_EGG_CONFIG,
  POEM_CHAR_STAGGER,
  POEM_COLUMN_STAGGER,
  POEM_CYCLE_TAIL_SECONDS,
  POEM_DRIFT_MIN,
  POEM_DRIFT_RANGE,
  POEM_EDGE_PADDING,
  POEM_FONT_MAX,
  POEM_FONT_MIN,
  POEM_FONT_RATIO,
  POEM_FONT_SCALE_MIN,
  POEM_FONT_SCALE_RANGE,
  POEM_GAP_BASE_SECONDS,
  POEM_GAP_RANDOM_SECONDS,
  POEM_HALF_HEIGHT_PAD_RATIO,
  POEM_HALF_WIDTH_RATIO,
  POEM_HORIZON_SECONDS,
  POEM_LIFE_BASE_SECONDS,
  POEM_LIFE_RANDOM_SECONDS,
  POEM_LINE_HEIGHT_RATIO,
  POEM_PHASE_RANGE,
  POEM_SCHEDULE_GUARD,
  POEM_SEED,
  POEM_SWAY_MIN,
  POEM_SWAY_RANGE,
  POEM_SWAY_SPEED_MIN,
  POEM_SWAY_SPEED_RANGE,
  POEM_VERTICAL_MARGIN,
  POEM_WOBBLE_MIN,
  POEM_WOBBLE_RANGE,
  clamp,
} from "./timeline";

export type PoemPair = readonly [string, string];

/** One scheduled appearance of a pair, with all of its layout parameters. */
export type PoemScheduleItem = {
  /** Seconds, relative to the start of the poem cycle. */
  start: number;
  /** Seconds, relative to the start of the poem cycle. */
  end: number;
  /** Index into `PoemSchedule.columns`. */
  pair: number;
  fontSize: number;
  lineHeight: number;
  centerX: number;
  centerY: number;
  /** Vertical drift over the whole lifetime (negative = floats upwards). */
  drift: number;
  swayAmplitude: number;
  swaySpeed: number;
  wobble: number;
  phase: number;
};

/** Precomputed poem layer: the glyph columns plus the appearance schedule. */
export type PoemSchedule = {
  /** `columns[pair][column]` is a list of code points; column 0 is the right (leading) line. */
  columns: string[][][];
  items: PoemScheduleItem[];
  /** Length of the precomputed table; the animation loops it. */
  cycle: number;
};

/**
 * Deterministic linear congruential generator, so the layout of the poem layer
 * is reproducible for a given viewport instead of being resampled every frame.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createPoemSchedule(options: {
  width: number;
  height: number;
  /** How many pairs may be on screen at the same time (at least 1). */
  maxPairs: number;
  pairs?: readonly PoemPair[];
}): PoemSchedule {
  const { width, height, maxPairs } = options;
  const pairs = options.pairs ?? DEFAULT_MID_AUTUMN_EGG_CONFIG.poemPairs;
  const baseFontSize = clamp(
    Math.min(width, height) * POEM_FONT_RATIO,
    POEM_FONT_MIN,
    POEM_FONT_MAX,
  );
  const random = createSeededRandom(POEM_SEED);
  const laneCount = Math.max(1, Math.trunc(maxPairs));

  const columns = pairs.map(([leading, answering]) => [
    Array.from(leading),
    Array.from(answering),
  ]);
  const longestLines = pairs.map(([leading, answering]) =>
    Math.max(Array.from(leading).length, Array.from(answering).length),
  );

  const items: PoemScheduleItem[] = [];
  const laneEnds: number[] = [];
  const laneLastPairs: number[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    laneEnds.push(0);
    laneLastPairs.push(-1);
  }

  let guard = 0;
  while (guard++ < POEM_SCHEDULE_GUARD) {
    // Always extend the lane that finished first, so the lanes interleave.
    let slot = 0;
    for (let lane = 1; lane < laneCount; lane++) {
      if (laneEnds[lane] < laneEnds[slot]) slot = lane;
    }

    const start =
      laneEnds[slot] + POEM_GAP_BASE_SECONDS + random() * POEM_GAP_RANDOM_SECONDS;
    if (start > POEM_HORIZON_SECONDS) break;
    const life = POEM_LIFE_BASE_SECONDS + random() * POEM_LIFE_RANDOM_SECONDS;

    // The famous pair opens the animation; afterwards a lane never repeats its
    // own previous pair back to back.
    let pair = items.length === 0 ? pairs.length - 1 : Math.floor(random() * pairs.length);
    if (pair === laneLastPairs[slot]) pair = (pair + 1) % pairs.length;
    laneLastPairs[slot] = pair;
    laneEnds[slot] = start + life;

    const fontSize = baseFontSize * (POEM_FONT_SCALE_MIN + random() * POEM_FONT_SCALE_RANGE);
    const lineHeight = fontSize * POEM_LINE_HEIGHT_RATIO;
    const halfHeight =
      ((longestLines[pair] - 1) / 2) * lineHeight +
      fontSize * POEM_HALF_HEIGHT_PAD_RATIO;
    const halfWidth = fontSize * POEM_HALF_WIDTH_RATIO;
    const minY = halfHeight + POEM_VERTICAL_MARGIN;
    const maxY = height - halfHeight - POEM_VERTICAL_MARGIN;
    const minX = halfWidth + POEM_EDGE_PADDING;
    const maxX = width - halfWidth - POEM_EDGE_PADDING;

    items.push({
      start,
      end: start + life,
      pair,
      fontSize,
      lineHeight,
      // No fixed anchor: the pair may appear anywhere the text still fits.
      centerX: minX + random() * Math.max(1, maxX - minX),
      centerY: minY + random() * Math.max(1, maxY - minY),
      drift: -(POEM_DRIFT_MIN + random() * POEM_DRIFT_RANGE),
      swayAmplitude: POEM_SWAY_MIN + random() * POEM_SWAY_RANGE,
      swaySpeed: POEM_SWAY_SPEED_MIN + random() * POEM_SWAY_SPEED_RANGE,
      wobble: POEM_WOBBLE_MIN + random() * POEM_WOBBLE_RANGE,
      phase: random() * POEM_PHASE_RANGE,
    });
  }
  items.sort((left, right) => left.start - right.start);

  return {
    columns,
    items,
    cycle: items.length
      ? items[items.length - 1].end + POEM_CYCLE_TAIL_SECONDS
      : 1,
  };
}

/** Per-glyph phase offset used when drawing a pair. */
export function glyphPhase(item: PoemScheduleItem, column: number, index: number): number {
  return item.phase + column * POEM_COLUMN_STAGGER + index * POEM_CHAR_STAGGER;
}
