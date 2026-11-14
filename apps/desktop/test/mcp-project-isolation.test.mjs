import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { IPC } from "@pi-desktop/shared";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
const { registerMcpIpc } = await import("../electron/main/ipc/mcp-ipc.ts");

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

// Answers the handshake with one tool that reports the process cwd, so a call
// proves which workspace's server served it.
const SERVER = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (let index; (index = input.indexOf("\\n")) >= 0;) {
    const line = input.slice(0, index); input = input.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    let result;
    if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} } };
    else if (request.method === "tools/list") result = { tools: [{ name: "cwd" }] };
    else if (request.method === "tools/call") result = { content: [{ type: "text", text: process.cwd() }] };
    else continue;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
});
`;

async function fixture(t) {
  // Resolve the temp root so it matches the child cwd on macOS (/var -> /private/var).
  const temp = await realpath(await mkdtemp(join(root, "apps/desktop/.mcp-project-isolation-")));
  const projectA = join(temp, "project-a");
  const projectB = join(temp, "project-b");
  await mkdir(projectA);
  await mkdir(projectB);
  const server = join(temp, "server.mjs");
  await writeFile(server, SERVER);
  const userMcp = new UserMcpRuntime({
    createClient: (config) => new McpServerClient(config),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(async () => {
    userMcp.disposeAll();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
  const record = (id, overrides = {}) => ({
    id,
    label: id,
    transport: "stdio",
    command: "node",
    args: [server],
    env: {},
    enabled: true,
    scope: { mode: "global", projects: [] },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
  return { temp, projectA, projectB, userMcp, record };
}

async function sessionLaunch(temp, { host, userMcp }) {
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
  return createSessionLaunchRuntime({
    runtimeState: { host, sidecar: { setVendorAuthBindings() {} }, agentHostBridge: null },
    logger: { app() {} },
    userMcp,
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
}

// #2332: a session launched in project B refreshes B's active MCP list. A turn
// still running in project A must keep calling A's own server.
test("launching a session in another project keeps a running project's MCP tools", async (t) => {
  const { temp, projectA, projectB, userMcp, record } = await fixture(t);
  const demo = record("demo", {
    level: "project",
    projectPath: projectA,
    scope: { mode: "projects", projects: [projectA] },
  });
  const active = new Map([[projectA, [demo]], [projectB, []]]);
  const host = {
    isAvailable: () => true,
    async call(method, params) {
      assert.equal(method, "mcp.active");
      return { servers: active.get(params.projectPath) ?? [] };
    },
  };
  const launch = await sessionLaunch(temp, { host, userMcp });

  await launch.refreshUserMcp(projectA);
  assert.deepEqual((await userMcp.toolsForProject(projectA)).map((tool) => tool.fullName), ["mcp_demo_cwd"]);
  assert.equal((await userMcp.callTool("mcp_demo_cwd", {}, projectA)).content[0].text, projectA);

  await launch.refreshUserMcp(projectB);

  assert.deepEqual(await userMcp.toolsForProject(projectB), []);
  assert.equal((await userMcp.callTool("mcp_demo_cwd", {}, projectA)).content[0].text, projectA);
});

// Settings changes run against the open project, but a saved server can be
// active in several projects: switching it off has to reach all of them.
test("disabling a global server in settings stops it in every project", async (t) => {
  const { projectA, projectB, userMcp, record } = await fixture(t);
  const global = record("shared");
  let enabled = true;
  const refreshUserMcp = async (projectPath) => {
    const servers = enabled ? [global] : [];
    userMcp.setRecords(servers, projectPath ?? null);
    return servers;
  };
  const handlers = new Map();
  registerMcpIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        assert.equal(method, "mcp.setEnabled");
        enabled = false;
        return {};
      },
    }),
    userMcp,
    currentWorkspacePath: () => projectB,
    refreshUserMcp,
    describeError: (error) => error.message,
    sendToRenderer: () => {},
    searchMcpMarket: async () => ({ entries: [] }),
  });
  await refreshUserMcp(projectA);
  await refreshUserMcp(projectB);
  await userMcp.toolsForProject(projectA);
  assert.equal((await userMcp.callTool("mcp_shared_cwd", {}, projectA)).content[0].text, projectA);

  await handlers.get(IPC.invoke.mcpSetEnabled)({ id: "shared", enabled: false });

  assert.deepEqual(await userMcp.toolsForProject(projectA), []);
  await assert.rejects(userMcp.callTool("mcp_shared_cwd", {}, projectA), (error) => {
    assert.equal(error.errorCode, "TOOL_NOT_FOUND");
    return true;
  });
});
