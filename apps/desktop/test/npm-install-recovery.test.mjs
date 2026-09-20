import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { catalogs } = await import("@pi-desktop/i18n");
const { registerAgentExtensionIpc } = await import("../electron/main/agent-extensions-ipc.ts");
const { installExtensionDependencies } = await import("../electron/main/npm-installer.ts");
const { readNpmPath, writeNpmPath } = await import("../electron/main/npm-preferences.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "npm-picker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "index.ts"), "export default function (pi) {}\n");
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "picker-fixture", pi: { extensions: ["./index.ts"] }, dependencies: { "fixture-dep": "1.0.0" },
  }));
  const bin = join(root, "Node runtime with spaces");
  mkdirSync(bin);
  let npmPath;
  if (process.platform === "win32") {
    copyFileSync(process.execPath, join(bin, "node.exe"));
    const cli = join(bin, "node_modules", "npm", "bin");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "npm-cli.js"), "console.log('11.0.0');\n");
    npmPath = join(bin, "npm.cmd");
    writeFileSync(npmPath, '@"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
  } else {
    symlinkSync(process.execPath, join(bin, "node"));
    npmPath = join(bin, "npm");
    writeFileSync(npmPath, "#!/usr/bin/env node\nconsole.log('11.0.0');\n", { mode: 0o755 });
  }
  return { root, source, npmPath, importRoot: join(root, "plugins"), dataDir: join(root, "data") };
}

function harness(f, options = {}) {
  const handlers = new Map();
  const events = [];
  const pickerResults = [...(options.picks ?? [f.npmPath])];
  const responses = [...(options.responses ?? [1])];
  const dialogs = {
    async showOpenDialog(...args) {
      const config = args.at(-1);
      if (config.properties.includes("openDirectory")) {
        events.push({ kind: "source" });
        return { canceled: false, filePaths: [f.source] };
      }
      events.push({ kind: "npm-picker", config });
      const next = pickerResults.shift();
      return { canceled: !next, filePaths: next ? [next] : [] };
    },
    async showMessageBox(...args) {
      const config = args.at(-1);
      events.push({ kind: "message", config });
      return { response: responses.shift() ?? 0 };
    },
  };
  const runner = options.runner ?? (async (command, args, cwd) => {
    events.push({ kind: "run", command, args, cwd });
    if (command === "npm") throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    return { code: 0, stderr: "" };
  });
  registerAgentExtensionIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    bridge: { respond: () => true },
    dialogs,
    window: () => options.window ?? null,
    getLocale: () => options.locale ?? "en",
    getNpmPath: () => readNpmPath(f.dataDir),
    setNpmPath: options.save ?? ((path) => writeNpmPath(f.dataDir, path)),
    importRoot: f.importRoot,
    installDependencies: (dir, config) => installExtensionDependencies(dir, { ...config, runner }),
    loadDevPlugin: async (path) => {
      events.push({ kind: "load", path });
      return { path };
    },
    runCommand: async () => ({ handled: true }),
  });
  return { events, run: () => handlers.get(IPC.invoke.pluginImportExtension)() };
}

// E2E-PLUGIN-import-extension-recovers-missing-npm: real import service wiring with native I/O stubs.
test("missing npm → select → validate → remember → retry the same import → load once", async (t) => {
  const f = fixture(t);
  const h = harness(f);
  const result = await h.run();
  assert.equal(result.canceled, false);
  assert.deepEqual(result.dependencies, { state: "installed" });
  assert.equal(readNpmPath(f.dataDir), f.npmPath);
  assert.equal(readdirSync(f.importRoot).length, 1);
  assert.equal(h.events.filter((e) => e.kind === "source").length, 1);
  assert.equal(h.events.filter((e) => e.kind === "load").length, 1);
  const calls = h.events.filter((e) => e.kind === "run");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((e) => e.cwd === result.path));
  assert.equal(calls[1].args.includes("--package-lock-only"), true);
  assert.equal(calls[2].args.includes("ci"), true);
  assert.equal(h.events.at(-1).kind, "load");
  assert.ok(h.events.find((e) => e.kind === "npm-picker").config.properties.includes("showHiddenFiles"));
  assert.ok(h.events.find((e) => e.kind === "npm-picker").config.properties.includes("noResolveAliases"));

  // A newly registered handler (app restart equivalent) reuses the on-disk choice.
  const second = harness(f, { picks: [] });
  assert.equal((await second.run()).dependencies.state, "installed");
  assert.equal(second.events.some((e) => e.kind === "message" || e.kind === "npm-picker"), false);
});

