import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exportLinuxAsar } from "../../../scripts/export-linux-asar.mjs";

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "pi-desktop-release-asar-"));
  const releaseDir = join(rootDir, "apps/desktop/release");
  await mkdir(join(releaseDir, "linux-unpacked/resources"), { recursive: true });
  await writeFile(
    join(rootDir, "apps/desktop/package.json"),
    JSON.stringify({ version: "9.8.7" }),
  );
  const sourcePath = join(
    releaseDir,
    "linux-unpacked/resources/app.asar",
  );
  await writeFile(sourcePath, "fixture-asar-bytes");
  return { rootDir, releaseDir, sourcePath };
}

test("exports the exact Linux app.asar with the release asset name", async () => {
  const fixture = await createFixture();
  try {
    const result = await exportLinuxAsar({ rootDir: fixture.rootDir });
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

test("fails when electron-builder did not produce the Linux app.asar", async () => {
  const fixture = await createFixture();
  try {
    await rm(fixture.sourcePath);
    await assert.rejects(
      exportLinuxAsar({ rootDir: fixture.rootDir }),
      /Linux ASAR source not found:/,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});
