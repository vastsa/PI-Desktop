import { deflateSync } from "node:zlib";
import type { WebContents } from "electron";

/**
 * OS shell badge for durable task outcomes.
 *
 * Count = ALL unread `task.completed` + `task.failed` rows (host
 * `notification.list` unreadCount). This is intentionally different from the
 * D295 bell inbox in `notification-inbox.ts`, which still lists and badges
 * failures only.
 *
 * Display policy: counts 1–99 show the real digit string; counts ≥100 show
 * "99+" so a Windows overlay stays readable.
 *
 * Primary raster: a renderer Canvas at 64×64 using the Windows system UI font.
 * Paired with `nativeImage.createFromBuffer(png, { scaleFactor: 3 })`, this
 * occupies a ~21×21 logical Windows overlay image. The deterministic bitmap PNG
 * remains the fallback before a renderer exists or if Canvas rendering fails.
 *
 * Shape: always a black circle. Multi-digit and "99+" labels fit inside it,
 * never a pill or capsule. Black (#000) fill, white (#fff) glyphs.
 */

/** Physical PNG edge length (px). Logical DIP size = SIZE / SCALE_FACTOR. */
export const TASKBAR_UNREAD_OVERLAY_SIZE = 64;

/**
 * Electron `nativeImage` scaleFactor so 64px raster → ~21×21 logical DIP.
 * The larger logical image matches the visual weight of common Windows taskbar
 * badges; do not rely on a second OS scale to enlarge a smaller bitmap.
 */
export const TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR = 3;

const OVERLAY_SIZE = TASKBAR_UNREAD_OVERLAY_SIZE;

/**
 * Circle inset from canvas edge (physical px). The Windows shell clamps an
 * overlay to its own small slot, so use the full supplied raster rather than
 * surrendering visible area to a transparent safety margin.
 */
const CIRCLE_INSET = 0;

/** Single-digit bold bitmaps: 7×9. Digit "1" has widened top bar + base. */
const SINGLE_GLYPH_W = 7;
const SINGLE_GLYPH_H = 9;
const SINGLE_GLYPHS: Record<string, number[]> = {
  // bit 6 = leftmost pixel
  "0": [
    0b0111110, 0b1100011, 0b1100011, 0b1100011, 0b1100011, 0b1100011, 0b1100011,
    0b1100011, 0b0111110,
  ],
  "1": [
    0b0111000, 0b1111100, 0b0011000, 0b0011000, 0b0011000, 0b0011000, 0b0011000,
    0b0011000, 0b1111111,
  ],
  "2": [
    0b0111110, 0b1100011, 0b0000011, 0b0000110, 0b0001100, 0b0011000, 0b0110000,
    0b1100000, 0b1111111,
  ],
  "3": [
    0b0111110, 0b1100011, 0b0000011, 0b0000011, 0b0011110, 0b0000011, 0b0000011,
    0b1100011, 0b0111110,
  ],
  "4": [
    0b0000110, 0b0001110, 0b0011010, 0b0110010, 0b1100010, 0b1111111, 0b0000010,
    0b0000010, 0b0000010,
  ],
  "5": [
    0b1111111, 0b1100000, 0b1100000, 0b1111110, 0b0000011, 0b0000011, 0b0000011,
    0b1100011, 0b0111110,
  ],
  "6": [
    0b0111110, 0b1100011, 0b1100000, 0b1100000, 0b1111110, 0b1100011, 0b1100011,
    0b1100011, 0b0111110,
  ],
  "7": [
    0b1111111, 0b0000011, 0b0000010, 0b0000110, 0b0001100, 0b0011000, 0b0011000,
    0b0110000, 0b0110000,
  ],
  "8": [
    0b0111110, 0b1100011, 0b1100011, 0b1100011, 0b0111110, 0b1100011, 0b1100011,
    0b1100011, 0b0111110,
  ],
  "9": [
    0b0111110, 0b1100011, 0b1100011, 0b1100011, 0b0111111, 0b0000011, 0b0000011,
    0b1100011, 0b0111110,
  ],
};

/** Multi-digit / "99+" bitmaps: 5×7 (separate, smaller layout than singles). */
const MULTI_GLYPH_W = 5;
const MULTI_GLYPH_H = 7;
const MULTI_GLYPHS: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  "+": [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
};

