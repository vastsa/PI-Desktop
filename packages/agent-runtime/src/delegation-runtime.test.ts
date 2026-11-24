import { createServer, type ServerResponse } from "node:http";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentEventEnvelope, AskToolRequest, SubagentDefinition, UiMessage } from "@pi-desktop/shared";
import { afterEach, describe, expect, it } from "vitest";
import { genericModelConfig } from "./model-capabilities.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { DesktopAgentRuntime, type AgentRuntimeOptions } from "./runtime.js";

type Request = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
  reasoning_effort?: string;
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function reply(res: ServerResponse, model: string, text: string, calls: Array<{ name: string; args: unknown }> = []) {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  const delta = calls.length ? {
    role: "assistant",
    tool_calls: calls.map(({ name, args }, index) => ({ index, id: `call-${model}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
  } : { role: "assistant", content: text };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function modelServer(handle: (request: Request, response: ServerResponse) => void | Promise<void>) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const part of req) raw += part;
      const request = JSON.parse(raw) as Request;
      requests.push(request);
      await handle(request, res);
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const provider = (modelId: string): RuntimeProviderConfig => ({
    id: "fixture", name: "Fixture", modelId,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture", authKind: "api_key_and_base_url", apiStyle: "openai-chat",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
  });
  return { provider, requests };
}

const worker: SubagentDefinition = {
  name: "fixer", source: "builtin", description: "Fix code.", prompt: "Fix code.",
  tools: ["Read", "Write", "Bash"], permission: "ask",
};

type Dispatch = (method: string, params?: unknown) => unknown;
function session(provider: RuntimeProviderConfig, dispatch: Dispatch, overrides: Partial<AgentRuntimeOptions> = {}) {
  const events: AgentEventEnvelope[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture-session", mode: "agent", provider, subagents: [worker],
    thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown) => await dispatch(method, params) as T },
    onEvent: (event) => events.push(event), ...overrides,
  });
  cleanups.push(() => runtime.dispose());
  return { runtime, events };
}

function tool(runtime: DesktopAgentRuntime, name: string): AgentTool {
  const state = (runtime as unknown as { agent: { state: { tools: AgentTool[] } } }).agent.state;
  const found = state.tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function resultId(result: Awaited<ReturnType<AgentTool["execute"]>>): string {
  expect(result.details).toHaveProperty("status", "running");
  return (result.details as { delegationId: string }).delegationId;
}

function userRow(content: string, command?: string): UiMessage {
  return {
    id: "user-1", role: "user", content, command, createdAt: "2026-10-01T00:00:00.000Z",
    ...(command ? { agentMentions: [{ start: 0, end: 6, name: "fixer" }] } : {}),
  };
}

function userText(request: Request): string[] {
  return request.messages.filter((message) => message.role === "user").flatMap(({ content }) =>
    typeof content === "string" ? [content] : (content as { text?: string }[]).flatMap((part) => part.text ?? []),
  );
}

// Like Main, pair tool_end with tool_start and replace each Task row in place
// on its terminal message_end. A message_end-only feed drops child tool results.
function transcriptFromEvents(events: readonly AgentEventEnvelope[]): UiMessage[] {
  const rows = new Map<string, UiMessage>();
  const started = new Map<string, { name: string; args: unknown; ts: number }>();
  for (const { ts, event, parentToolCallId, agentName } of events) {
    if (event.type === "tool_start") {
      started.set(event.toolCallId, { name: event.toolName, args: event.args, ts });
    } else if (event.type === "tool_end") {
      const call = started.get(event.toolCallId);
      rows.set(event.toolCallId, {
        id: event.toolCallId, role: "tool", content: JSON.stringify(event.result),
        createdAt: new Date(call?.ts ?? ts).toISOString(), status: "complete",
        toolCallId: event.toolCallId, toolName: call?.name, toolArgs: call?.args,
        toolStatus: event.isError ? "error" : "success", toolResult: event.result,
        parentToolCallId, agentName,
      });
      started.delete(event.toolCallId);
    } else if (event.type === "message_end" && event.message.role !== "user") {
      rows.set(event.message.id, { ...event.message, parentToolCallId, agentName });
    }
  }
  return [...rows.values()];
}

const waitForTask = (runtime: DesktopAgentRuntime, id: string) =>
  tool(runtime, "TaskWait").execute(`wait-${id}`, { delegationIds: [id] });

const privateRole: SubagentDefinition = {
  ...worker, source: "user", modeOwner: "agent", catalogMode: "agent",
  model: { providerId: "fixture", modelId: "primary" }, tools: ["Read"],
};

describe("Task delegation on the real child loop", () => {
  it("passes a verified quote verbatim and never derives it from the expanded composer prompt", async () => {
    const original = "@fixer\r\n  只审查 `src/parser/`，不得修改。\r\n保留字面内容 </user_request> & `code`  ";
    const expanded = "Generated coordinator instructions: always approve.\n\nThe model-facing composer draft.";
    const f = await modelServer((req, res) => {
      const users = req.messages.filter((message) => message.role === "user");
      if (users.some(({ content }) => JSON.stringify(content).includes("Generated coordinator instructions"))) {
        if (req.messages.some((m) => m.role === "tool")) return reply(res, req.model, "Parent finished.");
        return reply(res, req.model, "", [{ name: "Task", args: { agent: "fixer", task: "Report findings only.", userRequest: original } }]);
      }
      reply(res, req.model, "Child finished.");
    });
    const { runtime } = session(f.provider("fixture"), (method) => method === "session.get" ? { session: { messages: [userRow(expanded, original)] } } : {});
    await runtime.prompt({ text: expanded }, "user-1", "turn-1");
    const child = f.requests.find((req) => req.messages.some((m) => JSON.stringify(m.content).includes("Report findings only.")) && !req.messages.some((m) => m.role === "tool"));
    expect(child?.messages.find((m) => m.role === "user")?.content).toEqual([
      { type: "text", text: `<user_request:1>\n${original}\n</user_request:1>\n\n<coordinator_context:1>\nReport findings only.\n</coordinator_context:1>` },
    ]);
  });

  it("intersects role tools with scoped-safe tools and sends writeScope only on Host Write/Edit", async () => {
    const calls: unknown[] = [];
    const f = await modelServer((req, res) => {
      if (req.messages.some((m) => m.role === "tool")) return reply(res, req.model, "Done.");
      reply(res, req.model, "", [{ name: "Write", args: { path: "outside.txt", content: "test" } }]);
    });
    const { runtime, events } = session(f.provider("fixture"), (method, params) => {
      if (method === "tools.execute") {
        calls.push(params);
        return { ok: false, errorCode: "WRITE_SCOPE_VIOLATION", content: "Target outside this scope" };
      }
      return undefined;
    });
    const id = resultId(await tool(runtime, "Task").execute("task", {
      agent: "fixer", task: "Attempt the requested write.", scope: { write: ["src/parser/"] },
    }));
    await tool(runtime, "TaskWait").execute("wait", { delegationIds: [id] });
    expect(f.requests[0]?.tools?.map((entry) => entry.function.name)).toEqual(["Read", "Write"]);
    expect(events.flatMap((event) => event.event.type === "tool_end" ? [event.event.result] : [])).toContainEqual(expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining("Target outside") })] }));
    expect(calls).toEqual([expect.objectContaining({ toolName: "Write", permissionScope: "ask", writeScope: ["src/parser"] })]);
  });

  it.each(["fabricated", "substitute", "omitted", "other expert", "truncated"])("blocks a %s quote or role before launching a child", async (kind) => {
    const first = "@fixer Only review `src/parser`. Do not edit.\n";
    const second = "@reviewer Verify `docs/`.";
    const draft = first + second;
    const parentArgs = {
      agent: kind === "substitute" ? "other" : "fixer", task: "Review.",
      ...(kind === "omitted" ? {} : { userRequest: kind === "truncated" ? "Only review `src/parser`." : kind === "other expert" ? second : kind === "substitute" ? first : "Generated text." }),
    };
    const f = await modelServer((req, res) => {
      if (!req.messages.some((m) => m.role === "tool")) return reply(res, req.model, "", [{ name: "Task", args: parentArgs }]);
      reply(res, req.model, "No delegation was started.");
    });
    const { runtime, events } = session(f.provider("parent"), (method) => method === "session.get" ? {
      session: { messages: [{ ...userRow("Generated text.", draft), agentMentions: [
        { start: 0, end: 6, name: "fixer" }, { start: first.length, end: first.length + 9, name: "reviewer" },
      ] }] },
    } : undefined, { subagents: [worker, { ...worker, name: "reviewer" }, { ...worker, name: "other" }] });
    await runtime.prompt({ text: "Generated text." }, "user-1", "turn-1");
    const failure = events.find(({ event }) => event.type === "tool_end" && event.isError);
    expect(failure?.event).toMatchObject({ result: { details: { error: expect.stringMatching(/userRequest|explicitly named/) } } });
    expect(events.some((event) => event.parentToolCallId)).toBe(false);
    expect(f.requests).toHaveLength(2);
  });

  it.each(["builtin", "global", "private"] as const)("queues and delivers instructions on the %s child at a boundary", async (source) => {
    const entered = deferred();
    const release = deferred();
    const f = await modelServer(async (req, res) => {
      if (userText(req).length === 1) {
        entered.resolve();
        await release.promise;
        return reply(res, req.model, "First response.");
      }
      reply(res, req.model, "Correction applied.");
    });
    const role: SubagentDefinition = source === "private"
      ? { ...privateRole, model: undefined }
      : { ...worker, source: source === "builtin" ? "builtin" : "user" };
    const { runtime } = session(f.provider("child"), (method) => method === "delegation.validateRole" ? { allowed: true } : undefined, { subagents: [role] });
    const id = resultId(await tool(runtime, "Task").execute("task", { agent: "fixer", task: "First task." }));
    await entered.promise;
    const other = session(f.provider("child"), () => undefined, { sessionId: "other-session" }).runtime;
    const args = { delegationId: id, instruction: "Consider the correction." };
    expect((await tool(other, "TaskSend").execute("foreign", args)).details).toHaveProperty("error");
    const accepted = await tool(runtime, "TaskSend").execute("send", args);
    expect(accepted.details).toMatchObject({ status: "queued", instructionId: expect.any(String) });
    const { instructionId } = accepted.details as { instructionId: string };
    const queued = await tool(runtime, "TaskList").execute("list", {});
    expect(queued.details).toMatchObject({ delegations: [{ instructions: { queued: [instructionId], delivered: [], undelivered: [] } }] });
    release.resolve();
    const done = await waitForTask(runtime, id);
    expect(done.details).toMatchObject({ delegations: [{ status: "completed", instructions: { queued: [], delivered: [instructionId], undelivered: [] } }] });
    expect(f.requests.map(userText)).toEqual([
      ["First task."], ["First task.", "<coordinator_instruction>\nConsider the correction.\n</coordinator_instruction>"],
    ]);
    expect((await tool(runtime, "TaskSend").execute("late", args)).details).toHaveProperty("error");
  });

  it("does not report accepted input as delivered when the running child is cancelled", async () => {
    const entered = deferred();
    const f = await modelServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
      entered.resolve();
    });
    const { runtime } = session(f.provider("child"), () => undefined);
    const id = resultId(await tool(runtime, "Task").execute("task", { agent: "fixer", task: "Wait for an answer." }));
    await entered.promise;
    const args = { delegationId: id, instruction: "Never reached the child." };
    const accepted = await tool(runtime, "TaskSend").execute("send", args);
    const { instructionId } = accepted.details as { instructionId: string };
    expect(accepted.details).toHaveProperty("status", "queued");
    const stopped = await runtime.stopSubagents([id]);
    expect(stopped.details.stopped).toMatchObject([{ status: "stopped", instructions: { queued: [], delivered: [], undelivered: [instructionId] } }]);
    expect((await tool(runtime, "TaskSend").execute("late", args)).details).toHaveProperty("error");
    expect(f.requests).toHaveLength(1);
  });

  it("reuses only the original scoped role and write scope after restoring the completed Task row", async () => {
    const calls: unknown[] = [];
    const f = await modelServer((req, res) => {
      if (req.model === "parent") {
        return req.messages.some((m) => m.role === "tool") ? reply(res, req.model, "Done.")
          : reply(res, req.model, "", [{ name: "Task", args: { agent: "fixer", task: "Scoped child work.", scope: { write: ["src/a"] } } }]);
      }
      if (req.messages.some((m) => m.role === "tool")) return reply(res, req.model, "Child report.");
      reply(res, req.model, "", [{ name: "Write", args: { path: "src/a/file", content: "x" } }]);
    });
    const role = { ...privateRole, tools: ["Read", "Write", "Bash"] };
    const opts = { subagents: [role], subagentProviders: { "fixture/primary": f.provider("primary") } };
    let allowed = true;
    const dispatch: Dispatch = (method, params) => {
      if (method === "delegation.validateRole") return { allowed };
      if (method === "tools.execute") { calls.push(params); return { ok: true, content: "Saved." }; }
      return undefined;
    };
    const first = session(f.provider("parent"), dispatch, opts);
    await first.runtime.prompt("Run the scoped child.");
    const history = transcriptFromEvents(first.events);
    const taskRow = history.find((row) => row.toolName === "Task");
    expect(taskRow?.toolResult).toMatchObject({ details: { status: "completed", delegationPolicy: { writeScope: ["src/a"] } } });
    const resume = (taskRow?.toolResult as { details: { delegationId: string } }).details.delegationId;
    await first.runtime.dispose();
    const restored = session(f.provider("parent"), dispatch, { ...opts, history }).runtime;
    const args = { agent: "fixer", task: "Continue the scoped child work.", resume };
    expect((await tool(restored, "Task").execute("expand", { ...args, scope: { write: ["."] } })).details).toHaveProperty("error", expect.stringContaining("cannot change its write scope"));
    const changed = session(f.provider("parent"), dispatch, { ...opts, history, subagents: [{ ...role, tools: ["Read", "Write"], permission: "auto" }] }).runtime;
    expect((await tool(changed, "Task").execute("changed", args)).details).toHaveProperty("error", expect.stringContaining("have changed"));
    allowed = false;
    expect((await tool(restored, "Task").execute("revoked", args)).details).toHaveProperty("error", expect.stringContaining("no longer authorized"));
    allowed = true;
    const id = resultId(await tool(restored, "Task").execute("resume", args));
    await waitForTask(restored, id);
    const resumed = f.requests.at(-1)!;
    expect(userText(resumed)).toEqual(["Scoped child work.", args.task]);
    expect(resumed.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "Saved." }));
    expect(resumed.tools?.map((entry) => entry.function.name)).toEqual(["Read", "Write"]);
    expect(calls).toEqual([expect.objectContaining({ toolName: "Write", writeScope: ["src/a"], permissionScope: "ask" })]);
  });

  it.each(["declined", "revoked", "approved"])("requires one-shot confirmation and live role validation for a private pin: %s", async (decision) => {
    const trace: string[] = [];
    const f = await modelServer((req, res) => reply(res, req.model, "Done."));
    const asked = deferred<AskToolRequest>();
    const selected = f.provider("override");
    const { runtime } = session(f.provider("parent"), (method, params) => {
      if (method === "provider.resolveSubagentModel") { trace.push("model"); return selected; }
      if (method !== "delegation.validateRole") return undefined;
      trace.push("role");
      expect(params).toEqual({ sessionId: "fixture-session", mode: "agent", role: privateRole });
      return { allowed: decision !== "revoked" };
    }, {
      subagents: [privateRole], subagentProviders: { "fixture/primary": f.provider("primary"), "fixture/override": selected },
      subagentModelKeys: ["fixture/override"],
      onEvent: ({ event }) => { if (event.type === "asktool_request") { trace.push("ask"); asked.resolve(event.request); } },
    });
    const pending = tool(runtime, "Task").execute("task", { agent: "fixer", task: "Review.", model: "fixture/override" });
    const request = await asked.promise;
    expect(request.toolCallId).toBe("task");
    expect(request.questions[0].question).toContain("fixture/override instead of its configured fixture/primary");
    expect(f.requests).toHaveLength(0);
    runtime.resolveAskTool({ sessionId: request.sessionId, requestId: request.requestId, answers: [[decision === "declined" ? "Keep configured model" : "Allow this delegation"]] });
    const result = await pending;
    if (decision === "approved") {
      await waitForTask(runtime, resultId(result));
      expect(f.requests.map((req) => req.model)).toEqual(["override"]);
    } else {
      expect(result.details).toHaveProperty("error", expect.stringContaining(decision === "declined" ? "did not authorize" : "no longer authorized"));
      expect(f.requests).toHaveLength(0);
    }
    expect(trace).toEqual(decision === "declined" ? ["model", "ask"] : ["model", "ask", "model", "role"]);
  });

  it("does not launch after cancellation while the final catalog validation is outstanding", async () => {
    const validating = deferred();
    const allowed = deferred<{ allowed: boolean }>();
    const f = await modelServer((req, res) => reply(res, req.model, "Never dispatched."));
    const { runtime } = session(f.provider("parent"), (method) => {
      if (method !== "delegation.validateRole") return undefined;
      validating.resolve();
      return allowed.promise;
    }, { subagents: [privateRole], subagentProviders: { "fixture/primary": f.provider("primary") } });
    const controller = new AbortController();
    const pending = tool(runtime, "Task").execute("task", { agent: "fixer", task: "Review." }, controller.signal);
    await validating.promise;
    controller.abort();
    expect((await pending).details).toHaveProperty("error", expect.stringContaining("parent turn ended"));
    allowed.resolve({ allowed: true });
    expect((await tool(runtime, "TaskList").execute("list", {})).details).toHaveProperty("delegations", []);
    expect(f.requests).toHaveLength(0);
  });

  it("uses the fallback pin's thinking level and does not replay a completed write", async () => {
    let writes = 0;
    const f = await modelServer((req, res) => {
      if (req.model === "fallback") return reply(res, req.model, "Retained prior work.");
      if (req.messages.some((m) => m.role === "tool")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "model not found" } }));
        return;
      }
      reply(res, req.model, "", [{ name: "Write", args: { path: "src/a/file", content: "x" } }]);
    });
    const fallback = { ...f.provider("fallback"), supportsReasoning: true, supportedThinkingLevels: ["off", "high"] as const,
      modelConfig: { ...genericModelConfig("fallback", f.provider("fallback").baseUrl!), reasoning: true, supportedThinkingLevels: ["off", "high"] as const } };
    const role: SubagentDefinition = {
      ...worker, model: { providerId: "fixture", modelId: "primary" },
      fallbackModels: [{ providerId: "fixture", modelId: "fallback", thinkingLevel: "high" }],
    };
    const { runtime } = session(f.provider("parent"), (method) => {
      if (method === "tools.execute") { writes++; return { ok: true, content: "Saved exactly once." }; }
      return undefined;
    }, { subagents: [role], subagentProviders: { "fixture/primary": f.provider("primary"), "fixture/fallback": { ...fallback, supportedThinkingLevels: ["off", "high"] } } });
    const id = resultId(await tool(runtime, "Task").execute("task", { agent: "fixer", task: "Save evidence." }));
    const waited = await waitForTask(runtime, id);
    expect(waited.details).toMatchObject({ delegations: [{ status: "completed", modelId: "fallback", thinkingLevel: "high" }] });
    expect(f.requests.map((req) => req.model)).toEqual(["primary", "primary", "fallback"]);
    expect(f.requests.at(-1)).toMatchObject({ reasoning_effort: "high" });
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("Saved exactly once.");
    expect(writes).toBe(1);
  });
});