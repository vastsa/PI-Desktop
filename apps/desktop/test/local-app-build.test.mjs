import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildEnvironment, createBuildPlan, executeBuildPlan, localBuilderConfig,
  nativeTarget, parseBuildArgs, repositoryRoot, runCommand, windowsPnpmCommand,
} from "../../../scripts/build-platform-app.mjs";

const base = JSON.parse(await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8")).build;

test("native hosts match both the Rust triple and Electron architecture; cross-builds fail", () => {
  assert.deepEqual(nativeTarget("mac", "darwin", "arm64"), { arch: "arm64", triple: "aarch64-apple-darwin" });
  assert.deepEqual(nativeTarget("mac", "darwin", "x64"), { arch: "x64", triple: "x86_64-apple-darwin" });
  assert.deepEqual(nativeTarget("win", "win32", "x64"), { arch: "x64", triple: "x86_64-pc-windows-msvc" });
  for (const input of [["win", "darwin", "arm64"], ["mac", "win32", "x64"], ["win", "win32", "arm64"], ["mac", "linux", "x64"]]) {
    assert.throws(() => nativeTarget(...input), /native/);
  }
});

test("the default Windows plan builds before producing separately marked NSIS, ZIP and portable apps", () => {
  const options = parseBuildArgs(["win"]);
  const target = nativeTarget("win", "win32", "x64");
  const plan = createBuildPlan(options, target, "C:/work with spaces/project", false);
  assert.deepEqual(plan[0].args, ["install", "--frozen-lockfile"]);
  assert.ok(plan[1].args.includes("--locked"));
  assert.ok(plan[1].args.includes("x86_64-pc-windows-msvc"));
  assert.ok(plan[3].args.includes("bundle"));
  assert.ok(plan[4].args.includes("build"));
  const packages = plan.slice(5);
  assert.deepEqual(packages.map((step) => step.args.at(-1)), [
    "-c.extraMetadata.piDistribution=installed", "-c.extraMetadata.piDistribution=zip", "-c.extraMetadata.piDistribution=portable",
  ]);
  for (const step of packages) {
    assert.ok(step.args.includes("--x64"));
    assert.equal(step.args[step.args.indexOf("--publish") + 1], "never");
  }
});

test("optional Cargo mirror is process-local and keeps the dependency lock", () => {
  const options = parseBuildArgs(["mac", "--cargo-mirror"]);
  const plan = createBuildPlan(options, nativeTarget("mac", "darwin", "arm64"), "/work", true);
  assert.ok(plan[0].args.includes('--config'));
  assert.ok(plan[0].args.includes('source.pi-local-mirror.registry="sparse+https://rsproxy.cn/index/"'));
  assert.ok(plan[0].args.includes('--locked'));
});

test("macOS reuses dependencies and --dir never builds installers", () => {
  const options = parseBuildArgs(["mac", "--dir"]);
  const target = nativeTarget("mac", "darwin", "arm64");
  const plan = createBuildPlan(options, target, "/work tree", true);
  assert.equal(plan[0].command, "cargo");
  assert.equal(plan.length, 5);
  assert.ok(plan.at(-1).args.includes("--dir"));
  assert.ok(plan.at(-1).args.includes("--arm64"));
  assert.ok(!plan.at(-1).args.includes("dmg"));
  const reinstall = createBuildPlan({ ...options, install: true }, target, "/work", true);
  assert.deepEqual(reinstall[0].args, ["install", "--frozen-lockfile"]);
  const installers = createBuildPlan({ ...options, dir: false }, target, "/work", true);
  assert.ok(installers.at(-1).args.includes("dmg") && installers.at(-1).args.includes("zip"));
});

test("local builder configuration preserves resources, uses the freshly compiled host and never points at upstream updates", () => {
  const original = structuredClone(base);
  for (const [platform, host, arch] of [["mac", "darwin", "arm64"], ["mac", "darwin", "x64"], ["win", "win32", "x64"]]) {
    const target = nativeTarget(platform, host, arch);
    const config = localBuilderConfig(base, platform, target, repositoryRoot);
    assert.equal(config.publish, null);
    assert.equal(config.forceCodeSigning, false);
    assert.equal(config.appId, base.appId);
    assert.deepEqual(config.extraResources, base.extraResources);
    assert.equal(config.directories.output, join(repositoryRoot, "apps/desktop/release/local", `${platform}-${arch}`));
    const binary = config[platform].extraResources.find((entry) => entry.to.startsWith("bin/pi-desktop-host-core"));
    assert.equal(binary.from, join(repositoryRoot, "target", target.triple, "release", `pi-desktop-host-core${platform === "win" ? ".exe" : ""}`));
    if (platform === "mac") {
      assert.equal(config.mac.identity, "-");
      assert.equal(config.mac.notarize, false);
    }
  }
  assert.deepEqual(base, original, "the checked-in upstream config is not mutated");
});

test("local builds cannot inherit release credentials and environment mutation stays child-local", () => {
  const env = { Path: "/existing", CARGO_HOME: "/rust", CSC_LINK: "test", WIN_CSC_LINK: "test", APPLE_TEAM_ID: "test", KEEP: "value" };
  const child = buildEnvironment(env);
  assert.ok(child.Path.startsWith(join("/rust", "bin")));
  assert.equal(child.CSC_LINK, undefined);
  assert.equal(child.WIN_CSC_LINK, undefined);
  assert.equal(child.APPLE_TEAM_ID, undefined);
  assert.equal(child.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(child.KEEP, "value");
  assert.equal(env.CSC_LINK, "test");
});

test("a failed prerequisite build aborts before any installer command; config paths retain spaces", async () => {
  const plan = createBuildPlan(parseBuildArgs(["mac"]), nativeTarget("mac", "darwin", "arm64"), "/work tree", true);
  const calls = [];
  await assert.rejects(executeBuildPlan(plan, { env: {}, configPath: "/temp with spaces/config.json", run: async (command) => { calls.push(command); throw new Error("compile failed"); } }), /compile failed/);
  assert.deepEqual(calls, ["cargo"]);
  const successful = [];
  await executeBuildPlan(plan, { env: {}, configPath: "/temp with spaces/config.json", run: async (_command, args) => successful.push(args) });
  assert.ok(successful.at(-1).includes("/temp with spaces/config.json"));
});

test("Windows pnpm shims quote space-containing paths without executing shell expressions", () => {
  assert.equal(windowsPnpmCommand(["exec", "electron-builder", "--config", "C:\\work & files\\config.json"]), 'pnpm.cmd "exec" "electron-builder" "--config" "C:\\work & files\\config.json"');
  for (const input of ['" & exit', "%USERNAME%", "a\nb", "!variable!"]) {
    assert.throws(() => windowsPnpmCommand([input]), /Windows build arguments/);
  }
});

test("the CLI dry-run is cwd-independent and rejects unsupported flags before building", () => {
  const script = join(repositoryRoot, "scripts/build-platform-app.mjs");
  const dry = spawnSync(process.execPath, [script, "win", "--dry-run"], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  const result = JSON.parse(dry.stdout);
  assert.equal(result.validation, "not run");
  assert.equal(result.target.triple, "x86_64-pc-windows-msvc");
  assert.equal(result.steps[0].cwd, repositoryRoot);
  const bad = spawnSync(process.execPath, [script, "mac", "--publish=always"], { cwd: tmpdir(), encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown build option/);
  assert.throws(() => parseBuildArgs(["mac", "--check", "--dry-run"]));
});

test("command execution surfaces nonzero exits and missing tools", async () => {
  assert.equal(await runCommand(process.execPath, ["-e", 'process.stdout.write("ok")'], { capture: true }), "ok");
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(7)"], { capture: true }), /failed \(7\)/);
  await assert.rejects(runCommand("pi-build-nonexistent-tool", [], { capture: true }), /Cannot run/);
});
