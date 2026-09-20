import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * End-to-end structure test for the signed local macOS lane.
 *
 * The lane was broken by a rewrite that turned two electron-builder flags into
 * two commands but kept the line continuation, so the notarization script
 * became a positional argument of electron-builder while a second command kept
 * pointing at a deleted script. Nothing failed until a real signed run weeks
 * later. This drives the whole script against stub tooling in a temporary
 * repository root, so the command structure, the flag set, and the phase order
 * are pinned without a certificate, a network, or a real package build.
 */

const scripts = new URL("../../../scripts/", import.meta.url);
const LANE_SCRIPTS = [
  "release-macos.sh",
  "notarize-and-staple-macos-release-dmg.sh",
  "verify-macos-release.sh",
  "macos-signing-watchdog.mjs",
  "macos-codesign-shim.sh",
  "macos-bundle-inventory.mjs",
];
const SIGNING_IDENTITY = "Developer ID Application: XingYu Liu (DUV63RKYTW)";
const SUBMISSION_ID = "11111111-2222-3333-4444-555555555555";

async function writeStubs(bin, log, repoRoot) {
  await mkdir(bin, { recursive: true });
  const stubs = {
    cargo: `#!/usr/bin/env bash
printf 'cargo %s\\n' "$*" >> "${log}"
exit 0
`,
    // The lane's only job here is to call the toolchain in the documented
    // order; the packaging stub produces the artifacts the later steps expect.
    pnpm: `#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >> "${log}"
case "$*" in
  *electron-builder*)
    app="${repoRoot}/apps/desktop/release/mac-arm64/PI-Desktop.app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/bin"
    : > "$app/Contents/MacOS/PI-Desktop"
    : > "$app/Contents/Resources/bin/pi-desktop-host-core"
    : > "${repoRoot}/apps/desktop/release/PI-Desktop-0.0.0-arm64.dmg"
    ;;
esac
exit 0
`,
    codesign: `#!/usr/bin/env bash
printf 'codesign %s\\n' "$*" >> "${log}"
if [[ "$*" == *"-dv"* ]]; then
  echo "Authority=${SIGNING_IDENTITY}" >&2
  echo "flags=0x10000(runtime)" >&2
fi
exit 0
`,
    spctl: `#!/usr/bin/env bash
printf 'spctl %s\\n' "$*" >> "${log}"
echo "source=Notarized Developer ID" >&2
exit 0
`,
    xcrun: `#!/usr/bin/env bash
printf 'xcrun %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "notarytool submit")
    echo "  id: ${SUBMISSION_ID}"
    echo "  status: Accepted"
    ;;
esac
exit 0
`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
}

test(
  "the signed local macOS lane runs electron-builder with every documented flag",
  { skip: process.platform !== "darwin" ? "macOS-only lane" : false },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-lane-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const repoRoot = join(root, "repo");
    const bin = join(root, "bin");
    const log = join(root, "calls.log");
    await mkdir(join(repoRoot, "scripts"), { recursive: true });
    await mkdir(join(repoRoot, "apps/desktop"), { recursive: true });
    for (const name of LANE_SCRIPTS) {
      await cp(new URL(name, scripts), join(repoRoot, "scripts", name));
    }
    await chmod(join(repoRoot, "scripts", "release-macos.sh"), 0o755);
    await writeStubs(bin, log, repoRoot);

    const result = spawnSync("bash", [join(repoRoot, "scripts", "release-macos.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        APPLE_ID: "release@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "app-specific-password",
        APPLE_TEAM_ID: "DUV63RKYTW",
        STAPLE_DELAY_SECONDS: "1",
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = (await readFile(log, "utf8")).trim().split("\n");

    const builderCall = calls.find((line) => line.includes("electron-builder"));
    assert.ok(builderCall, "the lane invokes electron-builder");
    assert.match(builderCall, /--mac --(?:arm64|x64)/);
    assert.match(builderCall, /--publish never/);
    assert.match(builderCall, /-c\.mac\.identity=XingYu Liu \(DUV63RKYTW\)/);
    assert.match(builderCall, /-c\.mac\.forceCodeSigning=true/);
    assert.match(builderCall, /-c\.mac\.notarize=true/);
    assert.doesNotMatch(
      builderCall,
      /notarize-and-staple-macos-release-dmg\.sh/,
      "the DMG script must be a command, not an electron-builder argument",
    );

    // The lane must submit, staple, and verify exactly once, in that order.
    const indexOfCall = (pattern) => calls.findIndex((line) => pattern.test(line));
    const submitIndex = indexOfCall(/^xcrun notarytool submit /);
    const stapleIndex = indexOfCall(/^xcrun stapler staple /);
    const validateIndex = calls.findIndex((line) => /^xcrun stapler validate /.test(line));
    const verifyIndex = calls.findIndex((line) => /verify-macos-release\.sh|^codesign -dv/.test(line));
    assert.ok(submitIndex > -1 && stapleIndex > submitIndex, "the DMG is submitted before stapling");
    assert.ok(validateIndex > stapleIndex, "the stapled ticket is validated");
    assert.ok(verifyIndex > validateIndex, "verification happens after stapling");
    assert.equal(
      calls.filter((line) => /^xcrun notarytool submit /.test(line)).length,
      1,
      "one DMG submission",
    );

    // The packaging phase stays wrapped, and the watchdog reports its summary.
    assert.match(result.stdout, /\[sign\] summary label=release-macos-/);
    assert.match(result.stdout, /Analyzing the packaged app bundle/);
    assert.doesNotMatch(result.stdout, /STALL/);
  },
);