/**
 * Format the overlay accessibility label / drawn text for an unread count.
 * Returns null when the overlay should be cleared.
 */
export function formatTaskbarUnreadOverlayLabel(count: number): string | null {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 100) return "99+";
  return String(n);
}

/**
 * Build the renderer-side Canvas paint. Segoe UI gives the small numeral the
 * same smooth, conventional appearance as Windows' common taskbar badges;
 * custom bitmap glyphs are visibly jagged once the shell downsamples them.
 */
export function buildTaskbarUnreadOverlayCanvasScript(count: number): string | null {
  const label = formatTaskbarUnreadOverlayLabel(count);
  if (!label) return null;

  const labelLiteral = JSON.stringify(label);
  return `(() => {
  const size = ${OVERLAY_SIZE};
  const label = ${labelLiteral};
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const center = size / 2;
  const radius = ${circleRadius()};
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
  const singleDigit = label.length === 1;
  let fontSize = singleDigit ? 50 : label.length === 2 ? 31 : 24;
  const maxWidth = radius * 2 * 0.78;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  do {
    ctx.font = "600 " + fontSize + "px \\\"Segoe UI\\\", sans-serif";
    if (ctx.measureText(label).width <= maxWidth) break;
    fontSize -= 1;
  } while (fontSize > 14);
  ctx.save();
  ctx.translate(center, center - (singleDigit ? 2 : 0));
  if (singleDigit) ctx.scale(1.1, 1.03);
  ctx.fillText(label, 0, 0);
  ctx.restore();
  return canvas.toDataURL("image/png");
})()`;
}

/** Render the smooth badge PNG in the renderer process. */
export async function renderTaskbarUnreadOverlayPng(
  webContents: Pick<WebContents, "isDestroyed" | "executeJavaScript"> | null | undefined,
  count: number,
): Promise<Buffer | null> {
  if (!webContents || webContents.isDestroyed()) return null;
  const script = buildTaskbarUnreadOverlayCanvasScript(count);
  if (!script) return null;
  const result = await webContents.executeJavaScript(script, true);
  if (typeof result !== "string") return null;
  const prefix = "data:image/png;base64,";
  if (!result.startsWith(prefix)) return null;
  const png = Buffer.from(result.slice(prefix.length), "base64");
  return png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? png
    : null;
}

/**
 * Build a deterministic 64×64 PNG (SDF anti-aliased black circle, white
 * custom bitmap glyphs) for `BrowserWindow.setOverlayIcon`. Returns null when
 * count clears the overlay.
 *
 * Pair with `nativeImage.createFromBuffer(png, { scaleFactor: 3 })`.
 */
