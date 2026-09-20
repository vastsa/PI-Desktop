import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Both scripts are plain bash / node CLI tools with no dependencies, so these
// tests drive them through a fake PATH and a temporary bundle fixture instead of
// importing repository code.

const diagnosticsScript = fileURLToPath(
  new URL("../../../scripts/macos-signing-diagnostics.sh", import.meta.url),
);
const inventoryScript = fileURLToPath(
  new URL("../../../scripts/macos-bundle-inventory.mjs", import.meta.url),
);

const SIGNING_IDENTITY_NAME = "XingYu Liu (DUV63RKYTW)";
const SIGNING_IDENTITY = `Developer ID Application: ${SIGNING_IDENTITY_NAME}`;
const NO_IDENTITIES = "  0 valid identities found";
const MATCHING_IDENTITY = `echo '  1) 0123456789ABCDEF "Developer ID Application: ${SIGNING_IDENTITY_NAME}"'
echo '     1 valid identities found'`;

const CSC_LINK_SENTINEL = "SENTINEL-CSC-LINK-1234";
const CSC_PASSWORD_SENTINEL = "SENTINEL-CSC-KEY-PASSWORD-5678";
const APPLE_PASSWORD_SENTINEL = "SENTINEL-APPLE-PASSWORD-9012";
const APPLE_ID_SENTINEL = "release-sentinel@example.com";

// The scripts must behave the same whether or not the surrounding environment
// carries signing secrets, so every test starts from a scrubbed copy.
const BASE_ENV = { ...process.env };
for (const name of [
  "MAC_SIGNING_IDENTITY",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]) {
  delete BASE_ENV[name];
}

async function writeShim(bin, name, body) {
  await mkdir(bin, { recursive: true });
  const file = join(bin, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body.trim()}\n`);
  await chmod(file, 0o755);
  return file;
}

/**
 * A complete fake macOS signing environment. `identities` is shell code printed
 * by `security find-identity`; `leaky` makes every shim echo the signing secrets
 * from the environment, which is how the redaction contract is tested.
 */
async function writeDiagnosticsShims(
  bin,
  {
    identities = NO_IDENTITIES,
    unameSystem = "Darwin",
    leaky = false,
  } = {},
) {
  const leak = leaky
    ? `echo "CSC_LINK=\${CSC_LINK:-}"
echo "CSC_KEY_PASSWORD=\${CSC_KEY_PASSWORD:-}"
echo "APPLE_ID=\${APPLE_ID:-}"
echo "APPLE_APP_SPECIFIC_PASSWORD=\${APPLE_APP_SPECIFIC_PASSWORD:-}"
echo "APPLE_TEAM_ID=\${APPLE_TEAM_ID:-}"`
    : "";

  await writeShim(
    bin,
    "uname",
    `case "\${1:-}" in
  -s) echo "${unameSystem}" ;;
  -m) echo "arm64" ;;
  *) echo "${unameSystem} fakehost 24.6.0 arm64" ;;
esac
exit 0`,
  );
  await writeShim(
    bin,
    "sw_vers",
    `echo "ProductName: macOS"
echo "ProductVersion: 15.7.5"
echo "BuildVersion: 24G624"
${leak}
exit 0`,
  );
  await writeShim(
    bin,
    "codesign",
    `if [[ "\${1:-}" == "--version" ]]; then
  echo "codesign fake 1.0.0"
  ${leak}
fi
exit 0`,
  );
  await writeShim(
    bin,
    "security",
    `if [[ "\${1:-}" == "find-identity" ]]; then
${identities}
  exit 0
fi
echo "fake keychain"
${leak}
exit 0`,
  );
  await writeShim(
    bin,
    "xcrun",
    `if [[ "\${1:-}" == "--find" ]]; then
  echo "/fake/Xcode/usr/bin/\${2:-tool}"
  exit 0
fi
echo "xcrun fake"
${leak}
exit 0`,
  );
  await writeShim(
    bin,
    "curl",
    `echo "302 0.512345"
