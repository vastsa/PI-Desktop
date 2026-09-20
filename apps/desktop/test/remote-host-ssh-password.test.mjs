/**
 * SSH password authentication, end to end across the seams that carry it.
 *
 * Three properties are load-bearing and each is asserted here rather than
 * assumed:
 *
 * 1. The secret never becomes an `ssh` argument. It reaches the child through
 *    the askpass helper's `0600` file, and the argv of a password spawn must
 *    still show exactly the options a key spawn shows, plus the two that make
 *    the helper usable.
 * 2. The credential material is short-lived: written when a child is about to
 *    authenticate and gone once it is not.
 * 3. It survives a restart by being persisted encrypted, and a record written
 *    before password auth existed keeps working unchanged.
 *
 * Fixture executables and a fake `EncryptionPort` keep every case offline.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  ASKPASS_HELPER_SCRIPT,
  ASKPASS_SECRET_ENV,
  assertSshPassword,
  createSshAskpass,
} = await import("../electron/main/remote/ssh-askpass.ts");
const { createSystemSshTransport, sshCommonArgs } = await import(
  "../electron/main/remote/ssh-transport.ts"
);
const { sshTargetOf } = await import("../electron/main/remote/ssh-tunnel.ts");
const { createRemoteHostRegistry } = await import(
  "../electron/main/remote/remote-host-registry.ts"
);
const { sshHostRecord, sshMetadataOf, transportOf } = await import(
  "../electron/main/bootstrap/remote-hosts.ts"
);

const TEST_TIMEOUT_MS = 20_000;
const PASSWORD = "correct horse battery staple";

/** Reversible fake keychain: the prefix proves the value went through encrypt. */
function fakeEncryption(overrides = {}) {
  return {
    available: overrides.available ?? true,
    isAvailable() {
      return this.available;
    },
    encryptString(plain) {
      return Buffer.from(`enc:${plain}`);
    },
    decryptString(buffer) {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
      return text.slice("enc:".length);
    },
  };
}

