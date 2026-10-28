import assert from "node:assert/strict";
import test from "node:test";
import { imageDownloadName } from "../src/lib/image-download-name.ts";

test("a URL's query and fragment are not part of the saved name", () => {
  assert.equal(imageDownloadName("https://example.com/a/photo.png?w=800"), "photo.png");
  assert.equal(imageDownloadName("https://example.com/a/photo.png#preview"), "photo.png");
  assert.equal(imageDownloadName("file:///Users/me/dog%20images/golden%20retriever.jpg"), "golden retriever.jpg");
});

test("a local path keeps its last segment verbatim", () => {
  assert.equal(imageDownloadName("/Users/me/dog-images/golden-retriever.jpg"), "golden-retriever.jpg");
  assert.equal(imageDownloadName("C:\\Users\\me\\shot #1.png"), "shot #1.png");
  assert.equal(imageDownloadName("./100%.png"), "100%.png");
});

test("a reference without a file name falls back to image", () => {
  assert.equal(imageDownloadName("https://example.com/"), "image");
  assert.equal(imageDownloadName(""), "image");
  assert.equal(imageDownloadName("https://example.com/a%2Fb.png"), "b.png");
});
