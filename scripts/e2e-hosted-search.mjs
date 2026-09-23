#!/usr/bin/env node
// Offline artifact-level regression. Default invocation rebuilds the production
// sidecar; --bundle runs an explicitly supplied artifact (e.g. a saved red baseline).
// No Electron, host-core, database, user config, live credentials, or source mocks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isolatedEnv } from "./e2e/hosted-search-sidecar.mjs";
import { runScenarios } from "./e2e/hosted-search-scenarios.mjs";

const { values } = parseArgs({ options: {
  bundle: { type: "string" }, "timeout-ms": { type: "string", default: "15000" },
  help: { type: "boolean", short: "h" },
} });
if (values.help) {
  console.log(`Usage: node scripts/e2e-hosted-search.mjs [--bundle PATH] [--timeout-ms 15000]
Default: pnpm --filter @pi-desktop/shared build, then @pi-desktop/agent-runtime bundle.
--bundle: skip rebuilding and run that explicit artifact, retaining its SHA-256.
Evidence and isolated homes stay under PI_SCRATCH_DIR or mkdtemp(os.tmpdir()).
Seven cases: next prompt, Read, instruction change, real Task/TaskWait, persisted restore, two invalid-history cases.
Files are retained for inspection; no automatic deletion and no dependency installation.
Reviewed source, patches, and lock metadata are fingerprinted before the build and again
when the run ends; any change between the two fails the run.`);
} else {
  const root = resolve(import.meta.dirname, "..");
  const timeoutMs = Number(values["timeout-ms"]);
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000, "timeout must be 1000..120000 ms");
  // Scratch allocation is the one step that has nowhere to record a failure: if
  // it throws there is no evidence directory, so the uncaught error on stderr is
  // the intended signal. There is deliberately no fallback location.
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "hosted-search-e2e-"));
  console.log(`Evidence: ${dir}`);
  const evidence = { startedAt: new Date().toISOString() };
  // Declared before the guard so the `finally` below can still run them when an
  // early step (env isolation, dependency inspection, pnpm) fails.
  let git = () => "unavailable";
  let fingerprint = async () => null;
  try {
    const env = await isolatedEnv(join(dir, "build"));
    // Reuse the already resolved project pnpm, not a PATH version-manager shim
    // that might try to bootstrap another copy after HOME becomes isolated.
    env.npm_config_manage_package_manager_versions = "false";
    const pnpmEntry = process.env.npm_execpath;
    const pnpmCommand = pnpmEntry && /\.[cm]?js$/.test(pnpmEntry) ? process.execPath : pnpmEntry ?? "pnpm";
    const pnpmArgs = pnpmEntry && /\.[cm]?js$/.test(pnpmEntry) ? [pnpmEntry] : [];
    const runPnpm = (args) => execFileSync(pnpmCommand, [...pnpmArgs, ...args], {
      cwd: root, env, encoding: "utf8", timeout: 120000, maxBuffer: 8_000_000,
    });
    git = (...args) => {
      try {
        return execFileSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 20000, maxBuffer: 32_000_000 }).trim();
      } catch { return "unavailable"; }
    };
    const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
    // Reviewed source, patch, and lock metadata only: dependency trees and
    // generated bundles are build outputs, so hashing them would fingerprint the
    // build instead of the artifact under review.
    const sourceScope = ["packages/agent-runtime", "packages/shared", "patches", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "scripts/e2e-hosted-search.mjs", "scripts/e2e/hosted-search-provider.mjs", "scripts/e2e/hosted-search-sidecar.mjs", "scripts/e2e/hosted-search-scenarios.mjs"];
    const generated = /(^|\/)(node_modules|dist|dist-bundle|coverage|\.turbo)(\/|$)|\.tsbuildinfo$/;
    const listGit = (args) => {
      try {
        return execFileSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 20000, maxBuffer: 32_000_000 })
          .split("\0").map((entry) => entry.trim()).filter(Boolean);
      } catch { return null; }
    };
    // One digest over tracked files plus untracked deliverables in scope: the
    // `git status --short` string alone cannot reveal an edit that leaves the
    // dirty set identical.
    fingerprint = async () => {
      const tracked = listGit(["ls-files", "-z", "--", ...sourceScope]);
      const untracked = listGit(["ls-files", "-z", "--others", "--exclude-standard", "--", ...sourceScope]);
      if (!tracked || !untracked) return null;
      const files = [...new Set([...tracked, ...untracked])].filter((path) => !generated.test(path)).sort();
      const digests = [];
      for (const path of files) {
        digests.push(`${path} ${await hash(join(root, path))}`);
      }
      return { files: files.length, sha256: createHash("sha256").update(digests.join("\n")).digest("hex") };
    };
    evidence.nodeVersion = process.version;
    evidence.pnpmVersion = values.bundle ? "not invoked (supplied artifact)" : runPnpm(["--version"]).trim();
    evidence.installedDependencies = {};
    for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent"]) {
      const manifest = JSON.parse(await readFile(join(root, "packages/agent-runtime/node_modules/@earendil-works", name, "package.json"), "utf8"));
      evidence.installedDependencies[name] = manifest.version;
      assert.equal(manifest.version, "0.87.1", `${name} must match the locked pi version`);
    }
    evidence.lockfileSha256 = await hash(join(root, "pnpm-lock.yaml"));
    evidence.head = git("rev-parse", "HEAD");
    evidence.statusBefore = git("status", "--short");
    evidence.build = values.bundle ? "explicit supplied artifact; not rebuilt by this invocation" : "production package build + bundle";
    evidence.sourceFingerprintBefore = await fingerprint();
    assert.ok(evidence.head !== "unavailable" && evidence.sourceFingerprintBefore, "build source identity is unavailable");
    if (!values.bundle) {
      for (const [pkg, script] of [["@pi-desktop/shared", "build"], ["@pi-desktop/agent-runtime", "bundle"]]) {
        const args = ["--filter", pkg, script];
        console.log(`Build: pnpm ${args.join(" ")}`);
        const output = runPnpm(args);
        await writeFile(join(dir, `${script}.log`), output);
      }
    }
    const source = resolve(root, values.bundle ?? "packages/agent-runtime/dist-bundle/sidecar.js");
    const bundle = join(dir, "sidecar.mjs");
    evidence.bundleSource = source;
    evidence.sha256 = await hash(source);
    // Snapshot the complete artifact so another agent's bundle rebuild cannot
    // silently replace code halfway through the child-process scenarios.
    await copyFile(source, bundle);
    assert.equal(await hash(bundle), evidence.sha256, "bundle changed during snapshot; rebuild and retry");
    console.log(`Bundle SHA-256: ${evidence.sha256}`);
    evidence.results = await runScenarios(bundle, dir, timeoutMs, (result) => {
      console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name} (${result.requests} provider requests)`);
      if (!result.passed) console.error(result.error);
    });
    assert.equal(await hash(bundle), evidence.sha256, "executed snapshot was modified");
    // The snapshot protects execution; qualification also requires its source
    // artifact to remain stable for a reproducible build-to-test attribution.
    evidence.bundleSourceSha256After = await hash(source);
    evidence.bundleSourceRewrittenDuringRun = evidence.bundleSourceSha256After !== evidence.sha256;
    assert.equal(evidence.bundleSourceRewrittenDuringRun, false, "bundle source changed during qualification");
    evidence.passed = evidence.results.every((result) => result.passed);
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    evidence.passed = false;
    evidence.error = error.stack ?? String(error);
    console.error(evidence.error);
    process.exitCode = 1;
  } finally {
    // The evidence directory exists by now, so no failure may escape before
    // result.json is written.
    try {
      evidence.sourceFingerprintAfter = await fingerprint();
    } catch (error) {
      evidence.sourceFingerprintError = error.stack ?? String(error);
    }
    const before = evidence.sourceFingerprintBefore;
    const after = evidence.sourceFingerprintAfter;
    evidence.sourceChangedDuringRun = Boolean(before && after && before.sha256 !== after.sha256);
    if (!before || !after || evidence.sourceChangedDuringRun) {
      evidence.qualificationFailure = !before || !after
        ? "reviewed source identity could not be verified"
        : "reviewed source, lockfile, or patch artifacts changed during the run";
      evidence.passed = false;
      process.exitCode = 1;
    }
    evidence.statusAfter = git("status", "--short");
    evidence.finishedAt = new Date().toISOString();
    try {
      await writeFile(join(dir, "result.json"), JSON.stringify(evidence, null, 2));
    } catch (error) {
      console.error(`failed to write result.json: ${error.message}`);
      evidence.passed = false;
      process.exitCode = 1;
    }
    console.log(`Result: ${evidence.passed ? "PASS" : "FAIL"}; ${join(dir, "result.json")}`);
  }
}
