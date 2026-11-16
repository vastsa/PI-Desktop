import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { isRenderableAttachment } from "@pi-desktop/shared";
import { snapshotComposerDraft } from "../src/lib/composer-draft-cache.ts";

function loadFunction(path, name, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const tree = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  const code = ts.transpileModule(node.getText(tree).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(`${code}\n${name};`, globals);
}

const reference = {
  path: "/outside/large.bin", name: "large.bin", kind: "file", token: "\ue001",
  localReference: "11111111-2222-4333-8444-555555555555", size: 67108865,
};

test("draft snapshot and dispatch preserve reference identity and exact size", () => {
  const draft = snapshotComposerDraft("Inspect \ue001", [{ ...reference, sessionId: "source" }], "source");
  assert.deepEqual(draft.fileReferences, [reference]);
  const fromDraft = loadFunction("../src/stores/helpers/store-helpers.ts", "promptAttachmentsFromDraft");
  const [attachment] = fromDraft(draft.fileReferences);
  assert.equal(attachment.localReference, reference.localReference);
  assert.equal(attachment.size, reference.size);
  const fromMessage = loadFunction("../src/stores/helpers/store-helpers.ts", "promptAttachmentsFromMessage", { isRenderableAttachment });
  const [retry] = fromMessage([{ ...attachment, ref: reference.path }]);
  assert.equal(retry.localReference, reference.localReference);
  assert.equal(retry.size, reference.size);
});

test("file card shows size, remains removable, and does not expand or preview contents", () => {
  function element() {
    return { dataset: {}, attrs: {}, events: {}, children: [], title: "", textContent: "",
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(key, handler) { this.events[key] = handler; },
      append(...items) { this.children.push(...items); },
    };
  }
  const globals = { document: { createElement: element }, chipIconKey: () => "file", chipSvg: () => "", isPluginMark: () => false };
  globals.isEditableTextReference = loadFunction("../src/features/chat/composer/editor.ts", "isEditableTextReference", globals);
  const build = loadFunction("../src/features/chat/composer/editor.ts", "buildChipElement", globals);
  let removed;
  const chip = build(reference, reference.token, "Remove", token => { removed = token; });
  assert.equal(chip.children[1].textContent, "large.bin · 64 MiB");
  assert.ok(chip.title.includes("67108865 B"));
  assert.equal(chip.attrs.role, "listitem");
  assert.equal(chip.dataset.image, undefined);
  chip.children[2].events.click({ stopPropagation() {} });
  assert.equal(removed, reference.token);
});
