import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Main-process TypeScript is imported directly, the same way the other
// `node --test` main-side suites do it.
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { AgentSidecar } = await import("@pi-desktop/host-runtime");
const { parseSkillFrontmatter } = await import("@pi-desktop/plugin-sdk");
const { createSkillToolHandler } = await import("../electron/main/skill-tool.ts");

const sessionId = "skill-bridge-fixture-session";
const BODY_SENTINEL = "SKILL-BODY-SENTINEL-417";
const CHILD_REPORT = "CHILD-REPORT-SENTINEL";
const READER_REPORT = "READER-REPORT-SENTINEL";
const DISABLED_BUILTIN = "pi-desktop/imagegen";
const ALLOWED_SKILL = "fixture-plugin/release-notes";
const HIDDEN_SKILL = "other-plugin/deploy-checklist";

const explorer = {
  name: "explorer",
  description: "Read-only fixture delegate that loads one skill document.",
  tools: ["Skill"],
  prompt: "EXPLORER-PROMPT-SENTINEL. Load the fixture skill document the task names.",
  source: "builtin",
};
const reader = {
  name: "reader",
  description: "Read-only fixture delegate; the parent catalog may withhold Skill.",
  tools: ["Read", "Skill"],
  prompt: "READER-PROMPT-SENTINEL. Report what the tools you have let you do.",
  source: "builtin",
};

/**
 * Stand-in for `PluginRuntime` (`apps/desktop/electron/main/plugin-runtime.ts`):
 * only the reads the `Skill` tool performs, with the same failure modes —
 * unknown id and a plugin that is not loaded both throw, and the body is the
 * frontmatter-stripped document read from disk on every call.
 */
function fixturePlugins(directory, skills) {
  const loaded = new Set(skills.filter((skill) => skill.loaded).map((skill) => skill.pluginId));
  return {
    getSkills: () => skills.map(({ id, pluginId, name, description }) => ({
      id, pluginId, name, description,
    })),
    loadSkillBody(id) {
      const skill = skills.find((candidate) => candidate.id === id);
      if (!skill) throw new Error(`unknown skill: ${id}`);
      if (!loaded.has(skill.pluginId)) throw new Error(`plugin not loaded: ${skill.pluginId}`);
      const location = join(directory, skill.file);
      const parsed = parseSkillFrontmatter(readFileSync(location, "utf8"));
      if (!parsed.body) throw new Error(`skill document is empty: ${id}`);
      return { id: skill.id, name: skill.name, body: parsed.body, location };
    },
  };
}

