import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
function load(path) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { nativeClipboardPaths, readComposerClipboardDirectories } = load("../electron/main/composer-clipboard-directories.ts");
const { serializeComposerFileReferences, serializeInlineComposerFileReferences } = load("../../../packages/shared/src/composer-trigger.ts");
const clipboard = values => ({ availableFormats: () => Object.keys(values), readBuffer: format => Buffer.from(values[format] ?? "") });

test("native URI file lists preserve order and decode spaces/unicode without reading clipboard text", () => {
  assert.deepEqual(nativeClipboardPaths(clipboard({
    "text/uri-list": "# comment\r\nfile:///tmp/one%20folder\r\nfile:///tmp/%E4%B8%AD%E6%96%87\r\nhttps://example.com/ignored",
    "text/plain": "unrelated clipboard text",
  })), ["/tmp/one folder", "/tmp/中文"]);
  assert.deepEqual(nativeClipboardPaths(clipboard({ "x-special/gnome-copied-files": "copy\nfile:///tmp/a\nfile:///tmp/a" })), ["/tmp/a"]);
});

test("native file lists enforce metadata and selection bounds", () => {
  assert.throws(() => nativeClipboardPaths(clipboard({ "text/uri-list": "x".repeat(1024 * 1024 + 1) })), /too large/);
  assert.throws(() => nativeClipboardPaths(clipboard({ "text/uri-list": Array.from({ length: 21 }, (_, i) => `file:///tmp/${i}`).join("\n") })), /too many/);
  assert.throws(() => nativeClipboardPaths(clipboard({ CF_HDROP: Buffer.alloc(2) })), /invalid/);
});

test("macOS Finder file-list metadata is decoded in full", { skip: process.platform !== "darwin" }, () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>/tmp/first folder</string><string>/tmp/second</string></array></plist>';
  assert.deepEqual(nativeClipboardPaths(clipboard({ NSFilenamesPboardType: xml })), ["/tmp/first folder", "/tmp/second"]);
});

test("directory metadata never copies a tree and mixed files use the existing import capability", async t => {
  const root = await mkdtemp(join(tmpdir(), "composer-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "folder & 中文"), file = join(root, "notes.txt");
  await mkdir(folder);
  await writeFile(join(folder, "keep.txt"), "original");
  await writeFile(file, "notes");
  let captured;
  const result = await readComposerClipboardDirectories(clipboard({ "text/uri-list": [folder, file].map(path => pathToFileURL(path).href).join("\n") }), paths => { captured = paths; return "selection"; });
  assert.deepEqual(result.items.map(item => item.kind), ["directory", "file"]);
  assert.equal(result.items[0].name, "folder & 中文");
  assert.equal(result.token, "selection");
  assert.equal(captured.length, 1);
  assert.equal(result.items[1].path, undefined, "regular source paths stay in main");
  assert.equal(await readFile(join(folder, "keep.txt"), "utf8"), "original");
  assert.equal(await readComposerClipboardDirectories(clipboard({ "public.file-url": pathToFileURL(file).href }), () => assert.fail("regular-only paste keeps its current flow")), null);
});

test("both send serializers include one directory instruction and escaped path markers", () => {
  const refs = [{ path: "/tmp/a & <b>", kind: "directory", token: "\ue001" }, { path: "/tmp/two", kind: "directory", token: "\ue002" }];
  for (const serialize of [serializeComposerFileReferences, serializeInlineComposerFileReferences]) {
    const result = serialize("Inspect \ue001 and \ue002", refs);
    assert.ok(result.includes("<dir>/tmp/a &amp; &lt;b&gt;</dir>"));
    assert.ok(result.includes("<dir>/tmp/two</dir>"));
    assert.equal(result.match(/Inspect their structure/g)?.length, 1);
    assert.equal(serialize("Removed both", refs), "Removed both");
    assert.equal(serialize("", [{ path: "/tmp/without-token", kind: "directory" }]).includes("<dir>/tmp/without-token</dir>"), true);
  }
});

test("the real editor paints an atomic folder card with a localized type, full path and remove action", t => {
  const originalDocument = globalThis.document, originalNode = globalThis.Node;
  t.after(() => { globalThis.document = originalDocument; globalThis.Node = originalNode; });
  function element(tag) {
    const node = { nodeType: 1, tagName: tag.toUpperCase(), className: "", dataset: {}, childNodes: [], attributes: {}, listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, value) { this.listeners[key] = value; },
      append(...nodes) { this.childNodes.push(...nodes); },
      appendChild(child) { this.childNodes.push(child); return child; },
      replaceChildren() { this.childNodes = []; },
    };
    node.classList = { contains: key => node.className.split(" ").includes(key), add: key => { node.className += ` ${key}`; } };
    return node;
  }
  globalThis.document = { createElement: element, createTextNode: value => ({ nodeType: 3, nodeValue: value }) };
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  const editor = load("../src/features/chat/composer/editor.ts");
  const reference = { path: "/tmp/folder.txt", name: "folder.txt", kind: "directory", token: "\ue001" };
  const container = element("div");
  let removed;
  const args = [container, "\ue001", new Map([["\ue001", reference]]), () => "Remove folder", token => { removed = token; }];
  if (editor.paintEditorValue.length >= 10) args.push(undefined, undefined, () => {}, () => {}, () => {}, "Folder");
  else args.push(() => {}, () => {}, () => {}, "Folder");
  editor.paintEditorValue(...args);
  const card = container.childNodes[0];
  assert.equal(card.classList.contains("composer-directory-card"), true);
  assert.equal(card.title, reference.path);
  assert.equal(card.contentEditable, "false");
  assert.equal(card.childNodes[1].childNodes[0].textContent, "folder.txt");
  assert.equal(card.childNodes[1].childNodes[1].textContent, "Folder");
  assert.equal(editor.readEditorValue(container), "\ue001");
  const remove = card.childNodes.at(-1);
  assert.equal(remove.attributes["aria-label"], "Remove folder");
  remove.listeners.click({ stopPropagation() {} });
  assert.equal(removed, "\ue001");
  assert.equal(editor.isEditableTextReference(reference), false, "a directory named .txt must not expand as a text file");
});
