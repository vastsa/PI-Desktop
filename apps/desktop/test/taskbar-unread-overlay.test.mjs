import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR,
  TASKBAR_UNREAD_OVERLAY_SIZE,
  buildTaskbarUnreadOverlayCanvasScript,
  buildTaskbarUnreadOverlayPng,
  formatTaskbarUnreadOverlayLabel,
  renderTaskbarUnreadOverlayPng,
} from "../electron/main/taskbar-unread-overlay.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read PNG IHDR width/height (big-endian) after the 8-byte signature + 4-byte length + "IHDR". */
function readPngIhdrSize(png) {
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length >= 24);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

/**
 * Decode an RGBA PNG produced by our filter-None encoder (no interlacing).
 * Returns { width, height, rgba: Uint8Array }.
 */
function decodeRgbaPng(png) {
  const { width, height } = readPngIhdrSize(png);
  const idats = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === "IDAT") idats.push(data);
    if (type === "IEND") break;
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const expected = (stride + 1) * height;
  assert.equal(raw.length, expected);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    assert.equal(raw[rowStart], 0, "expected filter type None");
    for (let x = 0; x < stride; x += 1) {
      rgba[y * stride + x] = raw[rowStart + 1 + x];
    }
  }
  return { width, height, rgba };
}

/** Bounding box of pixels whose channel exceeds threshold (default: near-white). */
function whiteGlyphBBox(rgba, width, height, { minLuma = 180, minAlpha = 128 } = {}) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const a = rgba[i + 3];
      if (a < minAlpha) continue;
      const luma = (r + g + b) / 3;
      if (luma < minLuma) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    count,
  };
}

/** Opaque (or mostly opaque) non-transparent pixel coverage + radial extent. */
function circleCoverage(rgba, width, height, { minAlpha = 128 } = {}) {
  let opaque = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = rgba[(y * width + x) * 4 + 3];
      if (a < minAlpha) continue;
      opaque += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const bboxW = maxX >= 0 ? maxX - minX + 1 : 0;
  const bboxH = maxY >= 0 ? maxY - minY + 1 : 0;
  // Transparent margin from canvas edge (min of four sides).
  const margin = maxX >= 0
    ? Math.min(minX, minY, width - 1 - maxX, height - 1 - maxY)
    : width;
  return {
    opaque,
    ratio: opaque / (width * height),
    bboxW,
    bboxH,
    margin,
    diameter: Math.min(bboxW, bboxH),
  };
}

test("clears the overlay label and png when count is zero or negative", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(0), null);
  assert.equal(formatTaskbarUnreadOverlayLabel(-3), null);
  assert.equal(buildTaskbarUnreadOverlayPng(0), null);
  assert.equal(buildTaskbarUnreadOverlayPng(-1), null);
});

test("formats unread counts 1–99 as their real digit string", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(1), "1");
  assert.equal(formatTaskbarUnreadOverlayLabel(5), "5");
  assert.equal(formatTaskbarUnreadOverlayLabel(9), "9");
  assert.equal(formatTaskbarUnreadOverlayLabel(10), "10");
  assert.equal(formatTaskbarUnreadOverlayLabel(36), "36");
  assert.equal(formatTaskbarUnreadOverlayLabel(99), "99");
});

test("caps overlay text at 99+ for counts of 100 or more", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(100), "99+");
  assert.equal(formatTaskbarUnreadOverlayLabel(101), "99+");
  assert.equal(formatTaskbarUnreadOverlayLabel(999), "99+");
});

test("exports 64px raster with scaleFactor 3 (~21px logical)", () => {
  assert.equal(TASKBAR_UNREAD_OVERLAY_SIZE, 64);
  assert.equal(TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR, 3);
  assert.equal(
    TASKBAR_UNREAD_OVERLAY_SIZE / TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR,
    64 / 3,
  );
});

