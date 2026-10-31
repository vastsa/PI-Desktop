import { describe, expect, it } from "vitest";
import {
  imageExceedsInlineDimensions,
  MAX_INLINE_IMAGE_EDGE_PX,
  omittedImageNotice,
  probeBase64ImageDimensions,
  probeImageDimensions,
} from "./image-dimensions.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

/** A JPEG whose frame header follows `segments` APP1 blocks of `exifBytes`. */
function jpeg(width: number, height: number, exifBytes = 16, segments = 1): Uint8Array {
  const app1 = [0xff, 0xe1, ((exifBytes + 2) >> 8) & 0xff, (exifBytes + 2) & 0xff];
  const sof = [0xff, 0xc2, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
  const segment = app1.length + exifBytes;
  const bytes = new Uint8Array(2 + segment * segments + sof.length + 9);
  bytes.set([0xff, 0xd8], 0);
  for (let index = 0; index < segments; index++) bytes.set(app1, 2 + segment * index);
  bytes.set(sof, 2 + segment * segments);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0,
  ]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(16 + payload.length);
  bytes.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk)]);
  bytes.set(payload, 16);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("image dimension probe", () => {
  it("reads PNG, GIF, and JPEG headers", () => {
    expect(probeImageDimensions(png(780, 14182))).toEqual({ width: 780, height: 14182 });
    expect(probeImageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(probeImageDimensions(jpeg(1688, 1514))).toEqual({ width: 1688, height: 1514 });
  });

  it("reads every WebP variant", () => {
    const vp8x = riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0x0b, 0x03, 0x00, 0x65, 0x37, 0x00]);
    expect(probeImageDimensions(vp8x)).toEqual({ width: 780, height: 14182 });
    // VP8L packs (width - 1) and (height - 1) into 14-bit fields.
    const bits = (780 - 1) | ((1000 - 1) << 14);
    const vp8l = riff("VP8L", [0, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
    expect(probeImageDimensions(vp8l)).toEqual({ width: 780, height: 1000 });
    const vp8 = riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x0c, 0x03, 0xe8, 0x03]);
    expect(probeImageDimensions(vp8)).toEqual({ width: 780, height: 1000 });
  });

  it("returns undefined for unknown or truncated data", () => {
    expect(probeImageDimensions(new TextEncoder().encode("not an image"))).toBeUndefined();
    expect(probeImageDimensions(png(10, 10).slice(0, 20))).toBeUndefined();
    expect(probeImageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeUndefined();
    expect(probeBase64ImageDimensions("%%%")).toBeUndefined();
  });

  it("probes base64, including a JPEG whose frame sits past a large EXIF block", () => {
    expect(probeBase64ImageDimensions(base64(png(780, 14182)))).toEqual({ width: 780, height: 14182 });
    const deep = jpeg(9000, 600, 60_000, 2);
    expect(deep.length).toBeGreaterThan(70_000);
    expect(probeBase64ImageDimensions(base64(deep))).toEqual({ width: 9000, height: 600 });
  });
});

describe("image dimension admission", () => {
  it("rejects only a known longest edge above the limit", () => {
    expect(imageExceedsInlineDimensions({ width: 780, height: 14182 })).toBe(true);
    expect(imageExceedsInlineDimensions({ width: MAX_INLINE_IMAGE_EDGE_PX, height: 10 })).toBe(false);
    expect(imageExceedsInlineDimensions({ width: 1688, height: 1514 })).toBe(false);
    expect(imageExceedsInlineDimensions(undefined)).toBe(false);
  });

  it("names the omitted image's size", () => {
    expect(omittedImageNotice({ width: 780, height: 14182 })).toBe(
      "[Image omitted: 780x14182 px exceeds the 8000 px longest-edge limit for model input.]",
    );
  });
});
