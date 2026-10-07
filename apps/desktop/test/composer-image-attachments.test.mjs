import assert from "node:assert/strict";
import test from "node:test";
import { attachImageTokens } from "../src/features/chat/composer/image-attachments.ts";

const image = { id: "image", sessionId: "a", path: "/scratch/a.png", name: "a.png", kind: "image", token: "\ue001" };
const tokenlessImage = { id: "inline", sessionId: "a", path: "/scratch/b.png", name: "b.png", kind: "image" };
const file = { id: "file", sessionId: "a", path: "/scratch/a.txt", name: "a.txt", kind: "file", token: "\ue002" };

test("a restored image without a token becomes an inline chip", () => {
  const { text, references } = attachImageTokens(`look${file.token} here`, [tokenlessImage, file], () => "\ue101");
  assert.equal(text, `look${file.token} here\ue101`);
  assert.equal(references[0].token, "\ue101");
  assert.equal(references[0].path, tokenlessImage.path);
  assert.equal(tokenlessImage.token, undefined);
  assert.equal(references[1], file);
});

test("an image that already carries its token is neither duplicated nor replaced", () => {
  const { text, references } = attachImageTokens(`x${image.token}`, [image], () => "\ue103");
  assert.equal(text, `x${image.token}`);
  assert.equal(references[0], image);
});

test("attaching restored drafts is idempotent", () => {
  const first = attachImageTokens("", [tokenlessImage], () => "\ue104");
  const second = attachImageTokens(first.text, first.references, () => "\ue105");
  assert.equal(second.text, first.text);
  assert.equal(second.references[0].token, "\ue104");
});
