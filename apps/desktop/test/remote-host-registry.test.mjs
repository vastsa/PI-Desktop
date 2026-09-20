import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createRemoteHostRegistry } = await import(
  "../electron/main/remote/remote-host-registry.ts"
);

/**
 * Reversible fake encryption for tests: prefix the plaintext so we can prove
 * the token was passed through `encrypt` and not written as clear bytes, and
 * so a "wrong key" scenario can be simulated by rejecting the prefix.
 */
function reversibleEncryption(overrides = {}) {
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

async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), "remote-hosts-"));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("list returns an empty array when the file does not exist", async () => {
  const { dir, cleanup } = await tmpDir();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption: reversibleEncryption() });
  assert.deepEqual(await registry.list(), []);
  await cleanup();
});

test("upsert then list round-trips a record and encrypts the token on disk", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption });
  await registry.upsert({
    hostKey: "hostA",
    label: "Home Linux",
    url: "wss://home.local:9443/racp",
    deviceToken: "rd_secret",
  });
  const rows = await registry.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hostKey, "hostA");
  assert.equal(rows[0].deviceToken, "rd_secret");
  // Confirm the token bytes never landed in plaintext.
  const raw = await readFile(join(dir, "remote-hosts.json"), "utf8");
  assert.ok(!raw.includes("rd_secret"), "plaintext token must not appear on disk");
  assert.ok(raw.includes("encryptedDeviceToken"));
  await cleanup();
});

test("upsert overwrites an existing hostKey and preserves the rest", async () => {
  const { dir, cleanup } = await tmpDir();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption: reversibleEncryption() });
  await registry.upsert({ hostKey: "a", label: "A", url: "wss://a", deviceToken: "t-a" });
  await registry.upsert({ hostKey: "b", label: "B", url: "wss://b", deviceToken: "t-b" });
  await registry.upsert({ hostKey: "a", label: "A renamed", url: "wss://a2", deviceToken: "t-a2" });
  const rows = await registry.list();
  assert.equal(rows.length, 2);
  const a = rows.find((row) => row.hostKey === "a");
  const b = rows.find((row) => row.hostKey === "b");
  assert.equal(a.label, "A renamed");
  assert.equal(a.url, "wss://a2");
  assert.equal(a.deviceToken, "t-a2");
  assert.equal(b.deviceToken, "t-b");
  await cleanup();
});

test("upsert refuses to write when safeStorage is unavailable", async () => {
  const { dir, cleanup } = await tmpDir();
  const registry = createRemoteHostRegistry({
    dataDir: dir,
    encryption: reversibleEncryption({ available: false }),
  });
  await assert.rejects(
    () =>
      registry.upsert({ hostKey: "a", label: "A", url: "wss://a", deviceToken: "t" }),
    (error) => error.errorCode === "REMOTE_STORAGE_UNAVAILABLE",
  );
  await cleanup();
});

test("remove drops one hostKey and unlinks the file when the last one leaves", async () => {
  const { dir, cleanup } = await tmpDir();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption: reversibleEncryption() });
  await registry.upsert({ hostKey: "a", label: "A", url: "wss://a", deviceToken: "t-a" });
  await registry.upsert({ hostKey: "b", label: "B", url: "wss://b", deviceToken: "t-b" });
  await registry.remove("a");
  assert.deepEqual((await registry.list()).map((row) => row.hostKey), ["b"]);
  await registry.remove("b");
  assert.deepEqual(await registry.list(), []);
  // File should no longer exist after emptying.
  await assert.rejects(
    () => readFile(join(dir, "remote-hosts.json"), "utf8"),
    (error) => error.code === "ENOENT",
  );
  await cleanup();
});

test("remove of a missing hostKey is a no-op", async () => {
  const { dir, cleanup } = await tmpDir();
  const registry = createRemoteHostRegistry({ dataDir: dir, encryption: reversibleEncryption() });
  await registry.upsert({ hostKey: "a", label: "A", url: "wss://a", deviceToken: "t-a" });
  await registry.remove("nope");
  const rows = await registry.list();
  assert.equal(rows.length, 1);
  await cleanup();
});

test("a record whose token fails to decrypt is skipped, not surfaced with a placeholder", async () => {
  const { dir, cleanup } = await tmpDir();
  const encryption = reversibleEncryption();
  const filePath = join(dir, "remote-hosts.json");
  const file = {
    version: 1,
    hosts: [
      {
        hostKey: "good",
        label: "Good",
        url: "wss://good",
        encryptedDeviceToken: Buffer.from("enc:t-good").toString("base64"),
      },
      {
        hostKey: "bad",
        label: "Bad",
        url: "wss://bad",
        encryptedDeviceToken: Buffer.from("wrong-prefix").toString("base64"),
      },
    ],
  };
  await writeFile(filePath, JSON.stringify(file), "utf8");
  const warnings = [];
  const registry = createRemoteHostRegistry({
    dataDir: dir,
    encryption,
    log: (level, message) => warnings.push({ level, message }),
  });
  const rows = await registry.list();
  assert.deepEqual(rows.map((row) => row.hostKey), ["good"]);
  assert.ok(warnings.some((entry) => /could not be decrypted/.test(entry.message)));
  await cleanup();
});

test("a shape-mismatched file is treated as empty and preserved on disk until rewritten", async () => {
  const { dir, cleanup } = await tmpDir();
  await writeFile(join(dir, "remote-hosts.json"), JSON.stringify({ hosts: "oops" }), "utf8");
  const warnings = [];
  const registry = createRemoteHostRegistry({
    dataDir: dir,
    encryption: reversibleEncryption(),
    log: (level, message) => warnings.push({ level, message }),
  });
  assert.deepEqual(await registry.list(), []);
  assert.ok(warnings.some((entry) => /shape rejected/.test(entry.message)));
  // File not deleted by list().
  const still = await readFile(join(dir, "remote-hosts.json"), "utf8");
  assert.ok(still.includes("oops"));
  await cleanup();
});
