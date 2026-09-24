import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { importComposerFiles, saveComposerPasteFiles } from "../electron/main/composer-paste.ts";
import { appendPromptFallbackPaths, preparePromptAttachments } from "../electron/main/prompt-attachments.ts";

const SVG_MIME = "image/svg+xml";
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text y="12">SVG regression</text></svg>');
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=", "base64");
const sessionId = "svg-regression";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-svg attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const project = join(root, "project");
  const scratch = join(data, "scratch", sessionId);
  await Promise.all([mkdir(project, { recursive: true }), mkdir(scratch, { recursive: true })]);
  return { root, data, project, scratch };
}

function assertInside(root, path) {
  const child = relative(root, path);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), path);
}

for (const [name, mimeType, expectedName] of [
  ["diagram.svg", SVG_MIME, "diagram.svg"],
  ["pasted-diagram", SVG_MIME, "pasted-diagram.svg"],
  ["", " IMAGE/SVG+XML ; charset=UTF-8 ", "pasted-file-1.svg"],
  ["diagram.SVG", "", "diagram.SVG"],
  ["diagram.svg", "application/octet-stream", "diagram.svg"],
  ["diagram.svg", "image/png", "diagram.svg"],
  ["diagram.png", SVG_MIME, "diagram.png"],
]) {
  test(`SVG paste stays a readable file: ${JSON.stringify([name, mimeType])}`, async (t) => {
    const { data } = await fixture(t);
    const input = { name, mimeType, data: new Uint8Array(svg) };
    const before = structuredClone(input);
    const [saved] = await saveComposerPasteFiles(data, sessionId, [input]);
    assert.equal(saved.kind, "file");
    assert.equal(saved.mimeType, SVG_MIME);
    assert.equal(saved.name, expectedName);
    assert.deepEqual(await readFile(saved.path), svg);
    const prepared = await preparePromptAttachments(data, sessionId, undefined, [saved], true);
    assert.equal(prepared[0].message.kind, "file");
    assert.equal(prepared[0].inlineData, undefined);
    assert.equal(prepared[0].message.mimeType, SVG_MIME);
    assert.ok(appendPromptFallbackPaths("Explain this diagram", prepared).includes(saved.path));
    assert.deepEqual(input, before);
  });
}

test("picker import and project-path drop use the same SVG fallback", async (t) => {
  const { data, project } = await fixture(t);
  const source = join(project, "diagram.SVG");
  await writeFile(source, svg);
  const [picked] = await importComposerFiles(data, sessionId, [source]);
  assert.equal(picked.kind, "file");
  assert.equal(picked.mimeType, SVG_MIME);
  assert.deepEqual(await readFile(picked.path), svg);
  const dropped = { path: source, name: "diagram.SVG", kind: "image", mimeType: "image/png" };
  for (const supportsVision of [false, true]) {
    const prepared = await preparePromptAttachments(data, sessionId, project, [picked, dropped], supportsVision);
    assert.ok(prepared.every((item) => item.message.kind === "file" && item.inlineData === undefined));
    assert.ok(prepared.every((item) => item.message.mimeType === SVG_MIME));
    assert.ok(appendPromptFallbackPaths("Explain both", prepared).includes("diagram.SVG"));
  }
  assert.deepEqual(await readFile(source), svg);
});

test("legacy content-store SVG retries produce a session-readable file, not an image", async (t) => {
  const { data, scratch } = await fixture(t);
  const ref = `attachments/${createHash("sha256").update(svg).digest("hex")}`;
  await mkdir(join(data, "attachments"));
  await writeFile(join(data, ref), svg);
  for (const metadata of [
    { name: "pasted-diagram.bin", mimeType: SVG_MIME },
    { name: "diagram.svg", mimeType: "image/png" },
  ]) {
    const attachment = { kind: "image", path: ref, ...metadata };
    const before = structuredClone(attachment);
    const [prepared] = await preparePromptAttachments(data, sessionId, undefined, [attachment], true);
    assert.equal(prepared.message.kind, "file");
    assert.equal(prepared.message.ref, ref);
    assert.equal(prepared.message.mimeType, SVG_MIME);
    assert.equal(prepared.inlineData, undefined);
    assertInside(scratch, prepared.fallbackPath);
    assert.deepEqual(await readFile(prepared.fallbackPath), svg);
    assert.deepEqual(attachment, before);
  }
  assert.deepEqual(await readFile(join(data, ref)), svg);
});

