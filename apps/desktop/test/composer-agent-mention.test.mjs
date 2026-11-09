import { builtinModeRuns } from "./helpers/builtin-mode-runs.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { IPC, serializeInlineComposerFileReferences } = await import("@pi-desktop/shared");

/** Drive the real prompt channel; only host, sidecar and launch are stubbed. */
function promptFixture({ mode = "agent", projectPath = null, skills = [], templates = [] } = {}) {
  const handlers = new Map();
  const calls = [];
  const sidecarCalls = [];
  const host = { async call(method, params) {
    calls.push({ method, params });
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: "s", projectPath, messages: [] } };
    if (method === "session.beginTurn") return { turnId: "turn-1" };
    if (method === "session.appendMessage") return {};
    assert.fail(`unexpected RPC ${method}`);
  } };
  registerAgentIpc({
    modeRuns: builtinModeRuns,
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({ setProjectInstructionRoot() {}, async call(method, params) {
      sidecarCalls.push({ method, params });
      return { accepted: true, turnId: "turn-1" };
    } }),
    getAgentHostBridge: () => null,
    isTurnDispatchable: () => true,
    logger: { app() {} }, agentExtensions: {}, cancelSessionTools() {},
    persistenceOutbox: {}, dataDir: "/unused-for-no-attachments",
    activeTurns: new Map(), activeTurnUsages: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart() {},
    resolveAgentRuntimeLaunch: async () => ({
      projectPath, providerId: "provider", modelId: "model",
      sidecarParams: {
        sessionId: "s", mode,
        subagents: [{ name: "explorer" }, { name: "code-reviewer" }],
        provider: { modelConfig: { input: ["text"] } },
      },
    }),
    acquireSessionOperation: async () => () => {},
    finishTurn: async () => { assert.fail("no turn failure expected"); },
    emitAgentEvent() {}, setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => projectPath,
    composerCommandService: { buildComposerCommands: async () => skills },
    loadComposerTemplatesCached: async () => templates,
  });
  return {
    async prompt(content) {
      await handlers.get(IPC.invoke.agentPrompt)({ sessionId: "s", content });
      return calls.find((call) => call.method === "session.appendMessage").params.message;
    },
    sidecarCalls,
  };
}

test("an accepted agent chip mid-sentence becomes an explicit Task instruction", async () => {
  // The composer serializes the chip; the leading space is what lets the
  // send-time resolver see `@explorer` after "look".
  const content = serializeInlineComposerFileReferences("look\ue020where the retry policy lives", [
    { path: "explorer", kind: "agent", token: "\ue020" },
  ]);
  const fixture = promptFixture();
  const row = await fixture.prompt(content);
  assert.equal(row.command, "look @explorer where the retry policy lives");
  assert.deepEqual(row.agentMentions, [{ start: 5, end: 14, name: "explorer" }]);
  assert.match(row.content, /^The user explicitly delegated.*`Task`.*"explorer"/);
  assert.match(row.content, /look @explorer where the retry policy lives$/);
  assert.equal(fixture.sidecarCalls.at(-1).params.content, row.content);
});

test("Plan mode, unknown names and e-mail-like text stay literal", async () => {
  for (const [mode, content] of [
    ["plan", "@explorer find it"],
    ["goal", "@explorer find it"],
    ["agent", "@nobody find it"],
    ["agent", "mail me at user@explorer"],
  ]) {
    const row = await promptFixture({ mode }).prompt(content);
    assert.equal(row.content, content, `${mode}: ${content}`);
    assert.equal(row.command, undefined);
    assert.equal(row.agentMentions, undefined);
  }
});

test("a workspace file of the same name wins over the agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-mention-"));
  try {
    await writeFile(join(root, "explorer"), "a real file");
    const row = await promptFixture({ projectPath: root }).prompt("@explorer @code-reviewer check");
    assert.deepEqual(row.agentMentions, [{ start: 10, end: 24, name: "code-reviewer" }]);
    assert.doesNotMatch(row.content.split("\n\n")[0], /"explorer"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Skill and agent mentions combine; a leading template keeps its expansion", async () => {
  const skills = [{ name: "skill:review", kind: "skill", skillId: "review" }];
  const row = await promptFixture({ skills }).prompt("/skill:review @code-reviewer check this");
  assert.deepEqual(row.skillMentions, [{ start: 0, end: 13, id: "review" }]);
  assert.deepEqual(row.agentMentions, [{ start: 14, end: 28, name: "code-reviewer" }]);
  const [skill, agent, body] = row.content.split("\n\n");
  assert.match(skill, /`Skill`.*"review"/);
  assert.match(agent, /`Task`.*"code-reviewer"/);
  assert.equal(body, "@code-reviewer check this");

  const templated = await promptFixture({
    skills: [{ name: "fix", kind: "template" }],
    templates: [{ name: "fix", body: "Fix: $ARGUMENTS", description: "" }],
  }).prompt("/fix @explorer it");
  assert.equal(templated.agentMentions, undefined);
  assert.doesNotMatch(templated.content, /`Task`/);
});
