import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { trustedExtensionAgentProviderId } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");

const platform = {
  id: "platform", name: "Platform", vendorKey: "ai-aggregation-platform",
  baseUrl: "https://ai.yykkj.com/v1", authKind: "api_key_and_base_url",
  apiStyle: "chat_completions", enabled: true, hasSecret: true,
  models: [{ id: "fixture-chat", thinkingLevels: ["off"] }, { id: "delegate-chat", thinkingLevels: ["off"], availableForSubagents: true }],
  defaultModelId: "fixture-chat",
};
const foreign = { ...platform, id: "legacy", vendorKey: "openai", baseUrl: "https://api.openai.com/v1" };

function fixture(t, rows = [foreign, platform], definitions = []) {
  const root = mkdtempSync(join(tmpdir(), "pi-platform-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const documents = definitions.map(({ name, model, fallbackModels = [] }) => {
    const path = join(root, `${name}.md`);
    writeFileSync(path, `---\nname: ${name}\ndescription: Fixture reviewer\nmodel: ${model}\nfallbackModels: ${JSON.stringify(fallbackModels)}\n---\nReview the fixture.\n`);
    return { id: name, path };
  });
  const calls = [];
  const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
  const host = {
    isAvailable: () => true,
    call: async (method, input) => {
      calls.push({ method, input });
      switch (method) {
        case "commandShells.list": return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        case "providers.list": return { providers: [...rows] };
        case "providers.getSecret": return { value: input.id === platform.id ? "dummy" : `dummy-${input.id}` };
        case "agents.active": return { subagents: documents };
        case "agents.disabledBuiltins": return { disabled: [] };
        case "skills.active": return { skills: [] };
        case "mcp.active": return { servers: [] };
        case "project.group.context": return { context: null };
        case "project.memory.get": return {};
        default: throw new Error(`Unexpected host call ${method}`);
      }
    },
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Launch must not use the network"); });
  const modelsDevCatalog = { ensureLoaded: async () => true, findModel: () => undefined };
  const providerCatalog = createProviderCatalogRuntime({ getHost: () => host, modelsDevCatalog });
  const oauth = t.mock.fn(async () => { throw new Error("Launch must not use OAuth"); });
  const logs = [];
  const runtime = createSessionLaunchRuntime({
    runtimeState: { host }, logger: { app: (...args) => logs.push(args) },
    userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: root,
    vendorOAuth: { bindingFor: oauth, resolveAuth: oauth }, modelsDevCatalog,
    getWorkspacePath: () => root, pluginActiveInProject: () => true,
    bindingForModel: providerCatalog.bindingForModel,
    effectiveSubagentModelConfig: providerCatalog.effectiveSubagentModelConfig,
    normalizeThinkingLevel: () => "off",
  });
  return {
    calls, fetch, oauth, logs,
    launch: (session = {}, settings = {}, overrides = {}) => runtime.resolveAgentRuntimeLaunch(
      "platform-session", { projectPath: root, ...session }, settings, overrides,
    ),
  };
}

test("a persisted foreign session fails before retrieving either provider's secret", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.launch({ providerId: foreign.id, modelId: "fixture-chat" }, { defaultProviderId: platform.id }), {
    errorCode: "PLATFORM_PROVIDER_REQUIRED",
  });
  assert.deepEqual(f.calls.map(({ method }) => method), ["commandShells.list", "providers.list"]);
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.oauth.mock.callCount(), 0);
});

test("a prompt override cannot select a foreign provider from an otherwise platform session", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.launch({ providerId: platform.id }, {}, { providerId: foreign.id }), {
    errorCode: "PLATFORM_PROVIDER_REQUIRED",
  });
  assert.equal(f.calls.some(({ method }) => method === "providers.getSecret"), false);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test("an extension-owned agent cannot bypass launch through its synthetic provider ID", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.launch({ providerId: trustedExtensionAgentProviderId("fixture/agent") }), {
    errorCode: "PLATFORM_PROVIDER_REQUIRED",
  });
  assert.equal(f.calls.some(({ method }) => method === "providers.getSecret"), false);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test("an empty platform provider set reports missing configuration without unlocking old keys", async (t) => {
  const f = fixture(t, [foreign]);
  await assert.rejects(f.launch({}, { defaultProviderId: foreign.id }), { errorCode: "MODEL_NOT_CONFIGURED" });
  assert.equal(f.calls.some(({ method }) => method === "providers.getSecret"), false);
});

test("a stale foreign default resolves only platform credentials and eligible delegate models", async (t) => {
  const f = fixture(t);
  const result = await f.launch({}, { defaultProviderId: foreign.id });
  assert.equal(result.providerId, platform.id);
  assert.equal(result.modelId, "fixture-chat");
  for (const key of ["id", "name", "vendorKey", "baseUrl", "authKind", "apiStyle"]) {
    assert.equal(result.sidecarParams.provider[key], platform[key]);
  }
  assert.equal(result.sidecarParams.provider.apiKey, "dummy");
  assert.deepEqual(result.sidecarParams.subagentModelKeys, ["ai-aggregation-platform/delegate-chat"]);
  assert.ok(f.calls.some(({ method }) => method === "providers.getSecret"));
  assert.ok(f.calls.filter(({ method }) => method === "providers.getSecret").every(({ input }) => input.id === platform.id));
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.oauth.mock.callCount(), 0);
});

