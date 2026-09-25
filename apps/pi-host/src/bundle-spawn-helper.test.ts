import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureUnixSpawnHelperExecutable } from "../scripts/spawn-helper-permissions.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-bundle-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("release bundle node-pty helper", () => {
  it("marks the selected Unix spawn helper executable", () => {
    const nodePtyDir = join(tempDir(), "node-pty");
    const helper = join(nodePtyDir, "prebuilds", "darwin-arm64", "spawn-helper");
    const otherHelper = join(nodePtyDir, "prebuilds", "linux-x64", "spawn-helper");
    mkdirSync(join(nodePtyDir, "prebuilds", "darwin-arm64"), { recursive: true });
    mkdirSync(join(nodePtyDir, "prebuilds", "linux-x64"), { recursive: true });
    writeFileSync(helper, "fixture");
    writeFileSync(otherHelper, "fixture");
    chmodSync(helper, 0o644);
    chmodSync(otherHelper, 0o600);

    expect(ensureUnixSpawnHelperExecutable(nodePtyDir, "darwin", "arm64")).toBe(helper);
    expect(statSync(helper).mode & 0o111).toBe(0o111);
    expect(statSync(otherHelper).mode & 0o111).toBe(0);
  });

  it("fails a Unix bundle when its PTY helper is missing", () => {
    expect(() => ensureUnixSpawnHelperExecutable(tempDir(), "linux", "x64")).toThrow(
      "node-pty spawn-helper is missing for linux-x64",
    );
  });

  it("does not require a Unix helper for Windows", () => {
    expect(ensureUnixSpawnHelperExecutable(tempDir(), "win32", "x64")).toBeNull();
  });
});
