import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { patchHashesIn } from "./pi-patch-hash.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const patchDependencyCheck = join(here, "check-pi-dependencies.mjs");
const patchCheck = join(here, "check-pi-patches.mjs");

const TARGET = "1.1.0";
const PATCHED = [
  {
    name: "@earendil-works/pi-agent-core",
    markers: ["hosted_search_update", "localRequestErrorDetails"],
    extra: "",
  },
  {
    name: "@earendil-works/pi-ai",
    markers: ["hostedSearch", "withLocalRequestErrors", "AnthropicOAuthTokenError", "Retry-After"],
    extra: [
      '+{"openai-completions":{"chat:deepseek-flash":{"baseUrl":"https://api.deepseek.com","compat":{"supportsMidConvoSystemMessages":true}}}}',
      "diff --git a/dist/index.d.ts b/dist/index.d.ts",
      "diff --git a/dist/types.d.ts b/dist/types.d.ts",
      "diff --git a/dist/utils/assistant-message-frame.d.ts b/dist/utils/assistant-message-frame.d.ts",
      "diff --git a/dist/utils/estimate.d.ts b/dist/utils/estimate.d.ts",
      "diff --git a/dist/utils/hosted-search.d.ts b/dist/utils/hosted-search.d.ts",
      "diff --git a/dist/utils/local-request-error.d.ts b/dist/utils/local-request-error.d.ts",
      "diff --git a/dist/utils/local-request-stream.d.ts b/dist/utils/local-request-stream.d.ts",
    ].join("\n"),
  },
  {
    name: "@earendil-works/pi-coding-agent",
    markers: ["hostedSearchReplayProjection", "estimateProjectedContextTokens"],
    extra: "+export declare function estimateProjectedContextTokens(",
  },
];
const RELEASE_AGE_EXCLUDE = [
  "chord",
  "pi-agent-core",
  "pi-ai",
  "pi-codemode",
  "pi-coding-agent",
  "pi-mcp",
  "pi-telemetry",
  "pi-tui",
].map((name) => `@earendil-works/${name}@${TARGET}`);
const HASH = `${"0".repeat(63)}1`;

function patchPath(name) {
  return `patches/${name.replace("@earendil-works/", "@earendil-works__")}@${TARGET}.patch`;
}

/**
 * A `.pnpm` entry name as pnpm writes it once it has to shorten the virtual
 * store directory on a long path: the `patch_hash=` segment is gone even
 * though the install really is patched. Both checks used to read the hash out
 * of the resolved symlink, so they called this install unpatched.
 */
function storeEntryDir(name, hash, shorten) {
  const bare = name.replace("@earendil-works/", "");
  return shorten
    ? `node_modules/.pnpm/${bare}@${TARGET}_${hash.slice(0, 12)}`
    : `node_modules/.pnpm/${bare}@${TARGET}_patch_hash=${hash}`;
}

