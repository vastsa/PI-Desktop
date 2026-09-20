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
const notarizeScript = new URL(
  "../../../scripts/notarize-and-staple-macos-release-dmg.sh",
  import.meta.url,
);

const SIGNING_IDENTITY = "Developer ID Application: XingYu Liu (DUV63RKYTW)";
const SIGNING_IDENTITY_NAME = "XingYu Liu (DUV63RKYTW)";
const SUBMISSION_ID = "11111111-2222-3333-4444-555555555555";
const NOTARY_ENV = {
  APPLE_ID: "release@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "app-specific-password",
  APPLE_TEAM_ID: "DUV63RKYTW",
};

async function writeSignedAppFixture(release) {
  const app = join(release, "mac-arm64", "PI-Desktop.app");
  const hostCore = join(app, "Contents", "Resources", "bin", "pi-desktop-host-core");
  const dmg = join(release, "PI-Desktop-0.14.2-arm64.dmg");
  await mkdir(join(app, "Contents", "Resources", "bin"), { recursive: true });
  await writeFile(hostCore, "fixture");
  await writeFile(dmg, "fixture");
  return { app, dmg };
}

async function writeDmgFixture(release) {
  const dmg = join(release, "PI-Desktop-0.15.1-beta.3-arm64.dmg");
  await mkdir(release, { recursive: true });
  await writeFile(dmg, "fixture");
  return dmg;
}

/**
 * Fake `xcrun` that records every notarytool/stapler call. `status` is the
 * notarytool result and `stapleFailures` makes the first N staple attempts fail
 * so the bounded retry is covered.
 */
async function writeXcrunNotaryFixture(
  bin,
  { status = "Accepted", submitExit = 0, stapleFailures = 0 } = {},
) {
  await mkdir(bin, { recursive: true });
  const xcrun = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NOTARY_LOG"
case "$1 $2" in
  "notarytool submit")
    echo "Conducting pre-submission checks for the artifact"
    echo "Submission ID received"
    echo "  id: ${SUBMISSION_ID}"
    echo "Waiting for processing to complete."
    echo "  id: ${SUBMISSION_ID}"
    echo "  status: ${status}"
    exit ${submitExit}
    ;;
  "notarytool log") exit 0 ;;
  "stapler staple")
    count_file="$NOTARY_LOG.staples"
    count=0
    if [[ -f "$count_file" ]]; then count="$(cat "$count_file")"; fi
    count=$((count + 1))
    echo "$count" > "$count_file"
    if (( count <= ${stapleFailures} )); then
      echo 'CloudKit query failed due to "Record not found"' >&2
      echo 'Could not find base64 encoded ticket' >&2
      exit 65
    fi
    exit 0
    ;;
