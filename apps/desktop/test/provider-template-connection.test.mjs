import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

test("custom inference connection check reports unsupported without refreshing auth or generating", async () => {
  const handlers = new Map(), calls = [];
  registerProviderIpc({ registrar: { handle: (channel, fn) => handlers.set(channel, fn) }, getHost: () => ({ call: async method => {
    calls.push(method);
    if (method === "providers.testConnection") return { ok: true };
    if (method === "providers.get") return { provider: { authKind: "oauth", pluginModelOperations: { chat: ["chat"] } } };
    throw new Error("Unexpected external call");
  } }), vendorOAuth: { resolveAuth: () => { throw new Error("Must not refresh for an unsupported check"); } },
    modelsDevCatalog: {}, logger: { app: () => {} }, enrichProvider: p => p, listRuntimeProviders: async () => [], enrichProviderList: x => x, bindingForModel: () => undefined });
  const result = await handlers.get(IPC.invoke.providersTest)("account");
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UNSUPPORTED");
  assert.equal(result.network, "skipped");
  assert.deepEqual(calls, ["providers.testConnection", "providers.get"]);
});
