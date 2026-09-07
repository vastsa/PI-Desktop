import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, markdown, api, main, panel, protocol, hook] = await Promise.all([
  read("../src/components/ChatTranscript.tsx"),
  read("../src/components/Markdown.tsx"),
  read("../src/lib/api.ts"),
  read("../electron/main/index.ts"),
  read("../electron/main/fs-panel.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/use-referenced-image-data-url.ts"),
]);

test("in-chat image display has a contained renderer-to-main bridge", () => {
  assert.match(protocol, /fsReadImageDataUrl: "pi-desktop\/fs\/readImageDataUrl"/);
  assert.match(api, /fsReadImageDataUrl: \(ref: string, mimeType\?: string\)/);
  assert.match(main, /IPC\.invoke\.fsReadImageDataUrl/);
  assert.match(main, /readOpenableImage\(/);
  assert.match(panel, /export async function readOpenableImage\(/);
  assert.match(panel, /isAttachmentBlobRef/);
  assert.match(panel, /ALLOWED_IMAGE_MIME/);
  assert.match(panel, /MAX_IMAGE_BYTES/);
  assert.doesNotMatch(panel, /info\.isFile\(\) \? trimmed : null/);
});

test("renderer hook loads referenced image data URLs with a scoped bounded cache", () => {
  assert.match(hook, /useReferencedImageDataUrl\(/);
  assert.match(hook, /dataUrlCache = new Map<string, string>\(\)/);
  assert.match(hook, /DATA_URL_CACHE_ENTRIES/);
  assert.match(hook, /DATA_URL_CACHE_MAX_BYTES/);
  assert.match(hook, /fsReadImageDataUrl\(key, mimeType\)/);
  assert.match(hook, /result\.kind === "image" && result\.dataUrl/);
  assert.match(hook, /\^https\?:/);
});

test("user message image attachments render as thumbnails", () => {
  assert.match(transcript, /function MessageAttachmentImage\(/);
  assert.match(transcript, /useReferencedImageDataUrl\(attachment\.ref, attachment\.mimeType\)/);
  assert.match(transcript, /className="message-attachment-image"/);
  assert.match(
    transcript,
    /openFileInWorkPanel\(attachment\.ref, attachment\.mimeType\)/,
  );
  assert.match(
    transcript,
    /attachment\.kind === "image" \?/,
  );
});

test("local markdown images render inline with a chip fallback", () => {
  assert.match(markdown, /useReferencedImageDataUrl\(isRemote \? null : localRef\)/);
  assert.match(markdown, /className="chat-image-local"/);
  assert.match(markdown, /className="chat-image-chip"/);
  assert.match(markdown, /attachmentRef/);
});
