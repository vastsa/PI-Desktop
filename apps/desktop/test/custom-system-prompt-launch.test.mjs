import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");

// Issue #542: pi CLI's SYSTEM.md / APPEND_SYSTEM.md must be discovered at
// launch with pi's precedence (project .pi/ over ~/.pi/agent/) and reach the
// sidecar params that compose the system prompt. The home directory is
// redirected through the import hook below, so a real global file is read.
const workspace = mkdtempSync(join(tmpdir(), "pi-csp-ws-"));

test.after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
const provider = {
  id: "fixture-provider", vendorKey: "fixture", name: "Fixture", enabled: true,
  authKind: "none", baseUrl: "http://127.0.0.1:1/v1", apiStyle: "openai-chat",
  models: [{ id: "parent", thinkingLevels: ["off"] }],
};

function launchRuntime() {
  return createSessionLaunchRuntime({
    runtimeState: { host: {
      isAvailable: () => true,
      call: async (method) => {
        if (method === "commandShells.list") return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return {};
        if (method === "agents.active") return { subagents: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "project.memory.get") return {};
        throw new Error(`Unexpected host call ${method}`);
      },
    } },
    logger: { app() {} }, userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: workspace, vendorOAuth: {},
    modelsDevCatalog: { ensureLoaded: async () => {}, findModel: () => undefined },
    getWorkspacePath: () => workspace, pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models.find((m) => m.id === id),
    modelsDevModelFor: () => undefined,
    effectiveSubagentModelConfig: () => ({}),
    normalizeThinkingLevel: () => "off",
  });
}

async function launchParams(runtime) {
  const launch = await runtime.resolveAgentRuntimeLaunch("session", {
    providerId: provider.id, modelId: "parent", projectPath: workspace,
  }, {});
  return launch.sidecarParams;
}

// The global (~/.pi/agent) precedence and per-kind independence are covered
// against injectable directories in packages/agent-runtime/src/custom-system-prompt.test.ts;
// this suite covers the real user path through the launch: files on disk in
// <workspace>/.pi reach sidecarParams, and removing them reverts to default.
test("launch discovers project custom system prompt files (issue #542)", async () => {
  const runtime = launchRuntime();

  // No files: no custom prompt, prompt stays the composed default.
  assert.equal((await launchParams(runtime)).customSystemPrompt, undefined);

  // Project .pi/SYSTEM.md replaces the persona.
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "SYSTEM.md"), "MARKER-PROJECT-PERSONA");
  assert.deepEqual((await launchParams(runtime)).customSystemPrompt, {
    replace: "MARKER-PROJECT-PERSONA",
  });

  // Project .pi/APPEND_SYSTEM.md is discovered independently.
  writeFileSync(join(workspace, ".pi", "APPEND_SYSTEM.md"), "MARKER-PROJECT-APPEND");
  assert.deepEqual((await launchParams(runtime)).customSystemPrompt, {
    replace: "MARKER-PROJECT-PERSONA", append: "MARKER-PROJECT-APPEND",
  });

  // Deleting the files reverts the launch to the default prompt.
  rmSync(join(workspace, ".pi"), { recursive: true, force: true });
  assert.equal((await launchParams(runtime)).customSystemPrompt, undefined);
});
