#!/usr/bin/env node
/** Production sidecar transport + isolated Host + local SSE provider.
 * Message persistence is harness-owned; Electron's UI/outbox is not exercised.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { DEEPSEEK_MODELS } from "../packages/agent-runtime/node_modules/@earendil-works/pi-ai/dist/providers/deepseek.models.js";
import { modelConfigFromPi } from "../packages/agent-runtime/dist/model-capabilities.js";
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
const flash = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash");
const model = process.env.PI_FIXED_TOOL_FIXTURE_ROUTE === "compatible"
  ? { ...flash, id: "compatible-fixture", baseUrl: "https://fixture.invalid/v1", compat: undefined }
  : flash;
const provider = { id: "fixture", name: "Fixed tools fixture", modelId: model.id, baseUrl: model.baseUrl,
  modelConfig: modelConfigFromPi(model), apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] };
const fetchHook = join(root, "fixture-fetch.mjs");
await writeFile(fetchHook, `const fetch = globalThis.fetch; globalThis.fetch = (url, init) => {
  if (String(url) !== ${JSON.stringify(`${model.baseUrl}/chat/completions`)}) throw new Error("Unexpected fixture endpoint");
  return fetch(${JSON.stringify(baseUrl)}, init);
};`);
let pluginTools = ["plugin_alpha", "plugin_beta"].map((name) => ({ name,
  description: "Synthetic read-only marker", parameters: { type: "object", properties: {}, required: [] }, risk: "low" }));
try {
  await withScenario("E2E-fixed-tool-declarations", async ({ host, workspace }) => {
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
          env: { ...process.env, NODE_OPTIONS: `--import=${fetchHook}`, PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_COMPACTION_STRATEGY: "fresh_window" },
        },
        onStderr: (chunk) => { stderr += chunk; },
      });
      sidecar.setHost({ call: host.call.bind(host), onNotification: () => () => {}, onExit: () => () => {} });
      for (const name of ["plugin_alpha", "plugin_beta"]) sidecar.setLocalTool(name, async () => {
        executedTools.push(name);
        return { ok: true, content: `${name} synthetic result` };
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
    const params = () => ({ sessionId: session.id, mode: "agent", provider, thinkingLevel: "off", pluginTools,
      projectPath: workspace,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    });
    const prompt = async (id, expectedErrors = 0) => {
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
        assert.equal(turn.toolResults.filter((event) => event.isError).length, expectedErrors, JSON.stringify(turn.toolResults));
        await host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
        return turn;
      } finally { clearTimeout(timer); turns.delete(turnId); }
    };
    const detail = async () => (await host.call("session.get", { id: session.id })).session;
    try {
      responses.push({ name: "ToolSearch", args: { query: "plugin_alpha" } }, { name: "plugin_alpha", args: {} });
      await prompt("user-1");
      const declared = requests[0].tools;
      assert(declared.some((tool) => tool.function.name === "plugin_beta"));
      for (let index = 1; index < requests.length; index++) {
        assert.deepEqual(requests[index].tools, declared);
        assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages);
      }
      assert.deepEqual(executedTools, ["plugin_alpha"]);
      const states = (await detail()).messages.filter((row) => row.modelSystem);
      assert(states.length >= 2);
      console.log("PASS: fixed declarations survive ToolSearch through production sidecar and HTTP/SSE");
      await sidecar.dispose();
      await host.stop(); await host.start(PROTOCOL_VERSION);
      assert.deepEqual((await detail()).messages.filter((row) => row.modelSystem), states);
      sidecar = startSidecar();
      responses.push({ name: "plugin_alpha", args: {} }, { name: "plugin_beta", args: {} });
      await prompt("user-2", 1);
      assert.deepEqual(executedTools, ["plugin_alpha", "plugin_alpha"]);
      assert.deepEqual(requests.at(-1).tools, declared);
      console.log("PASS: Host and sidecar restart restore Alpha activation without activating declared Beta");
      await sidecar.call("agent.compact", params());
      const checkpoint = JSON.parse((await detail()).compaction.details.systemMessageJson);
      assert.deepEqual(JSON.parse(checkpoint.sections.tool_activation).active, ["plugin_alpha"]);
      await sidecar.dispose(); sidecar = startSidecar();
      responses.push({ name: "plugin_alpha", args: {} }, { name: "plugin_beta", args: {} });
      await prompt("user-3", 1);
      assert.deepEqual(executedTools, ["plugin_alpha", "plugin_alpha", "plugin_alpha"]);
      assert.deepEqual(requests.at(-1).tools, declared);
      console.log("PASS: compaction and process restart preserve declarations and activation separately");
      responses.push({ name: "ToolSearch", args: { query: "plugin_beta" } }, { name: "plugin_beta", args: {} });
      await prompt("user-4");
      assert.equal(executedTools.at(-1), "plugin_beta");
      assert.deepEqual(requests.at(-1).tools, declared);
      pluginTools = pluginTools.slice(0, 1);
      responses.push({ name: "plugin_beta", args: {} });
      await prompt("user-5", 1);
      assert.equal(executedTools.length, 4);
      assert(!requests.at(-1).tools.some((tool) => tool.function.name === "plugin_beta"));
      console.log("PASS: changed catalog revokes Beta execution and creates a new declaration epoch");
    } finally { await sidecar.dispose(); await writes; }
  }, resolveHostBinary(), root, PROTOCOL_VERSION);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
