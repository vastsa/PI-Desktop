import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginProviderInferenceBroker } = await import("../electron/main/plugin-provider-inference.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("account deletion cancels only its image call, drops late output and releases completed calls", async () => {
  const started = { a: deferred(), b: deferred() };
  const replies = { a: deferred(), b: deferred() };
  const closed = [];
  const signals = {};
  const runtime = new AbortController();
  const broker = new PluginProviderInferenceBroker({
    plugins: {
      providerInferenceBinding: row => ({ version: 1, pluginId: "fixture.images", contributionId: "gateway", templateId: "gateway", accountId: row.id, runtimeId: "runtime", images: true }),
      providerInferenceSignal: () => runtime.signal,
      invokeProviderInference: async (binding, operation, _payload, signal) => {
        if (operation === "close") { closed.push(binding.accountId); return {}; }
        signals[binding.accountId] = signal;
        started[binding.accountId].resolve();
        return replies[binding.accountId].promise;
      },
    },
    credential: async id => ({ apiKey: `synthetic-${id}` }), reportError: error => { throw error; },
  });
  const generate = id => broker.images({ id, ownerPluginId: "fixture.images", pluginTemplateId: "gateway", pluginTemplateVersion: 1 }, "image")
    .generateImages({ id: "image", api: "fixture", provider: id }, { input: [{ type: "text", text: "cover" }] });
  const a = generate("a");
  const b = generate("b");
  await Promise.all([started.a.promise, started.b.promise]);
  broker.invalidateProvider("a");
  assert.equal(signals.a.aborted, true);
  assert.equal(signals.b.aborted, false);
  const rejected = assert.rejects(a, /abort/i);
  replies.a.resolve({ images: [{ type: "image", mimeType: "image/png", data: png }] });
  replies.b.resolve({ images: [{ type: "image", mimeType: "image/png", data: png }] });
  await rejected;
  assert.equal((await b).stopReason, "stop");
  broker.invalidateProvider("b");
  broker.clear();
  assert.deepEqual(closed, ["a"], "completed/aborted calls must not remain registered");
});
