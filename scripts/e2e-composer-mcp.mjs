#!/usr/bin/env node
/** Explicit composer selection through a real stdio MCP child, sidecar and Host.
 * The model endpoint is a deterministic local SSE fixture.
 * Message persistence is harness-owned; Electron's UI/outbox is not exercised.
 */
import { register } from "node:module";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { UserMcpRuntime } = await import("../apps/desktop/electron/main/user-mcp.ts");
const { McpServerClient } = await import("../apps/desktop/electron/main/plugin-mcp.ts");
const { createComposerCommandService } = await import("../apps/desktop/electron/main/ipc/composer-ipc.ts");
const { expandMcpInvocation } = await import("../apps/desktop/electron/main/composer-mcp.ts");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { DEEPSEEK_MODELS } from "../packages/agent-runtime/node_modules/@earendil-works/pi-ai/dist/providers/deepseek.models.js";
import { modelConfigFromPi } from "../packages/agent-runtime/dist/model-capabilities.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { withScenario } from "./e2e/fixture.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-composer-mcp-e2e-"));
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
const model = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash");
const provider = { id: "fixture", name: "Flash fixture", modelId: model.id, baseUrl: model.baseUrl,
  modelConfig: modelConfigFromPi(model), apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] };
const fetchHook = join(root, "fixture-fetch.mjs");
await writeFile(fetchHook, `const fetch = globalThis.fetch; globalThis.fetch = (url, init) => {
  if (String(url) !== "https://api.deepseek.com/chat/completions") throw new Error("Unexpected fixture endpoint");
  return fetch(${JSON.stringify(baseUrl)}, init);
};`);
const nonce = randomUUID();
const mcpFile = join(root, "mcp.mjs");
await writeFile(mcpFile, `
import { createInterface } from "node:readline";
const tools = Array.from({length:6}, (_,i) => ({name:"probe_"+i, description:i===5?"Read the validation nonce":"Read marker "+i,inputSchema:{type:"object",properties:{},required:[]}}));
createInterface({input:process.stdin}).on("line", line=>{
 const msg=JSON.parse(line); if(msg.id===undefined)return;
 let result;
 if(msg.method==="initialize")result={protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}}};
 if(msg.method==="tools/list")result={tools};
 if(msg.method==="tools/call")result={content:[{type:"text",text:${JSON.stringify(nonce)}}]};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result})+"\\n");
});`);
const mcp = new UserMcpRuntime({ createClient: config => new McpServerClient(config) });
mcp.setRecords([{id:"chosen",label:"Validation MCP",transport:"stdio",command:process.execPath,args:[mcpFile],env:{},enabled:true,scope:{mode:"global",projects:[]}}]);
const service = createComposerCommandService({
 plugins:{listLoaded:()=>[],getSkills:()=>[],getCommands:()=>[]},
 agentExtensions:{allCommands:()=>[]},activeUserSkills:async()=>[],
 pluginActiveInProject:()=>true,loadComposerTemplatesCached:async()=>[],userMcp:mcp,
});
let pluginTools;
try {
  await withScenario("E2E-composer-mcp", async ({ host, workspace }) => {
    const descriptors = await mcp.toolsForProject(workspace);
    pluginTools = descriptors.map(tool=>({name:tool.fullName,mcpServerId:tool.serverId,description:tool.description,parameters:tool.schema,risk:"low"}));
    const commands = await service.buildComposerCommands(workspace);
    const specific = process.env.MCP_SELECTION_TOOL === "1";
    assert.throws(() => expandMcpInvocation("/mcp:chosen", commands), {
      errorCode: "COMPOSER_MCP_REQUEST_REQUIRED",
    });
    const expansion = expandMcpInvocation(`${specific ? "/mcp:chosen:probe_5" : "/mcp:chosen"} Read the validation nonce using probe_5.`, commands);
    assert.deepEqual(expansion.mcpToolNames, specific ? ["mcp_chosen_probe_5"] : undefined);
    assert.deepEqual(expansion.mcpServerIds,["chosen"]);
    const session = await createSession(host, workspace, "Composer MCP fixture");
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
          env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(fetchHook).href}`, PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_COMPACTION_STRATEGY: "fresh_window" },
        },
        onStderr: (chunk) => { stderr += chunk; },
      });
      sidecar.setHost({ call: host.call.bind(host), onNotification: () => () => {}, onExit: () => () => {} });
      for (const { name } of pluginTools) sidecar.setLocalTool(name, async () => {
        executedTools.push(name);
        return { ok: true, content: JSON.stringify(await mcp.callTool(name, {}, workspace, session.id)) };
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
    const sidecar = startSidecar();
    const params = () => ({ sessionId: session.id, mode: "agent", provider, thinkingLevel: "off", pluginTools,
      projectPath: workspace,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    });
    const prompt = async (id, expectedErrors = 0) => {
      const { turnId } = await host.call("session.beginTurn", { sessionId: session.id });
      await host.call("session.appendMessage", { sessionId: session.id, turnId,
        message: { id, role: "user", content: expansion.expanded, command: expansion.command, createdAt: new Date().toISOString() } });
      let timer;
      const turn = { errors: [], toolResults: [] };
      const ended = new Promise((resolve, reject) => {
        turn.resolve = resolve;
        timer = setTimeout(() => reject(new Error(`Turn timed out: ${JSON.stringify(turn.errors)}\n${stderr}`)), 20_000);
      });
      turns.set(turnId, turn);
      try {
        await sidecar.call("agent.prompt", { ...params(), turnId, userMessageId: id, content: expansion.expanded, mcpServerIds: expansion.mcpServerIds, mcpToolNames: expansion.mcpToolNames });
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
      responses.push({name:"mcp_chosen_probe_5",args:{}});
      const result = await prompt("mcp-user");
      assert.deepEqual(executedTools,["mcp_chosen_probe_5"]);
      assert.equal(result.toolResults.length,1);
      assert(JSON.stringify(result.toolResults[0].result).includes(nonce));
      assert.equal(requests.length,2);
      assert(requests[1].messages.some(message => message.role === "tool" && JSON.stringify(message).includes(nonce)));
      assert.equal((await detail()).messages.find(row=>row.id==="mcp-user").command,expansion.command);
      console.log("PASS: composer catalog → exact server selection → production sidecar → Host permission gate → real stdio MCP tools/call → provider follow-up");
      console.log("PASS: sixth selected tool executes without ToolSearch; server-only nonce reaches the model; original slash command persists");
    } finally {
      await sidecar.dispose();
      await writes;
      await mcp.disposeAll();
    }
  }, resolveHostBinary(), root, PROTOCOL_VERSION);
} finally {
  await mcp.disposeAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
