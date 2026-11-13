import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createComposerCommandService } = await import("../electron/main/ipc/composer-ipc.ts");
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { loadProjectCapabilities } = await import("../electron/main/project-capabilities.ts");

const record = (id, extra = {}) => ({ id, label: id, enabled: true, transport: "http", url: "http://127.0.0.1:1/mcp", ...extra });

test("project choices are read-only, scoped, secret-free and independent of saved selections", async () => {
  const records = [record("docs", { headers: { Authorization: "SECRET-SENTINEL" } }), record("off", { enabled: false }),
    record("elsewhere", { scope: { mode: "projects", projects: ["/elsewhere"] } })];
  let selected = { skillIds: [], mcpServerIds: [] };
  let connections = 0;
  const service = createComposerCommandService({
    plugins: { listLoaded: () => [], getSkills: () => [{ id: "plugin/docs", name: "Docs", pluginId: "on" },
      { id: "plugin/hidden", name: "Hidden", pluginId: "off" }], getCommands: () => [] },
    agentExtensions: { allCommands: () => [] },
    activeUserSkills: async () => [{ id: "user/docs", name: "User docs" }],
    pluginActiveInProject: (id) => id === "on", disabledBuiltinSkills: async () => ["pi-desktop/imagegen"],
    loadComposerTemplatesCached: async () => [], projectCapabilities: async () => selected,
    projectMcpRecords: async () => records,
    userMcp: { listRecords: () => records, listStatuses: () => records.map(r => ({ serverId: r.id, state: "ready", toolCount: 1, toolNames: ["lookup"] })),
      toolsForProject: async () => { connections++; return []; } },
  });
  const catalog = await service.listProjectCapabilities("/repo", false);
  assert.equal(connections, 0);
  assert.deepEqual(catalog.mcpServers, [{ id: "docs", name: "docs" }]);
  assert(catalog.skills.some(s => s.id === "plugin/docs"));
  assert(catalog.skills.some(s => s.id === "user/docs"));
  assert(!catalog.skills.some(s => ["plugin/hidden", "pi-desktop/imagegen"].includes(s.id)));
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET-SENTINEL|127\.0\.0\.1|Authorization/);
  assert(!(await service.buildComposerCommands("/repo")).some(c => ["skill", "mcp"].includes(c.kind)));
  selected = { skillIds: ["plugin/docs"], mcpServerIds: ["docs", "off", "elsewhere"] };
  const commands = await service.buildComposerCommands("/repo");
  assert.deepEqual(commands.filter(c => c.kind === "skill").map(c => c.skillId), ["plugin/docs"]);
  assert.deepEqual(commands.filter(c => c.kind === "mcp" && !c.mcpToolName).map(c => c.mcpServerId), ["docs"]);
});

test("MCP selections prevent connection and guessed dispatch, then honor live revocation", async (t) => {
  let selected = [];
  let connects = 0;
  let calls = 0;
  let connected = false;
  let duringConnect = () => {};
  const tools = [{ name: "lookup" }];
  const runtime = new UserMcpRuntime({ selectedServerIds: async () => selected, createClient: () => ({
    connect: async () => { connects++; connected = true; duringConnect(); return tools; },
    getTools: () => connected ? tools : [], isConnected: () => connected,
    callTool: async () => { calls++; return { content: [{ type: "text", text: "result" }] }; },
    close: () => { connected = false; }, ping: async () => {},
  }) });
  t.after(() => runtime.disposeAll());
  runtime.setRecords([record("docs"), record("off", { enabled: false })]);
  assert.deepEqual(await runtime.toolsForProject("/repo"), []);
  await assert.rejects(runtime.callTool("mcp_docs_lookup", {}, "/repo"), { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(connects, 0);
  selected = ["docs", "off"];
  assert.deepEqual((await runtime.toolsForProject("/repo")).map(tool => tool.fullName), ["mcp_docs_lookup"]);
  await runtime.callTool("mcp_docs_lookup", {}, "/repo");
  assert.equal(calls, 1);
  selected = [];
  await assert.rejects(runtime.callTool("mcp_docs_lookup", {}, "/repo"), { errorCode: "TOOL_NOT_FOUND" });
  selected = ["docs"];
  connected = false;
  duringConnect = () => { selected = []; };
  await assert.rejects(runtime.callTool("mcp_docs_lookup", {}, "/repo"), { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(calls, 1, "revocation during preparation must prevent dispatch");
});

test("project configuration lookup fails closed on Host failure or corrupt selections", async () => {
  assert.equal(await loadProjectCapabilities(null, null), undefined);
  await assert.rejects(loadProjectCapabilities(null, "/repo"), /unavailable/);
  await assert.rejects(loadProjectCapabilities({ call: async () => ({ context: { capabilities: { skillIds: null } } }) }, "/repo"), /Invalid/);
  assert.deepEqual(await loadProjectCapabilities({ call: async () => ({ context: { capabilities: { skillIds: [] } } }) }, "/repo"), { skillIds: [] });
});

for (const failure of ["revocation", "lookup failure"]) {
  test(`MCP connections remain reclaimable after post-connect ${failure}`, async (t) => {
    let reads = 0;
    let rejectRead = Infinity;
    let active = 0;
    let dispatched = 0;
    const tools = [{ name: "lookup" }];
    const runtime = new UserMcpRuntime({
      selectedServerIds: async () => {
        if (++reads !== rejectRead) return ["docs"];
        if (failure === "lookup failure") throw new Error("configuration unavailable");
        return [];
      },
      createClient: () => {
        let connected = false;
        return {
          connect: async () => { connected = true; active++; return tools; },
          getTools: () => connected ? tools : [], isConnected: () => connected,
          callTool: async () => { dispatched++; return "called"; }, ping: async () => {},
          close: () => { if (connected) { connected = false; active--; } },
        };
      },
    });
    t.after(() => runtime.disposeAll());
    runtime.setRecords([{ id: "docs", label: "Docs", enabled: true, transport: "stdio", command: "fixture" }]);
    await runtime.toolsForProject("/workspace/0");
    for (let index = 0; index < 64; index++) {
      rejectRead = reads + 2;
      await assert.rejects(runtime.callTool("mcp_docs_lookup", {}, `/workspace/${index}`),
        failure === "revocation" ? { errorCode: "TOOL_NOT_FOUND" } : /configuration unavailable/);
    }
    rejectRead = Infinity;
    assert.equal(dispatched, 0);
    assert.deepEqual((await runtime.toolsForProject("/workspace/64")).map(tool => tool.fullName), ["mcp_docs_lookup"]);
    assert.equal(active, 64, "rejected calls must release their connection reservations");
  });
}
