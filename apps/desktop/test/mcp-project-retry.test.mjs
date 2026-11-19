import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
const { registerMcpIpc } = await import("../electron/main/ipc/mcp-ipc.ts");

const SERVER = `
import { existsSync } from "node:fs";
if (!existsSync(process.env.READY_FILE)) process.exit(1);
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

for (const explicitProject of [false, true]) {
  test(`MCP Test connection restores the ${explicitProject ? "selected" : "current"} project's real stdio tools`, async (t) => {
    // Resolve the temp root so it matches the child cwd on macOS (/var -> /private/var).
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-retry-ipc-")));
    const project = mkdtempSync(join(root, "project-"));
    const otherProject = mkdtempSync(join(root, "other-"));
    const server = join(root, "server.mjs");
    const readyFile = join(root, "ready");
    writeFileSync(server, SERVER);
    const record = {
      id: "retry", label: "Retry", transport: "stdio", command: "node", args: [server],
      env: { READY_FILE: readyFile }, enabled: true, scope: { mode: "global", projects: [] },
    };
    const rt = new UserMcpRuntime({
      createClient: (config) => new McpServerClient(config), connectTimeoutMs: 5_000, callTimeoutMs: 5_000,
    });
    t.after(async () => {
      rt.disposeAll();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });
    rt.setRecords([record]);
    assert.deepEqual(await rt.toolsForProject(project), []);
    assert.deepEqual(await rt.toolsForProject(otherProject), []);
    writeFileSync(readyFile, "ready");

    const handlers = new Map();
    const events = [];
    const currentProject = explicitProject ? otherProject : project;
    registerMcpIpc({
      registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
      getHost: () => ({ call: async (method) => {
        assert.equal(method, "mcp.list");
        return { servers: [record] };
      } }),
      userMcp: rt,
      currentWorkspacePath: () => currentProject,
      refreshUserMcp: async (projectPath) => {
        rt.setRecords([record]);
        await rt.toolsForProject(projectPath);
        return [record];
      },
      describeError: (error) => error.message,
      sendToRenderer: (channel, payload) => events.push([channel, payload]),
      searchMcpMarket: async () => ({ entries: [] }),
    });
    const response = await handlers.get(IPC.invoke.mcpTest)({
      id: record.id, ...(explicitProject ? { level: "project", projectPath: project } : {}),
    });
    assert.equal(response.status.state, "ready");
    assert.deepEqual(response.status.toolNames, ["cwd"]);
    assert.ok(events.some(([channel]) => channel === IPC.event.pluginChanged));
    assert.equal((await rt.toolsForProject(project))[0].fullName, "mcp_retry_cwd");
    assert.equal((await rt.toolsForProject(otherProject))[0].fullName, "mcp_retry_cwd");
    const result = await rt.callTool("mcp_retry_cwd", {}, project);
    assert.equal(result.content[0].text.toLowerCase(), project.toLowerCase());
    assert.equal(readFileSync(readyFile, "utf8"), "ready");
  });
}
