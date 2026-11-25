import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type PluginToolDef } from "../runtime.js";
import type { RuntimeProviderConfig } from "../provider-binding.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Item = { type?: string; role?: string; name?: string; call_id?: string; content?: unknown; output?: unknown };
type Request = { tools?: Array<{ name?: string }>; input: Item[] };
type Reply = { call: { id: string; name: string; args: Record<string, unknown> } } | { text: string };

function respond(res: ServerResponse, reply: Reply) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (data: { type: string; [key: string]: unknown }) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({ type: "response.created", response: { id: "resp_fixture" } });
  const item = "call" in reply
    ? { id: `fc_${reply.call.id}`, type: "function_call", call_id: reply.call.id, name: reply.call.name, arguments: JSON.stringify(reply.call.args), status: "completed" }
    : { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text, annotations: [] }] };
  send({ type: "response.output_item.added", output_index: 0, item: "call" in reply ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
  send("call" in reply
    ? { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(reply.call.args) }
    : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: reply.text });
  send({ type: "response.output_item.done", output_index: 0, item });
  send({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  res.end();
}

async function fixtureModel(replies: Reply[]) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw) as Request);
    respond(res, replies.shift() ?? { text: "Done." });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const provider: RuntimeProviderConfig = {
    id: "account-fixture", name: "Fixture", baseUrl, modelId: "fixture-model", apiKey: "fixture-not-real", apiStyle: "responses",
    headers: { "x-fixture-secret": "must-not-reach-script" },
    supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: { source: "generic", name: "Fixture", baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2000 },
  };
  return { requests, provider };
}

const pluginTools: PluginToolDef[] = [{
  name: "plugin_alpha", description: "Synthetic deferred plugin probe", parameters: { type: "object", properties: {}, required: [] }, risk: "low",
}];

function runtimeFixture(
  provider: RuntimeProviderConfig,
  options: {
    codemodeEnabled: boolean;
    history?: UiMessage[];
    deny?: (toolName: string) => boolean;
    /** Hold this tool's Host execution until Host receives `tools.abort` for it. */
    holdUntilAbort?: string;
  },
) {
  const aborts: string[] = [];
  const held = new Map<string, () => void>();
  let heldStarted!: () => void;
  const heldStartedPromise = new Promise<void>((resolve) => { heldStarted = resolve; });
  const events: AgentEventEnvelope[] = [];
  const executed: Array<{ toolName: string; toolCallId: string }> = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "codemode-fixture", mode: "agent", provider, thinkingLevel: "off", history: options.history ?? [],
    pluginTools, codemodeEnabled: options.codemodeEnabled,
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "session.appendMessage") return undefined as T;
      if (method === "project.instructions.resolve") return undefined as T;
      if (method === "tools.abort") {
        const call = params as { toolCallId: string };
        aborts.push(call.toolCallId);
        held.get(call.toolCallId)?.();
        return undefined as T;
      }
      if (method === "tools.execute") {
        const call = params as { toolName: string; toolCallId: string };
        executed.push({ toolName: call.toolName, toolCallId: call.toolCallId });
        if (options.deny?.(call.toolName)) return { ok: false, denied: true, content: "Permission denied by the user" } as T;
        if (options.holdUntilAbort === call.toolName) {
          heldStarted();
          await new Promise<void>((resolve) => held.set(call.toolCallId, resolve));
          return { ok: false, content: "Command aborted", errorCode: "TOOL_ABORTED" } as T;
        }
        return { ok: true, content: "alpha\nbeta\ngamma" } as T;
      }
      throw new Error(`Unexpected host method: ${method}`);
    }, onNotification: () => () => {} },
    onEvent: (event) => { events.push(event); },
  });
  cleanups.push(() => runtime.dispose());
  return { runtime, events, executed, aborts, heldStarted: heldStartedPromise };
}

const SCRIPT = `
const text = await tools.Read({ path: "notes.txt" });
let blocked = "";
try { await tools.plugin_alpha({}); } catch (error) { blocked = error.message; }
const listed = await models.list();
const summary = await models.complete({ prompt: "Summarize: " + text });
return { lines: text.split("\\n").length, blocked, listed, summary: summary.text };
`;