${leak}
exit 0`,
  );
}

function runDiagnostics(bin, { args = [], env = {} } = {}) {
  return spawnSync("bash", [diagnosticsScript, ...args], {
    encoding: "utf8",
    env: { ...BASE_ENV, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
}

function runInventory(args, env = {}) {
  return spawnSync(process.execPath, [inventoryScript, ...args], {
    encoding: "utf8",
    env: { ...BASE_ENV, ...env },
    timeout: 30_000,
  });
}

function parseInventoryJson(stdout) {
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("inventory-json: "));
  assert.ok(line, `no inventory-json line in output:\n${stdout}`);
  return JSON.parse(line.slice("inventory-json: ".length));
}

// 64-bit little-endian Mach-O magic, i.e. the first four bytes of every file
// osx-sign treats as a signing candidate.
const MACH_O_HEADER = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

async function writeFileWithParents(file, content, mode = 0o644) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, mode);
}

async function writeMachO(file, bytes, mode = 0o755) {
  await writeFileWithParents(
    file,
    Buffer.concat([MACH_O_HEADER, Buffer.alloc(Math.max(0, bytes - 4))]),
    mode,
  );
}

/**
 * A resource that is not Mach-O but looks binary: a NUL byte inside the first
 * 8 KiB is what makes osx-sign give the file its own `codesign` call.
 */
async function writeBinaryResource(file, bytes, mode = 0o644) {
  await writeFileWithParents(
    file,
    Buffer.concat([Buffer.from("RESOURCE"), Buffer.alloc(bytes)]),
    mode,
  );
}

function appFixturePath(release) {
  return join(release, "mac-arm64", "PI-Desktop.app");
}

async function tempRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * The bundle used by the counting tests:
 *   Contents/MacOS/PI-Desktop                            mach-o, executable
 *   Contents/Frameworks/Foo.framework/Versions/A/Foo     mach-o in a framework
 *   Contents/Frameworks/Foo.framework/Versions/Current   symlink to A
 *   Contents/Frameworks/Helper.app/Contents/MacOS/Helper text, nested bundle
 *   Contents/Resources/bin/pi-desktop-host-core          mach-o, executable
 *   Contents/Resources/bin/run.sh                        script, executable
 *   Contents/Resources/native.dylib                      text
 *   Contents/Resources/native.node                       text
 *   Contents/Resources/icudtl.dat                        binary-looking (NUL)
 *   Contents/Info.plist                                  text
 * => 9 files, 11 directories, 1 symlink, 3 mach-o, 1 nested app, 1 binary
 *    resource
 */
async function writeBundleFixture(release) {
  const app = appFixturePath(release);
  await writeMachO(join(app, "Contents", "MacOS", "PI-Desktop"), 4100);
  await writeMachO(
    join(app, "Contents", "Frameworks", "Foo.framework", "Versions", "A", "Foo"),
    516,
  );
  await writeMachO(
    join(app, "Contents", "Resources", "bin", "pi-desktop-host-core"),
    2052,
  );
  await writeFileWithParents(
    join(app, "Contents", "Frameworks", "Helper.app", "Contents", "MacOS", "Helper"),
    "helper-stand-in",
  );
  await writeFileWithParents(
    join(app, "Contents", "Resources", "bin", "run.sh"),
    "#!/bin/sh\nexit 0\n",
    0o755,
  );
  await writeFileWithParents(join(app, "Contents", "Resources", "native.dylib"), "dylib-fixture");
  await writeFileWithParents(join(app, "Contents", "Resources", "native.node"), "node-fixture");
  await writeBinaryResource(join(app, "Contents", "Resources", "icudtl.dat"), 64);
  await writeFileWithParents(join(app, "Contents", "Info.plist"), "<plist/>");
  await symlink(
    "A",
    join(app, "Contents", "Frameworks", "Foo.framework", "Versions", "Current"),
  );
  return app;
}

test("diagnostics report an available Developer ID identity", async (t) => {
  const root = await tempRoot(t, "pi-desktop-signing-diagnostics-");
  const bin = join(root, "bin");
  await writeDiagnosticsShims(bin, { identities: MATCHING_IDENTITY });

  const result = runDiagnostics(bin);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^==> System$/m);
  assert.match(result.stdout, /^==> codesign$/m);
  assert.match(result.stdout, /^==> Keychain$/m);
  assert.match(result.stdout, /^==> Xcode toolchain$/m);
  assert.ok(
    result.stdout.includes(`==> Developer ID identity available: ${SIGNING_IDENTITY}`),
    result.stdout,
  );
  assert.ok(
    result.stdout.includes(`"${SIGNING_IDENTITY}"`),
    "the matching find-identity line is echoed",
  );
  assert.doesNotMatch(result.stdout, /is not available/);
});

test("diagnostics fail closed when --require-identity finds no identity", async (t) => {
  const root = await tempRoot(t, "pi-desktop-signing-required-");
  const bin = join(root, "bin");
  await writeDiagnosticsShims(bin, { identities: NO_IDENTITIES });

  const result = runDiagnostics(bin, { args: ["--require-identity"] });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not available/);
  assert.ok(
    result.stdout.includes(
      `warning: Developer ID Application: ${SIGNING_IDENTITY_NAME} is not available in the current keychain`,
    ),
    result.stdout,
  );
});

test("diagnostics treat a missing identity as a warning by default", async (t) => {
  const root = await tempRoot(t, "pi-desktop-signing-optional-");
  const bin = join(root, "bin");
  await writeDiagnosticsShims(bin, { identities: NO_IDENTITIES });

  const result = runDiagnostics(bin);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stdout.includes(
      `warning: Developer ID Application: ${SIGNING_IDENTITY_NAME} is not available`,
    ),
    result.stdout,
  );
  assert.doesNotMatch(result.stdout, /Developer ID identity available/);
});

test("diagnostics refuse to run off macOS", async (t) => {
  const root = await tempRoot(t, "pi-desktop-signing-linux-");
  const bin = join(root, "bin");
  await writeDiagnosticsShims(bin, { unameSystem: "Linux" });

  const result = runDiagnostics(bin);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must run on macOS/);
});

test("diagnostics never echo signing secrets", async (t) => {
  const root = await tempRoot(t, "pi-desktop-signing-redaction-");
  const bin = join(root, "bin");
  await writeDiagnosticsShims(bin, { leaky: true });

  const result = runDiagnostics(bin, {
    env: {
      CSC_LINK: CSC_LINK_SENTINEL,
      CSC_KEY_PASSWORD: CSC_PASSWORD_SENTINEL,
      APPLE_ID: APPLE_ID_SENTINEL,
      APPLE_APP_SPECIFIC_PASSWORD: APPLE_PASSWORD_SENTINEL,
      APPLE_TEAM_ID: "DUV63RKYTW",
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const combined = `${result.stdout}${result.stderr}`;
  // The shims did print the values, so the assertions below are not vacuous.
  assert.ok(combined.includes("CSC_LINK=[redacted]"), combined);
  for (const secret of [
    CSC_LINK_SENTINEL,
    CSC_PASSWORD_SENTINEL,
    APPLE_PASSWORD_SENTINEL,
    APPLE_ID_SENTINEL,
  ]) {
    assert.ok(!combined.includes(secret), `secret value leaked: ${secret}`);
  }
});

test("inventory counts the signing payload of a release directory", async (t) => {
  const root = await tempRoot(t, "pi-desktop-bundle-inventory-");
  const release = join(root, "release");
  const app = await writeBundleFixture(release);

  const result = runInventory([release, "--json", "--top", "2"]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stdout.includes(`==> PI-Desktop.app inventory: ${app}`),
    result.stdout,
  );
  assert.match(result.stdout, /^entries: 21 \(files: 9, directories: 11, symlinks: 1\)$/m);
  assert.match(
    result.stdout,
    /^mach-o: 3 \(dylib: 1, node: 1, framework binaries: 1\)$/m,
  );
  assert.match(result.stdout, /^bundles: frameworks=1 nested-apps=1$/m);
  assert.match(result.stdout, /^executables: script=1 mach-o=3$/m);
  assert.match(result.stdout, /^binary-resources: 1$/m);
  assert.match(
    result.stdout,
    /^signing-candidates: 5 \(mach-o 3 \+ nested-bundles 1 \+ binary-resources 1\)$/m,
  );
  assert.match(
    result.stdout,
    /^resources: agent-runtime=<missing>, plugins=<missing>, skills=<missing>, models\.dev=<missing>, bin=2\/\d+$/m,
  );
  assert.match(result.stdout, /^top-level-cost: Contents\/MacOS=\d+, Contents\/Resources=\d+$/m);
  assert.match(
    result.stdout,
    /^slowest-likely: Contents\/MacOS\/PI-Desktop \(4100 bytes\), Contents\/Resources\/bin\/pi-desktop-host-core \(2052 bytes\)$/m,
  );
  assert.match(result.stdout, /^warning: non-Mach-O regular file in Contents\/Resources\/bin: Contents\/Resources\/bin\/run\.sh$/m);

  const json = parseInventoryJson(result.stdout);
  assert.equal(json.bundle, app);
  assert.equal(json.entries, 21);
  assert.equal(json.files, 9);
  assert.equal(json.directories, 11);
  assert.equal(json.symlinks, 1);
  assert.equal(json.machO, 3);
  assert.equal(json.dylib, 1);
  assert.equal(json.nodeModules, 1);
  assert.equal(json.frameworks, 1);
  assert.equal(json.nestedApps, 1);
  assert.equal(json.executableScripts, 1);
  assert.equal(json.executableMachO, 3);
  assert.equal(json.machOOutsideFramework, 2);
  assert.equal(json.binaryResources, 1);
  assert.equal(json.signingCandidates, 5);
  assert.equal(json.topLevelCost.length, 2);
  assert.equal(json.slowestLikely.length, 2);
  assert.equal(json.slowestLikely[0].path, "Contents/MacOS/PI-Desktop");
  assert.equal(json.slowestLikely[0].bytes, 4100);
  assert.equal(json.resources.bin.files, 2);
  assert.equal(json.resources["models.dev"], null);
});

test("inventory counts binary-looking resources as signing candidates", async (t) => {
  const root = await tempRoot(t, "pi-desktop-bundle-binary-resources-");
  const release = join(root, "release");
  const app = appFixturePath(release);
  // One Mach-O, one NUL-carrying resource, one text resource and one nested
  // bundle: osx-sign signs all of those except the text resource, so the total
  // is 1 + 1 + 1 = 3.
  await writeMachO(join(app, "Contents", "MacOS", "PI-Desktop"), 512);
  await writeBinaryResource(
    join(app, "Contents", "Frameworks", "Electron Framework.framework", "Resources", "icudtl.dat"),
    256,
  );
  await writeFileWithParents(
    join(app, "Contents", "Resources", "notes.txt"),
    "plain text, no NUL\n",
  );
  await writeFileWithParents(
    join(app, "Contents", "Frameworks", "Helper.app", "Contents", "MacOS", "Helper"),
    "helper-stand-in",
  );

  const result = runInventory([app, "--json"]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^mach-o: 1 \(dylib: 0, node: 0, framework binaries: 0\)$/m);
  assert.match(result.stdout, /^binary-resources: 1$/m);
  assert.match(result.stdout, /^bundles: frameworks=1 nested-apps=1$/m);
  assert.match(
    result.stdout,
    /^signing-candidates: 3 \(mach-o 1 \+ nested-bundles 1 \+ binary-resources 1\)$/m,
  );

  const json = parseInventoryJson(result.stdout);
  assert.equal(json.machO, 1);
  assert.equal(json.binaryResources, 1);
  assert.equal(json.nestedApps, 1);
  assert.equal(json.signingCandidates, 3);
  // The text file is counted as an entry but is not a signing candidate.
  assert.equal(json.files, 4);
  assert.deepEqual(json.warnings, []);
});

test("inventory does not double count native-extension files as binary resources", async (t) => {
  const root = await tempRoot(t, "pi-desktop-bundle-native-extensions-");
  const release = join(root, "release");
  const app = appFixturePath(release);
  // A `.dylib` and a `.node` that happen to look binary are already reported by
  // their own counters, so only the `.dat` may raise `binary-resources`.
  await writeMachO(
    join(app, "Contents", "Resources", "bin", "pi-desktop-host-core"),
    256,
  );
  await writeBinaryResource(
    join(app, "Contents", "Resources", "libstub.dylib"),
    128,
  );
  await writeBinaryResource(
    join(app, "Contents", "Resources", "native.node"),
    128,
  );
  await writeBinaryResource(
    join(app, "Contents", "Resources", "icudtl.dat"),
    128,
  );

  const result = runInventory([app, "--json"]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^binary-resources: 1$/m);
  assert.match(
    result.stdout,
    /^signing-candidates: 2 \(mach-o 1 \+ nested-bundles 0 \+ binary-resources 1\)$/m,
  );

  const json = parseInventoryJson(result.stdout);
  assert.equal(json.machO, 1);
  assert.equal(json.binaryResources, 1);
  assert.equal(json.dylib, 1);
  assert.equal(json.nodeModules, 1);
  assert.equal(json.signingCandidates, 2);
});

test("inventory requires exactly one app bundle under the given path", async (t) => {
  const root = await tempRoot(t, "pi-desktop-bundle-selection-");

  const empty = join(root, "empty-release");
  await mkdir(join(empty, "mac-arm64"), { recursive: true });
  const emptyResult = runInventory([empty]);
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /expected exactly one \*\.app bundle under/);

  const twoApps = join(root, "two-release");
  await writeFileWithParents(
    join(twoApps, "mac-arm64", "PI-Desktop.app", "Contents", "Info.plist"),
    "<plist/>",
  );
  await writeFileWithParents(
    join(twoApps, "mac-x64", "PI-Desktop.app", "Contents", "Info.plist"),
    "<plist/>",
  );
  const twoResult = runInventory([twoApps]);
  assert.equal(twoResult.status, 1);
  assert.match(twoResult.stderr, /expected exactly one/);

  const missingResult = runInventory([join(root, "does-not-exist")]);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /path does not exist/);

  const fileResult = runInventory([join(root, "two-release", "mac-arm64", "PI-Desktop.app", "Contents", "Info.plist")]);
  assert.equal(fileResult.status, 1);
  assert.match(fileResult.stderr, /not a directory/);
});

test("inventory survives a symlink cycle without hanging or double counting", async (t) => {
  const root = await tempRoot(t, "pi-desktop-bundle-symlink-");
  const release = join(root, "release");
  const app = appFixturePath(release);
  await writeFileWithParents(join(app, "Contents", "MacOS", "PI-Desktop"), "not-mach-o");
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await symlink(
    join("..", ".."),
    join(app, "Contents", "Resources", "ancestor-loop"),
  );
  await symlink("self-loop", join(app, "Contents", "Resources", "self-loop"));

  const startedAt = Date.now();
  const result = runInventory([app, "--json"]);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null, "the inventory must terminate on its own");
  assert.ok(elapsed < 5000, `inventory took ${elapsed}ms`);
  // Contents, Contents/MacOS and Contents/Resources are real directories; the
  // ancestor symlink must not make the walker revisit them.
  assert.match(result.stdout, /^entries: 6 \(files: 1, directories: 3, symlinks: 2\)$/m);
  const json = parseInventoryJson(result.stdout);
  assert.equal(json.symlinks, 2);
  assert.equal(json.files, 1);
  assert.equal(json.entries, 6);
});

test("inventory warns about oversized bundles without failing", async (t) => {
  const root = await tempRoot(t, "pi-desktop-bundle-thresholds-");
  const release = join(root, "release");
  const app = appFixturePath(release);
  for (let index = 0; index < 5; index += 1) {
    await writeFileWithParents(
      join(app, "Contents", "MacOS", `tool-${index}`),
      "plain file",
    );
  }

  const result = runInventory([app, "--json"], {
    PI_DESKTOP_INVENTORY_MAX_FILES: "3",
    PI_DESKTOP_INVENTORY_MAX_DIR_FILES: "1",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^warning: bundle contains 5 files \(threshold 3\)/m);
  assert.match(result.stdout, /^warning: directory holds more than 1 files/m);

  const json = parseInventoryJson(result.stdout);
  assert.equal(json.files, 5);
  assert.ok(json.warnings.length >= 2);
});

test("inventory flags Mach-O files outside the expected locations", async (t) => {
  const root = await tempRoot(t, "pi-desktop-bundle-misplaced-");
  const release = join(root, "release");
  const app = appFixturePath(release);
  await writeMachO(join(app, "Contents", "Resources", "tools", "odd-binary"), 128);

  const result = runInventory([app]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^mach-o: 1 \(dylib: 0, node: 0, framework binaries: 0\)$/m);
  assert.match(
    result.stdout,
    /^warning: Mach-O outside Contents\/MacOS, Contents\/Frameworks, Contents\/Resources\/bin or a nested \.app: Contents\/Resources\/tools\/odd-binary$/m,
  );
  assert.match(
    result.stdout,
    /^signing-candidates: 1 \(mach-o 1 \+ nested-bundles 0 \+ binary-resources 0\)$/m,
  );
});