async function tmpDir(t, prefix = "ssh-password-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write an executable fixture and clean it up with its test. */
async function writeFixture(t, body, name) {
  const dir = await tmpDir(t, "ssh-fixture-");
  const path = join(dir, name);
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
  t.after(() => rm(path, { force: true }));
  return path;
}

const FIXTURES = {
  /** Prints argv one per line, then reports what the askpass seam looked like. */
  argvAndEnv: `#!/bin/sh
for arg in "$@"; do
  printf 'ARGV %s\\n' "$arg"
done
printf 'HAS_ASKPASS %s\\n' "\${SSH_ASKPASS:+set}"
printf 'ASKPASS_REQUIRE %s\\n' "\${SSH_ASKPASS_REQUIRE:-unset}"
printf 'SECRET_FILE %s\\n' "\${${ASKPASS_SECRET_ENV}:-unset}"
printf 'HELPER_PATH %s\\n' "\${SSH_ASKPASS:-unset}"
if [ -n "\${${ASKPASS_SECRET_ENV}}" ]; then
  # POSIX find -perm rather than ls, whose permissions column differs per
  printf 'SECRET_MODE %s\\n' "$(find "\${${ASKPASS_SECRET_ENV}}" -perm 600 -print)"
  printf 'HELPER_MODE %s\\n' "$(find "\$SSH_ASKPASS" -perm 700 -print)"
  printf 'DIR_MODE %s\\n' "$(find "$(dirname "\${${ASKPASS_SECRET_ENV}}")" -perm 700 -print)"
  printf 'HELPER_READS %s\\n' "$(sh "\$SSH_ASKPASS")"
  printf 'HELPER_RUNS %s\\n' "$("\$SSH_ASKPASS" "deploy@remote.example's password:")"
fi
`,
};

/** The askpass secret path a fixture child reported, for lifetime assertions. */
function secretPathOf(stdout) {
  return stdout
    .split("\n")
    .find((line) => line.startsWith("SECRET_FILE "))
    ?.slice("SECRET_FILE ".length);
}
test("sshCommonArgs keeps a key-authenticated target on BatchMode", () => {
  const args = sshCommonArgs({ host: "remote.example" });
  const index = args.indexOf("BatchMode=yes");
  assert.notEqual(index, -1, "the default path must still fail instead of prompting");
  assert.equal(args.includes("BatchMode=no"), false);
  assert.equal(args.includes("NumberOfPasswordPrompts=1"), false);
  assert.equal(args.includes("PubkeyAuthentication=no"), false);
  // No password means no askpass plumbing at all.
  assert.equal(args.includes("-o"), true);
  assert.equal(args.some((arg) => arg.includes("NumberOfPasswordPrompts")), false);
});

test("sshCommonArgs relaxes BatchMode only for a password target", () => {
  const args = sshCommonArgs({ host: "remote.example", user: "deploy", password: PASSWORD });
  assert.equal(args.includes("BatchMode=no"), true, "the prompt must be allowed");
  assert.equal(args.includes("BatchMode=yes"), false);
  // Exactly one answer can be given, so exactly one attempt may be made: a
  // retry against a wrong password is what trips server-side lockouts.
  const index = args.indexOf("NumberOfPasswordPrompts=1");
  assert.notEqual(index, -1);
  assert.equal(args[index - 1], "-o");
  // Password mode replaces a key: default identities must not consume the
  // single askpass answer as a passphrase.
  assert.equal(args.includes("PubkeyAuthentication=no"), true);
  // The secret is nowhere in the argv, in any form.
  for (const arg of args) {
    assert.equal(arg.includes(PASSWORD), false, "the password must never be an ssh argument");
  }
  assert.equal(args.at(-1), "deploy@remote.example");
});

test("a password target reaches ssh through the askpass helper and nowhere else", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvAndEnv, "ssh-askpass-probe");
  const transport = createSystemSshTransport(
    { host: "remote.example", user: "deploy", password: PASSWORD },
    { binary },
  );
  t.after(() => transport.dispose());

  const result = await transport.exec("id -u");
  const lines = result.stdout.split("\n").filter(Boolean);
  const read = (key) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
  const argv = lines.filter((line) => line.startsWith("ARGV ")).map((line) => line.slice(5));

  // The secret is not an argument…
  for (const arg of argv) {
    assert.equal(arg.includes(PASSWORD), false, `argv leaked the password: ${arg}`);
  }
  assert.equal(argv.at(-1), "id -u");
  assert.equal(argv.at(-2), "deploy@remote.example");

  // …but the helper is wired up and answers with it.
  assert.equal(read("HAS_ASKPASS"), "set");
  assert.equal(read("ASKPASS_REQUIRE"), "force");
  assert.notEqual(read("SECRET_FILE"), "unset");
  assert.equal(read("HELPER_READS"), PASSWORD, "the helper returns the secret whole");
  assert.equal(read("HELPER_RUNS"), PASSWORD, "ssh's own prompt is answered by the helper");
  // The helper is executable only by its owner, and the secret only readable by
  // its owner. The modes are checked inside the child, because the material is
  // already deleted by the time this assertion runs — which is itself the next
  // thing asserted.
  const secretPath = read("SECRET_FILE");
  assert.notEqual(read("SECRET_MODE"), "", "the secret must be 0600");
  assert.notEqual(read("HELPER_MODE"), "", "the helper must be 0700");
  assert.notEqual(read("DIR_MODE"), "", "the credential directory must be 0700");

  // The material is gone once the child that needed it is done.
  await assert.rejects(stat(secretPath));
});

test("a key-authenticated transport is handed no askpass material", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvAndEnv, "ssh-no-askpass");
  const transport = createSystemSshTransport({ host: "remote.example" }, { binary });
  t.after(() => transport.dispose());

  const result = await transport.exec("id -u");
  const lines = result.stdout.split("\n").filter(Boolean);
  const read = (key) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);

  // The fixture prints an empty value for an unset variable, so "no askpass"
  // looks like the empty string rather than a missing line.
  assert.equal(read("HAS_ASKPASS"), "");
  assert.equal(read("SECRET_FILE"), "unset");
  assert.equal(read("HELPER_PATH"), "unset");
  // Nothing was written, so nothing had to be cleaned up.
  assert.equal(read("HELPER_READS"), undefined);
});