test("mixed SVG and PNG paste keeps PNG image bytes and SVG file references", async (t) => {
  const { data } = await fixture(t);
  const saved = await saveComposerPasteFiles(data, sessionId, [
    { name: "diagram.svg", mimeType: SVG_MIME, data: svg },
    { name: "pixel.png", mimeType: "image/png", data: png },
  ]);
  const prepared = await preparePromptAttachments(data, sessionId, undefined, saved, true);
  assert.deepEqual(prepared.map((item) => item.message.kind), ["file", "image"]);
  assert.equal(prepared[0].inlineData, undefined);
  assert.equal(prepared[1].message.mimeType, "image/png");
  assert.deepEqual(Buffer.from(prepared[1].inlineData, "base64"), png);
  const text = appendPromptFallbackPaths("Compare", prepared);
  assert.ok(text.startsWith("Compare\n"));
  assert.ok(text.includes(saved[0].path));
  assert.ok(!text.includes(saved[1].path));
  const nonVision = await preparePromptAttachments(data, sessionId, undefined, saved, false);
  assert.ok(nonVision.every((item) => item.inlineData === undefined));
  assert.ok(appendPromptFallbackPaths("Compare", nonVision).includes(saved[1].path));
});

test("SVG classification does not bypass attachment roots or mutate failed input", async (t) => {
  const { data, project, root } = await fixture(t);
  const outside = join(root, "outside.svg");
  await writeFile(outside, svg);
  const attachment = { kind: "image", path: outside, name: "outside.svg", mimeType: SVG_MIME };
  const before = structuredClone(attachment);
  await assert.rejects(
    preparePromptAttachments(data, sessionId, project, [attachment], true),
    { errorCode: "PATH_OUTSIDE_WORKSPACE" },
  );
  assert.deepEqual(attachment, before);
  assert.deepEqual(await readFile(outside), svg);
  const link = join(project, "escape.svg");
  try {
    await symlink(outside, link);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return;
    throw error;
  }
  await assert.rejects(
    preparePromptAttachments(data, sessionId, project, [{ ...attachment, path: link }], true),
    { errorCode: "PATH_OUTSIDE_WORKSPACE" },
  );
});

// The history service is imported without booting a sidecar or using a provider.
const { hydrateAttachmentHistory } = await import("../../../packages/agent-runtime/src/attachment-history.ts");

test("restoring legacy SVG history strips image data and keeps a readable scratch fallback", async (t) => {
  const { data, project, scratch } = await fixture(t);
  const attachmentsDir = join(data, "attachments");
  await mkdir(attachmentsDir);
  const svgRef = `attachments/${createHash("sha256").update(svg).digest("hex")}`;
  const pngRef = `attachments/${createHash("sha256").update(png).digest("hex")}`;
  await Promise.all([writeFile(join(data, svgRef), svg), writeFile(join(data, pngRef), png)]);
  const history = [{
    id: "legacy-user", role: "user", content: "Explain the diagram", ts: 1,
    attachments: [
      { kind: "image", name: "pasted-diagram.bin", mimeType: " IMAGE/SVG+XML ; charset=utf-8", ref: svgRef, data: svg.toString("base64") },
      { kind: "image", name: "pixel.png", mimeType: "image/png", ref: pngRef },
    ],
  }];
  const before = structuredClone(history);
  const [restored] = await hydrateAttachmentHistory(history, {
    scratchDir: scratch, projectPath: project, attachmentsDir, supportsVision: true,
  });
  const [vector, raster] = restored.attachments;
  assert.equal(vector.kind, "file");
  assert.equal(vector.mimeType, SVG_MIME);
  assert.equal(vector.data, undefined);
  assert.equal(vector.ref, svgRef);
  assert.equal(raster.kind, "image");
  assert.deepEqual(Buffer.from(raster.data, "base64"), png);
  assert.ok(restored.content.startsWith("Explain the diagram\n"));
  const fallback = restored.content.match(/@"([^"\n]+)"/)?.[1];
  assert.ok(fallback);
  assertInside(scratch, fallback);
  assert.deepEqual(await readFile(fallback), svg);
  assert.deepEqual(history, before);
  assert.deepEqual(await readFile(join(data, svgRef)), svg);
});

