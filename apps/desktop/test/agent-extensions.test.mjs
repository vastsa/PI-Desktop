import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentExtensionBridge,
  generateImportedExtensionPlugin,
  installExtensionDependencies,
} from "../electron/main/agent-extensions.ts";

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

test("importing a directory keeps its package.json at the plugin root and never copies node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ax-pkg-"));
  const extDir = join(root, "memory-ext");
  mkdirSync(join(extDir, "node_modules", "some-dep"), { recursive: true });
  writeFileSync(join(extDir, "node_modules", "some-dep", "index.js"), "module.exports = {};");
  writeFileSync(join(extDir, "index.ts"), "export default function () {}\n");
  writeFileSync(
    join(extDir, "package.json"),
    JSON.stringify({ name: "memory-ext", dependencies: { "some-dep": "^1.0.0" }, pi: { extensions: ["index.ts"] } }),
  );
  writeFileSync(join(extDir, "package-lock.json"), "{}");

  const generated = generateImportedExtensionPlugin(extDir, join(root, "imported"));
  assert.equal(readFileSync(join(generated.path, "package.json"), "utf8"), readFileSync(join(extDir, "package.json"), "utf8"), "package.json lands at the plugin root for dependency install");
  assert.ok(existsSync(join(generated.path, "package-lock.json")));
  assert.ok(!existsSync(join(generated.path, "src", "node_modules")), "node_modules is reinstalled, never copied");

  const file = join(root, "solo.ts");
  writeFileSync(file, "export default function () {}\n");
  const single = generateImportedExtensionPlugin(file, join(root, "imported"));
  assert.ok(!existsSync(join(single.path, "package.json")), "a lone file has nothing to install from");
});

test("importing strips workspaces from the copied package.json so npm never enters src/", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ax-ws-"));
  const extDir = join(root, "monorepo-ext");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "index.ts"), "export default function () {}\n");
  writeFileSync(
    join(extDir, "package.json"),
    JSON.stringify({ name: "monorepo-ext", workspaces: ["packages/*"], dependencies: { "some-dep": "^1" } }),
  );

  const generated = generateImportedExtensionPlugin(extDir, join(root, "imported"));
  const pkg = JSON.parse(readFileSync(join(generated.path, "package.json"), "utf8"));
  assert.ok(!("workspaces" in pkg), "workspaces is stripped from the plugin root copy");
  assert.deepEqual(pkg.dependencies, { "some-dep": "^1" });

  const plainDir = join(root, "plain-ext");
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(join(plainDir, "index.ts"), "export default function () {}\n");
  writeFileSync(join(plainDir, "package.json"), JSON.stringify({ name: "plain-ext", dependencies: {} }));
  const plain = generateImportedExtensionPlugin(plainDir, join(root, "imported"));
  assert.deepEqual(JSON.parse(readFileSync(join(plain.path, "package.json"), "utf8")), {
    name: "plain-ext",
    dependencies: {},
  }, "a package.json without workspaces is copied verbatim");
});

test("default runner caps captured stderr and escalates the timeout kill", async () => {
  const { defaultDependencyRunner } = await import("../electron/main/agent-extensions.ts");

  const flooded = await defaultDependencyRunner(
    process.execPath,
    ["-e", "process.stderr.write('x'.repeat(40000)); process.exit(0)"],
    process.cwd(),
    30_000,
  );
  assert.equal(flooded.code, 0);
  assert.ok(flooded.stderr.length <= 8192 + 64, "stderr is capped to a rolling tail");

  const stalled = await defaultDependencyRunner(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)"],
    process.cwd(),
    300,
  );
  assert.notEqual(stalled.code, 0, "a stalled install is killed");
  assert.match(stalled.stderr, /exceeded 300ms and was terminated/);
});

test("dependency install: skips without a manifest or dependencies, runs npm with pinned flags, surfaces failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ax-deps-"));
  const write = (name, json) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (json !== null) writeFileSync(join(dir, "package.json"), json);
    return dir;
  };

  const noPackage = write("no-package", null);
  assert.deepEqual(await installExtensionDependencies(noPackage), { state: "skipped", reason: "no-package-json" });

  const noDeps = write("no-deps", JSON.stringify({ name: "x" }));
  assert.deepEqual(await installExtensionDependencies(noDeps), { state: "skipped", reason: "no-dependencies" });

  const badJson = write("bad-json", "{ not json");
  const bad = await installExtensionDependencies(badJson);
  assert.equal(bad.state, "failed");
  assert.match(bad.error, /package\.json is not valid JSON/);

  const calls = [];
  const installed = write("installed", JSON.stringify({ name: "x", dependencies: { "some-dep": "^1" } }));
  const runner = async (command, args, cwd, timeoutMs) => {
    calls.push({ command, args, cwd, timeoutMs });
    return { code: 0, stderr: "" };
  };
  assert.deepEqual(await installExtensionDependencies(installed, { runner, timeoutMs: 1234 }), { state: "installed" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "npm");
  assert.deepEqual(calls[0].args, ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", "--ignore-scripts"]);
  assert.equal(calls[0].cwd, installed, "npm runs inside the plugin directory");
  assert.equal(calls[0].timeoutMs, 1234);

  const failing = write("failing", JSON.stringify({ name: "x", dependencies: { "some-dep": "^1" } }));
  const result = await installExtensionDependencies(failing, {
    runner: async () => ({ code: 1, stderr: "npm error code ENOTFOUND\nnpm error network unreachable" }),
  });
  assert.equal(result.state, "failed");
  assert.match(result.error, /exited 1/);
  assert.match(result.error, /ENOTFOUND/);

  const throwing = write("throwing", JSON.stringify({ name: "x", dependencies: { "some-dep": "^1" } }));
  const thrown = await installExtensionDependencies(throwing, {
    runner: async () => {
      throw new Error("npm not found");
    },
  });
  assert.deepEqual(thrown, { state: "failed", error: "npm not found" });
});
