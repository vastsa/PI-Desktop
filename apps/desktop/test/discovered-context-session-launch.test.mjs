import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("session launch resolves the saved endpoint's context window", async (t) => {
  const temp = await mkdtemp(join(root, "apps/desktop/.discovered-context-launch-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bundle = join(temp, "session-launch.mjs");
  await build({
    entryPoints: [join(root, "apps/desktop/electron/main/runtime/session-launch.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const { createSessionLaunchRuntime } = await import(pathToFileURL(bundle).href);

  const modelId = "relay/large-model";
  const binding = {
    id: modelId,
    contextWindow: 1_050_000,
    contextWindowSource: "catalog",
    maxTokens: 128_000,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  };
  const provider = {
    id: "relay",
    name: "Relay",
    authKind: "none",
    baseUrl: "http://127.0.0.1:9/v1",
    apiStyle: "responses",
    models: [binding],
  };
  const discoveredModel = {
    providerId: provider.id,
    modelId,
    source: "discovered",
    discoveryState: "published",
    contextWindow: 500_000,
    reportedContextWindow: 500_000,
  };
  let cachedModels = [discoveredModel];
  let cacheError;
  const warnings = [];
  const shell = {
    id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true,
  };
  const host = {
    isAvailable: () => true,
    async call(method, params) {
      switch (method) {
        case "commandShells.list":
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        case "providers.list": return { providers: [provider] };
        case "providers.getSecret": return {};
        case "providers.listModels":
          assert.equal(params.providerId, provider.id);
          assert.deepEqual(params.endpoint, { baseUrl: provider.baseUrl, apiStyle: provider.apiStyle });
          if (cacheError) throw cacheError;
          return { models: cachedModels };
        case "skills.disabledBuiltins": return { disabled: [] };
        case "skills.active": return { skills: [] };
        case "mcp.active": return { servers: [] };
        case "agents.active": return { subagents: [] };
        case "agents.disabledBuiltins": return { disabled: [] };
        default: throw new Error(`Unexpected fixture Host method: ${method}`);
      }
    },
  };
  const launchRuntime = createSessionLaunchRuntime({
    runtimeState: { host, sidecar: { setVendorAuthBindings() {} }, agentHostBridge: null },
    logger: { app(...args) { warnings.push(args); } },
    userMcp: { setRecords() {}, async toolsForProject() { return []; } },
    plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(),
    dataDir: temp,
    vendorOAuth: { async bindingFor() { return undefined; } },
    modelsDevCatalog: {
      async ensureLoaded() {},
      configureAccount() {},
      modelConfigFor: () => ({
        source: "models.dev", name: "Large model", input: ["text"], reasoning: false,
        contextWindow: 1_050_000, catalogContextWindow: 1_050_000, maxTokens: 128_000,
      }),
    },
    getWorkspacePath: () => null,
    pluginActiveInProject: () => true,
    bindingForModel: (row, selectedId) => row.models?.find((entry) => entry.id === selectedId),
    effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
    normalizeThinkingLevel: () => "off",
  });
  async function launchModel() {
    const { sidecarParams } = await launchRuntime.resolveAgentRuntimeLaunch(
      "session-fixture", { providerId: provider.id, modelId }, { defaultMode: "agent" },
    );
    return sidecarParams.provider.modelConfig;
  }

  const discovered = await launchModel();
  assert.equal(discovered.contextWindow, 500_000);
  assert.equal(discovered.maxTokens, 128_000);

  await t.test("a user window takes precedence", async () => {
    provider.models = [{ ...binding, contextWindow: 300_000, contextWindowSource: "user" }];
    assert.equal((await launchModel()).contextWindow, 300_000);
    provider.models = [binding];
  });

  await t.test("a legacy binding keeps its saved window", async () => {
    provider.models = [{ ...binding, contextWindow: 350_000, contextWindowSource: undefined }];
    assert.equal((await launchModel()).contextWindow, 350_000);
    provider.models = [binding];
  });

  await t.test("an enriched cache row without a report leaves the catalog window in place", async () => {
    cachedModels = [{ ...discoveredModel, reportedContextWindow: undefined }];
    assert.equal((await launchModel()).contextWindow, 1_050_000);
  });

  await t.test("another route and an unlisted record leave the catalog window in place", async () => {
    cachedModels = [
      { ...discoveredModel, modelId: "another-relay/large-model" },
      { ...discoveredModel, discoveryState: "unlisted" },
    ];
    assert.equal((await launchModel()).contextWindow, 1_050_000);
  });

  await t.test("a cache read failure leaves the catalog window in place", async () => {
    cacheError = new Error("fixture cache read failure");
    assert.equal((await launchModel()).contextWindow, 1_050_000);
    assert.ok(warnings.some(([, level, message]) => level === "warn" && message.includes("cache")));
  });
});
