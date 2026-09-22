import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createExtensionProviderAccess } = await import(
  "../electron/main/runtime/extension-provider-access.ts"
);

const MODELS = [
  {
    providerId: "provider-one",
    providerName: "Provider One",
    modelId: "catalog-model",
    label: "catalog-model (Provider One)",
    baseUrl: "https://models.example/v1",
    supportsReasoning: false,
    supportsImages: false,
    hasSecret: true,
    hasOauth: false,
    authKind: "api_key",
    toolCall: true,
    thinkingLevels: ["off"],
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
];

function accessFor({
  extensions,
  permissions = {},
  projectPath = null,
  sessionId = "session-one",
  // main owns this map; a session id absent from it is refused without a read.
  sessionProjects = new Map([[sessionId, projectPath]]),
  activeInProject = () => true,
  catalogModels = MODELS,
  catalog = null,
} = {}) {
  const audits = [];
  const calls = [];
  const access = createExtensionProviderAccess({
    catalog: catalog ?? {
      listReadyModels: async () => catalogModels,
    },
    getHost: () => ({
      call: async (method, params) => {
        calls.push({ method, params });
        throw new Error(`unexpected host call ${method}`);
      },
    }),
    activeInProject,
    sessionProjects,
    audit: (entry) => audits.push(entry),
    plugins: {
      getAgentExtensions: () => extensions,
      pluginHasPermission: (pluginId, permission) =>
        (permissions[pluginId] ?? []).includes(permission),
    },
  });
  return { access, audits, calls };
}

test("denies without the grant and audits the denial with identity", async () => {
  const { access, audits, calls } = accessFor({
    extensions: [{ id: "extension-a", pluginId: "plugin-a" }],
    permissions: { "plugin-a": ["agent.extension"] },
  });

  assert.deepEqual(await access.listProviderModels({ sessionId: "session-one" }), {
    models: [],
  });
  assert.deepEqual(calls, []);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    api: "models.list",
    ok: false,
    errorCode: "PERMISSION_DENIED",
    count: 0,
    sessionId: "session-one",
    pluginIds: ["plugin-a"],
    ts: audits[0].ts,
  });
  assert.equal(typeof audits[0].ts, "number");
});

test("answers the ready catalogue with the grant and audits the row count", async () => {
  const { access, audits } = accessFor({
    extensions: [{ id: "extension-a", pluginId: "plugin-a" }],
    permissions: { "plugin-a": ["agent.extension", "models.list"] },
    projectPath: "/workspace/demo",
  });

  const result = await access.listProviderModels({ sessionId: "session-one" });
  assert.deepEqual(result, { models: MODELS });
  assert.deepEqual(audits, [
    {
      api: "models.list",
      ok: true,
      count: 1,
      sessionId: "session-one",
      pluginIds: ["plugin-a"],
      ts: audits[0].ts,
    },
  ]);
});

test("grants when either contributing plugin holds models.list", async () => {
  const { access } = accessFor({
    extensions: [
      { id: "extension-a", pluginId: "plugin-a" },
      { id: "extension-b", pluginId: "plugin-b" },
    ],
    permissions: {
      "plugin-a": ["agent.extension"],
      "plugin-b": ["agent.extension", "models.list"],
    },
  });

  const result = await access.listProviderModels({ sessionId: "session-one" });
  assert.deepEqual(result.models, MODELS);
});

test("ignores extensions whose plugin is out of the session's project scope", async () => {
  const { access, audits } = accessFor({
    extensions: [{ id: "extension-a", pluginId: "plugin-a" }],
    permissions: { "plugin-a": ["agent.extension", "models.list"] },
    activeInProject: (pluginId, projectPath) =>
      pluginId === "plugin-a" && projectPath === "/workspace/demo",
  });

  // The session resolves to another project, so its extension set is empty.
  assert.deepEqual(await access.listProviderModels({ sessionId: "session-one" }), {
    models: [],
  });
  assert.equal(audits[0].ok, false);
});

test("denies an unidentified caller instead of trusting the wire", async () => {
  const { access, audits, calls } = accessFor({
    extensions: [{ id: "extension-a", pluginId: "plugin-a" }],
    permissions: { "plugin-a": ["agent.extension", "models.list"] },
  });

  assert.deepEqual(await access.listProviderModels({}), { models: [] });
  assert.deepEqual(await access.listProviderModels(null), { models: [] });
  assert.deepEqual(await access.listProviderModels({ sessionId: "  " }), {
    models: [],
  });
  assert.deepEqual(await access.listProviderModels({ sessionId: 42 }), {
    models: [],
  });
  // No session was named, so no host call could resolve a subject.
  assert.deepEqual(calls, []);
  assert.equal(audits.length, 4);
  assert.equal(audits.every((entry) => entry.ok === false), true);
  assert.equal(audits.every((entry) => entry.pluginIds.length === 0), true);
});

test("denies a session id main does not own without reading the catalogue", async () => {
  const { access, audits, calls } = accessFor({
    extensions: [{ id: "extension-a", pluginId: "plugin-a" }],
    permissions: { "plugin-a": ["agent.extension", "models.list"] },
    // main knows only `session-one`, so a sibling's id cannot borrow its grant.
    sessionProjects: new Map([["session-one", null]]),
  });

  assert.deepEqual(
    await access.listProviderModels({ sessionId: "session-borrowed" }),
    { models: [] },
  );
  assert.deepEqual(calls, []);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    api: "models.list",
    ok: false,
    errorCode: "PERMISSION_DENIED",
    count: 0,
    sessionId: "session-borrowed",
    pluginIds: [],
    ts: audits[0].ts,
  });
});

test("rejects when the catalogue itself is unreachable and leaves a trace", async () => {
  const { access, audits } = accessFor({
    extensions: [{ id: "extension-a", pluginId: "plugin-a" }],
    permissions: { "plugin-a": ["agent.extension", "models.list"] },
  });
  const failing = createExtensionProviderAccess({
    catalog: {
      listReadyModels: async () => {
        throw new Error("host unavailable");
      },
    },
    getHost: () => ({
      call: async (method) => {
        throw new Error(`unexpected host call ${method}`);
      },
    }),
    activeInProject: () => true,
    sessionProjects: new Map([["session-one", null]]),
    audit: (entry) => audits.push(entry),
    plugins: {
      getAgentExtensions: () => [{ id: "extension-a", pluginId: "plugin-a" }],
      pluginHasPermission: () => true,
    },
  });

  // An unreachable host and a host with no ready models must not look alike.
  await assert.rejects(
    () => failing.listProviderModels({ sessionId: "session-one" }),
    /host unavailable/,
  );
  // A granted call that then fails still leaves an audit row.
  assert.deepEqual(audits, [
    {
      api: "models.list",
      ok: false,
      errorCode: "UNSUPPORTED",
      count: 0,
      sessionId: "session-one",
      pluginIds: ["plugin-a"],
      ts: audits[0].ts,
    },
  ]);
  // The same access object still answers once the catalogue recovers.
  assert.deepEqual(await access.listProviderModels({ sessionId: "session-one" }), {
    models: MODELS,
  });
});
