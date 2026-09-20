import assert from "node:assert/strict";
import test from "node:test";
import { detachImageTokens } from "../src/features/chat/composer/image-attachments.ts";

const image = { id: "image", sessionId: "a", path: "/scratch/a.png", name: "a.png", kind: "image", token: "\ue001" };
const file = { id: "file", sessionId: "a", path: "/scratch/a.txt", name: "a.txt", kind: "file", token: "\ue002" };

test("restored inline images retain identity and paths while text and file chips retain order", () => {
  const result = detachImageTokens(`before ${image.token}${file.token} after`, [image, file], 9);
  assert.equal(result.text, `before ${file.token} after`);
  assert.equal(result.caret, 8);
  const { token, ...detachedImage } = image;
  assert.deepEqual(result.references, [detachedImage, file]);
  assert.equal(image.token, "\ue001");
});

test("image-only drafts keep metadata and a valid empty-text caret", () => {
  const result = detachImageTokens(image.token, [image], 1);
  assert.equal(result.text, "");
  assert.equal(result.caret, 0);
  assert.equal(result.references[0].path, image.path);
  assert.equal(result.references[0].token, undefined);
});

test("MIME image references detach without changing earlier text or repeated normalization", () => {
  const result = detachImageTokens(`abc${image.token}def${image.token}`, [{ ...image, kind: "file", mimeType: "IMAGE/PNG" }], 2);
  assert.equal(result.text, "abcdef");
  assert.equal(result.caret, 2);
  assert.deepEqual(detachImageTokens(result.text, result.references, result.caret), result);
});