test("builds a deterministic 64×64 PNG with the PNG signature for positive counts", () => {
  const one = buildTaskbarUnreadOverlayPng(1);
  const again = buildTaskbarUnreadOverlayPng(1);
  const hundred = buildTaskbarUnreadOverlayPng(100);
  assert.ok(Buffer.isBuffer(one));
  assert.ok(Buffer.isBuffer(hundred));
  assert.deepEqual([...one.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...hundred.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(one, again);
  assert.notDeepEqual(one, hundred);

  const oneSize = readPngIhdrSize(one);
  const hundredSize = readPngIhdrSize(hundred);
  assert.equal(oneSize.width, 64);
  assert.equal(oneSize.height, 64);
  assert.equal(oneSize.width, TASKBAR_UNREAD_OVERLAY_SIZE);
  assert.equal(oneSize.height, TASKBAR_UNREAD_OVERLAY_SIZE);
  assert.equal(hundredSize.width, TASKBAR_UNREAD_OVERLAY_SIZE);
  assert.equal(hundredSize.height, TASKBAR_UNREAD_OVERLAY_SIZE);
});

test("single-digit, two-digit, and 99+ overlays produce different PNG buffers", () => {
  const five = buildTaskbarUnreadOverlayPng(5);
  const thirtysix = buildTaskbarUnreadOverlayPng(36);
  const hundred = buildTaskbarUnreadOverlayPng(100);
  assert.ok(Buffer.isBuffer(five));
  assert.ok(Buffer.isBuffer(thirtysix));
  assert.ok(Buffer.isBuffer(hundred));
  assert.notDeepEqual(five, thirtysix);
  assert.notDeepEqual(thirtysix, hundred);
  assert.notDeepEqual(five, hundred);
});

test("fallback circle fills the complete 64px canvas", () => {
  const png = buildTaskbarUnreadOverlayPng(8);
  const { width, height, rgba } = decodeRgbaPng(png);
  assert.equal(width, 64);
  assert.equal(height, 64);
  const cov = circleCoverage(rgba, width, height);
  assert.ok(cov.diameter >= 63, `diameter ${cov.diameter}`);
  assert.ok(cov.margin <= 1, `margin ${cov.margin}`);
  assert.ok(cov.ratio >= 0.65, `opaque ratio ${cov.ratio}`);
  // Perfect circle: bbox roughly square.
  assert.ok(Math.abs(cov.bboxW - cov.bboxH) <= 2);
});

test("Canvas path uses the full badge area and a prominent single digit", () => {
  const one = buildTaskbarUnreadOverlayCanvasScript(1);
  assert.ok(one);
  assert.match(one, /const radius = 32/);
  assert.match(one, /let fontSize = singleDigit \? 50/);
  assert.match(one, /ctx\.font = "600 "/);
  assert.match(one, /ctx\.scale\(1\.1, 1\.03\)/);
});

test("Canvas PNG decoding rejects invalid renderer output", async () => {
  const valid = buildTaskbarUnreadOverlayPng(7);
  const contents = (result) => ({
    isDestroyed: () => false,
    executeJavaScript: async () => result,
  });
  assert.deepEqual(
    await renderTaskbarUnreadOverlayPng(contents(`data:image/png;base64,${valid.toString("base64")}`), 7),
    valid,
  );
  assert.equal(
    await renderTaskbarUnreadOverlayPng(contents("data:image/png;base64,bm90IGEgcG5n"), 7),
    null,
  );
  assert.equal(await renderTaskbarUnreadOverlayPng(contents(null), 7), null);
});

test("single-digit white glyph height ≈44–48px and ~65–80% of circle diameter", () => {
  for (const count of [1, 8]) {
    const png = buildTaskbarUnreadOverlayPng(count);
    const { width, height, rgba } = decodeRgbaPng(png);
    const cov = circleCoverage(rgba, width, height);
    const glyph = whiteGlyphBBox(rgba, width, height);
    assert.ok(glyph, `expected white glyph for ${count}`);
    assert.ok(
      glyph.height >= 44 && glyph.height <= 48,
      `glyph height ${glyph.height} for ${count}`,
    );
    const ratio = glyph.height / cov.diameter;
    assert.ok(
      ratio >= 0.65 && ratio <= 0.85,
      `glyph/diameter ratio ${ratio} for ${count}`,
    );
  }
});

test("digit 1 has widened top bar and base (not a thin stem)", () => {
  const png = buildTaskbarUnreadOverlayPng(1);
  const { width, height, rgba } = decodeRgbaPng(png);
  const glyph = whiteGlyphBBox(rgba, width, height);
  assert.ok(glyph);

  function rowWhiteWidth(y) {
    let min = width;
    let max = -1;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] < 128) continue;
      if ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 < 180) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    return max >= 0 ? max - min + 1 : 0;
  }

  // Sample bands: tip row alone is narrow; the widened top bar sits just below it.
  const h = glyph.height;
  let topW = 0;
  for (let y = glyph.minY; y <= glyph.minY + Math.floor(h * 0.3); y += 1) {
    topW = Math.max(topW, rowWhiteWidth(y));
  }
  let baseW = 0;
  for (let y = glyph.maxY - Math.floor(h * 0.2); y <= glyph.maxY; y += 1) {
    baseW = Math.max(baseW, rowWhiteWidth(y));
  }
  const midY = Math.floor((glyph.minY + glyph.maxY) / 2);
  const stemW = Math.min(
    rowWhiteWidth(midY),
    rowWhiteWidth(midY - 1),
    rowWhiteWidth(midY + 1),
  );
  assert.ok(stemW > 0, "stem present");
  assert.ok(topW > stemW, `top bar ${topW} should exceed stem ${stemW}`);
  assert.ok(baseW > stemW, `base ${baseW} should exceed stem ${stemW}`);
  // Base should be clearly wider than a thin stem (≈2× or more).
  assert.ok(baseW >= stemW * 1.8, `base ${baseW} vs stem ${stemW}`);
});