test("history SVG filename metadata overrides stale kind and MIME", async (t) => {
  const { data, scratch } = await fixture(t);
  const path = join(scratch, "diagram.SVG");
  await writeFile(path, svg);
  for (const supportsVision of [false, true]) {
    const [restored] = await hydrateAttachmentHistory([{
      id: "named-svg", role: "user", content: "", ts: 1,
      attachments: [{ kind: "image", name: "legacy.bin", ref: path, mimeType: "image/png", data: svg.toString("base64") }],
    }], { scratchDir: scratch, attachmentsDir: join(data, "attachments"), supportsVision });
    assert.equal(restored.attachments[0].kind, "file");
    assert.equal(restored.attachments[0].data, undefined);
    assert.ok(restored.content.includes(path));
  }
});

test("missing or outside-root SVG history never retains a stale image payload", async (t) => {
  const { scratch, root } = await fixture(t);
  const outside = join(root, "outside.svg");
  await writeFile(outside, svg);
  for (const ref of [outside, join(scratch, "missing.svg"), ""]) {
    const attachment = { kind: "image", name: "diagram.svg", ref, data: svg.toString("base64") };
    const before = structuredClone(attachment);
    const [restored] = await hydrateAttachmentHistory([{
      id: "unavailable-svg", role: "user", content: "Keep this prompt", ts: 1, attachments: [attachment],
    }], { scratchDir: scratch, supportsVision: true });
    assert.equal(restored.attachments[0].kind, "file");
    assert.equal(restored.attachments[0].data, undefined);
    assert.equal(restored.content, "Keep this prompt");
    assert.deepEqual(attachment, before);
  }
});

test("history non-vision images and non-user messages preserve existing behavior", async (t) => {
  const { scratch } = await fixture(t);
  const path = join(scratch, "pixel.png");
  await writeFile(path, png);
  const assistant = { id: "assistant", role: "assistant", content: "Unchanged", ts: 2 };
  const [restored, unchanged] = await hydrateAttachmentHistory([{
    id: "user", role: "user", content: "Explain", ts: 1,
    attachments: [{ kind: "image", name: "pixel.png", ref: path, mimeType: "image/png" }],
  }, assistant], { scratchDir: scratch, supportsVision: false });
  assert.equal(restored.attachments[0].kind, "image");
  assert.equal(restored.attachments[0].data, undefined);
  assert.ok(restored.content.includes(path));
  assert.equal(unchanged, assistant);
});

test("existing non-SVG image metadata is not narrowed to a new provider allowlist", async (t) => {
  const { data } = await fixture(t);
  // These fixtures test classification/transport, not image decoding.
  for (const extension of ["png", "jpeg", "gif", "webp", "avif", "bmp", "heic", "tiff"]) {
    const mimeType = `image/${extension}`;
    const bytes = Buffer.from(`transport fixture: ${extension}`);
    const [saved] = await saveComposerPasteFiles(data, sessionId, [{ name: `fixture.${extension}`, mimeType, data: bytes }]);
    assert.equal(saved.kind, "image");
    const [prepared] = await preparePromptAttachments(data, sessionId, undefined, [saved], true);
    assert.equal(prepared.message.kind, "image");
    assert.equal(prepared.message.mimeType, mimeType);
    assert.deepEqual(Buffer.from(prepared.inlineData, "base64"), bytes);
  }
});
