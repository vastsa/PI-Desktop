import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { clipboardFiles, normalizeClipboardLineEndings, preferClipboardText } =
  await import("../src/features/chat/composer/editor.ts");
const image = () =>
  new File(["image bytes"], "image.png", { type: "image/png" });
const noPath = () => null;

test("Word text wins over generated image representations", () => {
  assert.equal(
    preferClipboardText("  Word paragraph\n中文  ", [image()], noPath),
    true,
  );
  assert.equal(preferClipboardText("text", [image(), image()], noPath), true);
});

test("image-only and blank-text clipboard payloads keep their images", () => {
  for (const text of ["", " \t\r\n"]) {
    assert.equal(preferClipboardText(text, [image()], noPath), false);
  }
});

test("native image files and non-image files retain attachment semantics", () => {
  assert.equal(
    preferClipboardText("photo.png", [image()], () => "/native/photo.png"),
    false,
  );
  assert.equal(
    preferClipboardText("photo.png", [image()], () => "C:\\photos\\photo.png"),
    false,
  );
  assert.equal(
    preferClipboardText(
      "notes",
      [new File(["notes"], "notes.txt", { type: "text/plain" })],
      noPath,
    ),
    false,
  );
  assert.equal(
    preferClipboardText(
      "mixed files",
      [image(), new File(["bytes"], "unknown.bin")],
      noPath,
    ),
    false,
  );
  const native = image();
  assert.equal(
    preferClipboardText("images", [image(), native], (file) =>
      file === native ? "/native.png" : null,
    ),
    false,
  );
});

test("clipboard FileList and item-only fallback both support text selection", () => {
  const file = image();
  const items = [
    { kind: "string", getAsFile: () => null },
    { kind: "file", getAsFile: () => file },
  ];
  for (const data of [
    { files: [file], items },
    { files: [], items },
  ]) {
    const files = clipboardFiles(data);
    assert.deepEqual(files, [file]);
    assert.equal(preferClipboardText("Word", files, noPath), true);
  }
  assert.deepEqual(clipboardFiles({ files: [], items: [] }), []);
  assert.equal(preferClipboardText("plain text", [], noPath), false);
});

test("clipboard line endings normalize to the editor LF draft model", () => {
  assert.equal(normalizeClipboardLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(normalizeClipboardLineEndings("no breaks"), "no breaks");
  assert.equal(normalizeClipboardLineEndings(""), "");
});