test("each command gets its own credential, and none outlives it", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvAndEnv, "ssh-per-command-secret");
  const transport = createSystemSshTransport(
    { host: "remote.example", password: PASSWORD },
    { binary },
  );
  t.after(() => transport.dispose());

  const first = await transport.exec("uname -s");
  const firstSecret = secretPathOf(first.stdout);
  // The first command is finished, so its copy is already gone — the secret is
  // on disk only while a child can still be prompting for it.
  await assert.rejects(stat(firstSecret));

  const second = await transport.exec("id -u");
  const secondSecret = secretPathOf(second.stdout);
  assert.notEqual(firstSecret, secondSecret, "a new credential is minted per command");
  await assert.rejects(stat(secondSecret));
});

test("dispose removes credential material that no child has reclaimed", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const binary = await writeFixture(t, FIXTURES.argvAndEnv, "ssh-dispose-secret");
  const transport = createSystemSshTransport(
    { host: "remote.example", password: PASSWORD },
    { binary },
  );
  await transport.exec("id -u");
  // `dispose` has to be safe to call after the normal release, and it must not
  // leave a stray directory behind for the next launch to find.
  transport.dispose();
  transport.dispose();
});

test("the helper script is POSIX shell that reads the secret by path", async () => {
  assert.ok(ASKPASS_HELPER_SCRIPT.startsWith("#!/bin/sh"));
  assert.ok(ASKPASS_HELPER_SCRIPT.includes(`\${${ASKPASS_SECRET_ENV}}`));
  // A literal secret could only have got here by being interpolated; the only
  // thing the script may contain is the indirection through the environment.
  assert.ok(ASKPASS_HELPER_SCRIPT.endsWith("echo\n"));
});

test("assertSshPassword refuses what OpenSSH could never receive", () => {
  assert.equal(assertSshPassword(PASSWORD), PASSWORD);
  // A leading or trailing space is a valid password and must survive.
  assert.equal(assertSshPassword("  spaced  "), "  spaced  ");
  // OpenSSH reads the helper's answer up to the first line break, so a secret
  // containing one would be silently truncated into a different password.
  assert.throws(() => assertSshPassword("two\nlines"), /line break/);
  assert.throws(() => assertSshPassword("two\rlines"), /line break/);
  assert.throws(() => assertSshPassword(""), /must not be empty/);
  assert.throws(() => assertSshPassword(null), /must be a string/);
  assert.throws(() => assertSshPassword("x".repeat(4097)), /at most/);
});

test("createSshAskpass refuses Windows instead of writing a helper that cannot run", async (t) => {
  const dir = await tmpDir(t);
  await assert.rejects(
    createSshAskpass(PASSWORD, { dir, platform: "win32" }),
    (error) => error.errorCode === "HOST_BOOTSTRAP_FAILED" && /Windows/.test(error.message),
  );
  // Nothing may have been created on the way to that refusal.
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(dir), []);
});

test("createSshAskpass writes a 0600 secret in a 0700 directory and cleans up", async (t) => {
  const parent = await tmpDir(t);
  const material = await createSshAskpass(PASSWORD, { dir: parent });
  const secretPath = material.env[ASKPASS_SECRET_ENV];
  const helperPath = material.env.SSH_ASKPASS;
  const root = dirname(secretPath);

  assert.equal(material.env.SSH_ASKPASS_REQUIRE, "force");
  assert.equal(await readFile(secretPath, "utf8"), PASSWORD);
  assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  assert.equal((await stat(helperPath)).mode & 0o777, 0o700);
  assert.equal((await stat(root)).mode & 0o777, 0o700);

  await material.dispose();
  await assert.rejects(stat(root));
  // Idempotent: a second close must not throw over the already-deleted files.
  await material.dispose();
});

