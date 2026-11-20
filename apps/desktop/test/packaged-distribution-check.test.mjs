import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../../scripts/check-packaged-distribution.mjs");

// The same resolution the script uses: the asar library electron-builder ships.
function loadAsar() {
  const fromDesktop = createRequire(join(here, "../package.json"));
  const fromBuilder = createRequire(fromDesktop.resolve("electron-builder/package.json"));
  const fromLib = createRequire(fromBuilder.resolve("app-builder-lib/package.json"));
  return fromLib("@electron/asar");
}

async function packageWith(metadata) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-packaged-distribution-"));
  const source = join(root, "app");
  await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify(metadata));
  const archive = join(root, "app.asar");
  await loadAsar().createPackage(source, archive);
  return { root, archive };
}

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("the packaged marker check passes only when the archive carries the expected marker", async () => {
  const { root, archive } = await packageWith({ name: "app", piDistribution: "unsigned" });
  try {
    const match = run(archive, "unsigned");
    assert.equal(match.status, 0, match.stderr);
    assert.match(match.stdout, /piDistribution is "unsigned"/);

    const mismatch = run(archive, "installed");
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /expected piDistribution "installed" but the package carries "unsigned"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the packaged marker check fails when the marker never reached the package", async () => {
  // What a dropped electron-builder flag produces: the static default.
  const { root, archive } = await packageWith({ name: "app", piDistribution: "installed" });
  try {
    const result = run(archive, "unsigned");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected piDistribution "unsigned" but the package carries "installed"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the packaged marker check fails closed on a missing archive or missing arguments", async () => {
  const missing = run(join(tmpdir(), "pi-desktop-no-such-archive.asar"), "unsigned");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read package\.json from/);

  const usage = run();
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: check-packaged-distribution\.mjs <app\.asar> <expected>/);
});
