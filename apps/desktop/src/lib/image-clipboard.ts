/**
 * Copies a generated image to the system clipboard as PNG.
 *
 * Chromium's async clipboard only accepts `image/png` image payloads, so JPEG
 * and WebP results are re-encoded first. Only the image types the host reader
 * hands to the renderer are accepted; anything else is rejected before any
 * clipboard access.
 */
export interface ImageClipboardTarget {
  /** Re-encode a decoded raster image as PNG. */
  convertToPng: (image: Blob) => Promise<Blob>;
  /** Write a PNG blob to the system clipboard. */
  writePng: (png: Blob) => Promise<void>;
}

const SUPPORTED_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

/** Decode a supported base64 image data URL, or return null. */
export function imageDataUrlToBlob(dataUrl: string): Blob | null {
  const match = SUPPORTED_IMAGE_DATA_URL.exec(dataUrl);
  if (!match || match[2].length === 0) return null;
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

export async function copyImageDataUrlToClipboard(
  dataUrl: string,
  target: ImageClipboardTarget = browserImageClipboard,
): Promise<void> {
  const image = imageDataUrlToBlob(dataUrl);
  if (!image) throw new Error("unsupported image data");
  const png = image.type === "image/png" ? image : await target.convertToPng(image);
  await target.writePng(png);
}

const browserImageClipboard: ImageClipboardTarget = {
  async convertToPng(image) {
    const bitmap = await createImageBitmap(image);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas 2d context unavailable");
      context.drawImage(bitmap, 0, 0);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png encoding failed"))), "image/png");
      });
    } finally {
      bitmap.close();
    }
  },
  async writePng(png) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  },
};
