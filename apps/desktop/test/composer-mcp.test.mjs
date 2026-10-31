import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createComposerCommandService } = await import("../electron/main/ipc/composer-ipc.ts");

const record = (id, extra = {}) => ({ id, label: "Documentation", transport: "http", enabled: true, createdAt: "", updatedAt: "", ...extra });
const ready = (serverId) => ({ serverId, state: "ready", toolCount: 1, toolNames: ["search"], updatedAt: 0 });
function service(records, statuses) {
  return createComposerCommandService({
    plugins: { listLoaded: () => [], getSkills: () => [], getCommands: () => [] },
    agentExtensions: { allCommands: () => [] },
    activeUserSkills: async () => [], pluginActiveInProject: () => true,
    loadComposerTemplatesCached: async () => [],
    userMcp: { listRecords: () => records, listStatuses: () => statuses, toolsForProject: async () => [] },
  });
}
test("slash source lists only ready MCP servers in the current project without credentials", async () => {
  const records = [record("docs", { url: "https://private.invalid", headers: { Authorization: "secret" } }), record("off", { enabled: false }), record("other", { scope: { mode: "projects", projects: ["/other"] } }), record("idle")];
  const commands = await service(records, records.slice(0, 3).map(r => ready(r.id))).buildComposerCommands("/repo");
  const mcp = commands.filter(c => c.kind === "mcp");
  assert.equal(mcp.length, 2);
  assert.equal(mcp[0].name, "mcp:docs");
  assert.equal(mcp[0].title, "Documentation");
  assert.doesNotMatch(JSON.stringify(mcp), /secret|private.invalid/);
});

const { expandMcpInvocation } = await import("../electron/main/composer-mcp.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { findSkillMentions, formatCommandInsert, IPC } = await import("@pi-desktop/shared");

test("selection uses stable encoded IDs even when labels match", async () => {
  const records = [record("docs one"), record("docs/two")];
  const commands = await service(records, records.map(r => ready(r.id))).buildComposerCommands(null);
  assert.deepEqual(commands.filter(c => c.kind === "mcp" && !c.mcpToolName).map(c => c.name), ["mcp:docs%20one", "mcp:docs%2Ftwo"]);
  const input = "/mcp:docs%2Ftwo find API docs";
  const expansion = expandMcpInvocation(input, commands);
  assert.equal(expansion.command, input);
  assert.deepEqual(expansion.mcpServerIds, ["docs/two"]);
  assert.doesNotMatch(expansion.expanded, /ToolSearch|mcp_docs_two_/);
  assert.match(expansion.expanded, /find API docs$/);
  assert.throws(() => expandMcpInvocation("/mcp:docs%2Ftwo", commands), { errorCode: "COMPOSER_MCP_REQUEST_REQUIRED" });
  assert.deepEqual(
    expandMcpInvocation("/mcp:docs%2Ftwo", commands, true).mcpServerIds,
    ["docs/two"],
  );
  assert.equal(expandMcpInvocation("ordinary text /mcp:docs", commands), null);
  assert.equal(expandMcpInvocation("/mcp:docs template text", [{ name: "mcp:docs", kind: "template" }]), null);
});

function promptFixture(commandService, projectPath = "/repo", remoteWorkspace) {
  const handlers = new Map();
  const calls = [];
  const sidecarCalls = [];
  let released = false;
  const host = { async call(method, params) {
    calls.push({ method, params });
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: "target", projectPath, remoteWorkspace, messages: [] } };
    if (method === "session.beginTurn") return { turnId: "turn-1" };
    if (method === "session.appendMessage") return {};
    assert.fail(`unexpected RPC ${method}`);
  } };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({ setProjectInstructionRoot() {}, async call(method, params) {
      sidecarCalls.push({ method, params });
      if (method === "agent.steeringContext") return { projectPath, remoteWorkspace, supportsVision: false };
      return { accepted: true, turnId: "turn-1" };
    } }),
    getAgentHostBridge: () => null,
    isTurnDispatchable: () => true,
    logger: { app() {} }, vendorOAuth: {}, agentExtensions: {}, cancelSessionTools() {},
    persistenceOutbox: {}, dataDir: "/unused-for-no-attachments",
    activeTurns: new Map(), activeTurnUsages: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart() {},
    resolveAgentRuntimeLaunch: async () => ({
      projectPath, providerId: "provider", modelId: "model",
      sidecarParams: { sessionId: "target", provider: { modelConfig: { input: ["text"] } } },
    }),
    acquireSessionOperation: async () => () => { released = true; },
    finishTurn: async () => { assert.fail("no turn failure expected"); },
    emitAgentEvent() {}, setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => projectPath,
    composerCommandService: commandService,
    loadComposerTemplatesCached: async () => [],
  });
  return { calls, sidecarCalls, released: () => released,
    prompt: (content, extra = {}) => handlers.get(IPC.invoke.agentPrompt)({ sessionId: "target", content, ...extra }),
    steer: (content, extra = {}) => handlers.get(IPC.invoke.agentSteer)({ sessionId: "target", content, expectedTurnId: "turn-1", ...extra }),
  };
}

