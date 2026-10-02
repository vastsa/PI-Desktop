import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exportLinuxAsar,
  linuxUnpackedDirName,
} from "../../../scripts/export-linux-asar.mjs";

async function createFixture({ unpackedDir = "linux-unpacked" } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "pi-desktop-release-asar-"));
  const releaseDir = join(rootDir, "apps/desktop/release");
  await mkdir(join(releaseDir, `${unpackedDir}/resources`), { recursive: true });
  await writeFile(
    join(rootDir, "apps/desktop/package.json"),
    JSON.stringify({ version: "9.8.7" }),
  );
  const sourcePath = join(
    releaseDir,
    `${unpackedDir}/resources/app.asar`,
  );
  await writeFile(sourcePath, "fixture-asar-bytes");
  return { rootDir, releaseDir, sourcePath };
}

test("exports the exact Linux app.asar with the release asset name", async () => {
  const fixture = await createFixture();
  try {
    const result = await exportLinuxAsar({ rootDir: fixture.rootDir, arch: "x64" });
    const destination = join(
      fixture.releaseDir,
      "PI-Desktop-9.8.7-linux-x64.asar",
    );

    assert.equal(result.destination, destination);
    assert.equal(
      await readFile(destination, "utf8"),
      await readFile(fixture.sourcePath, "utf8"),
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test("arm64 exports the arm64 asset from electron-builder's arm64 unpacked tree", async () => {
  // electron-builder only drops the architecture suffix for x64, so reading
  // `linux-unpacked` on the arm64 lane would export nothing at all.
  assert.equal(linuxUnpackedDirName("x64"), "linux-unpacked");
  assert.equal(linuxUnpackedDirName("arm64"), "linux-arm64-unpacked");

  const fixture = await createFixture({ unpackedDir: "linux-arm64-unpacked" });
  try {
    const result = await exportLinuxAsar({
      rootDir: fixture.rootDir,
      arch: "arm64",
    });

    assert.equal(
      result.destination,
      join(fixture.releaseDir, "PI-Desktop-9.8.7-linux-arm64.asar"),
    );
    assert.equal(
      await readFile(result.destination, "utf8"),
      await readFile(fixture.sourcePath, "utf8"),
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test("refuses an architecture the release matrix does not publish", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      exportLinuxAsar({ rootDir: fixture.rootDir, arch: "riscv64" }),
      /Unsupported Linux release architecture: riscv64/,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test("fails when electron-builder did not produce the Linux app.asar", async () => {
  const fixture = await createFixture();
  try {
    await rm(fixture.sourcePath);
    await assert.rejects(
      exportLinuxAsar({ rootDir: fixture.rootDir, arch: "x64" }),
      /Linux ASAR source not found:/,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});
