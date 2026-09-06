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

test("in-chat image display has a bounded renderer-to-main bridge", () => {
  assert.match(protocol, /fsReadImageDataUrl: "pi-desktop\/fs\/readImageDataUrl"/);
  assert.match(api, /fsReadImageDataUrl: \(ref: string, mimeType\?: string\)/);
  assert.match(api, /IPC\.invoke\.fsReadImageDataUrl/);
  assert.match(main, /IPC\.invoke\.fsReadImageDataUrl/);
  assert.match(
    main,
    /readReferencedImage\(\s*dataDir,\s*workspaceRoot,\s*String\(input\.ref \?\? ""\),\s*input\.mimeType,\s*\)/,
  );
  assert.match(panel, /export async function readReferencedImage\(/);
  assert.match(panel, /resolveReferencedPath\(dataRoot, workspaceRoot, ref\)/);
  // The resolver must stay inside allowed roots after real-path checks, and
  // the stored mimeType must win for extension-less `attachments/<sha256>`
  // blobs so pasted images actually render.
  assert.match(panel, /trimmed\.startsWith\("attachments\/"\)/);
  assert.match(panel, /resolveAbsoluteAttachmentPath\(dataRoot, trimmed\)/);
  assert.match(panel, /declared\.startsWith\("image\/"\)/);
  assert.match(panel, /MAX_IMAGE_BYTES/);
});

test("renderer hook loads referenced image data URLs with a scoped bounded cache", () => {
  assert.match(
    hook,
    /useReferencedImageDataUrl\(\s*ref: string \| null \| undefined,\s*mimeType\?: string,\s*\)/,
  );
  assert.match(hook, /dataUrlCache = new Map<string, string>\(\)/);
  assert.match(hook, /DATA_URL_CACHE_ENTRIES/);
  assert.match(hook, /DATA_URL_CACHE_MAX_BYTES/);
  assert.match(hook, /api\s*\n?\s*\.fsReadImageDataUrl\(key, mimeType\)/);
  assert.match(hook, /result\.kind === "image" && result\.dataUrl/);
  // The cache key includes the workspace root so a relative path cannot leak
  // across projects.
  assert.match(hook, /return `\$\{workspaceRoot \?\? ""\}\\u0000\$\{ref\}`/);
});

test("user message image attachments render as thumbnails", () => {
  assert.match(transcript, /function MessageAttachmentImage\(\{ attachment \}: \{ attachment: MessageAttachment \}\)/);
  assert.match(transcript, /useReferencedImageDataUrl\(attachment\.ref, attachment\.mimeType\)/);
  assert.match(transcript, /className="message-attachment-image"/);
  assert.match(
    transcript,
    /className="message-attachment-image"[\s\S]*?openFileInWorkPanel\(\s*attachment\.ref,\s*attachment\.mimeType\s*\)/,
  );
  assert.match(
    transcript,
    /message\.attachments\.map\(\(attachment\) =>\s*attachment\.kind === "image" \?/,
  );
  assert.match(
    transcript,
    /className="message-attachment-image"[\s\S]*?<img src=\{dataUrl\} alt=\{attachment\.name\} \/>/,
  );
});

test("local markdown images render inline with a chip fallback", () => {
  assert.match(markdown, /useReferencedImageDataUrl\(rel \?\? decoded\)/);
  assert.match(markdown, /className="chat-image-local"/);
  assert.match(markdown, /className="chat-image-chip"/);
  assert.match(markdown, /openFile\(rel\)/);
  // The remote branch still renders directly, and the hook runs before any
  // branch so hook order stays stable.
  assert.match(markdown, /const dataUrl = useReferencedImageDataUrl\(rel \?\? decoded\);/);
  assert.match(markdown, /className="chat-image-remote"/);
});
