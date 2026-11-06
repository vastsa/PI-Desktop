import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const crypto = await import("../electron/main/browser-cookies/chrome-crypto.ts");
const { KeychainAccessError, listChromeProfiles, readChromeSafeStoragePassword } = await import("../electron/main/browser-cookies/chrome-source.ts");
const { importChromeCookies } = await import("../electron/main/browser-cookies/import.ts");
const { validateBrowserCookieImportRequest } = await import("@pi-desktop/shared");

const PASSWORD = "test-safe-storage-password";
const KEY = pbkdf2Sync(PASSWORD, "saltysalt", 1003, 16, "sha1");
const NOW_MS = Date.UTC(2026, 10, 6);
/** Chrome stores expiry as microseconds since 1601-01-01. */
const chromeTime = (unixSeconds) => (BigInt(unixSeconds) + 11_644_473_600n) * 1_000_000n;
const FUTURE = chromeTime(NOW_MS / 1000 + 86_400);
const PAST = chromeTime(NOW_MS / 1000 - 86_400);

function encrypt(hostKey, value, version) {
  const prefix = version >= 24 ? createHash("sha256").update(hostKey).digest() : Buffer.alloc(0);
  const cipher = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  const body = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), body]);
}

const row = (overrides = {}) => ({
  host_key: ".github.com",
  name: "user_session",
  value: "",
  encrypted_value: new Uint8Array(),
  path: "/",
  expires_utc: FUTURE,
  is_secure: 1,
  is_httponly: 1,
  samesite: 1,
  ...overrides,
});

