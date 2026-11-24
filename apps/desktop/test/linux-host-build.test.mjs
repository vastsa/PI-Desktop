import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("a Linux build with no new host-core artifact fails even if an old binary exists", {
  skip: process.platform === "win32",
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-linux-host-test-"));
  try {
    for (const subdir of ["scripts", "bin", "target/release"]) {
      mkdirSync(path.join(dir, subdir), { recursive: true });
    }
    const script = path.join(dir, "scripts/build-linux-host-core.mjs");
    copyFileSync(new URL("../../../scripts/build-linux-host-core.mjs", import.meta.url), script);
    writeFileSync(path.join(dir, "target/release/pi-desktop-host-core"), "old host");
    writeFileSync(path.join(dir, "scripts/check-linux-host-glibc.mjs"), "");
    writeFileSync(path.join(dir, "bin/docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: path.join(dir, "bin") },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /did not produce pi-desktop-host-core/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
