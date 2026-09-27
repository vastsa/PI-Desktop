import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifyScript = new URL(
  "../../../scripts/verify-macos-release.sh",
  import.meta.url,
);
const stapleScript = new URL(
  "../../../scripts/staple-macos-release-dmg.sh",
  import.meta.url,
);

test("macOS release finalization staples the generated DMG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-staple-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  const log = join(root, "xcrun.log");
  const dmg = join(release, "PI-Desktop-0.14.2-arm64.dmg");
  await mkdir(release, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(dmg, "fixture");
  await writeFile(
    join(bin, "xcrun"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$STAPLE_LOG\"\n[[ \"$1 $2\" == 'stapler staple' ]]\n",
  );
  await chmod(join(bin, "xcrun"), 0o755);

  const result = spawnSync("bash", [stapleScript.pathname, release], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STAPLE_LOG: log },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    await readFile(log, "utf8"),
    `stapler staple ${dmg}\n`,
  );
});

test("macOS release verification requires a notarized Developer ID app and DMG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const app = join(release, "mac-arm64", "PI-Desktop.app");
  const bin = join(root, "bin");
  const staplerLog = join(root, "stapler.log");
  const dmg = join(release, "PI-Desktop-0.14.2-arm64.dmg");
  await mkdir(app, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(dmg, "fixture");
  await writeFile(
    join(bin, "codesign"),
    "#!/usr/bin/env bash\nif [[ \"$*\" == *\"-dv\"* ]]; then echo 'Authority=Developer ID Application: PI-Desktop (TEAM123)' >&2; fi\nexit 0\n",
  );
  await writeFile(
    join(bin, "spctl"),
    "#!/usr/bin/env bash\necho 'source=Notarized Developer ID' >&2\n",
  );
  await writeFile(
    join(bin, "xcrun"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$STAPLER_LOG\"\n[[ \"$1 $2\" == 'stapler validate' ]]\n",
  );
  await Promise.all(
    ["codesign", "spctl", "xcrun"].map((name) => chmod(join(bin, name), 0o755)),
  );

  const result = spawnSync("bash", [verifyScript.pathname, release], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STAPLER_LOG: staplerLog,
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Notarized Developer ID/);
  assert.match(result.stdout, /PI-Desktop-0\.14\.2-arm64\.dmg/);
  assert.equal(
    await readFile(staplerLog, "utf8"),
    `stapler validate ${app}\nstapler validate ${dmg}\n`,
  );
});

test("macOS release verification rejects a Developer ID app without notarization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-unnotarized-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const app = join(release, "mac-arm64", "PI-Desktop.app");
  const bin = join(root, "bin");
  await mkdir(app, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(release, "PI-Desktop-0.14.2-arm64.dmg"), "fixture");
  await writeFile(
    join(bin, "codesign"),
    "#!/usr/bin/env bash\nif [[ \"$*\" == *\"-dv\"* ]]; then echo 'Authority=Developer ID Application: PI-Desktop (TEAM123)' >&2; fi\n",
  );
  await writeFile(
    join(bin, "spctl"),
    "#!/usr/bin/env bash\necho 'source=Developer ID' >&2\n",
  );
  await writeFile(join(bin, "xcrun"), "#!/usr/bin/env bash\nexit 0\n");
  await Promise.all(
    ["codesign", "spctl", "xcrun"].map((name) => chmod(join(bin, name), 0o755)),
  );

  const result = spawnSync("bash", [verifyScript.pathname, release], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not recognize .* as notarized/);
});
