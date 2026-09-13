import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  AgentExtensionBridge,
  generateImportedExtensionPlugin,
} = await import("../electron/main/agent-extensions.ts");

function bridge(overrides = {}) {
  const events = { changed: 0, prompts: [], toasts: [], statuses: [] };
  const b = new AgentExtensionBridge({
    hasRenderer: () => true,
    onChanged: () => {
      events.changed += 1;
    },
    onPrompt: (prompt) => events.prompts.push(prompt),
    onToast: (message, level) => events.toasts.push({ message, level }),
    onStatus: (event) => events.statuses.push(event),
    promptTimeoutMs: 50,
    ...overrides,
  });
  return { b, events };
}

test("session publications drive the plugin's agent-extension status and the command list", () => {
  const { b, events } = bridge();
  const ids = ["/p/a.ts", "/p/b.ts"];
  assert.deepEqual(b.statusForPlugin(ids), { state: "enabled", toolNames: [], commandNames: [], diagnostics: [] });

  b.publishDiagnostics("s1", [{ extensionId: "/p/a.ts", kind: "unsupported_api", message: "x", member: "setWidget", count: 2 }], [
    { extensionId: "/p/a.ts", state: "loaded", toolNames: ["fx_add"], commandNames: ["greet"], eventNames: [] },
    { extensionId: "/p/b.ts", state: "loaded", toolNames: ["fx_two"], commandNames: [], eventNames: [] },
    { extensionId: "/other.ts", state: "error", toolNames: [], commandNames: [], eventNames: [] },
  ]);
  b.publishCommands("s1", [{ extensionId: "/p/a.ts", extensionLabel: "P", name: "greet", description: "hi" }]);
  b.publishCommands("s2", [{ extensionId: "/p/a.ts", extensionLabel: "P", name: "greet" }, { extensionId: "/p/a.ts", extensionLabel: "P", name: "other" }]);

  const status = b.statusForPlugin(ids);
  assert.equal(status.state, "loaded", "the other plugin's error does not leak in");
  assert.deepEqual(status.toolNames, ["fx_add", "fx_two"]);
  assert.deepEqual(status.commandNames, ["greet"]);
  assert.equal(status.diagnostics[0].member, "setWidget");
  assert.deepEqual(b.allCommands().map((c) => [c.name, c.description]), [["greet", "hi"], ["other", undefined]]);
  assert.deepEqual(b.commandsForSession("s2").map((c) => c.name), ["greet", "other"]);

  b.publishDiagnostics("s1", [], [{ extensionId: "/p/a.ts", state: "error", toolNames: [], commandNames: [], eventNames: [] }]);
  assert.equal(b.statusForPlugin(ids).state, "error");
  b.clearSession("s1");
  b.clearSession("s2");
  assert.deepEqual(b.allCommands(), []);
  assert.ok(events.changed >= 5);
});

test("ui requests: notify and status pass through; prompts round-trip, queue per session, time out, and cancel on abort", async () => {
  const { b, events } = bridge();
  const envelope = (request, sessionId = "s1") => ({ sessionId, extensionId: "ext", extensionLabel: "Hello", request });
  assert.deepEqual(await b.requestUi(envelope({ kind: "notify", message: "hi", level: "warning" })), { kind: "notify" });
  assert.deepEqual(events.toasts, [{ message: "Hello: hi", level: "warning" }]);
  await b.requestUi(envelope({ kind: "setStatus", key: "k", text: "busy" }));
  await b.requestUi(envelope({ kind: "setWorkingMessage", text: undefined }));
  assert.deepEqual(events.statuses.map((s) => [s.key, s.text]), [["k", "busy"], ["working", undefined]]);

  const confirm = b.requestUi(envelope({ kind: "confirm", title: "Sure?", message: "really" }));
  const select = b.requestUi(envelope({ kind: "select", title: "Pick", options: ["a", "b"] }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.prompts.length, 1, "second prompt waits behind the first");
  assert.equal(b.respond("nope", true), false);
  assert.equal(b.respond(events.prompts[0].promptId, true), true);
  assert.deepEqual(await confirm, { kind: "confirm", value: true });
  await new Promise((r) => setTimeout(r, 0));
  b.respond(events.prompts[1].promptId, "b");
  assert.deepEqual(await select, { kind: "select", value: "b" });

  assert.deepEqual(await b.requestUi(envelope({ kind: "input", title: "Name" })), { kind: "input", value: undefined });

  const aborted = b.requestUi(envelope({ kind: "confirm", title: "x", message: "" }, "s9"));
  await new Promise((r) => setTimeout(r, 0));
  b.cancelPrompts("s9");
  assert.deepEqual(await aborted, { kind: "confirm", value: false });
  assert.equal(b.pendingPromptCount(), 0);

  const { b: headless } = bridge({ hasRenderer: () => false });
  await assert.rejects(headless.requestUi(envelope({ kind: "input", title: "x" })), (err) => err.errorCode === "UNSUPPORTED");
});

test("importing a pi extension directory or file generates a plugin holding agent.extension", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ax-import-"));
  const importRoot = join(root, "imported");
  const extDir = join(root, "git-helper");
  mkdirSync(join(extDir, "lib"), { recursive: true });
  writeFileSync(join(extDir, "index.ts"), "export default function () {}\n");
  writeFileSync(join(extDir, "lib", "util.ts"), "export const x = 1;\n");
  writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "@acme/git-helper", pi: { extensions: ["index.ts"] } }));

  const dir = generateImportedExtensionPlugin(extDir, importRoot);
  assert.equal(dir.id, "imported.git-helper");
  assert.deepEqual(dir.entries, ["src/index.ts"]);
  const manifest = JSON.parse(readFileSync(join(dir.path, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["agent.extension"]);
  assert.deepEqual(manifest.contributes, { agentExtensions: ["src/index.ts"] });
  assert.ok(existsSync(join(dir.path, "src", "lib", "util.ts")), "the whole directory is copied");
  assert.match(readFileSync(join(dir.path, "main.js"), "utf8"), /module\.exports = \{\}/);

  const file = join(root, "solo.ts");
  writeFileSync(file, "export default function () {}\n");
  const single = generateImportedExtensionPlugin(file, importRoot);
  assert.equal(single.id, "imported.solo");
  assert.deepEqual(single.entries, ["src/solo.ts"]);

  // A second import of the same name gets its own directory.
  const again = generateImportedExtensionPlugin(file, importRoot);
  assert.notEqual(again.path, single.path);

  writeFileSync(join(root, "notes.md"), "# no");
  assert.throws(() => generateImportedExtensionPlugin(join(root, "notes.md"), importRoot), /no extension entry/);
});