test("menu selection reaches runtime with MCP instructions and preserves the visible command", async () => {
  const catalog = service([record("docs")], [ready("docs")]);
  const selected = (await catalog.buildComposerCommands("/repo")).find(c => c.kind === "mcp");
  const input = `/${selected.name} find API docs`;
  const fixture = promptFixture(catalog);
  await fixture.prompt(input);
  const row = fixture.calls.find(c => c.method === "session.appendMessage").params.message;
  assert.equal(row.command, input);
  assert.match(row.content, /Documentation/);
  assert.deepEqual(fixture.sidecarCalls[0].params.mcpServerIds, ["docs"]);
  assert.equal(fixture.sidecarCalls[0].params.content, row.content);
  assert.equal(fixture.released(), true);
});

test("Skill commands use an explicit namespace and resolve original ids at send time", async () => {
  const catalog = createComposerCommandService({
    plugins: {
      listLoaded: () => [],
      getSkills: () => [{ id: "plugin/review", name: "Plugin review", pluginId: "review-plugin" }],
      getCommands: () => [],
    },
    agentExtensions: { allCommands: () => [] },
    activeUserSkills: async () => [{ id: "review", name: "User review" }],
    disabledBuiltinSkills: async () => ["pi-desktop/imagegen"],
    pluginActiveInProject: () => true,
    loadComposerTemplatesCached: async () => [{ name: "review" }],
  });
  const commands = await catalog.buildComposerCommands("/repo");
  const skills = commands.filter((command) => command.kind === "skill");
  const builtinSkill = skills.find((command) => command.skillId === "pi-desktop/imagegen");
  const pluginSkill = skills.find((command) => command.skillId === "plugin/review");
  const userSkill = skills.find((command) => command.skillId === "review");

  assert.equal(builtinSkill, undefined);
  assert.equal(pluginSkill?.name, "skill:plugin/review");
  assert.equal(userSkill?.name, "skill:review");
  assert.equal(commands.find((command) => command.name === "review")?.kind, "template");

  const activeSkills = new Map(skills.map(({ name, skillId }) => [name, skillId]));
  assert.deepEqual(findSkillMentions("/review please", activeSkills), []);
  const input = `${formatCommandInsert(pluginSkill.name)}review the plugin ${formatCommandInsert(userSkill.name)}also review this`;
  const expectedMentions = findSkillMentions(input, activeSkills);
  assert.deepEqual(expectedMentions.map((mention) => mention.id), ["plugin/review", "review"]);

  const fixture = promptFixture(catalog);
  await fixture.prompt(input);
  const row = fixture.calls.find((call) => call.method === "session.appendMessage").params.message;
  assert.equal(row.command, input);
  assert.deepEqual(row.skillMentions, expectedMentions);
  assert.match(row.content, /"plugin\/review", "review"/);
  assert.match(row.content, /review the plugin.*also review this/s);
});

