import assert from "node:assert/strict";
import test from "node:test";
import { register, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { defaultDependencyRunner, validateNpmExecutable } = await import("../electron/main/npm-executable.ts");
const { installExtensionDependencies } = await import("../electron/main/npm-installer.ts");
const windows = process.platform === "win32";

const originalEnvironments = new WeakMap();
function setEnv(t, values) {
  let previous = originalEnvironments.get(t);
  if (!previous) {
    previous = new Map();
    originalEnvironments.set(t, previous);
    t.after(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  for (const [key, value] of Object.entries(values)) {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    process.env[key] = value;
  }
}

function fixture(t, body = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-npm-executable-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "node tools & %literal%");
  const plugin = join(root, "plugin");
  const emptyPath = join(root, "empty-path");
  const log = join(root, "calls.jsonl");
  for (const path of [bin, plugin, emptyPath]) mkdirSync(path);
  const node = join(bin, windows ? "node.exe" : "node");
  if (windows) copyFileSync(process.execPath, node);
  else symlinkSync(process.execPath, node);
  const npm = join(bin, windows ? "npm.cmd" : "npm");
  const cli = windows ? join(bin, "node_modules", "npm", "bin", "npm-cli.js") : npm;
  mkdirSync(dirname(cli), { recursive: true });
  if (windows) writeFileSync(npm, "@echo off\r\necho Unsafe shell shim executed >&2\r\nexit /b 99\r\n");
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env }) + '\\n');
${body}
if (args[0] === '--version') process.stdout.write('10.0.0\\n');
if (args[0] === 'install') fs.writeFileSync(path.join(process.cwd(), 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
`);
  chmodSync(cli, 0o755);
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ dependencies: { example: "^1" } }));
  setEnv(t, { PATH: emptyPath });
  return { root, bin, plugin, emptyPath, log, node, npm, cli };
}

function calls(f) {
  return readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("selected npm uses its directory PATH for both stages, without inheriting secrets or config", async (t) => {
  const f = fixture(t);
  const home = join(f.root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=private\n");
  setEnv(t, {
    HOME: home, NPM_TOKEN: "secret", NODE_AUTH_TOKEN: "secret", NODE_OPTIONS: "--bad-option",
    npm_config_userconfig: join(home, ".npmrc"), npm_config_registry: "https://private.invalid/",
    HTTPS_PROXY: "http://private.invalid", SSH_AUTH_SOCK: "private",
  });
  assert.deepEqual(await validateNpmExecutable(f.npm), { ok: true });
  assert.deepEqual(await installExtensionDependencies(f.plugin, { npmPath: f.npm }), { state: "installed" });
  const recorded = calls(f);
  assert.deepEqual(recorded.map((call) => call.args[0]), ["--version", "--version", "install", "ci"]);
  assert.equal(process.env.PATH, f.emptyPath);
  for (const call of recorded) {
    assert.equal(call.env.PATH, `${f.bin}${delimiter}${f.emptyPath}`);
    for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NODE_OPTIONS", "HTTPS_PROXY", "SSH_AUTH_SOCK"]) {
      assert.equal(call.env[key], undefined, key);
    }
    assert.notEqual(call.env.npm_config_userconfig, join(home, ".npmrc"));
    assert.equal(existsSync(call.env.npm_config_userconfig), false);
    assert.equal(existsSync(call.env.npm_config_globalconfig), false);
    assert.equal(call.env.npm_config_registry, "https://registry.npmjs.org/");
    assert.equal(call.env.npm_config_ignore_scripts, "true");
    if (call.args[0] === "--version") {
      assert.notEqual(call.cwd, f.plugin);
      assert.equal(existsSync(call.cwd), false, "validation directory is cleaned");
      assert.equal(call.env.npm_config_proxy, "");
    } else {
      assert.equal(call.cwd, f.plugin);
      assert.ok(call.args.includes("--ignore-scripts"));
      assert.match(call.env.npm_config_proxy, /^http:\/\/127\.0\.0\.1:/);
      assert.equal(call.env.npm_config_https_proxy, call.env.npm_config_proxy);
      assert.equal(call.env.npm_config_noproxy, "");
    }
  }
});

test("symlinked npm keeps the selected bin directory, not the real npm-cli directory", { skip: windows }, async (t) => {
  const f = fixture(t);
  const target = join(f.root, "npm-cli.js");
  copyFileSync(f.npm, target);
  chmodSync(target, 0o755);
  rmSync(f.npm);
  symlinkSync(target, f.npm);
  assert.deepEqual(await installExtensionDependencies(f.plugin, { npmPath: f.npm }), { state: "installed" });
  assert.deepEqual(calls(f).map((call) => call.args[0]), ["--version", "install", "ci"]);
  for (const call of calls(f)) assert.equal(call.env.PATH.split(delimiter)[0], f.bin);
});

test("invalid selections and missing Node are unavailable; no-dependency skips remain unchanged", async (t) => {
  const f = fixture(t);
  for (const npmPath of ["npm", "", f.bin, join(f.bin, "missing")]) {
    const validation = await validateNpmExecutable(npmPath);
    assert.equal(validation.ok, false);
    assert.equal(typeof validation.error, "string");
    const result = await installExtensionDependencies(f.plugin, { npmPath });
    assert.equal(result.reason, "npm-unavailable");
  }
  if (!windows) {
    chmodSync(f.npm, 0o644);
    assert.equal((await validateNpmExecutable(f.npm)).ok, false);
    chmodSync(f.npm, 0o755);
  }
  rmSync(f.node);
  assert.equal((await validateNpmExecutable(f.npm)).ok, false);
  assert.equal((await installExtensionDependencies(f.plugin, { npmPath: f.npm })).reason, "npm-unavailable");
  assert.equal(existsSync(f.log), false, "npm never runs without Node");
  writeFileSync(join(f.plugin, "package.json"), "{}");
  assert.deepEqual(await installExtensionDependencies(f.plugin, { npmPath: "bad" }), { state: "skipped", reason: "no-dependencies" });
  rmSync(join(f.plugin, "package.json"));
  assert.deepEqual(await installExtensionDependencies(f.plugin, { npmPath: "bad" }), { state: "skipped", reason: "no-package-json" });
});

test("missing default npm and missing default Node produce structured unavailable failures", async (t) => {
  const f = fixture(t);
  // Node is available, but npm is not: no real npm or network can be reached.
  if (windows) copyFileSync(f.node, join(f.emptyPath, "node.exe"));
  else symlinkSync(process.execPath, join(f.emptyPath, "node"));
  const missingNpm = await installExtensionDependencies(f.plugin);
  assert.equal(missingNpm.state, "failed");
  assert.equal(missingNpm.reason, "npm-unavailable");
  rmSync(join(f.emptyPath, windows ? "node.exe" : "node"));
  const missingNode = await installExtensionDependencies(f.plugin);
  assert.equal(missingNode.reason, "npm-unavailable");
});

test("npm --version nonzero and timeout reject the selected tool", { timeout: 15_000 }, async (t) => {
  const bad = fixture(t, "process.stderr.write('broken tool'); process.exit(2);");
  const failed = await validateNpmExecutable(bad.npm);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /broken tool/);
  const slow = fixture(t, "setInterval(() => {}, 60_000);");
  const started = Date.now();
  const result = await validateNpmExecutable(slow.npm);
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeded .*ms/);
  assert.ok(Date.now() - started < 12_000);
  assert.equal(existsSync(calls(slow)[0].cwd), false);
});

test("registry/network/nonzero install failures never masquerade as unavailable tools", async (t) => {
  for (const stage of ["install", "ci"]) {
    const f = fixture(t, `if (args[0] === '${stage}') {
      fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(process.cwd(), '.npm-cache'), { recursive: true });
      process.stderr.write('npm ERR! ENOTFOUND node missing package; registry unavailable');
      process.exit(127);
    }`);
    const result = await installExtensionDependencies(f.plugin, { npmPath: f.npm });
    assert.equal(result.state, "failed");
    assert.equal(result.reason, undefined);
    assert.match(result.error, /ENOTFOUND/);
    assert.equal(existsSync(join(f.plugin, "node_modules")), false);
    assert.equal(existsSync(join(f.plugin, ".npm-cache")), false);
    assert.equal(existsSync(join(f.plugin, "package-lock.json")), false);
  }
});

test("selected executable still cannot install an unsafe resolved lockfile", async (t) => {
  const f = fixture(t, `if (args[0] === 'install') {
    fs.writeFileSync(path.join(process.cwd(), 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/evil': { resolved: 'https://evil.invalid/evil.tgz' } } }));
    process.exit(0);
  }`);
  const result = await installExtensionDependencies(f.plugin, { npmPath: f.npm });
  assert.equal(result.state, "failed");
  assert.equal(result.reason, undefined);
  assert.match(result.error, /non-registry/);
  assert.deepEqual(calls(f).map((call) => call.args[0]), ["--version", "install"]);
});

test("Windows selected .cmd uses adjacent node + npm-cli with shell disabled even for metacharacters", async (t) => {
  const f = fixture(t);
  const npm = join(f.bin, "npm.cmd");
  const node = join(f.bin, "node.exe");
  const cli = join(f.bin, "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(npm, "not executed");
  if (!windows) writeFileSync(node, "mock node");
  writeFileSync(cli, "mock cli");
  const recorded = [];
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const spawn = t.mock.method(childProcess, "spawn", (command, args, options) => {
    recorded.push({ command, args, options });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(args.length === 1 ? "v24.0.0\n" : "10.0.0\n"));
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    assert.deepEqual(await installExtensionDependencies(f.plugin, { npmPath: npm }), { state: "installed" });
    assert.equal(recorded.length, 4);
    assert.deepEqual(recorded[0].args, ["--version"]);
    assert.deepEqual(recorded.slice(1).map((call) => call.args[1]), ["--version", "install", "ci"]);
    for (const call of recorded) {
      assert.equal(call.command, node);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.env.PATH, `${f.bin}${delimiter}${f.emptyPath}`);
    }
    for (const call of recorded.slice(1)) assert.equal(call.args[0], cli);
    rmSync(cli);
    assert.equal((await validateNpmExecutable(npm)).ok, false, "nonstandard shims are rejected, not shell-executed");
  } finally {
    Object.defineProperty(process, "platform", platform);
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

test("version validation rejects empty, unrelated, Node and oversized output without disclosing stdout", async (t) => {
  for (const output of ["", "private-output", "v24.0.0\n", "private-output\n10.0.0\n", "x".repeat(40_000) + "\n10.0.0\n"]) {
    const f = fixture(t, `if (args[0] === '--version') process.stdout.write(${JSON.stringify(output)}); return;`);
    const result = await validateNpmExecutable(f.npm);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not return a valid npm version/);
    assert.doesNotMatch(result.error, /private-output|xxxx/);
    assert.equal((await installExtensionDependencies(f.plugin, { npmPath: f.npm })).reason, "npm-unavailable");
    assert.ok(calls(f).every((call) => call.args[0] === "--version"));
  }
  const node = await validateNpmExecutable(process.execPath);
  assert.equal(node.ok, false);
  assert.match(node.error, /did not return a valid npm version/);
  const flooded = await defaultDependencyRunner(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(40000))"], tmpdir(), 5_000);
  assert.equal(flooded.code, 0);
  assert.equal(flooded.stdout, "", "oversized stdout is discarded, never a valid-looking tail");
});

test("Node validation requires the leading v", { skip: windows }, async (t) => {
  const f = fixture(t);
  rmSync(f.node);
  writeFileSync(f.node, "#!/bin/sh\nprintf '24.0.0\\n'\n", { mode: 0o755 });
  const result = await validateNpmExecutable(f.npm);
  assert.equal(result.ok, false);
  assert.match(result.error, /did not return a valid Node.js version/);
  assert.equal(existsSync(f.log), false);
});

test("short install budgets cap validation and include its time in both install stages", async (t) => {
  const slow = fixture(t, "if (args[0] === '--version') setInterval(() => {}, 60_000);");
  const started = Date.now();
  const result = await installExtensionDependencies(slow.plugin, { npmPath: slow.npm, timeoutMs: 150 });
  assert.equal(result.reason, "npm-unavailable");
  assert.ok(Date.now() - started < 2_000, "validation does not consume its default five seconds");
  const f = fixture(t, "if (args[0] === '--version') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);");
  const budgets = [];
  // Validation spawns two real processes, so these short budgets only prove the
  // containment property on an idle machine. Five seconds still leaves the
  // budget far below the installer's default.
  const installed = await installExtensionDependencies(f.plugin, {
    npmPath: f.npm, timeoutMs: 5_000,
    runner: async (_command, _args, _cwd, timeoutMs) => {
      budgets.push(timeoutMs);
      return { code: 0, stderr: "" };
    },
  });
  assert.deepEqual(installed, { state: "installed" });
  assert.equal(budgets.length, 2);
  assert.ok(budgets.every((budget) => budget <= 4_700 && budget > 0));
  const stalled = fixture(t, "if (args[0] === 'install') setInterval(() => {}, 60_000);");
  const timedOut = await installExtensionDependencies(stalled.plugin, { npmPath: stalled.npm, timeoutMs: 5_000 });
  assert.equal(timedOut.state, "failed");
  assert.equal(timedOut.reason, undefined, "install timeout is not an unavailable tool");
  assert.match(timedOut.error, /exceeded/);
});

test("timeout kills resistant descendants after their group leader exits with ignored stdio", { skip: windows, timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  const pidFile = join(f.root, "descendant.pid");
  const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 60000);`;
  const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 60000);`;
  let pid;
  const alive = () => {
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  try {
    const started = Date.now();
    const result = await defaultDependencyRunner(process.execPath, ["-e", leader], f.root, 1_500);
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - started < 3_000, "no five-second escalation delay after leader exits");
    pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    // SIGKILL is sent before resolution; allow the OS to finish reaping.
    for (let attempt = 0; attempt < 100 && alive(); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(), false, "the orphaned same-group descendant is gone");
  } finally {
    if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, "utf8"));
    if (pid && alive()) process.kill(pid, "SIGKILL");
  }
});
