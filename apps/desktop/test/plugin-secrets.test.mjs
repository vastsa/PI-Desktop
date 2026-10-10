import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPluginSecretsApi } = await import("../electron/main/plugin-secrets.ts");
const { assertPluginSecretKey, assertPluginSecretValue } = await import("../../../packages/plugin-sdk/src/secrets.ts");

function fixture() {
  const values = new Map();
  const calls = [];
  const grants = new Set(["test.room", "test.other"]);
  function api(pluginId) {
    return createPluginSecretsApi({
      pluginId,
      assertPermission(permission) {
        assert.equal(permission, "secrets.store");
        if (!grants.has(pluginId)) throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" });
      },
      async callHost(method, params) {
        calls.push({ method, params });
        const ref = JSON.stringify([params.pluginId, params.key]);
        if (method === "plugins.secrets.get") return { value: values.get(ref) ?? null };
        if (method === "plugins.secrets.set") values.set(ref, params.value);
        if (method === "plugins.secrets.delete") values.delete(ref);
        return { ok: true };
      },
    });
  }
  return { api, calls, values, grants };
}

test("public plugin secret lifecycle keeps namespaces isolated", async () => {
  const { api, calls } = fixture();
  const room = api("test.room");
  const other = api("test.other");
  assert.equal(await room.get("account"), null);
  await room.set("account", "fixture-room");
  await other.set("account", "fixture-other");
  assert.equal(await room.get("account"), "fixture-room");
  assert.equal(await other.get("account"), "fixture-other");
  await room.set("account", "");
  assert.equal(await room.get("account"), "");
  await room.delete("account");
  await room.delete("account");
  assert.equal(await room.get("account"), null);
  assert.equal(await other.get("account"), "fixture-other");
  assert.ok(calls.every(({ method, params }) => method.startsWith("plugins.secrets.") && !("secretRef" in params)));
});

test("each operation checks the current grant before calling the host", async () => {
  const { api, calls, grants } = fixture();
  const room = api("test.room");
  await room.set("account", "fixture");
  const count = calls.length;
  grants.delete("test.room");
  for (const operation of [() => room.get("account"), () => room.set("account", "new"), () => room.delete("account")]) {
    await assert.rejects(operation, { code: "PERMISSION_DENIED" });
  }
  assert.equal(calls.length, count);
});

test("untrusted keys and values cannot become references or exceed bounds", async () => {
  const { api, calls } = fixture();
  const room = api("test.room");
  for (const key of [undefined, null, 42, {}, "", "../key", "a/b", "a\\b", "a:b", "a\0b", "é", "secret:provider:openai:api_key", "a".repeat(129)]) {
    await assert.rejects(() => room.get(key), { code: "INVALID_ARGUMENT" });
    await assert.rejects(() => room.set(key, "fixture"), { code: "INVALID_ARGUMENT" });
    await assert.rejects(() => room.delete(key), { code: "INVALID_ARGUMENT" });
  }
  for (const value of [undefined, null, 42, {}, "a".repeat(65537), "é".repeat(32769), "😀".repeat(16385)]) {
    await assert.rejects(() => room.set("key", value), { code: "INVALID_ARGUMENT" });
  }
  assert.equal(calls.length, 0);
  assertPluginSecretKey("a".repeat(128));
  assertPluginSecretValue("é".repeat(32768));
  assertPluginSecretValue("😀".repeat(16384));
  await room.set("a".repeat(128), "é".repeat(32768));
  for (const identity of ["", "a:b", "a/b", "../room", "a".repeat(257)]) {
    assert.throws(() => api(identity), { code: "INVALID_ARGUMENT" });
  }
});

test("caller objects cannot inject another identity or a raw reference", async () => {
  const { api, calls } = fixture();
  const room = api("test.room");
  await assert.rejects(() => room.get({ key: "account", pluginId: "test.other", secretRef: "secret:provider:openai:api_key" }), { code: "INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
});

test("host transport failures and malformed responses are redacted", async () => {
  for (const operation of ["get", "set", "delete"]) {
    const api = createPluginSecretsApi({
      pluginId: "test.room", assertPermission() {},
      async callHost() { throw new Error("private-fixture-value request payload"); },
    });
    await assert.rejects(() => api[operation]("key", "fixture"), (error) => {
      assert.equal(error.code, "INTERNAL");
      assert.equal(error.message, "plugin secret storage operation failed");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  for (const result of [undefined, {}, { value: 42 }, { value: "a".repeat(65537) }]) {
    const api = createPluginSecretsApi({ pluginId: "test.room", assertPermission() {}, async callHost() { return result; } });
    await assert.rejects(() => api.get("key"), { code: "INTERNAL", message: "invalid plugin secret storage response" });
  }
});


test("a revoked grant cannot receive a delayed secret response", async () => {
  let granted = true;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const api = createPluginSecretsApi({
    pluginId: "test.room",
    assertPermission() {
      if (!granted) throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" });
    },
    callHost: () => response,
  });
  const pending = api.get("key");
  granted = false;
  release({ value: "private-fixture" });
  await assert.rejects(pending, { code: "PERMISSION_DENIED" });
});

test("write operations reject missing or negative host acknowledgements", async () => {
  for (const result of [undefined, {}, { ok: false }, { ok: "true" }]) {
    const api = createPluginSecretsApi({ pluginId: "test.room", assertPermission() {}, async callHost() { return result; } });
    await assert.rejects(() => api.set("key", "fixture"), { code: "INTERNAL" });
    await assert.rejects(() => api.delete("key"), { code: "INTERNAL" });
  }
});
