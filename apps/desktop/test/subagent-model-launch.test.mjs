import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilitiesFromModelConfig, modelConfigWithBinding } from "@pi-desktop/agent-runtime";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");

test("launch resolves definition-only pins without granting Task.model selection (#286)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-model-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "reviewer.md");
  writeFileSync(path, "---\nname: private-reviewer\ndescription: Fixture reviewer\nmodel: fixture/private\nfallbackModels: [fixture/backup]\n---\nInspect the fixture.\n");
  const provider = {
    id: "fixture-provider", vendorKey: "fixture", name: "Fixture", enabled: true,
    authKind: "none", baseUrl: "http://127.0.0.1:1/v1", apiStyle: "openai-chat",
    models: [
      { id: "parent" }, { id: "private", availableForSubagents: false },
      { id: "allowed", availableForSubagents: true },
    ].map((binding) => ({ ...binding, thinkingLevels: ["off"] })),
  };
  const providers = [provider];
  const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
  const runtime = createSessionLaunchRuntime({
    runtimeState: { host: {
      isAvailable: () => true,
      call: async (method) => {
        if (method === "commandShells.list") return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        if (method === "providers.list") return { providers };
        if (method === "providers.getSecret") return {};
        if (method === "agents.active") return { subagents: [{ id: "reviewer", path }] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "project.memory.get") return {};
        throw new Error(`Unexpected host call ${method}`);
      },
    } },
    logger: { app() {} }, userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: root, vendorOAuth: {},
    modelsDevCatalog: { ensureLoaded: async () => {}, findModel: () => undefined },
    getWorkspacePath: () => root, pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models.find((m) => m.id === id),
    modelsDevModelFor: () => undefined,
    effectiveSubagentModelConfig: (row, id, catalog) => {
      const modelConfig = modelConfigWithBinding(catalog, row.models.find((m) => m.id === id));
      return { modelConfig, capabilities: capabilitiesFromModelConfig(modelConfig) };
    },
    normalizeThinkingLevel: () => "off",
  });
  const launch = () => runtime.resolveAgentRuntimeLaunch("session", {
    providerId: provider.id, modelId: "parent", projectPath: root,
  }, {});
  const initial = (await launch()).sidecarParams;
  assert.ok(initial.subagentProviders["fixture/private"]);
  assert.ok(initial.subagentProviders["fixture/backup"]);
  assert.deepEqual(initial.subagents.find((d) => d.name === "private-reviewer").fallbackModels, [{ providerId: "fixture", modelId: "backup" }]);
  assert.deepEqual(initial.subagentModelKeys, ["fixture/allowed"]);
  assert.equal(initial.subagents.find((d) => d.name === "private-reviewer").model.modelId, "private");

  // A pin already in the resolved map still needs an independent opt-in.
  provider.models[1].availableForSubagents = true;
  const optedIn = (await launch()).sidecarParams;
  assert.deepEqual(optedIn.subagentModelKeys, ["fixture/private", "fixture/allowed"]);
  provider.models[1].availableForSubagents = false;
  provider.models[2].availableForSubagents = false;
  const revoked = (await launch()).sidecarParams;
  assert.ok(revoked.subagentProviders["fixture/private"]);
  assert.deepEqual(revoked.subagentModelKeys, []);

  // A second configured account sharing the vendor alias cannot lend its
  // opt-in to the first account's private pin.
  providers.push({ ...provider, id: "other-account", name: "Other", models: [
    { id: "private", availableForSubagents: true, thinkingLevels: ["off"] },
  ] });
  const collision = (await launch()).sidecarParams;
  assert.equal(collision.subagentProviders["fixture/private"].id, provider.id);
  assert.equal(collision.subagentProviders["other-account/private"].id, "other-account");
  assert.deepEqual(collision.subagentModelKeys, ["other-account/private"]);
});
