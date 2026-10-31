/**
 * Pixel-geometry admission for images sent to a model (issue #1913).
 *
 * The byte bound in `attachment-limits.ts` does not stop a small but very
 * tall image (a full-page screenshot, 780 x 14182) that providers reject with
 * a non-retriable 400. Once such an image is in history every later request
 * replays it, so admission reads the pixel size from the file header without
 * a decoder and keeps an oversized image out of the provider request.
 */

/**
 * Longest image edge, in pixels, admitted into a provider request. Anthropic
 * documents 8000 px as a hard rejection limit; other vision endpoints reject
 * or fail on far smaller extremes. Host-core's Read tool mirrors this value.
 */
export const MAX_INLINE_IMAGE_EDGE_PX = 8000;

export type ImageDimensions = { width: number; height: number };

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24 || !ascii(bytes, 12, "IHDR")) return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (ascii(bytes, 12, "VP8X") && bytes.length >= 30) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (ascii(bytes, 12, "VP8L") && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits =
      bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (
    ascii(bytes, 12, "VP8 ") &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return undefined;
}

/** Walk JPEG marker segments up to the first start-of-frame header. */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Entropy-coded data starts without a frame header: nothing to read.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(bytes, offset + 2);
    if (length < 2) return undefined;
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return undefined;
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) };
    }
    offset += 2 + length;
  }
  return undefined;
}

/**
 * Pixel size from a PNG, JPEG, GIF, or WebP header, or `undefined` when the
 * bytes are not a recognized image or the header is cut short.
 */
export function probeImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (ascii(bytes, 0, "\x89PNG\r\n\x1a\n")) return pngDimensions(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return jpegDimensions(bytes);
  }
  if (ascii(bytes, 0, "GIF8")) return gifDimensions(bytes);
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpDimensions(bytes);
  return undefined;
}

function decodeBase64Prefix(data: string, chars: number): Uint8Array | undefined {
  const prefix = data.slice(0, chars - (chars % 4)).replace(/=+$/, "");
  try {
    const binary = atob(prefix.length % 4 === 1 ? prefix.slice(0, -1) : prefix);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/** Header-only bytes cover every format except a JPEG with a large EXIF block. */
const BASE64_HEADER_CHARS = 87_384;

/** `probeImageDimensions` for a base64 payload, decoding only what it needs. */
export function probeBase64ImageDimensions(data: string): ImageDimensions | undefined {
  const head = decodeBase64Prefix(data, BASE64_HEADER_CHARS);
  if (!head) return undefined;
  const dimensions = probeImageDimensions(head);
  if (dimensions || data.length <= BASE64_HEADER_CHARS) return dimensions;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (!isJpeg) return undefined;
  const full = decodeBase64Prefix(data, data.length + 4);
  return full ? probeImageDimensions(full) : undefined;
}

/**
 * Whether known dimensions exceed what a provider request admits. Unknown
 * dimensions are not a rejection: the byte bound and the provider still
 * judge an image this probe cannot read.
 */
export function imageExceedsInlineDimensions(
  dimensions: ImageDimensions | undefined,
): dimensions is ImageDimensions {
  return (
    dimensions !== undefined &&
    Math.max(dimensions.width, dimensions.height) > MAX_INLINE_IMAGE_EDGE_PX
  );
}

/** Text that takes an omitted image's place so the model knows it existed. */
export function omittedImageNotice(dimensions: ImageDimensions): string {
  return `[Image omitted: ${dimensions.width}x${dimensions.height} px exceeds the ${MAX_INLINE_IMAGE_EDGE_PX} px longest-edge limit for model input.]`;
}
