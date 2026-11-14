import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

// A faithful stand-in for the catalog runtime's own binding lookup (same
// case-insensitive complete-id rule as bindingForModel in provider-catalog).
const bindingForModel = (provider, modelId) =>
  provider.models?.find(
    (binding) => binding.id.trim().toLowerCase() === modelId.trim().toLowerCase(),
  );

test("session launch honors a binding's image pin even when the catalog misses the model", async () => {
  // #2120: a custom provider serves the model under one spelling while the
  // catalog (or an alias/id mismatch) resolves nothing, so the raw catalog
  // config has no image input. The binding's explicit supportsImages pin is
  // the escape hatch, and the send path must honor it — the settings switch
  // already shows vision, and dropping it leaves images attached as @path
  // text the model cannot read.
  const temp = await mkdtemp(join(root, "apps/desktop/.vision-pin-launch-test-"));
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
      id: "custom-provider",
      name: "Custom",
      authKind: "none",
      apiStyle: "chat_completions",
      baseUrl: "http://127.0.0.1:9/v1",
      enabled: true,
      defaultModelId: "Agents-A1",
      models: [
        {
          id: "Agents-A1",
          contextWindow: 128_000,
          maxTokens: 8_192,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          supportsImages: true,
        },
      ],
    };
    const host = {
      isAvailable: () => true,
      async call(method) {
        if (method === "commandShells.list") {
          const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return { value: "" };
        if (method === "skills.disabledBuiltins") return { disabled: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "agents.active") return { subagents: [] };
        if (method === "agents.disabledBuiltins") return { disabled: [] };
        throw new Error("Unexpected fixture Host method: " + method);
      },
    };
    const launchRuntime = createSessionLaunchRuntime({
      runtimeState: { host, sidecar: { setVendorAuthBindings() {} }, agentHostBridge: null },
      logger: { app() {} },
      userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
      sessionProjects: new Map(),
      dataDir: temp,
      vendorOAuth: { async bindingFor() { return undefined; } },
      // No models.dev record for this custom endpoint: the raw catalog answer
      // is the generic shape, whose input carries text only.
      modelsDevCatalog: { async ensureLoaded() {}, configureAccount() {}, findModel() { return undefined; } },
      getWorkspacePath: () => null,
      pluginActiveInProject: () => true,
      bindingForModel,
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: () => "off",
    });
    const { sidecarParams } = await launchRuntime.resolveAgentRuntimeLaunch(
      "session-fixture",
      { providerId: provider.id, modelId: "Agents-A1" },
      { defaultProviderId: provider.id, defaultModelId: "Agents-A1", defaultMode: "agent" },
    );
    assert.equal(sidecarParams.provider.supportsVision, true,
      "the binding's image pin must reach the send path even on a catalog miss");
    assert.ok(
      sidecarParams.provider.modelConfig.input.includes("image"),
      "the adapter-facing input modalities must carry image",
    );
  } finally {
    process.env.HOME = priorHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("session launch keeps the catalog answer when no binding is stored", async () => {
  // Without a stored binding there is no override to apply: the generic
  // catalog shape stands, images stay out, and the previous behavior holds.
  const temp = await mkdtemp(join(root, "apps/desktop/.vision-nobinding-launch-test-"));
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
      id: "custom-provider",
      name: "Custom",
      authKind: "none",
      apiStyle: "chat_completions",
      baseUrl: "http://127.0.0.1:9/v1",
      enabled: true,
      defaultModelId: "mystery-model",
      models: [],
    };
    const host = {
      isAvailable: () => true,
      async call(method) {
        if (method === "commandShells.list") {
          const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return { value: "" };
        if (method === "skills.disabledBuiltins") return { disabled: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "agents.active") return { subagents: [] };
        if (method === "agents.disabledBuiltins") return { disabled: [] };
        throw new Error("Unexpected fixture Host method: " + method);
      },
    };
    const launchRuntime = createSessionLaunchRuntime({
      runtimeState: { host, sidecar: { setVendorAuthBindings() {} }, agentHostBridge: null },
      logger: { app() {} },
      userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
      sessionProjects: new Map(),
      dataDir: temp,
      vendorOAuth: { async bindingFor() { return undefined; } },
      modelsDevCatalog: { async ensureLoaded() {}, configureAccount() {}, findModel() { return undefined; } },
      getWorkspacePath: () => null,
      pluginActiveInProject: () => true,
      bindingForModel,
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: () => "off",
    });
    const { sidecarParams } = await launchRuntime.resolveAgentRuntimeLaunch(
      "session-fixture",
      { providerId: provider.id, modelId: "mystery-model" },
      { defaultProviderId: provider.id, defaultModelId: "mystery-model", defaultMode: "agent" },
    );
    assert.equal(sidecarParams.provider.supportsVision, false);
    assert.equal(sidecarParams.provider.modelConfig.input.includes("image"), false);
  } finally {
    process.env.HOME = priorHome;
    await rm(temp, { recursive: true, force: true });
  }
});