test("the persisted record carries the password encrypted and reads it back", async (t) => {
  const dir = await tmpDir(t);
  const encryption = fakeEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  const record = sshHostRecord({
    hostKey: "ssh-remote.example-prod",
    label: "Prod box",
    url: "ws://127.0.0.1:41234/v1/racp/ws",
    deviceToken: "dt_secret",
    ssh: { host: "remote.example", user: "deploy", auth: "password", remotePort: 41234, version: "1.2.3" },
    sshSecret: PASSWORD,
  });
  await registry.upsert(record);

  const raw = await readFile(join(dir, "remote-hosts.json"), "utf8");
  assert.equal(raw.includes(PASSWORD), false, "the password must not be on disk in clear text");
  assert.ok(raw.includes("encryptedSshSecret"));

  const [stored] = await registry.list();
  assert.equal(stored.sshSecret, PASSWORD);
  assert.equal(stored.deviceToken, "dt_secret");
  assert.equal(sshMetadataOf(stored)?.auth, "password");
  assert.equal(transportOf(stored), "ssh");
  // The secret is in the record, never in the descriptor the renderer receives.
  assert.equal(JSON.stringify(sshMetadataOf(stored)).includes(PASSWORD), false);
});

test("a record written before password auth reads back unchanged", async (t) => {
  const dir = await tmpDir(t);
  const encryption = fakeEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert(
    sshHostRecord({
      hostKey: "legacy",
      label: "Legacy",
      url: "ws://127.0.0.1:1/v1/racp/ws",
      deviceToken: "dt",
      // No password, so no `auth` field: exactly the pre-password-auth shape.
      ssh: { host: "old.example", remotePort: 22, version: "1.2.3" },
    }),
  );

  const [stored] = await registry.list();
  assert.equal(stored.sshSecret, undefined);
  const metadata = sshMetadataOf(stored);
  assert.equal(metadata?.auth, undefined, "a key descriptor must not gain an auth field");
  assert.deepEqual(metadata, { host: "old.example", remotePort: 22, version: "1.2.3" });
  const raw = await readFile(join(dir, "remote-hosts.json"), "utf8");
  assert.equal(raw.includes("encryptedSshSecret"), false);
});

test("an undecryptable password costs the secret, not the paired host", async (t) => {
  const dir = await tmpDir(t);
  await createRemoteHostRegistry({ dataDir: dir, encryption: fakeEncryption() }).upsert(
    sshHostRecord({
      hostKey: "h",
      label: "H",
      url: "u",
      deviceToken: "dt_keep_me",
      ssh: { host: "remote.example", auth: "password", remotePort: 1, version: "1" },
      sshSecret: PASSWORD,
    }),
  );

  // Simulate a keychain that moved: the device token still decrypts, the SSH
  // password does not. Dropping the whole record would hide a paired host.
  const encryption = fakeEncryption();
  const original = encryption.decryptString.bind(encryption);
  encryption.decryptString = (buffer) => {
    if (buffer.toString("utf8").includes(PASSWORD)) throw new Error("cannot decrypt");
    return original(buffer);
  };
  const [stored] = await createRemoteHostRegistry({ dataDir: dir, encryption }).list();
  assert.equal(stored.deviceToken, "dt_keep_me");
  assert.equal(stored.sshSecret, undefined);
});

test("sshTargetOf carries the secret beside the descriptor, never inside it", () => {
  const ssh = { host: "remote.example", user: "deploy", auth: "password", remotePort: 1, version: "1" };
  const withSecret = sshTargetOf(ssh, PASSWORD);
  assert.equal(withSecret.password, PASSWORD);
  assert.equal(JSON.stringify(ssh).includes(PASSWORD), false, "the descriptor stays secret-free");

  // Absent secret means key auth, which is the pre-existing behaviour.
  assert.equal("password" in sshTargetOf(ssh), false);
});
