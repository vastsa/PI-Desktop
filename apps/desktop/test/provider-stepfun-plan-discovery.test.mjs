/**
 * A subscription endpoint whose model list authenticates differently from its
 * chat route.
 *
 * `https://api.stepfun.com/step_plan/v1` answers generation on Anthropic
 * Messages but accepts its model list only for `Authorization: Bearer`. The
 * row therefore used to derive `anthropic_models` — the style of the wire
 * format it generates in — so the probe sent `x-api-key`, took a 401, and the
 * settings dialog reported "API key rejected" for a valid key. Both surfaces
 * that ask the endpoint have to agree on the credentials that actually answer:
 * the model list and the connection test.
 *
 * This drives the real handlers and the real request builder, stubbing only
 * HTTP and host persistence.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { IPC } = await import("@pi-desktop/shared");

const catalogPath = fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url));

/** The reported row: the StepFun subscription preset, saved as its preset writes it. */
const stepfunPlanRow = {
  id: "stepfun-plan",
  name: "StepFun Plan",
  vendorKey: "stepfun-step-plan",
  enabled: true,
  hasSecret: true,
  authKind: "api_key_and_base_url",
  baseUrl: "https://api.stepfun.com/step_plan/v1",
  apiStyle: "anthropic_messages",
  headers: {},
  models: [],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handlersFor(t, row) {
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true, "the bundled snapshot must load");

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {} });
    return init?.headers?.Authorization === "Bearer sk-secret"
      ? jsonResponse({ data: [{ id: "step-5-preview" }] })
      : jsonResponse({ error: { message: "Incorrect API key provided" } }, 401);
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const handlers = new Map();
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        if (method === "providers.list") return { providers: [row] };
        if (method === "providers.get") return { provider: row };
        if (method === "providers.getSecret") return { value: "sk-secret" };
        if (method === "providers.testConnection") return { ok: true };
        return {};
      },
    }),
    modelsDevCatalog: catalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [row],
    bindingForModel: () => undefined,
  });

  return { calls, handlers };
}

test("the model list of an Anthropic-Messages plan is asked with a Bearer token", async (t) => {
  const { calls, handlers } = await handlersFor(t, stepfunPlanRow);

  const result = await handlers.get(IPC.invoke.providersListModels)({
    providerId: stepfunPlanRow.id,
    source: "refresh",
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.stepfun.com/step_plan/v1/models",
  ]);
  assert.equal(calls[0].headers.Authorization, "Bearer sk-secret");
  assert.equal(calls[0].headers["x-api-key"], undefined, "the model list does not accept x-api-key");
  assert.deepEqual(
    result.models.map((model) => model.modelId),
    ["step-5-preview"],
    "the endpoint's own list is the answer",
  );
  assert.equal(result.source, "remote");
  assert.equal(result.discoveryStyle, "openai_models");
  assert.equal(result.effectiveBaseUrl, "https://api.stepfun.com/step_plan/v1");
});

test("the connection test of that row uses the same credentials as its model list", async (t) => {
  const { calls, handlers } = await handlersFor(t, stepfunPlanRow);

  const result = await handlers.get(IPC.invoke.providersTest)(stepfunPlanRow.id);

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.stepfun.com/step_plan/v1/models",
  ]);
  assert.equal(calls[0].headers.Authorization, "Bearer sk-secret");
  assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.deepEqual(
    { ok: result.ok, network: result.network },
    { ok: true, network: "ok" },
    "a valid key must not be reported as rejected",
  );
});

test("the connection test probes the effective endpoint when a row has an operation suffix", async (t) => {
  const row = {
    ...stepfunPlanRow,
    baseUrl: "https://api.stepfun.com/step_plan/v1/messages",
  };
  const { calls, handlers } = await handlersFor(t, row);

  const result = await handlers.get(IPC.invoke.providersTest)(row.id);

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.stepfun.com/step_plan/v1/models",
  ]);
  assert.equal(calls[0].headers.Authorization, "Bearer sk-secret");
  assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.deepEqual(
    { ok: result.ok, network: result.network },
    { ok: true, network: "ok" },
    "a valid key must not be rejected because the operation suffix was appended",
  );
});

test("the connection test probes the resolved effective endpoint, matching model discovery", async () => {
  const { readMainSource } = await import("./helpers/source-contracts.mjs");
  const source = await readMainSource("ipc/provider-ipc.ts");

  // Contract (#1687): the probe's baseUrl is the profile's effectiveBaseUrl —
  // operation suffixes like a saved `/messages` must not send the connection
  // test to `<endpoint>/messages/models` while the model list on the same
  // page loads from `<endpoint>/models`.
  assert.match(
    source,
    /const\s+profile\s*=\s*inferEndpointProfile\(\{[\s\S]*?baseUrl,[\s\S]*?explicitApiStyle:\s*true,\s*\}\);[\s\S]*?probeProviderEndpoint\(\{[\s\S]*?baseUrl:\s*profile\?\.effectiveBaseUrl\s*\?\?\s*baseUrl,[\s\S]*?discoveryStyle:\s*profile\?\.discoveryStyle,/,
    "the connection test must resolve the endpoint profile once and probe its effectiveBaseUrl",
  );
});