async function chromeProfile({ version = 24, rows, profile = "Default", localState } = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-chrome-fixture-"));
  await mkdir(join(userDataDir, profile, "Network"), { recursive: true });
  if (localState) await writeFile(join(userDataDir, "Local State"), JSON.stringify(localState));
  const db = new DatabaseSync(join(userDataDir, profile, "Network", "Cookies"));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  db.exec(`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of rows) {
    insert.run(item.host_key, item.name, item.value, item.encrypted_value, item.path, item.expires_utc,
      item.is_secure, item.is_httponly, item.samesite);
  }
  db.close();
  return userDataDir;
}

test("decrypts v10 values and verifies the v24 host-key hash prefix", () => {
  const encrypted = encrypt(".github.com", "secret", 24);
  assert.equal(crypto.decryptChromeCookieValue({ host_key: ".github.com", value: "", encrypted_value: encrypted }, KEY, 24), "secret");
  // A value copied to another host no longer matches its domain binding.
  assert.equal(crypto.decryptChromeCookieValue({ host_key: ".evil.com", value: "", encrypted_value: encrypted }, KEY, 24), null);
  const legacy = encrypt(".github.com", "old", 23);
  assert.equal(crypto.decryptChromeCookieValue({ host_key: ".github.com", value: "", encrypted_value: legacy }, KEY, 23), "old");
  assert.equal(crypto.decryptChromeCookieValue({ host_key: "x", value: "plain", encrypted_value: new Uint8Array() }, KEY, 24), "plain");
  assert.equal(crypto.decryptChromeCookieValue({ host_key: "x", value: "", encrypted_value: Buffer.from("v20abc") }, KEY, 24), null);
  const wrongKey = pbkdf2Sync("other", "saltysalt", 1003, 16, "sha1");
  assert.equal(crypto.decryptChromeCookieValue({ host_key: ".github.com", value: "", encrypted_value: encrypted }, wrongKey, 24), null);
});

test("maps Chrome rows to Electron cookie details", () => {
  const domainCookie = crypto.toCookieSetDetails(row({ samesite: 0 }), "v");
  assert.deepEqual(domainCookie, {
    url: "https://github.com/", name: "user_session", value: "v", domain: ".github.com", path: "/",
    secure: true, httpOnly: true, expirationDate: NOW_MS / 1000 + 86_400, sameSite: "no_restriction",
  });
  const hostOnly = crypto.toCookieSetDetails(row({ host_key: "app.example.com", is_secure: 0, expires_utc: 0n, samesite: -1, path: "/a" }), "v");
  assert.equal(hostOnly.url, "http://app.example.com/a");
  assert.equal("domain" in hostOnly, false);
  assert.equal("expirationDate" in hostOnly, false);
  assert.equal(hostOnly.sameSite, "unspecified");
});

test("rejects invalid import requests", () => {
  assert.throws(() => validateBrowserCookieImportRequest({ profile: "../Default" }), /Invalid Chrome profile/);
  assert.throws(() => validateBrowserCookieImportRequest(null), /Invalid cookie import request/);
  assert.deepEqual(validateBrowserCookieImportRequest({ profile: "Profile 1", extra: true }), { profile: "Profile 1" });
});

test("lists Chrome profiles that have a cookie store", async () => {
  const userDataDir = await chromeProfile({
    rows: [],
    profile: "Profile 1",
    localState: { profile: { info_cache: { "Profile 1": { name: "Work" }, "Profile 2": { name: "No cookies" } } } },
  });
  assert.deepEqual(await listChromeProfiles(userDataDir), [{ id: "Profile 1", name: "Work" }]);
});

test("imports every live cookie into the jar with one Keychain read", async () => {
  const rows = [
    row({ encrypted_value: encrypt(".github.com", "session-a", 24) }),
    row({ host_key: "api.github.com", name: "token", encrypted_value: encrypt("api.github.com", "session-b", 24) }),
    row({ name: "expired", expires_utc: PAST, encrypted_value: encrypt(".github.com", "old", 24) }),
    row({ name: "corrupt", encrypted_value: encrypt(".other.com", "moved", 24) }),
    row({ host_key: ".example.org", name: "other", encrypted_value: encrypt(".example.org", "x", 24) }),
  ];
  const userDataDir = await chromeProfile({ rows });
  const jar = [];
  let passwordReads = 0;
  const result = await importChromeCookies({ profile: "Default" }, {
    userDataDir,
    readPassword: async () => { passwordReads += 1; return PASSWORD; },
    setCookie: async (details) => { jar.push(details); },
    now: () => NOW_MS,
  });
  assert.deepEqual(result, { imported: 3, skipped: 1, failed: 1 });
  assert.equal(passwordReads, 1);
  assert.deepEqual(jar.map(({ name, value }) => [name, value]), [["user_session", "session-a"], ["token", "session-b"], ["other", "x"]]);
});

test("skips the Keychain for an empty cookie store and reports jar rejections", async () => {
  const empty = await chromeProfile({ rows: [] });
  let passwordReads = 0;
  const none = await importChromeCookies({ profile: "Default" }, {
    userDataDir: empty,
    readPassword: async () => { passwordReads += 1; return PASSWORD; },
    setCookie: async () => {},
  });
  assert.deepEqual(none, { imported: 0, skipped: 0, failed: 0 });
  assert.equal(passwordReads, 0);

  const userDataDir = await chromeProfile({ rows: [row({ encrypted_value: encrypt(".github.com", "a", 24) })] });

  const rejected = await importChromeCookies({ profile: "Default" }, {
    userDataDir,
    readPassword: async () => PASSWORD,
    setCookie: async () => { throw new Error("rejected"); },
    now: () => NOW_MS,
  });
  assert.deepEqual(rejected, { imported: 0, skipped: 0, failed: 1 });

  await assert.rejects(
    importChromeCookies({ profile: "Missing" }, { userDataDir, readPassword: async () => PASSWORD, setCookie: async () => {} }),
    (error) => error.errorCode === "CHROME_PROFILE_NOT_FOUND",
  );
});

test("a Keychain denial aborts the import without touching the jar", async () => {
  const userDataDir = await chromeProfile({ rows: [row({ encrypted_value: encrypt(".github.com", "a", 24) })] });
  const jar = [];
  await assert.rejects(importChromeCookies({ profile: "Default" }, {
    userDataDir,
    readPassword: async () => { throw new Error("denied"); },
    setCookie: async (details) => { jar.push(details); },
  }), /denied/);
  assert.equal(jar.length, 0);
});

test("reads the Chrome secret through host-core and maps Keychain denials", async () => {
  const calls = [];
  const host = {
    async call(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      return { password: PASSWORD };
    },
  };
  assert.equal(await readChromeSafeStoragePassword(host), PASSWORD);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "browser.chromeSafeStoragePassword");
  assert.ok(calls[0].timeoutMs >= 120_000, "the prompt wait must not hit the default RPC timeout");

  const denied = {
    async call() {
      throw Object.assign(new Error("access was denied"), { errorCode: "CHROME_KEYCHAIN_DENIED" });
    },
  };
  await assert.rejects(readChromeSafeStoragePassword(denied), (error) => {
    assert.ok(error instanceof KeychainAccessError);
    assert.equal(error.errorCode, "CHROME_KEYCHAIN_DENIED");
    return true;
  });

  const unavailable = {
    async call() {
      throw Object.assign(new Error("host RPC unavailable"), { errorCode: "HOST_UNAVAILABLE" });
    },
  };
  await assert.rejects(readChromeSafeStoragePassword(unavailable), (error) => !(error instanceof KeychainAccessError));
  await assert.rejects(readChromeSafeStoragePassword(null), /host-core is unavailable/);
  await assert.rejects(readChromeSafeStoragePassword({ async call() { return {}; } }), KeychainAccessError);
});
