import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

// ADR 0329: an isolated session reads files (AGENTS.md) from its worktree while
// project-keyed configuration (group instructions, memory) stays on the project.
test("an isolated session launches in its worktree with its project's configuration", async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.isolated-launch-test-"));
  const priorHome = process.env.HOME;
  process.env.HOME = temp;
  try {
    const project = join(temp, "project");
    const worktree = join(temp, "worktrees", "project-1", "s1");
    await mkdir(project, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "MAIN CHECKOUT RULES\n");
    await writeFile(join(worktree, "AGENTS.md"), "SESSION BRANCH RULES\n");

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
    const groupContextPaths = [];
    let locationAvailable = true;
    const host = {
      isAvailable: () => true,
      async call(method, input) {
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
        if (method === "worktree.location") {
          assert.deepEqual(input, { sessionId: "session-fixture" });
          if (!locationAvailable) throw new Error("the isolated worktree folder no longer exists");
          return { path: worktree };
        }
        if (method === "project.group.context") {
          groupContextPaths.push(input.path);
          return {
            context: {
              roots: [{ path: project }, { path: join(temp, "other-root") }],
              instructions: "GROUP NOTES",
              memory: { content: "PROJECT MEMORY" },
            },
          };
        }
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
      bindingForModel: () => undefined,
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: () => "off",
    });
    const settings = { defaultProviderId: provider.id, defaultModelId: provider.defaultModelId };
    const launch = (session) =>
      launchRuntime.resolveAgentRuntimeLaunch(
        "session-fixture",
        { providerId: provider.id, modelId: provider.defaultModelId, projectPath: project, ...session },
        settings,
      );
    const text = (instructions) => JSON.stringify(instructions?.entries ?? []);

    const isolated = await launch({ worktree: { branch: "pi-desktop/s1", status: "active" } });
    assert.equal(isolated.projectPath, project);
    assert.equal(isolated.workspaceRoot, worktree);
    assert.equal(isolated.sidecarParams.projectPath, project);
    assert.equal(isolated.sidecarParams.workspaceRoot, worktree);
    const isolatedText = text(isolated.sidecarParams.projectInstructions);
    assert.match(isolatedText, /SESSION BRANCH RULES/);
    assert.doesNotMatch(isolatedText, /MAIN CHECKOUT RULES/);
    assert.match(isolatedText, /GROUP NOTES/);
    assert.doesNotMatch(isolatedText, /Additional root/);
    assert.equal(isolated.sidecarParams.projectMemory, "PROJECT MEMORY");
    assert.deepEqual(groupContextPaths, [project]);

    const ordinary = await launch({});
    assert.equal(ordinary.workspaceRoot, undefined);
    assert.equal("workspaceRoot" in ordinary.sidecarParams, false);
    const ordinaryText = text(ordinary.sidecarParams.projectInstructions);
    assert.match(ordinaryText, /MAIN CHECKOUT RULES/);
    assert.match(ordinaryText, /Additional root/);

    locationAvailable = false;
    await assert.rejects(
      launch({ worktree: { branch: "pi-desktop/s1", status: "missing" } }),
      /no longer exists/,
    );
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(temp, { recursive: true, force: true });
  }
});
