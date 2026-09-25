/**
 * Pixel sampling of the target text.
 *
 * The offscreen canvas is drawn and read back purely for geometry: it produces
 * the points the mooncakes fly to. Nothing here touches the scene, the DOM of
 * the overlay or the animation clock.
 */
import { TEXT_FONT_STACK, rand } from "./timeline";

/** A sampled point of the target text, in the coordinate space of the offscreen canvas. */
export type TextSamplePoint = { x: number; y: number };

/** Alpha above which a pixel counts as part of a glyph. */
const ALPHA_THRESHOLD = 128;
/** Font size as a share of the offscreen canvas height. */
const FONT_SIZE_RATIO = 0.94;
/** Glyph width is kept inside this share of the canvas width. */
const WIDTH_FIT_RATIO = 0.96;
/** Random jitter per point, as a share of the sampling step. */
const JITTER_RATIO = 0.16;
const MIN_STEP = 3;
const MIN_STEP_REFINED = 2;
/** Accepted deviation of the point count from the requested target. */
const ACCEPT_MIN_RATIO = 0.85;
const ACCEPT_MAX_RATIO = 1.15;
const MAX_REFINE_PASSES = 5;

/**
 * Sample the filled pixels of `text` on a `width` x `height` offscreen canvas.
 *
 * The sampling step is refined until the point count is within ±15% of
 * `target`, so the number of points matches the number of mooncakes. Returns an
 * empty array when the 2D context is unavailable (canvas unsupported) or when
 * the text paints nothing; the caller then keeps the mooncakes on the ground.
 */
export function sampleTextPoints(
  text: string,
  target: number,
  width: number,
  height: number,
): TextSamplePoint[] {
  const canvasWidth = Math.max(2, Math.round(width));
  const canvasHeight = Math.max(2, Math.round(height));

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d");
  if (!context) return [];

  let fontSize = canvasHeight * FONT_SIZE_RATIO;
  const applyFont = (): void => {
    context.font = `bold ${fontSize.toFixed(1)}px ${TEXT_FONT_STACK}`;
  };
  context.textAlign = "center";
  context.textBaseline = "middle";
  applyFont();
  const measured = context.measureText(text).width;
  if (measured > canvasWidth * WIDTH_FIT_RATIO) {
    fontSize *= (canvasWidth * WIDTH_FIT_RATIO) / measured;
    applyFont();
  }
  context.fillStyle = "#fff";
  context.fillText(text, canvasWidth / 2, canvasHeight / 2);

  const pixels = context.getImageData(0, 0, canvasWidth, canvasHeight).data;

  const collect = (step: number): TextSamplePoint[] => {
    const points: TextSamplePoint[] = [];
    const jitter = step * JITTER_RATIO;
    let row = 0;
    for (let y = step * 0.5; y < canvasHeight; y += step, row++) {
      const offset = (row % 2) * step * 0.5;
      for (let x = step * 0.5 + offset; x < canvasWidth; x += step) {
        const sampleX = x | 0;
        const sampleY = y | 0;
        if (sampleX < 0 || sampleX >= canvasWidth) continue;
        if (sampleY < 0 || sampleY >= canvasHeight) continue;
        if (pixels[(sampleY * canvasWidth + sampleX) * 4 + 3] > ALPHA_THRESHOLD) {
          points.push({ x: x + rand(-jitter, jitter), y: y + rand(-jitter, jitter) });
        }
      }
    }
    return points;
  };

  let step = Math.max(
    MIN_STEP,
    Math.sqrt((canvasWidth * canvasHeight) / Math.max(1, target)),
  );
  let points = collect(step);
  for (let pass = 0; pass < MAX_REFINE_PASSES; pass++) {
    if (!points.length) break;
    const ratio = points.length / target;
    if (ratio > ACCEPT_MAX_RATIO || ratio < ACCEPT_MIN_RATIO) {
      step = Math.max(MIN_STEP_REFINED, step * Math.sqrt(ratio));
      points = collect(step);
    } else {
      break;
    }
  }
  return points;
}
