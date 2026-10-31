#!/usr/bin/env node
// Real Host persistence, production IPC and Composer; only HTTP is simulated.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { HostProcess } = await import("../packages/host-runtime/dist/index.js");
const { registerProviderIpc } = await import("../apps/desktop/electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../apps/desktop/electron/main/models-dev-catalog.ts");
const { createProviderCatalogRuntime } = await import("../apps/desktop/electron/main/runtime/provider-catalog.ts");
const { composerModelsForProvider } = await import("../apps/desktop/src/lib/composer-models.ts");
const { bindingForCustomModel, IPC } = await import("../packages/shared/dist/index.js");
const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "model-discovery-e2e-"));
const originalFetch = globalThis.fetch;
let host;
let body = { data: [{ id: "alpha" }, { id: "beta" }] };
let offline = false;
try {
  const boot = async () => {
    host = new HostProcess({ binaryPath: join(root, "target/debug/pi-desktop-host-core"), dataDir, onStderr() {} });
    await host.handshake();
  };
  await boot();
  const { provider } = await host.call("providers.create", {
    name: "Discovery fixture", baseUrl: "https://fixture.example/v1", authKind: "none",
    apiStyle: "chat_completions", defaultModelId: "beta",
    models: ["alpha", "beta", "manual"].map(bindingForCustomModel),
  });
  const catalog = new ModelsDevCatalog({ catalogPath: join(root, "apps/desktop/resources/models.dev/api.json") });
  assert.equal(await catalog.loadLocal(), true);
  globalThis.fetch = async () => {
    if (offline) throw new Error("fixture offline");
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const wire = () => {
    const runtime = createProviderCatalogRuntime({ getHost: () => host, modelsDevCatalog: catalog });
    const handlers = new Map();
    registerProviderIpc({ registrar: { handle: (key, handler) => handlers.set(key, handler) },
      getHost: () => host, modelsDevCatalog: catalog, vendorOAuth: {}, logger: { app() {} }, ...runtime });
    return (source = "refresh") => handlers.get(IPC.invoke.providersListModels)({ providerId: provider.id, source });
  };
  let list = wire();
  const choices = result => composerModelsForProvider(provider, result.models).map(row => row.modelId);
  assert.deepEqual(choices(await list()), ["alpha", "beta", "manual"]);
  body = { data: [{ id: "alpha" }] };
  assert.deepEqual(choices(await list()), ["alpha", "manual"]);
  assert.equal((await host.call("providers.get", { id: provider.id })).provider.defaultModelId, provider.defaultModelId);
  assert.deepEqual((await host.call("providers.get", { id: provider.id })).provider.models, provider.models);
  offline = true;
  assert.deepEqual(choices(await list()), ["alpha", "manual"]);
  await host.dispose();
  await boot();
  list = wire();
  assert.deepEqual(choices(await list("cache")), ["alpha", "manual"]);
  offline = false;
  body = { data: [{ id: "alpha" }, { id: "beta" }] };
  assert.deepEqual(choices(await list()), ["alpha", "beta", "manual"]);
  body = { data: [{ id: "ALPHA" }, { id: "BETA" }] };
  assert.deepEqual(choices(await list()), ["alpha", "beta", "manual"]);
  assert.deepEqual(choices(await list("cache")), ["alpha", "beta", "manual"]);
  body = { data: [{ id: "alpha" }], has_more: true };
  assert.deepEqual(choices(await list()), ["alpha", "beta", "manual"]);
  body = { data: [{ id: "alpha" }, {}] };
  assert.deepEqual(choices(await list()), ["alpha", "beta", "manual"]);
  body = { data: [] };
  assert.deepEqual(choices(await list()), ["alpha", "beta", "manual"]);
  body = { data: [{ id: "alpha" }] };
  assert.deepEqual(choices(await list()), ["alpha", "manual"]);
  await host.call("providers.update", { id: provider.id, baseUrl: "https://other.example/v1" });
  assert.deepEqual(choices(await list("cache")), ["alpha", "beta", "manual"]);
  assert.deepEqual(choices(await list()), ["alpha", "beta", "manual"]);
  const legacy = await host.call("providers.create", {
    name: "Legacy fixture", baseUrl: "https://legacy.example/v1", authKind: "none",
    defaultModelId: "legacy", apiStyle: "chat_completions",
  });
  await host.call("providers.cacheModels", { providerId: legacy.provider.id, complete: true,
    models: [{ modelId: "legacy", displayName: "Legacy" }] });
  const legacyCache = await host.call("providers.cacheModels", { providerId: legacy.provider.id, complete: true,
    models: [{ modelId: "new", displayName: "New" }] });
  assert.equal(legacyCache.models.find(row => row.modelId === "legacy").discoveryState, "unlisted");
  console.log("PASS real Host -> IPC -> Composer: removal, offline fallback, restart, recovery, partial/empty answers, manual bindings and endpoint isolation");
} finally {
  globalThis.fetch = originalFetch;
  if (host) await host.dispose();
  await rm(dataDir, { recursive: true, force: true });
}
