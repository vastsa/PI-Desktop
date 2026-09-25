import assert from "node:assert/strict";
import test from "node:test";
import { generatedImageDownloadName } from "../src/features/chat/transcript/generated-image-download.ts";

test("download names use only supported image MIME types and an ordinal", () => {
  assert.equal(generatedImageDownloadName("data:image/png;base64,AA==", 0), "generated-image-1.png");
  assert.equal(generatedImageDownloadName("data:image/jpeg;base64,AA==", 2), "generated-image-3.jpg");
  assert.equal(generatedImageDownloadName("data:image/webp;base64,AA==", 1), "generated-image-2.webp");
  assert.equal(generatedImageDownloadName("data:text/html;base64,AA==", 0), null);
  assert.equal(generatedImageDownloadName(null, 0), null);
});
