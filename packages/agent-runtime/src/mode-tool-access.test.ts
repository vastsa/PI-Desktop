import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentEventEnvelope, Mode, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { modeToolDenial, withModeExecutionGuard } from "./mode-tool-access.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Item = { type?: string; role?: string; name?: string; call_id?: string; content?: unknown; output?: unknown };
type Request = { tools: Array<{ name?: string }>; input: Item[] };

function respond(res: ServerResponse, name?: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (data: { type: string; [key: string]: unknown }) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({ type: "response.created", response: { id: "resp_fixture" } });
  const args = name === "Task" ? { agent: "worker", task: "Inspect the fixture." }
    : name === "Write" ? { path: "fixture.txt", content: "must not be written" }
      : { path: "fixture.txt", tag: "ABCD", ops: "PUT >$:\n+must not be written" };
  const text = "This mode cannot perform that action. I will continue with a read-only plan.";
  const item = name
    ? { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name, arguments: JSON.stringify(args), status: "completed" }
    : { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  send({ type: "response.output_item.added", output_index: 0, item: name ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
  send(name
    ? { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(args) }
    : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
  send({ type: "response.output_item.done", output_index: 0, item });
  send({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  res.end();
}

it.each([
  ["plan", "Edit"], ["plan", "Write"], ["plan", "Task"],
  ["goal", "Edit"], ["goal", "Write"], ["goal", "Task"],
] as const)("%s declares %s but returns a paired denial before any host action", async (mode, name) => {
  const requests: Request[] = [];
  let firstReceived!: () => void;
  const received = new Promise<void>((resolve) => { firstReceived = resolve; });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const request = JSON.parse(raw) as Request;
    requests.push(request);
    if (requests.length === 1) {
      firstReceived();
      // A strict gateway rejects undeclared calls before the application sees them.
      if (!request.tools.some((tool) => tool.name === name)) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `undeclared client tool ${name}` } }));
        return;
      }
      respond(res, name);
    } else respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const provider: RuntimeProviderConfig = {
    id: "fixture", name: "Fixture", baseUrl, modelId: "fixture", apiKey: "fixture-not-real", apiStyle: "responses",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: { source: "generic", name: "Fixture", baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2000 },
  };
  const history: UiMessage[] = [
    { id: "old-user", role: "user", content: "Earlier work", createdAt: "2026-09-28T00:00:00Z", status: "complete" },
    { id: "old-edit", role: "tool", toolName: "Edit", toolCallId: "old-edit", toolArgs: { path: "fixture.txt" },
      toolResult: "Earlier edit succeeded", content: "Earlier edit succeeded", toolStatus: "success", createdAt: "2026-09-28T00:00:00Z", status: "complete" },
  ];
  const originalHistory = structuredClone(history);
  const events: AgentEventEnvelope[] = [];
  const hostCalls: string[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture", mode: "agent", provider, history, thinkingLevel: "off",
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Inspect", tools: ["Read"], prompt: "Inspect only.", source: "user" }],
    host: { call: async (method) => { hostCalls.push(method); throw new Error("blocked tools must never reach the host"); }, onNotification: () => () => {} },
    onEvent: (event) => { events.push(event); },
  });
  runtime.setMode(mode);
  const pending = runtime.prompt("Only discuss the plan.");
  void pending.catch(() => undefined);
  cleanups.push(async () => { await runtime.dispose(); await pending.catch(() => undefined); });
  await received;
  expect(requests[0].tools.some((tool) => tool.name === name)).toBe(true);
  await pending;
  expect(requests).toHaveLength(2);
  const result = requests[1].input.find((item) => item.type === "function_call_output" && item.call_id === "call_fixture");
  expect(JSON.stringify(result?.output)).toContain(`${name} is not allowed in ${mode} mode`);
  expect(requests[1].input.some((item) => item.type === "function_call" && item.call_id === "call_fixture" && item.name === name)).toBe(true);
  expect(requests[1].input.filter((item) => item.role === "user")).toEqual(requests[0].input.filter((item) => item.role === "user"));
  expect(requests[1].input.some((item) => item.type === "function_call_output" && item.call_id === "old-edit")).toBe(true);
  expect(history).toEqual(originalHistory);
  expect(hostCalls).toEqual([]);
  expect(events.some((event) => event.parentToolCallId)).toBe(false);
  expect(events.find((event) => event.event.type === "tool_end")?.event).toMatchObject({ type: "tool_end", isError: true });
  expect(events.some((event) => event.event.type === "error")).toBe(false);
  expect(events.some((event) => event.event.type === "agent_end")).toBe(true);
});

it("an old tool reference rechecks the current mode and resumes normal execution only in Agent", async () => {
  let mode: Mode = "agent";
  let calls = 0;
  const tool = withModeExecutionGuard({
    name: "Edit", label: "Edit", description: "Edit fixture", parameters: Type.Object({}),
    execute: async () => { calls++; return { content: [{ type: "text", text: "edited" }], details: {} }; },
  }, () => mode === "agent" ? undefined : modeToolDenial("Edit", mode));
  mode = "plan";
  await expect(tool.execute("blocked", {})).rejects.toThrow("not allowed in plan");
  mode = "goal";
  await expect(tool.execute("blocked-goal", {})).rejects.toThrow("not allowed in goal");
  expect(calls).toBe(0);
  mode = "agent";
  await tool.execute("allowed", {});
  expect(calls).toBe(1);
});
