import assert from "node:assert/strict";
import test from "node:test";
import { absoluteImagePath, remarkLocalImagePaths } from "../src/lib/markdown-image-paths.ts";

test("absolute image paths survive URL encoding without enabling URL protocols", () => {
  for (const path of [String.raw`C:\scratch\cup.png`, "D:/work/cup image.png", "/tmp/scratch/杯子.png"]) {
    assert.equal(absoluteImagePath(path), path);
    assert.equal(absoluteImagePath(encodeURIComponent(path)), path);
    const tree = { type: "root", children: [{ type: "image", url: path }] };
    remarkLocalImagePaths()(tree);
    assert.equal(tree.children[0].url, encodeURIComponent(path));
  }
});

test("remote, executable, network and malformed paths are not local image refs", () => {
  for (const source of ["https://example.com/image.png", "javascript:alert(1)", "data:image/png;base64,AA", "//server/share.png", String.raw`\\server\share.png`, "file://server/share.png", "C:relative.png", "../image.png", "%ZZ", "C:/image%00.png", "C:/image\n.png"]) {
    assert.equal(absoluteImagePath(source), null, source);
  }
});

test("the image transformer preserves ordinary links, relative and remote images", () => {
  const tree = { type: "root", children: [
    { type: "link", url: "C:/file.md" },
    { type: "image", url: "relative.png" },
    { type: "image", url: "https://example.com/image.png" },
  ] };
  const original = structuredClone(tree);
  remarkLocalImagePaths()(tree);
  assert.deepEqual(tree, original);
});
