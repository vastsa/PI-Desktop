import assert from "node:assert/strict";
import test from "node:test";
import { copyImageDataUrlToClipboard, imageDataUrlToBlob } from "../src/lib/image-clipboard.ts";

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47];
const pngDataUrl = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString("base64")}`;

function recordingTarget() {
  const calls = { converted: [], written: [] };
  return {
    calls,
    target: {
      async convertToPng(image) {
        calls.converted.push(image);
        return new Blob([Uint8Array.from(PNG_BYTES)], { type: "image/png" });
      },
      async writePng(png) {
        calls.written.push(png);
      },
    },
  };
}

test("PNG images are written to the clipboard byte-for-byte without re-encoding", async () => {
  const { calls, target } = recordingTarget();
  await copyImageDataUrlToClipboard(pngDataUrl, target);
  assert.equal(calls.converted.length, 0);
  assert.equal(calls.written.length, 1);
  assert.equal(calls.written[0].type, "image/png");
  assert.deepEqual([...new Uint8Array(await calls.written[0].arrayBuffer())], PNG_BYTES);
});

test("JPEG and WebP images are re-encoded to PNG before writing", async () => {
  const { calls, target } = recordingTarget();
  await copyImageDataUrlToClipboard(jpegDataUrl, target);
  assert.equal(calls.converted.length, 1);
  assert.equal(calls.converted[0].type, "image/jpeg");
  assert.equal(calls.written[0].type, "image/png");
});

test("unsupported or malformed data never reaches the clipboard", async () => {
  for (const dataUrl of [
    "data:text/html;base64,PGI+",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,",
    "data:image/png;base64,***",
    "https://example.com/a.png",
  ]) {
    const { calls, target } = recordingTarget();
    await assert.rejects(copyImageDataUrlToClipboard(dataUrl, target), /unsupported image data/);
    assert.equal(calls.written.length, 0, dataUrl);
    assert.equal(imageDataUrlToBlob(dataUrl), null, dataUrl);
  }
});

test("clipboard write failures propagate to the caller", async () => {
  await assert.rejects(
    copyImageDataUrlToClipboard(pngDataUrl, {
      convertToPng: async (image) => image,
      writePng: async () => { throw new Error("denied"); },
    }),
    /denied/,
  );
});

test("the common image/jpg alias is accepted as JPEG", async () => {
  const jpgAlias = `data:image/jpg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString("base64")}`;
  assert.equal(imageDataUrlToBlob(jpgAlias)?.type, "image/jpeg");
  const { calls, target } = recordingTarget();
  await copyImageDataUrlToClipboard(jpgAlias, target);
  assert.equal(calls.converted[0].type, "image/jpeg");
  assert.equal(calls.written[0].type, "image/png");
});