test("definition pins cannot retrieve a foreign key while platform-only private pins remain usable", async (t) => {
  const f = fixture(t, [foreign, platform], [
    { name: "foreign-reviewer", model: "legacy/private-chat" },
    { name: "platform-reviewer", model: "ai-aggregation-platform/private-chat" },
  ]);
  const { sidecarParams } = await f.launch({ providerId: platform.id, modelId: "fixture-chat" });
  assert.equal(sidecarParams.subagentProviders["legacy/private-chat"], undefined);
  assert.equal(sidecarParams.subagentProviders["ai-aggregation-platform/private-chat"].id, platform.id);
  assert.equal(sidecarParams.subagentProviders["ai-aggregation-platform/private-chat"].apiKey, "dummy");
  assert.deepEqual(sidecarParams.subagentModelKeys, ["ai-aggregation-platform/delegate-chat"]);
  assert.ok(f.calls.filter(({ method }) => method === "providers.getSecret").every(({ input }) => input.id === platform.id));
  assert.equal(f.fetch.mock.callCount(), 0);
});

for (const position of ["primary", "fallback"]) {
  for (const reverseRows of [false, true]) {
    test(`an ambiguous ${position} pin stays unavailable with ${reverseRows ? "reversed" : "original"} account order`, async (t) => {
      const personal = { ...platform, name: "Personal", models: [{ id: "fixture-chat", thinkingLevels: ["off"] }] };
      const team = { ...platform, id: "team", name: "Team", models: [
        { id: "delegate-chat", thinkingLevels: ["off"], availableForSubagents: true },
      ] };
      const ambiguous = "ai-aggregation-platform/delegate-chat";
      const f = fixture(t, reverseRows ? [team, personal] : [personal, team], [{
        name: "pinned-reviewer",
        model: position === "primary" ? ambiguous : "Personal/fixture-chat",
        fallbackModels: position === "primary" ? ["team/delegate-chat"] : [ambiguous, "team/delegate-chat"],
      }]);
      const { sidecarParams } = await f.launch({ providerId: personal.id, modelId: "fixture-chat" });
      assert.equal(sidecarParams.subagentProviders[ambiguous], undefined,
        "an opted-in account must not supply credentials for an unresolved definition pin");
      assert.deepEqual(sidecarParams.subagentModelKeys, ["team/delegate-chat"]);
      assert.equal(sidecarParams.subagentProviders["team/delegate-chat"].id, "team");
      assert.equal(sidecarParams.subagentProviders["team/delegate-chat"].apiKey, "dummy-team");
      const definition = sidecarParams.subagents.find(({ name }) => name === "pinned-reviewer");
      assert.deepEqual(definition.model, position === "primary"
        ? { providerId: "ai-aggregation-platform", modelId: "delegate-chat" }
        : { providerId: "Personal", modelId: "fixture-chat" });
      assert.deepEqual(definition.fallbackModels, position === "primary"
        ? [{ providerId: "team", modelId: "delegate-chat" }]
        : [{ providerId: "ai-aggregation-platform", modelId: "delegate-chat" }, { providerId: "team", modelId: "delegate-chat" }]);
      if (position === "fallback") {
        assert.equal(sidecarParams.subagentProviders["Personal/fixture-chat"].id, personal.id);
        assert.equal(sidecarParams.subagentProviders["Personal/fixture-chat"].apiKey, "dummy");
      }
      assert.ok(f.logs.some(([, level, , details]) => level === "warn" && details?.data?.diagnostics?.includes(
        'pinned-reviewer: no enabled provider matches "ai-aggregation-platform"',
      )), "the unresolved pin must keep its existing diagnostic");
      assert.equal(f.fetch.mock.callCount(), 0);
    });
  }
}

test("duplicate platform display names advertise exact account IDs and leave their ambiguous pin unresolved", async (t) => {
  const personal = { ...platform, name: "AI Aggregation Platform" };
  const team = { ...platform, id: "team", name: "AI Aggregation Platform" };
  const f = fixture(t, [personal, team], [{
    name: "pinned-reviewer", model: "ai-aggregation-platform/delegate-chat",
  }]);
  const { sidecarParams } = await f.launch({ providerId: personal.id, modelId: "fixture-chat" });
  assert.equal(sidecarParams.subagentProviders["ai-aggregation-platform/delegate-chat"], undefined);
  assert.deepEqual(sidecarParams.subagentModelKeys, ["platform/delegate-chat", "team/delegate-chat"]);
  assert.equal(sidecarParams.subagentProviders["platform/delegate-chat"].apiKey, "dummy");
  assert.equal(sidecarParams.subagentProviders["team/delegate-chat"].apiKey, "dummy-team");
  assert.equal(f.fetch.mock.callCount(), 0);
});
