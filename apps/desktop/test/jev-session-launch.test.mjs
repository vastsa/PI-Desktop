import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("session launch resolves Jev credentials only for opted-in Agent mode", async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.jev-launch-test-"));
  const priorHome = process.env.HOME;
  process.env.HOME = temp;
  try {
    const bundle = join(temp, "session-launch.mjs");
    await build({
      entryPoints: [join(root, "apps/desktop/electron/main/runtime/session-launch.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const { createSessionLaunchRuntime } = await import(pathToFileURL(bundle).href);
    const provider = {
      id: "fixture-provider",
      name: "Fixture provider",
      authKind: "none",
      apiStyle: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      enabled: true,
      defaultModelId: "fixture-model",
      models: [],
    };
    const keyReads = [];
    const logs = [];
    let failJevSecretRead = false;
    const host = {
      isAvailable: () => true,
      async call(method, input) {
        if (method === "commandShells.list") {
          const shell = {
            id: "bash",
            label: "Bash",
            dialect: "posix",
            available: true,
            isDefault: true,
          };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return { value: "" };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "agents.active") return { subagents: [] };
        if (method === "agents.disabledBuiltins") return { disabled: [] };
        if (method === "secrets.getForRuntime") {
          keyReads.push(input);
          if (failJevSecretRead) throw new Error("private fixture detail");
          return { value: "jev-launch-fixture-key" };
        }
        throw new Error("Unexpected fixture Host method: " + method);
      },
    };
    const dependencies = {
      runtimeState: {
        host,
        sidecar: { setVendorAuthBindings() {} },
        agentHostBridge: null,
      },
      logger: { app(...args) { logs.push(args); } },
      userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: {
        getTools: () => [],
        getSkills: () => [],
        listLoaded: () => [],
        getAgentExtensions: () => [],
      },
      sessionProjects: new Map(),
      dataDir: temp,
      vendorOAuth: { async bindingFor() { return undefined; } },
      modelsDevCatalog: {
        async ensureLoaded() {},
        configureAccount() {},
        findModel() { return undefined; },
      },
      getWorkspacePath: () => null,
      pluginActiveInProject: () => true,
      bindingForModel: () => undefined,
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: () => "off",
    };
    const launchRuntime = createSessionLaunchRuntime(dependencies);
    const launch = async (mode, jevEnabled) =>
      launchRuntime.resolveAgentRuntimeLaunch(
        "session-fixture",
        { providerId: provider.id, modelId: provider.defaultModelId },
        {
          defaultProviderId: provider.id,
          defaultModelId: provider.defaultModelId,
          defaultMode: mode,
          jevEnabled,
        },
      );

    const enabledAgent = await launch("agent", true);
    assert.equal(enabledAgent.sidecarParams.jevApiKey, "jev-launch-fixture-key");
    assert.equal(enabledAgent.sidecarParams.provider.apiKey, "");
    assert.deepEqual(keyReads, [{ secretRef: "secret:app:typesafe-jev" }]);

    keyReads.length = 0;
    const disabledAgent = await launch("agent", false);
    assert.equal("jevApiKey" in disabledAgent.sidecarParams, false);
    assert.deepEqual(keyReads, []);

    const plan = await launch("plan", true);
    assert.equal("jevApiKey" in plan.sidecarParams, false);
    assert.deepEqual(keyReads, []);

    failJevSecretRead = true;
    const unavailable = await launch("agent", true);
    assert.equal("jevApiKey" in unavailable.sidecarParams, false);
    assert.equal(JSON.stringify(logs).includes("private fixture detail"), false);
    assert.deepEqual(logs, [[
      "session",
      "warn",
      "Jev API key could not be loaded",
      { sessionId: "session-fixture" },
    ]]);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(temp, { recursive: true, force: true });
  }
});