test("an attachment alone supplies request context for an MCP selection", async () => {
  const projectPath = process.cwd();
  const fixture = promptFixture(service([record("docs")], [ready("docs")]), projectPath);
  const input = "/mcp:docs";
  await fixture.prompt(input, {
    attachments: [{ path: fileURLToPath(new URL("../package.json", import.meta.url)), name: "package.json", kind: "file" }],
  });
  const message = fixture.calls.find(c => c.method === "session.appendMessage").params.message;
  assert.equal(message.command, input);
  assert.equal(message.attachments.length, 1);
  assert.deepEqual(fixture.sidecarCalls[0].params.mcpServerIds, ["docs"]);
});

for (const method of ["prompt", "steer"]) {
  test(`command-only MCP ${method} is rejected before dispatching work`, async () => {
    const fixture = promptFixture(service([record("docs")], [ready("docs")]));
    await assert.rejects(fixture[method]("/mcp:docs"), { errorCode: "COMPOSER_MCP_REQUEST_REQUIRED" });
    assert(!fixture.calls.some(c => ["session.beginTurn", "session.appendMessage"].includes(c.method)));
    assert(!fixture.sidecarCalls.some(c => c.method === `agent.${method}`));
    assert.equal(fixture.released(), method === "prompt");
  });
}

for (const change of ["disconnect", "disable", "scope"]) {
  test(`send revalidates ${change} before opening or persisting a turn`, async () => {
    const records = [record("docs")];
    const statuses = [ready("docs")];
    const catalog = service(records, statuses);
    assert((await catalog.buildComposerCommands("/repo")).some(c => c.kind === "mcp"));
    if (change === "disconnect") statuses[0].state = "failed";
    if (change === "disable") records[0].enabled = false;
    if (change === "scope") records[0].scope = { mode: "projects", projects: ["/other"] };
    const fixture = promptFixture(catalog);
    await assert.rejects(fixture.prompt("/mcp:docs find API docs"), { errorCode: "COMPOSER_MCP_UNAVAILABLE" });
    assert(!fixture.calls.some(c => ["session.beginTurn", "session.appendMessage"].includes(c.method)));
    assert.equal(fixture.sidecarCalls.length, 0);
    assert.equal(fixture.released(), true);
  });
}


test("steering uses the same MCP expansion and preserves typed text", async () => {
  const fixture = promptFixture(service([record("docs")], [ready("docs")]));
  await fixture.steer("/mcp:docs find API docs");
  const sent = fixture.sidecarCalls.find(c => c.method === "agent.steer").params;
  assert.equal(sent.message.command, "/mcp:docs find API docs");
  assert.match(sent.content, /Documentation/);
  assert.deepEqual(sent.mcpServerIds, ["docs"]);
  assert.equal(sent.message.content, sent.content);
});

test("unavailable selection rejects before regenerating history", async () => {
  const fixture = promptFixture(service([], []));
  await assert.rejects(fixture.prompt("/mcp:docs find API docs", { truncateFromMessageId: "previous" }), { errorCode: "COMPOSER_MCP_UNAVAILABLE" });
  assert(!fixture.calls.some(c => c.method === "session.truncateFrom"));
  assert.equal(fixture.sidecarCalls.length, 0);
});

test("native Pi cannot silently accept a Desktop-managed MCP selection", async () => {
  const fixture = promptFixture(service([record("docs")], [ready("docs")]));
  await assert.rejects(fixture.prompt("/mcp:docs find API docs", { sessionId: "native-pi:test" }), { errorCode: "COMPOSER_MCP_UNAVAILABLE" });
  assert.equal(fixture.sidecarCalls.length, 0);
});