test("two-digit / 99+ use smaller glyph layout than single-digit", () => {
  const single = whiteGlyphBBox(
    decodeRgbaPng(buildTaskbarUnreadOverlayPng(8)).rgba,
    64,
    64,
  );
  const two = whiteGlyphBBox(
    decodeRgbaPng(buildTaskbarUnreadOverlayPng(36)).rgba,
    64,
    64,
  );
  const capped = whiteGlyphBBox(
    decodeRgbaPng(buildTaskbarUnreadOverlayPng(100)).rgba,
    64,
    64,
  );
  assert.ok(single && two && capped);
  // Multi-digit row is shorter than the single-digit glyph height.
  assert.ok(
    two.height < single.height,
    `two-digit height ${two.height} vs single ${single.height}`,
  );
  assert.ok(
    capped.height < single.height,
    `99+ height ${capped.height} vs single ${single.height}`,
  );
  // Single-digit must not reuse multi-digit proportions (taller + typically narrower).
  assert.ok(single.height >= 44);
  assert.ok(two.height <= 36);
});

test("source uses a Segoe UI Canvas path for smooth Windows badge glyphs", () => {
  const overlaySource = readFileSync(
    join(root, "electron/main/taskbar-unread-overlay.ts"),
    "utf8",
  );
  assert.match(overlaySource, /buildTaskbarUnreadOverlayCanvasScript/);
  assert.match(overlaySource, /renderTaskbarUnreadOverlayPng/);
  assert.match(overlaySource, /\.fillText\s*\(/);
  assert.match(overlaySource, /ctx\.font/);
  assert.match(overlaySource, /Segoe UI/);
  assert.match(overlaySource, /executeJavaScript/);
  assert.doesNotMatch(overlaySource, /\.roundRect\s*\(/);
  assert.doesNotMatch(overlaySource, /ctx\.ellipse\s*\(/);
  assert.match(overlaySource, /D295/);
  assert.match(overlaySource, /failures only|failure-only|failures-only/i);
});

test("documents the D295 bell vs shell-badge count split", () => {
  const inboxSource = readFileSync(
    join(root, "src/lib/notification-inbox.ts"),
    "utf8",
  );
  assert.match(inboxSource, /task\.completed/);
  assert.match(inboxSource, /notification\.kind !== "task\.completed"/);
});