function sse(res, delta, finish) {
  const chunk = (value, reason) => `data: ${JSON.stringify({
    id: "fixture-completion", object: "chat.completion.chunk", created: 1,
    model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: reason }],
  })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n");
}
function say(res, text) {
  sse(res, { role: "assistant", content: text }, "stop");
}
function toolCall(res, name, id, args) {
  sse(res, {
    role: "assistant",
    tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  }, "tool_calls");
}
function systemPrompt(body) {
  const system = body.messages.find((message) => message.role === "system");
  assert.ok(system, "Fixture provider request carried no system prompt");
  return typeof system.content === "string"
    ? system.content
    : system.content.map((part) => part?.text ?? "").join("\n");
}
function toolNames(body) {
  return (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
}
function toolOutputs(body) {
  return body.messages
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
}
function lastUserText(body) {
  const user = [...body.messages].reverse().find((message) => message.role === "user");
  if (typeof user?.content === "string") return user.content;
  return Array.isArray(user?.content) ? user.content.map((part) => part.text ?? "").join("") : "";
}

// Real child execution through the real sidecar and the real Host-side RPC
// client (`AgentSidecar`, which owns the `tools.execute` → local-tool dispatch).
// Only the fictional provider (loopback), the Host RPC surface and the plugin
// registry are fixtures; no real session, database or network is touched.
test("a delegated child loads a skill through the real bridge while its scope and catalog stay bounded", {
  timeout: 120_000,
}, async (t) => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "skill-bridge-"));
  const pluginDir = join(temp, "plugin");
  await rm(pluginDir, { recursive: true, force: true });
  await writeFile(join(temp, "placeholder"), "", "utf8").catch(() => {});
  const { mkdir } = await import("node:fs/promises");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "release-notes.md"),
    `---\nname: Fixture release notes\ndescription: How to write release notes\n---\n\n${BODY_SENTINEL}: write the release notes here.\n`,
    "utf8",
  );
  const projectPath = join(temp, "project");
  await mkdir(projectPath, { recursive: true });
  const otherProject = join(temp, "other-project");
  await mkdir(otherProject, { recursive: true });

  const plugins = fixturePlugins(pluginDir, [
    {
      id: ALLOWED_SKILL, pluginId: "fixture-plugin", name: "Fixture release notes",
      description: "How to write release notes", file: "release-notes.md", loaded: true,
    },
    {
      id: HIDDEN_SKILL, pluginId: "other-plugin", name: "Deploy checklist",
      description: "Another project's checklist", file: "release-notes.md", loaded: true,
    },
  ]);
  // Scope lookup as Main keeps it: a plugin limited to another project is never
  // offered to this session (the catalog is filtered before launch).
  const pluginActiveInProject = (pluginId, scope) =>
    pluginId === "other-plugin" ? false : Boolean(scope) || pluginId === "fixture-plugin";

  const skillBridge = createSkillToolHandler({
    sessionProjects: new Map([[sessionId, projectPath]]),
    loadUserSkillBody: async () => null,
    activeUserSkills: async () => [],
    disabledBuiltinSkills: async () => [DISABLED_BUILTIN],
    plugins,
    pluginActiveInProject,
  });

  const events = [];
  const hostCalls = [];
  const bridgeCalls = [];
  const store = new Map();
  const sessionMessages = () => [...store.values()];
  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      if (method === "session.get") {
        return { session: { id: sessionId, messages: sessionMessages(), projectPath } };
      }
      if (method === "session.appendMessage") {
        assert.equal(params.sessionId, sessionId, "Journal write escaped its fictional session");
        return { ok: true };
      }
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false };
      if (method === "tools.abort") return { ok: true };
      throw new Error(`Unexpected Host method: ${method}`);
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };

  const requests = [];
  const parentRequests = [];
  const childRequests = { explorer: [], reader: [] };
  const taskIssued = new Set();
  const childToolCalls = { explorer: 0 };

  const sidecar = new AgentSidecar({
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../../packages/agent-runtime/dist/sidecar.js", import.meta.url))],
      env: {
        ...process.env,
        HOME: temp,
        USERPROFILE: temp,
        PI_CODING_AGENT_DIR: join(temp, "agent"),
      },
      cwd: temp,
    },
    onStderr(text) {
      if (text.includes("[agent-sidecar] ready")) return;
      stderrTail = (stderrTail + text).slice(-8_000);
    },
  });
  let stderrTail = "";
  t.after(() => sidecar.dispose());

  const bridge = {
    ...skillBridge,
    async handler(input) {
      bridgeCalls.push(input);
      return skillBridge(input);
    },
  };
  // Registered exactly the way Electron main registers it.
  sidecar.setLocalTool("Skill", bridge.handler);
  sidecar.setHost(host);

  const waiters = new Set();
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const waitFor = async (predicate, label, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() > deadline) {
        const taskRows = [...store.values()].filter((message) => message.toolName === "Task")
          .map((message) => ({ id: message.id, toolCallId: message.toolCallId,
            toolStatus: message.toolStatus, status: message.toolResult?.details?.status,
            errorCode: message.error?.code }));
        const recentEvents = events.slice(-12).map((entry) => ({ type: entry.event?.type,
          turnId: entry.turnId, parentToolCallId: entry.parentToolCallId }));
        throw new Error(`Timed out waiting for ${label}. Task rows: ${JSON.stringify(taskRows)}. Recent events: ${JSON.stringify(recentEvents)}. stderr: ${stderrTail}`);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(check); resolve(); }, 100);
        const check = () => { clearTimeout(timer); waiters.delete(check); resolve(); };
        waiters.add(check);
      });
    }
  };

  sidecar.onNotification((method, params) => {
    if (method !== "agent.event" || params?.sessionId !== sessionId) return;
    events.push(params);
    if (params.event?.type === "message_end" && params.event.message) {
      store.set(params.event.message.id, params.event.message);
    }
    notify();
  });

  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        assert.ok(text.length <= 1_048_576, "Fixture provider input exceeded its budget");
      }
      const body = JSON.parse(text);
      requests.push(body);
      assert.ok(requests.length <= 12, "Unexpected provider loop");
      const prompt = systemPrompt(body);
      const childName = /^You are the "([^"]+)" subagent inside PI-Desktop/.exec(prompt)?.[1];
      if (childName) {
        const queue = childRequests[childName];
        assert.ok(queue, `Unexpected delegate name: ${childName}`);
        queue.push(body);
        notify();
        if (childName === "reader") {
          if (queue.length === 1) return say(res, READER_REPORT);
          return say(res, "Reader turn closed.");
        }
        childToolCalls.explorer += 1;
        if (queue.length === 1) {
          return toolCall(res, "Skill", "skill-disabled", { id: DISABLED_BUILTIN });
        }
        if (queue.length === 2) {
          return toolCall(res, "Skill", "skill-allowed", { id: ALLOWED_SKILL });
        }
        return say(res, CHILD_REPORT);
      }
      parentRequests.push(body);
      notify();
      const marker = lastUserText(body);
      if (marker.includes("TURN1-USER") && !taskIssued.has("turn1")) {
        taskIssued.add("turn1");
        return toolCall(res, "Task", "task-call-turn1", { agent: "explorer", task: "TURN1-TASK: load the fixture skill." });
      }
      if (marker.includes("TURN2-USER") && !taskIssued.has("turn2")) {
        taskIssued.add("turn2");
        const delegationId = [...store.values()]
          .find((message) => message.toolName === "Task")?.toolResult?.details?.delegationId;
        assert.ok(delegationId, "The fixture lost the Task delegation id");
        return toolCall(res, "Task", "task-call-turn2", {
          agent: "explorer", task: "TURN2-TASK: continue the delegation.", resume: delegationId,
        });
      }
      if (marker.includes("TURN3-USER") && !taskIssued.has("turn3")) {
        taskIssued.add("turn3");
        return toolCall(res, "Task", "task-call-turn3", { agent: "reader", task: "TURN3-TASK: report your tools." });
      }
      return say(res, "Parent acknowledged.");
    } catch (error) {
      res.writeHead(500);
      res.end();
      stderrTail = `${stderrTail}\nprovider fixture failed: ${error?.stack ?? error}`;
      notify();
    }
  });

  const prompt = (params) => sidecar.call("agent.prompt", params);
  const baseParams = (extra) => ({
    sessionId,
    mode: "agent",
    thinkingLevel: "off",
    projectPath,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: {
      id: "fixture",
      modelId: "fixture-model",
      authKind: "none",
      apiStyle: "openai-chat",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelConfig: { input: ["text"] },
    },
    ...extra,
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    // --- Turn 1: the catalog teaches one skill; the parent delegates it. ----
    const turn1 = await prompt(baseParams({
      content: "TURN1-USER: load the fixture skill through a delegate.",
      userMessageId: "user-turn1",
      pluginSkills: [
        { id: ALLOWED_SKILL, name: "Fixture release notes", description: "How to write release notes" },
      ],
      subagents: [explorer],
    }));
    assert.equal(turn1?.accepted, true, JSON.stringify(turn1));

    await waitFor(() => childRequests.explorer.length >= 3, "the delegated child's Skill round-trip");
    await waitFor(
      () => [...store.values()].some((message) => message.toolName === "Task"
        && message.toolResult?.details?.status === "completed"),
      "the delegated report to settle",
    );

    const [parentOne] = parentRequests;
    assert.ok(toolNames(parentOne).includes("Skill"), "The parent lost its own Skill declaration");
    assert.ok(toolNames(parentOne).includes("Task"), "The parent lost the Task declaration");
    assert.ok(
      systemPrompt(parentOne).includes(ALLOWED_SKILL),
      "The parent prompt must advertise the in-scope skill",
    );

    const [explorerOne, explorerTwo, explorerThree] = childRequests.explorer;
    assert.deepEqual(toolNames(explorerOne), ["Skill"],
      "The child must see exactly the tools its definition resolves to");
    const explorerPrompt = systemPrompt(explorerOne);
    assert.match(explorerPrompt, /^You are the "explorer" subagent inside PI-Desktop/);
    assert.ok(explorerPrompt.includes("Finish the task with the tools you have: Skill."),
      "The child prompt must list its actual tools");
    assert.ok(explorerPrompt.includes(ALLOWED_SKILL),
      "The child must be taught the skill the session catalog carries");
    assert.ok(!explorerPrompt.includes(HIDDEN_SKILL),
      "A skill scoped to another project must never be advertised");
    assert.ok(!explorerPrompt.includes(DISABLED_BUILTIN),
      "A disabled builtin skill must never be advertised");
    assert.deepEqual(
      explorerOne.messages.map((message) => message.role),
      ["system", "user"],
      "The child must start from its system prompt plus its own task only",
    );
    assert.equal(lastUserText(explorerOne), "TURN1-TASK: load the fixture skill.");

    // 1. A disabled builtin the model guessed: the activation revalidation in
    //    the real bridge refuses it, and the hint lists only this project.
    const refusal = toolOutputs(explorerTwo).at(-1) ?? "";
    assert.match(refusal, /skill "pi-desktop\/imagegen" is disabled in Settings/);
    assert.match(refusal, /Available skills: fixture-plugin\/release-notes\./);
    assert.ok(!refusal.includes(BODY_SENTINEL), "A refusal must not carry any skill body");
    assert.ok(!refusal.includes(HIDDEN_SKILL), "The hint must stay inside this project's scope");

    // 2. The advertised id resolves through the real bridge to the real body.
    const delivered = toolOutputs(explorerThree).at(-1) ?? "";
    assert.ok(delivered.includes(`# Skill: Fixture release notes (${ALLOWED_SKILL})`),
      `The child did not receive the formatted skill document: ${delivered}`);
    assert.ok(delivered.includes(BODY_SENTINEL), "The child did not receive the skill body");

    // 3. Child scope: every child event stays inside this session and names the
    //    parent tool call that owns it.
    const childEvents = events.filter((envelope) => envelope.parentToolCallId);
    assert.ok(childEvents.length > 0, "The delegate emitted no scoped events");
    for (const envelope of childEvents) {
      assert.equal(envelope.sessionId, sessionId);
      assert.equal(envelope.parentToolCallId, "task-call-turn1");
      assert.equal(envelope.agentName, "explorer");
    }
    assert.equal(bridgeCalls.length, 2, "The bridge must serve exactly the two child Skill calls");
    for (const call of bridgeCalls) assert.equal(call.sessionId, sessionId);
    const settled = [...store.values()].find((message) => message.toolName === "Task");
    assert.equal(settled.toolResult.details.agent, "explorer");
    assert.equal(settled.toolResult.details.status, "completed");
    assert.ok(settled.toolResult.details.delegationId, "The settled Task row lost its delegation id");

    // The parent's model context never sees the child's transcript or the body.
    for (const parentRequest of parentRequests) {
      const wire = JSON.stringify(parentRequest.messages);
      assert.ok(!wire.includes(BODY_SENTINEL), "The skill body leaked into the parent model context");
      assert.ok(!wire.includes("EXPLORER-PROMPT-SENTINEL"), "The child prompt leaked into the parent model context");
    }
    assert.equal(childToolCalls.explorer, 3);

    // --- Turn 2: the catalog is withdrawn; a resume must re-derive it. -----
    await waitFor(() => events.some((entry) => !entry.parentToolCallId
      && entry.turnId === turn1.turnId && entry.event?.type === "agent_end"), "the first parent turn to finish");
    const turn2 = await prompt(baseParams({
      content: "TURN2-USER: continue the delegation you started.",
      userMessageId: "user-turn2",
      pluginSkills: [],
      subagents: [explorer],
    }));
    assert.equal(turn2?.accepted, true, JSON.stringify(turn2));
    await waitFor(() => taskIssued.has("turn2"), "the turn-2 parent request");
    const turn2Request = await waitFor(
      () => parentRequests.find((body) => lastUserText(body).includes("TURN2-USER")),
      "the turn-2 parent request body",
    );
    const turn2Task = await waitFor(
      () => events.find((entry) => !entry.parentToolCallId && entry.turnId === turn2.turnId
        && entry.event?.type === "tool_end" && entry.event.toolCallId === "task-call-turn2"),
      "the turn-2 Task refusal",
    );
    assert.deepEqual(toolNames(turn2Request).filter((name) => name === "Skill"), [],
      "A withdrawn catalog must not leave Skill declared");
    assert.ok(!systemPrompt(turn2Request).includes("have taught you the following skills"),
      "A withdrawn catalog must not leave the Skills section in the prompt");
    assert.equal(turn2Task.event.isError, true, "The withdrawn Skill grant must mark Task as failed");
    assert.match(
      String(turn2Task.event.result?.details?.error ?? turn2Task.event.result?.content?.[0]?.text ?? ""),
      /declares no tool available in this session/,
      "A resume must fail closed when the current catalog no longer grants Skill",
    );
    assert.equal(childRequests.explorer.length, 3, "No stale grant may start another child");

    // --- Turn 3: a definition that declares Skill gets a child without it. --
    await waitFor(() => events.some((entry) => !entry.parentToolCallId
      && entry.turnId === turn2.turnId && entry.event?.type === "agent_end"), "the second parent turn to finish");
    const turn3 = await prompt(baseParams({
      content: "TURN3-USER: delegate a read-only report.",
      userMessageId: "user-turn3",
      pluginSkills: [],
      subagents: [reader],
    }));
    assert.equal(turn3?.accepted, true, JSON.stringify(turn3));
    await waitFor(() => childRequests.reader.length >= 1, "the turn-3 child request");
    const [readerOne] = childRequests.reader;
    assert.deepEqual(toolNames(readerOne), ["Read"],
      "A child must not receive Skill the session catalog does not carry");
    const readerPrompt = systemPrompt(readerOne);
    assert.ok(readerPrompt.includes("Finish the task with the tools you have: Read."));
    assert.ok(!readerPrompt.includes("have taught you the following skills"));
    assert.ok(!JSON.stringify(readerOne.messages).includes(BODY_SENTINEL));
    await waitFor(
      () => [...store.values()].some((message) => message.toolName === "Task"
        && message.toolResult?.details?.agent === "reader"
        && message.toolResult?.details?.status === "completed"),
      "the turn-3 report to settle",
    );
    const readerSettled = [...store.values()].find((message) => message.toolResult?.details?.agent === "reader");
    assert.equal(readerSettled.toolResult.details.status, "completed");
    await waitFor(
      () => parentRequests.some((request) => JSON.stringify(request.messages).includes(READER_REPORT)),
      "the child's report to reach the parent model",
    );
    for (const parentRequest of parentRequests) {
      assert.ok(!JSON.stringify(parentRequest.messages).includes(BODY_SENTINEL),
        "The skill body leaked into the parent model context");
    }

    // The replayed history Main would hand back really did carry the child
    // rows, so the filtering assertions above are not vacuous.
    assert.ok(
      sessionMessages().some((message) => message.parentToolCallId && message.agentName === "explorer"),
      "The fixture never persisted child rows, so the parent-context check proves nothing",
    );
    assert.ok(hostCalls.some((call) => call.method === "session.get"));
  } finally {
    await sidecar.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