for (const stage of ["confirmation", "picker"]) {
  test(`cancel at ${stage} preserves failed import without saving or retrying`, async (t) => {
    const f = fixture(t);
    const h = harness(f, stage === "confirmation" ? { responses: [0] } : { picks: [] });
    const result = await h.run();
    assert.equal(result.dependencies.state, "failed");
    assert.equal(result.dependencies.reason, "npm-unavailable");
    assert.equal(readNpmPath(f.dataDir), undefined);
    assert.equal(h.events.filter((e) => e.kind === "run").length, 1);
    assert.equal(h.events.at(-1).kind, "load");
  });
}

test("invalid selection is not remembered and can be corrected in the same import", async (t) => {
  const f = fixture(t);
  const h = harness(f, { picks: [join(f.root, "missing", "npm"), f.npmPath], responses: [1, 1] });
  const result = await h.run();
  assert.equal(result.dependencies.state, "installed");
  assert.equal(readNpmPath(f.dataDir), f.npmPath);
  const messages = h.events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 2);
  assert.equal(messages[1].config.title, catalogs.en.plugins.npmInvalidTitle);
  assert.equal(readdirSync(f.importRoot).length, 1);
});

test("a stale saved executable can be replaced", async (t) => {
  const f = fixture(t);
  writeNpmPath(f.dataDir, join(f.root, "removed-node", "npm"));
  const h = harness(f);
  assert.equal((await h.run()).dependencies.state, "installed");
  assert.equal(readNpmPath(f.dataDir), f.npmPath);
  assert.equal(h.events.filter((e) => e.kind === "npm-picker").length, 1);
});

test("ordinary npm failures never open the executable picker", async (t) => {
  const f = fixture(t);
  const h = harness(f, { runner: async () => ({ code: 1, stderr: "registry is unavailable" }) });
  const result = await h.run();
  assert.equal(result.dependencies.state, "failed");
  assert.equal(result.dependencies.reason, undefined);
  assert.equal(h.events.some((e) => e.kind === "message" || e.kind === "npm-picker"), false);
  assert.equal(h.events.at(-1).kind, "load");
});

test("a network error after selection is reported without a second path prompt", async (t) => {
  const f = fixture(t);
  const h = harness(f, { runner: async (command) => {
    if (command === "npm") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { code: 1, stderr: "ETIMEDOUT fetching registry" };
  } });
  const result = await h.run();
  assert.equal(result.dependencies.state, "failed");
  assert.equal(result.dependencies.reason, undefined);
  assert.equal(h.events.filter((e) => e.kind === "message").length, 1);
  assert.equal(readNpmPath(f.dataDir), f.npmPath);
});

test("preference write failure warns but does not block the selected npm retry", async (t) => {
  const f = fixture(t);
  const h = harness(f, { save: () => { throw new Error("read-only data directory"); } });
  assert.equal((await h.run()).dependencies.state, "installed");
  assert.equal(readNpmPath(f.dataDir), undefined);
  assert.equal(h.events.filter((e) => e.kind === "message").at(-1).config.title, catalogs.en.plugins.npmSaveFailedTitle);
});

test("dialogs use the current locale and tolerate a destroyed parent window", async (t) => {
  const f = fixture(t);
  const h = harness(f, { locale: "zh-CN", responses: [0], window: { isDestroyed: () => true } });
  await h.run();
  const message = h.events.find((e) => e.kind === "message").config;
  assert.equal(message.title, catalogs["zh-CN"].plugins.npmMissingTitle);
  assert.deepEqual(message.buttons, [catalogs["zh-CN"].common.cancel, catalogs["zh-CN"].plugins.npmChoose]);
});

test("missing, malformed and relative npm preferences fall back without accepting arbitrary commands", (t) => {
  const f = fixture(t);
  assert.equal(readNpmPath(f.dataDir), undefined);
  mkdirSync(f.dataDir);
  for (const value of ["broken JSON", "null", "[]", JSON.stringify({ npmPath: "npm --unsafe" })]) {
    writeFileSync(join(f.dataDir, "npm-path.json"), value);
    assert.equal(readNpmPath(f.dataDir), undefined);
  }
  assert.throws(() => writeNpmPath(f.dataDir, "npm --unsafe"), /absolute/);
  writeNpmPath(f.dataDir, f.npmPath);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, "npm-path.json"), "utf8")), { npmPath: f.npmPath });
  assert.deepEqual(readdirSync(f.dataDir), ["npm-path.json"]);
});