for (const method of ["prompt", "steer"]) {
  test(`specific MCP tool selection reaches ${method} with exact identity`, async () => {
    const catalog = service([record("docs")], [ready("docs")]);
    const selected = (await catalog.buildComposerCommands("/repo")).find(c => c.mcpToolName);
    assert.equal(selected?.name, "mcp:docs:search");
    const fixture = promptFixture(catalog);
    await fixture[method](`/${selected.name} find API docs`);
    const sent = fixture.sidecarCalls.find(c => c.method === `agent.${method}`).params;
    assert.deepEqual(sent.mcpServerIds, ["docs"]);
    assert.deepEqual(sent.mcpToolNames, ["mcp_docs_search"]);
    assert.match(sent.content, /mcp_docs_search/);
  });
}

test("a removed tool fails before opening a turn even while its server is ready", async () => {
  const statuses = [ready("docs")];
  const catalog = service([record("docs")], statuses);
  assert((await catalog.buildComposerCommands("/repo")).some(c => c.name === "mcp:docs:search"));
  statuses[0].toolNames = ["replacement"];
  const fixture = promptFixture(catalog);
  await assert.rejects(fixture.prompt("/mcp:docs:search find API docs"), { errorCode: "COMPOSER_MCP_UNAVAILABLE" });
  assert(!fixture.calls.some(c => c.method === "session.beginTurn"));
});

test("cold composer discovery connects enabled MCP servers before the first prompt", async () => {
  const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
  let connected = false;
  let calls = 0;
  const tools = [{ name: "search", inputSchema: { type: "object", properties: {} } }];
  const runtime = new UserMcpRuntime({ createClient: () => ({
    async connect() { connected = true; return tools; },
    isConnected: () => connected,
    getTools: () => connected ? tools : [],
    close() { connected = false; },
    async callTool() { calls++; return { content: [] }; },
  }) });
  const catalog = createComposerCommandService({
    plugins: { listLoaded: () => [], getSkills: () => [], getCommands: () => [] },
    agentExtensions: { allCommands: () => [] },
    activeUserSkills: async () => [], pluginActiveInProject: () => true,
    loadComposerTemplatesCached: async () => [], userMcp: runtime,
    refreshUserMcp: async (projectPath) => {
      assert.equal(projectPath, "/repo");
      runtime.setRecords([record("docs")]);
    },
  });
  try {
    assert.equal(runtime.statusFor("docs").state, "idle");
    const commands = await catalog.buildComposerCommands("/repo");
    assert(commands.some(command => command.name === "mcp:docs:search"));
    assert.equal(calls, 0, "discovery must not execute a tool");
    const fixture = promptFixture(catalog);
    await fixture.prompt("/mcp:docs:search find API docs");
    assert.deepEqual(fixture.sidecarCalls[0].params.mcpToolNames, ["mcp_docs_search"]);
  } finally { runtime.disposeAll(); }
});

test("remote workspace prompt and steering never resolve commands from the same local path", async () => {
  const catalog = service([record("docs")], [ready("docs")]);
  const selected = (await catalog.buildComposerCommands(null)).find(c => c.kind === "mcp");
  const roots = [];
  const fixture = promptFixture({ buildComposerCommands: async root => {
    roots.push(root);
    return catalog.buildComposerCommands(root);
  } }, "/remote/workspace", { hostKey: "ssh", path: "/remote/workspace" });
  await fixture.prompt(`/${selected.name} inspect`);
  await fixture.steer(`/${selected.name} inspect again`);
  assert.deepEqual(roots, [null, null]);
});

test("remote sessions do not offer or expand the local-only visualize skill", async () => {
  const catalog = service([], []);
  const skillIds = (commands) => commands.flatMap((c) => c.kind === "skill" ? [c.skillId] : []);
  assert.ok(skillIds(await catalog.buildComposerCommands(null)).includes("pi-desktop/visualize"));
  assert.ok(!skillIds(await catalog.buildComposerCommands(null, { remote: true })).includes("pi-desktop/visualize"));
});