esac
exit 0
`;
  await writeFile(join(bin, "xcrun"), xcrun);
  await chmod(join(bin, "xcrun"), 0o755);
}

function runNotarize(release, bin, log, extraEnv = {}) {
  return spawnSync("bash", [notarizeScript.pathname, release], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...NOTARY_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      NOTARY_LOG: log,
      STAPLE_DELAY_SECONDS: "1",
      ...extraEnv,
    },
  });
}

test("the DMG is submitted to Apple before it is stapled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-dmg-notary-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  const log = join(root, "xcrun.log");
  const dmg = await writeDmgFixture(release);
  await writeXcrunNotaryFixture(bin);

  const result = runNotarize(release, bin, log);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.match(calls[0], /^notarytool submit .*--wait$/);
  assert.ok(calls[0].includes(dmg), "the submitted artifact is the DMG");
  assert.ok(calls[0].includes("--apple-id release@example.com"));
  assert.equal(calls[1], `stapler staple ${dmg}`);
  assert.equal(calls[2], `stapler validate ${dmg}`);
  assert.match(result.stdout, /status.*Accepted/);
});

test("stapling retries only after Apple accepts the DMG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-dmg-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  const log = join(root, "xcrun.log");
  await writeDmgFixture(release);
  await writeXcrunNotaryFixture(bin, { stapleFailures: 2 });

  const result = runNotarize(release, bin, log);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = (await readFile(log, "utf8")).split("\n");
  assert.equal(
    calls.filter((line) => line.startsWith("stapler staple")).length,
    3,
    "two failures then a successful staple",
  );
});

test("a rejected DMG is never stapled and the Apple log is fetched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-dmg-rejected-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  const log = join(root, "xcrun.log");
  await writeDmgFixture(release);
  await writeXcrunNotaryFixture(bin, { status: "Invalid" });

  const result = runNotarize(release, bin, log);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Apple did not accept/);
  const calls = await readFile(log, "utf8");
  assert.doesNotMatch(calls, /stapler staple/);
  assert.match(calls, new RegExp(`notarytool log ${SUBMISSION_ID}`));
});

test("a failed submission fails the run and dumps the Apple log", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-dmg-submitfail-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  const log = join(root, "xcrun.log");
  await writeDmgFixture(release);
  await writeXcrunNotaryFixture(bin, { submitExit: 1 });

  const result = runNotarize(release, bin, log);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /notarytool submit failed/);
  const calls = await readFile(log, "utf8");
  assert.match(calls, new RegExp(`notarytool log ${SUBMISSION_ID}`));
  assert.doesNotMatch(calls, /stapler staple/);
});

test("the notarization step fails closed without team-scoped credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-dmg-nocreds-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  const log = join(root, "xcrun.log");
  await writeDmgFixture(release);
  await writeXcrunNotaryFixture(bin);

  const missing = { ...process.env, ...NOTARY_ENV, NOTARY_LOG: log };
  delete missing.APPLE_ID;
  delete missing.APPLE_APP_SPECIFIC_PASSWORD;
  const missingResult = spawnSync("bash", [notarizeScript.pathname, release], {
    encoding: "utf8",
    env: missing,
  });
  assert.equal(missingResult.status, 1);
  assert.match(
    missingResult.stderr,
    /APPLE_ID \/ APPLE_APP_SPECIFIC_PASSWORD \/ APPLE_TEAM_ID/,
  );

  const wrongTeam = runNotarize(release, bin, log, {
    APPLE_TEAM_ID: "WRONGTEAMID",
  });
  assert.equal(wrongTeam.status, 1);
  assert.match(wrongTeam.stderr, /APPLE_TEAM_ID must be DUV63RKYTW/);

  assert.equal(
    await readFile(log, "utf8").catch(() => ""),
    "",
    "no notarytool call may happen without valid credentials",
  );
});

test("macOS release verification requires a notarized Developer ID app and DMG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  const staplerLog = join(root, "stapler.log");
  const { app, dmg } = await writeSignedAppFixture(release);
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "codesign"),
    `#!/usr/bin/env bash\nif [[ "$*" == *"-dv"* ]]; then echo 'Authority=${SIGNING_IDENTITY}' >&2; echo 'flags=0x10000(runtime)' >&2; fi\nexit 0\n`,
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

  // The local lane passes the bare common name; the script must still match the
  // prefixed Authority line codesign prints.
  const result = spawnSync("bash", [verifyScript.pathname, release], {
    encoding: "utf8",
    env: {
      ...process.env,
      MAC_SIGNING_IDENTITY: SIGNING_IDENTITY_NAME,
      PATH: `${bin}:${process.env.PATH}`,
      STAPLER_LOG: staplerLog,
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Notarized Developer ID/);
  assert.match(result.stdout, /PI-Desktop-0\.14\.2-arm64\.dmg/);
  assert.match(result.stdout, /host-core sidecar/);
  assert.equal(
    await readFile(staplerLog, "utf8"),
    `stapler validate ${app}\nstapler validate ${dmg}\n`,
  );
});

test("macOS release verification rejects a Developer ID app without notarization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-unnotarized-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  await writeSignedAppFixture(release);
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "codesign"),
    `#!/usr/bin/env bash\nif [[ "$*" == *"-dv"* ]]; then echo 'Authority=${SIGNING_IDENTITY}' >&2; fi\n`,
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

test("macOS release verification accepts the prefixed identity form", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-prefixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  await writeSignedAppFixture(release);
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "codesign"),
    `#!/usr/bin/env bash\nif [[ "$*" == *"-dv"* ]]; then echo 'Authority=${SIGNING_IDENTITY}' >&2; echo 'flags=0x10000(runtime)' >&2; fi\n`,
  );
  await writeFile(
    join(bin, "spctl"),
    "#!/usr/bin/env bash\necho 'source=Notarized Developer ID' >&2\n",
  );
  await writeFile(join(bin, "xcrun"), "#!/usr/bin/env bash\nexit 0\n");
  await Promise.all(
    ["codesign", "spctl", "xcrun"].map((name) => chmod(join(bin, name), 0o755)),
  );

  const result = spawnSync("bash", [verifyScript.pathname, release], {
    encoding: "utf8",
    env: {
      ...process.env,
      MAC_SIGNING_IDENTITY: SIGNING_IDENTITY,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("macOS release verification rejects a different signing identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-macos-wrong-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, "release");
  const bin = join(root, "bin");
  await writeSignedAppFixture(release);
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "codesign"),
    "#!/usr/bin/env bash\nif [[ \"$*\" == *\"-dv\"* ]]; then echo 'Authority=Developer ID Application: Someone Else (ZZZZZZZZZZ)' >&2; fi\n",
  );
  await writeFile(
    join(bin, "spctl"),
    "#!/usr/bin/env bash\necho 'source=Notarized Developer ID' >&2\n",
  );
  await writeFile(join(bin, "xcrun"), "#!/usr/bin/env bash\nexit 0\n");
  await Promise.all(
    ["codesign", "spctl", "xcrun"].map((name) => chmod(join(bin, name), 0o755)),
  );

  const result = spawnSync("bash", [verifyScript.pathname, release], {
    encoding: "utf8",
    env: {
      ...process.env,
      MAC_SIGNING_IDENTITY: SIGNING_IDENTITY_NAME,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not signed with/);
});