export function buildTaskbarUnreadOverlayPng(count: number): Buffer | null {
  const label = formatTaskbarUnreadOverlayLabel(count);
  if (!label) return null;
  const rgba = new Uint8Array(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  paintBadgeShape(rgba);
  paintLabel(rgba, label);
  return encodeRgbaPng(OVERLAY_SIZE, OVERLAY_SIZE, rgba);
}

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/** Coverage alpha from signed distance (positive = inside). ~1px AA rim. */
function coverageFromSdf(dist: number): number {
  return clamp01(0.5 + dist);
}

function circleRadius(): number {
  return OVERLAY_SIZE / 2 - CIRCLE_INSET;
}

function paintBadgeShape(rgba: Uint8Array): void {
  const size = OVERLAY_SIZE;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = circleRadius();

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x - cx;
      const py = y - cy;
      const dist = radius - Math.sqrt(px * px + py * py);
      const alpha = coverageFromSdf(dist);
      if (alpha <= 0) continue;
      const i = (y * size + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
}

type GlyphLayout = {
  glyphs: Record<string, number[]>;
  glyphW: number;
  glyphH: number;
  scale: number;
  gap: number;
};

/**
 * Single-digit layout: large bold glyphs (~44–48px tall ≈ 11–12 logical).
 * Multi-digit / "99+" use a separate smaller layout and must not share these
 * proportions.
 */
function layoutForLabel(label: string): GlyphLayout {
  const diameter = circleRadius() * 2;
  if (label.length <= 1) {
    // Target glyph height ≈ 46px (≈11.5 logical) → ~77% of 60px diameter;
    // white ink still reads as ~65–70% of the disc at taskbar scale.
    const scale = 46 / SINGLE_GLYPH_H;
    return {
      glyphs: SINGLE_GLYPHS,
      glyphW: SINGLE_GLYPH_W,
      glyphH: SINGLE_GLYPH_H,
      scale,
      gap: 0,
    };
  }

  const n = label.length;
  const maxW = diameter * 0.82;
  const preferred = n === 2 ? 4.2 : 2.8;
  const gapPreferred = n === 2 ? 3 : 2;
  for (let scale = preferred; scale >= 1.5; scale -= 0.1) {
    const gap = scale >= 3 ? gapPreferred : Math.max(1, Math.floor(scale / 2));
    const totalW = n * MULTI_GLYPH_W * scale + (n - 1) * gap;
    if (totalW <= maxW) {
      return {
        glyphs: MULTI_GLYPHS,
        glyphW: MULTI_GLYPH_W,
        glyphH: MULTI_GLYPH_H,
        scale,
        gap,
      };
    }
  }
  return {
    glyphs: MULTI_GLYPHS,
    glyphW: MULTI_GLYPH_W,
    glyphH: MULTI_GLYPH_H,
    scale: 1.5,
    gap: 1,
  };
}

function paintLabel(rgba: Uint8Array, label: string): void {
  const size = OVERLAY_SIZE;
  const { glyphs, glyphW, glyphH, scale, gap } = layoutForLabel(label);
  const totalW = label.length * glyphW * scale + (label.length - 1) * gap;
  const totalH = glyphH * scale;
  let originX = (size - totalW) / 2;
  const originY = (size - totalH) / 2;

  for (const ch of label) {
    const rows = glyphs[ch];
    if (!rows) continue;
    for (let gy = 0; gy < glyphH; gy += 1) {
      const row = rows[gy] ?? 0;
      for (let gx = 0; gx < glyphW; gx += 1) {
        if (((row >> (glyphW - 1 - gx)) & 1) !== 1) continue;
        paintSoftBlock(
          rgba,
          originX + gx * scale,
          originY + gy * scale,
          scale,
        );
      }
    }
    originX += glyphW * scale + gap;
  }
}

/**
 * Draw a filled white block with ~1px coverage AA on the edges, blended over
 * the existing black badge (preserving shape alpha).
 */
function paintSoftBlock(
  rgba: Uint8Array,
  ox: number,
  oy: number,
  cell: number,
): void {
  const size = OVERLAY_SIZE;
  // Inset slightly so adjacent cells don't fuse into a blob; AA on the rim.
  const pad = Math.min(0.35, cell * 0.06);
  const x0 = ox + pad;
  const y0 = oy + pad;
  const x1 = ox + cell - pad;
  const y1 = oy + cell - pad;

  const minX = Math.max(0, Math.floor(x0 - 1));
  const maxX = Math.min(size - 1, Math.ceil(x1 + 1));
  const minY = Math.max(0, Math.floor(y0 - 1));
  const maxY = Math.min(size - 1, Math.ceil(y1 + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = Math.max(x0 - px, 0, px - x1);
      const dy = Math.max(y0 - py, 0, py - y1);
      const outside = Math.sqrt(dx * dx + dy * dy);
      const insideX = Math.min(px - x0, x1 - px);
      const insideY = Math.min(py - y0, y1 - py);
      const inside = Math.min(insideX, insideY);
      const dist = outside > 0 ? -outside : inside;
      const cov = coverageFromSdf(dist);
      if (cov <= 0) continue;

      const i = (y * size + x) * 4;
      const shapeA = rgba[i + 3]! / 255;
      if (shapeA <= 0) continue;
      const t = cov;
      rgba[i] = Math.round(255 * t);
      rgba[i + 1] = Math.round(255 * t);
      rgba[i + 2] = Math.round(255 * t);
      rgba[i + 3] = Math.round(shapeA * 255);
    }
  }
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < stride; x += 1) {
      raw[rowStart + 1 + x] = rgba[y * stride + x]!;
    }
  }
  const compressed = deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