describe("codemode through the session runtime", () => {
  it("is not offered unless enabled", async () => {
    const model = await fixtureModel([{ text: "Hello." }]);
    const f = runtimeFixture(model.provider, { codemodeEnabled: false });
    await f.runtime.prompt("hi", "user-1", "turn-1");
    expect(model.requests[0].tools?.some((tool) => tool.name === "codemode")).toBe(false);
  });

  it("runs nested calls through the Host pipeline, gates on ToolSearch, records lineage and usage", async () => {
    const model = await fixtureModel([
      { call: { id: "call_code", name: "codemode", args: { code: SCRIPT } } },
      { text: "Three short lines." },
      { text: "All done." },
    ]);
    const f = runtimeFixture(model.provider, { codemodeEnabled: true });
    await f.runtime.prompt("Summarize notes.txt", "user-1", "turn-1");

    expect(model.requests[0].tools?.some((tool) => tool.name === "codemode")).toBe(true);
    const start = f.events.find((envelope) => envelope.event.type === "tool_start" && envelope.event.toolName === "codemode");
    const callerId = start?.event.type === "tool_start" ? start.event.toolCallId : "";
    expect(callerId).toMatch(/^call_code/);
    // The nested Read went to Host under a child id; the inactive plugin never did.
    expect(f.executed).toEqual([{ toolName: "Read", toolCallId: `${callerId}/1` }]);

    const nested = f.events.filter((envelope) => envelope.nestedParentToolCallId === callerId);
    expect(nested.map((envelope) => envelope.event.type)).toEqual(
      expect.arrayContaining(["tool_start", "tool_end"]),
    );
    expect(nested.every((envelope) => envelope.parentToolCallId === undefined)).toBe(true);
    const codemodeEnd = f.events.find((envelope) => envelope.event.type === "tool_end" && envelope.event.toolCallId === callerId);
    expect(codemodeEnd?.nestedParentToolCallId).toBeUndefined();

    // Only the script result reaches the model; nested results do not.
    const followUp = model.requests.at(-1)!;
    const outputs = followUp.input.filter((item) => item.type === "function_call_output");
    expect(outputs.map((item) => item.call_id)).toEqual(["call_code"]);
    const output = JSON.stringify(outputs[0].output);
    expect(output).toContain("Script completed");
    expect(output).toContain('\\"lines\\":3');
    // An on-demand tool that was never activated is not even present in the sandbox.
    expect(output).toContain("tools.plugin_alpha does not exist");
    expect(output).toContain("Three short lines.");
    expect(output).not.toContain("must-not-reach-script");
    expect(output).not.toContain("fixture-not-real");
    expect(output).toContain('\\"providerId\\":\\"account-fixture\\"');

    // The sub-model completion is a separate physical operation on the session account.
    const usage = f.events.filter((envelope) => envelope.event.type === "usage")
      .map((envelope) => (envelope.event as { usage: { operationId?: string; providerId?: string; modelId?: string } }).usage);
    expect(usage.filter((entry) => entry.providerId === "account-fixture" && entry.modelId === "fixture-model").length)
      .toBeGreaterThanOrEqual(3);
    expect(new Set(usage.map((entry) => entry.operationId)).size).toBe(usage.length);
  });

  it("calls a tool once ToolSearch activated it, and surfaces Host denials to the script", async () => {
    const model = await fixtureModel([
      { call: { id: "call_search", name: "ToolSearch", args: { query: "plugin_alpha" } } },
      { call: { id: "call_code", name: "codemode", args: { code: `
        const alpha = await tools.plugin_alpha({});
        let denied = "";
        try { await tools.Bash({ command: "echo hi" }); } catch (error) { denied = error.message; }
        return { alpha, denied };
      ` } } },
      { text: "Done." },
    ]);
    const f = runtimeFixture(model.provider, { codemodeEnabled: true, deny: (name) => name === "Bash" });
    await f.runtime.prompt("Use the plugin", "user-1", "turn-1");
    expect(f.executed.map((call) => call.toolName)).toEqual(["plugin_alpha", "Bash"]);
    const output = JSON.stringify(model.requests.at(-1)!.input.filter((item) => item.type === "function_call_output").at(-1)?.output);
    expect(output).toContain("alpha");
    expect(output).toContain("Permission denied by the user");
    const bashStart = f.events.find((envelope) => envelope.event.type === "tool_start" && envelope.event.toolName === "Bash");
    const bashId = bashStart?.event.type === "tool_start" ? bashStart.event.toolCallId : undefined;
    expect(bashStart?.nestedParentToolCallId).toBeTruthy();
    const bashEnd = f.events.find((envelope) => envelope.event.type === "tool_end" && envelope.event.toolCallId === bashId);
    expect(bashEnd?.event).toMatchObject({ isError: true });
  });

  it("Stop aborts the script's in-flight Host call", async () => {
    const model = await fixtureModel([
      { call: { id: "call_code", name: "codemode", args: { code: `await tools.Bash({ command: "sleep 100" }); return "unreachable";` } } },
      { text: "Stopped." },
    ]);
    const f = runtimeFixture(model.provider, { codemodeEnabled: true, holdUntilAbort: "Bash" });
    const pending = f.runtime.prompt("Run it", "user-1", "turn-1");
    await f.heldStarted;
    await f.runtime.abort();
    await pending.catch(() => undefined);
    const bash = f.executed.find((call) => call.toolName === "Bash");
    expect(bash?.toolCallId).toMatch(/\/1$/);
    expect(f.aborts).toContain(bash?.toolCallId);
    const codemodeEnd = f.events.find((envelope) => envelope.event.type === "tool_end" && !envelope.nestedParentToolCallId);
    expect(codemodeEnd?.event).toMatchObject({ isError: true });
  });

  it("keeps persisted nested rows out of the replayed model context", async () => {
    const createdAt = "2026-11-20T00:00:00Z";
    const history: UiMessage[] = [
      { id: "u0", role: "user", content: "Earlier", createdAt, status: "complete" },
      { id: "a0", role: "assistant", content: "", createdAt, status: "complete" },
      { id: "call_old/1", role: "tool", toolName: "Read", toolCallId: "call_old/1", toolArgs: { path: "x" },
        toolResult: "nested result", content: "nested result", toolStatus: "success", createdAt, status: "complete",
        nestedParentToolCallId: "call_old" },
      { id: "call_old", role: "tool", toolName: "codemode", toolCallId: "call_old", toolArgs: { code: "return 1" },
        toolResult: "Script completed", content: "Script completed", toolStatus: "success", createdAt, status: "complete" },
    ];
    const model = await fixtureModel([{ text: "Ok." }]);
    const f = runtimeFixture(model.provider, { codemodeEnabled: true, history });
    await f.runtime.prompt("Continue", "user-2", "turn-2");
    const input = model.requests[0].input;
    expect(input.some((item) => item.call_id === "call_old")).toBe(true);
    expect(input.some((item) => item.call_id === "call_old/1")).toBe(false);
  });
});