function run(script, root) {
  try {
    const stdout = execFileSync("node", [script, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

function write(root, path, contents) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function snapshotSection(root, names, hash) {
  return `lockfileVersion: '9.0'\n\nsnapshots:\n${
    names.map((name) => `  '${name}@${TARGET}(patch_hash=${hash})': {}`).join("\n")
  }\n`;
}

/**
 * Build a workspace that satisfies both checks: correct pins, every patch
 * mapped and locked, and the Pi packages installed as patched instances.
 */
function workspace({
  shorten = true,
  storeNames = PATCHED.map((entry) => entry.name),
  storeHash = HASH,
  lockHash = HASH,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-patches-"));

  write(
    dir,
    "packages/agent-runtime/package.json",
    JSON.stringify({
      dependencies: Object.fromEntries([...PATCHED.map((e) => e.name), "@earendil-works/pi-mcp"].map((n) => [n, TARGET])),
    }),
  );
  write(
    dir,
    "apps/desktop/package.json",
    JSON.stringify({
      devDependencies: { "@earendil-works/pi-ai": TARGET, "@earendil-works/pi-mcp": TARGET },
    }),
  );
  write(dir, "pnpm-lock.yaml", snapshotSection(dir, PATCHED.map((entry) => entry.name), lockHash));
  write(dir, "node_modules/.pnpm/lock.yaml", snapshotSection(dir, storeNames, storeHash));

  for (const entry of PATCHED) {
    write(dir, patchPath(entry.name), [entry.markers.join("\n"), entry.extra].filter(Boolean).join("\n"));
  }
  // pnpm-workspace.yaml maps each patch, which is what check-pi-patches reads.
  const workspaceYaml = PATCHED.map(
    (entry) => `'${entry.name}@${TARGET}': ${patchPath(entry.name)}`,
  ).join("\n");
  write(
    dir,
    "pnpm-workspace.yaml",
    `${workspaceYaml}\nminimumReleaseAgeExclude:\n${RELEASE_AGE_EXCLUDE.map((name) => `  - '${name}'`).join("\n")}\n`,
  );

  const link = (from, to) => {
    mkdirSync(dirname(from), { recursive: true });
    symlinkSync(relative(dirname(from), to), from, "dir");
  };
  for (const name of PATCHED.map((entry) => entry.name)) {
    const entryDir = join(dir, storeEntryDir(name, storeHash, shorten), "node_modules", name);
    write(dir, relative(dir, join(entryDir, "package.json")), JSON.stringify({ name, version: TARGET }));
    link(join(dir, "packages/agent-runtime/node_modules", name), entryDir);
  }
  for (const [scope, name] of [
    ["apps/desktop", "@earendil-works/pi-ai"],
    ["apps/desktop", "@earendil-works/pi-mcp"],
  ]) {
    write(dir, `${scope}/node_modules/${name}/package.json`, JSON.stringify({ name, version: TARGET }));
  }
  return dir;
}

test("patchHashesIn reads scoped and unscoped snapshot keys, and ignores other versions", () => {
  const lock = [
    "  '@scope/pkg@2.0.0(patch_hash=abc123)': {}",
    "  bare@2.0.0(patch_hash=def456)': {}",
    "  '@scope/pkg@1.0.0(patch_hash=aaa111)(peer@1)': {}",
    "  '@scope/pkg@1.0.0(patch_hash=aaa111)(peer@2)': {}",
    "  '@scope/other@1.0.0(patch_hash=bbb222)': {}",
  ].join("\n");
  assert.deepEqual(patchHashesIn(lock, "@scope/pkg", "1.0.0"), ["aaa111"]);
  assert.deepEqual(patchHashesIn(lock, "bare", "2.0.0"), ["def456"]);
  assert.deepEqual(patchHashesIn(lock, "@scope/pkg", "9.9.9"), []);
});

test("patchHashesIn treats the version literally", () => {
  assert.deepEqual(patchHashesIn("  'pkg@1x0.0(patch_hash=aaa111)': {}", "pkg", "1.0.0"), []);
});

test("check-pi-dependencies accepts a shortened virtual store entry name", () => {
  const dir = workspace({ shorten: true });
  try {
    const result = run(patchDependencyCheck, dir);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pi-patches accepts a shortened virtual store entry name", () => {
  const dir = workspace({ shorten: true });
  try {
    const result = run(patchCheck, dir);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pi-dependencies still rejects an install with no patched snapshot", () => {
  const dir = workspace({ storeNames: [] });
  try {
    const result = run(patchDependencyCheck, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not resolve to pnpm's patched package instance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pi-patches rejects an installed patch hash that pnpm-lock.yaml does not record", () => {
  const dir = workspace({ storeHash: HASH, lockHash: "f".repeat(64) });
  try {
    const result = run(patchCheck, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /absent from pnpm-lock\.yaml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pi-patches rejects a package that is not installed as a patched instance", () => {
  const dir = workspace({ storeNames: [] });
  try {
    const result = run(patchCheck, dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is not installed as a patched instance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});