import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendPromptFallbackPaths, preparePromptAttachments } from "../electron/main/prompt-attachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);
const sessionId = "inline-placement";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-inline-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const pasted = join(data, "scratch", sessionId, "pasted");
  await mkdir(pasted, { recursive: true });
  const path = join(pasted, "pasted-a.png");
  await writeFile(path, png);
  return { data, path };
}

test("an image the draft named inline records that text and keeps its place", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const content = `compare @${path} with the rest`;
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    true,
    content,
  );
  assert.equal(prepared.message.kind, "image");
  assert.equal(prepared.message.inlinePath, `@${path}`);
  assert.ok(prepared.inlineData);
  // The prompt already names the path where the user put it, so no copy follows.
  assert.equal(appendPromptFallbackPaths(content, [prepared]), content);
});

test("an image the prompt does not name inline keeps the trailing position", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    "look at this",
  );
  assert.equal(prepared.message.inlinePath, undefined);
  assert.equal(prepared.inlineData, undefined);
  const text = appendPromptFallbackPaths("look at this", [prepared]);
  assert.ok(text.startsWith("look at this"));
  assert.ok(text.includes(path));
});

test("a replayed copy still travels for the path the prompt names", async (t) => {
  const { data } = await fixture(t);
  const ref = `attachments/${"a".repeat(64)}`;
  await mkdir(join(data, "attachments"), { recursive: true });
  await writeFile(join(data, ref), png);
  const attachment = { path: ref, name: "a.png", kind: "image", mimeType: "image/png" };
  const content = `look @${ref}`;
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    content,
  );
  assert.equal(prepared.message.inlinePath, `@${ref}`);
  const text = appendPromptFallbackPaths(content, [prepared]);
  assert.ok(text.startsWith(content));
  // The stored blob is replayed into scratch, so that working path is added.
  assert.notEqual(prepared.fallbackPath, ref);
  assert.ok(text.includes(prepared.fallbackPath));
});
