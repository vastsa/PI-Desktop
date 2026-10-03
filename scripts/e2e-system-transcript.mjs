#!/usr/bin/env node
/** Production sidecar transport + isolated Host + local SSE provider.
 * Message persistence is harness-owned; Electron's UI/outbox is not exercised.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { withScenario } from "./e2e/fixture.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-system-state-e2e-"));
const requests = [];
const responses = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  const tool = responses.shift();
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
    : { role: "assistant", content: "The fixture completed." };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [value, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) {
    res.write(`data: ${JSON.stringify({ id: "fixture", model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const provider = { id: "fixture", name: "Fixture", modelId: "fixture", baseUrl,
  apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] };
let skills = [
  { id: "fixture/notes", name: "First skill", description: "Summarize notes" },
  { id: "fixture/unchanged", name: "Unchanged skill", description: "Preserve this catalog entry" },
];
try {
  await withScenario("E2E-system-transcript", async ({ host, workspace }) => {
    const session = await createSession(host, workspace, "System state fixture");
    let writes = Promise.resolve();
    let writeError;
    let stderr = "";
    const turns = new Map();
    const executedTools = [];
    const toolRows = new Map();
    const persist = (message, turnId) => {
      writes = writes.then(() => host.call("session.appendMessage", { sessionId: session.id, turnId, message }))
        .catch((error) => { writeError ??= error; });
    };
    const startSidecar = () => {
      const sidecar = new AgentSidecar({
        launch: { command: process.execPath,
          args: [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))],
          cwd: workspace,
          env: { ...process.env, PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_COMPACTION_STRATEGY: "fresh_window" },
        },
        onStderr: (chunk) => { stderr += chunk; },
      });
      sidecar.setHost({ call: host.call.bind(host), onNotification: () => () => {}, onExit: () => () => {} });
      sidecar.setLocalTool("Skill", async ({ args }) => {
        executedTools.push(args);
        return { ok: true, content: "Fixture skill body: summarize the notes." };
      });
      sidecar.onNotification((method, envelope) => {
        if (method !== "agent.event") return;
        const { event, turnId } = envelope;
        const turn = turns.get(turnId);
        if (event.type === "error") turn?.errors.push(event.error);
        if (event.type === "message_end") persist(event.message, turnId);
        if (event.type === "tool_start") toolRows.set(event.toolCallId, {
          id: event.toolCallId, role: "tool", content: "", toolCallId: event.toolCallId,
          toolName: event.toolName, toolArgs: event.args, createdAt: new Date().toISOString(),
        });
        if (event.type === "tool_end") {
          turn?.toolResults.push(event);
          persist({ ...toolRows.get(event.toolCallId), toolResult: event.result, isError: event.isError,
            toolStatus: event.isError ? "error" : "success" }, turnId);
        }
        if (event.type === "agent_end") turn?.resolve();
      });
      return sidecar;
    };
    let sidecar = startSidecar();
    const params = () => ({ sessionId: session.id, mode: "agent", provider, thinkingLevel: "off", pluginSkills: skills,
      projectPath: workspace,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    });
    const identity = async () => (await sidecar.call("agent.testRuntimeIdentity", { sessionId: session.id })).runtimeId;
    const prompt = async (id) => {
      const { turnId } = await host.call("session.beginTurn", { sessionId: session.id });
      await host.call("session.appendMessage", { sessionId: session.id, turnId,
        message: { id, role: "user", content: "Continue", createdAt: new Date().toISOString() } });
      let timer;
      const turn = { errors: [], toolResults: [] };
      const ended = new Promise((resolve, reject) => {
        turn.resolve = resolve;
        timer = setTimeout(() => reject(new Error(`Turn timed out: ${JSON.stringify(turn.errors)}\n${stderr}`)), 20_000);
      });
      turns.set(turnId, turn);
      try {
        await sidecar.call("agent.prompt", { ...params(), turnId, userMessageId: id, content: "Continue" });
        await ended;
        await writes;
        if (writeError) throw writeError;
        assert.deepEqual(turn.errors, [], JSON.stringify(turn.errors));
        assert(turn.toolResults.every((event) => !event.isError), JSON.stringify(turn.toolResults));
        await host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
        return turn;
      } finally { clearTimeout(timer); turns.delete(turnId); }
    };
    const detail = async () => (await host.call("session.get", { id: session.id })).session;
    try {
      responses.push({ name: "ToolSearch", args: { query: "BrowserPreview" } });
      await prompt("user-1");
      const saved = await detail();
      const states = saved.messages.filter((row) => row.modelSystem);
      assert.equal(states.length, 2);
      assert(JSON.parse(JSON.parse(states[1].modelSystem.messageJson).sections.tool_activation).active.includes("BrowserPreview"));
      assert.deepEqual(requests[1].tools, requests[0].tools);
      assert(requests[1].tools.some((tool) => tool.function.name === "BrowserPreview"));
      console.log("PASS: sidecar ToolSearch and acknowledged Host persistence");
      await sidecar.dispose();
      await host.stop(); await host.start(PROTOCOL_VERSION);
      const recovered = await detail();
      assert.deepEqual(recovered.messages.filter((row) => row.modelSystem), states);
      sidecar = startSidecar();
      await prompt("user-2");
      const resumedStates = (await detail()).messages.filter((row) => row.modelSystem);
      assert.equal(resumedStates.length, 2, JSON.stringify(resumedStates.slice(2).map((row) => row.modelSystem.messageJson)));
      assert(requests.at(-1).tools.some((tool) => tool.function.name === "BrowserPreview"));
      console.log("PASS: Host and sidecar process restart restores tools without duplicate state");
      const priorRuntime = await identity();
      skills = [{ ...skills[0], name: "Updated skill" }, skills[1]];
      responses.push({ name: "Skill", args: { id: skills[0].id } });
      await prompt("user-3");
      assert.equal(await identity(), priorRuntime, "skill catalog update must reuse the runtime");
      assert.equal(executedTools.length, 1, "Skill execution reaches the embedding host");
      assert(JSON.stringify(requests.at(-1).messages).includes("Fixture skill body"));
      assert(JSON.stringify(requests.at(-1).messages).includes("Updated skill"));
      assert(!JSON.stringify(requests.at(-1).messages).includes("First skill"));
      assert(JSON.stringify(requests.at(-1).messages).includes("Unchanged skill"));
      console.log("PASS: skill catalog update reuses runtime and Skill executes across process boundary");
      await sidecar.call("agent.compact", params());
      const compacted = await detail();
      assert(JSON.parse(compacted.compaction.details.systemMessageJson).toolsAdded.some((tool) => tool.name === "BrowserPreview"));
      await sidecar.dispose();
      sidecar = startSidecar();
      await prompt("user-4");
      assert(requests.at(-1).tools.some((tool) => tool.function.name === "BrowserPreview"));
      assert(!requests.at(-1).messages.some((message) => message.role === "tool"));
      assert(JSON.stringify(requests.at(-1).messages).includes("Updated skill"));
      assert(!JSON.stringify(requests.at(-1).messages).includes("First skill"));
      console.log("PASS: compaction and sidecar restart preserve current skills and active tools");
      const beforeRemoval = await identity();
      skills = [];
      await prompt("user-5");
      assert.equal(await identity(), beforeRemoval);
      assert(!requests.at(-1).tools.some((tool) => tool.function.name === "Skill"));
      assert(!JSON.stringify(requests.at(-1).messages).includes("Updated skill"));
      console.log("PASS: removing the final skill removes its catalog and executable schema");
    } finally { await sidecar.dispose(); await writes; }
  }, resolveHostBinary(), root, PROTOCOL_VERSION);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
