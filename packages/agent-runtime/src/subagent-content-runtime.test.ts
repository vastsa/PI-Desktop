/**
 * `TaskRead` through the real runtime (ADR 0089): the parent model asks for a
 * delegate's recorded steps, not just its report.
 *
 * The delegation itself is real — `Task`, the child agent loop, the child's
 * `Read` host call, `TaskWait`, and the settlement all run. Only the provider
 * is a fixture, and it tells parent from child requests by the child system
 * prompt, which is what lets the parent's `TaskRead` land while the child is
 * still working.
 */
import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentEventEnvelope,
  SubagentDefinition,
  UiMessage,
} from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const ISO = "2026-11-01T00:00:00.000Z";
const explorer: SubagentDefinition = {
  name: "explorer",
  description: "Search the workspace and report findings.",
  tools: ["Read"],
  prompt: "Report file paths and line numbers.",
  source: "builtin",
};
const provider: RuntimeProviderConfig = {
  id: "fixture",
  name: "Fixture",
  modelId: "fixture-model",
  baseUrl: "http://provider.invalid/v1",
  apiKey: "fixture-only",
  apiStyle: "chat_completions",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
const commandShell = {
  id: "bash" as const,
  label: "Bash",
  dialect: "posix" as const,
  available: true,
  isDefault: true,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function sse(deltas: unknown[], finish: string): Response {
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({
      id: "completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`;
  const body =
    deltas.map((delta) => chunk(delta, null)).join("") +
    chunk({}, finish) +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function toolCall(name: string, id: string, args: unknown): Response {
  return sse(
    [
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    ],
    "tool_calls",
  );
}

type ChatBody = {
  messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ type?: string; function?: { name?: string } }>;
};

function pendingToolOutput(body: ChatBody, callId: string): unknown {
  const row = body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === callId,
  );
  return row?.content;
}

function taskDelegationId(body: ChatBody): string {
  const found = JSON.stringify(body).match(/Delegation ([0-9a-f-]{36}) started/);
  if (!found) throw new Error("the Task result carried no delegation id");
  return found[1];
}

function createRuntime(options: {
  history?: UiMessage[];
  onEvent?: (envelope: AgentEventEnvelope) => void;
  provider?: RuntimeProviderConfig;
  subagents?: SubagentDefinition[];
}) {
  return new DesktopAgentRuntime({
    sessionId: "taskread-fixture",
    mode: "agent",
    thinkingLevel: "off",
    provider: options.provider ?? provider,
    commandShell,
    ...(options.history ? { history: options.history } : {}),
    subagents: options.subagents ?? [explorer],
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    host: {
      async call<T>(method: string): Promise<T> {
        if (method === "tools.fileBatchCapabilities") {
          return { version: 1, supported: false } as T;
        }
        if (method === "tools.execute") {
          return {
            ok: true,
            content: [{ type: "text", text: "export const a = 1;" }],
          } as T;
        }
        return undefined as T;
      },
      onNotification: () => () => {},
    },
    onEvent: options.onEvent ?? (() => {}),
  });
}

function toolByName(runtime: DesktopAgentRuntime, name: string) {
  const tool = (runtime as unknown as {
    agent?: { state?: { tools?: Array<{ name: string }> } };
  }).agent?.state?.tools?.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} is not declared`);
  return tool as {
    name: string;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{ content: unknown; details?: unknown; isError?: boolean }>;
  };
}

afterEach(() => vi.unstubAllGlobals());

it("lets the parent page a running delegate's steps while keeping them out of its own history", async () => {
  const childReadDone = deferred();
  const readDone = deferred();
  const parentBodies: ChatBody[] = [];
  const childBodies: ChatBody[] = [];
  let childTurns = 0;
  let parentTurns = 0;
  const events: AgentEventEnvelope[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as ChatBody;
      const raw = JSON.stringify(body);
      if (raw.includes(explorer.prompt)) {
        childBodies.push(body);
        childTurns += 1;
        if (childTurns === 1) {
          return sse(
            [
              { role: "assistant", content: "Reading the fixture now." },
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "child-read",
                    type: "function",
                    function: {
                      name: "Read",
                      arguments: JSON.stringify({ path: "src/app.ts" }),
                    },
                  },
                ],
              },
            ],
            "tool_calls",
          );
        }
        // The child is held until the parent's TaskRead has actually run, so
        // the test observes a running delegate rather than a settled one.
        await readDone.promise;
        return sse([{ role: "assistant", content: "Found it: src/app.ts:1" }], "stop");
      }
      parentBodies.push(body);
      parentTurns += 1;
      if (parentTurns === 1) {
        return toolCall("Task", "parent-task", {
          agent: "explorer",
          task: "Inspect src/app.ts",
        });
      }
      if (parentTurns === 2) {
        await childReadDone.promise;
        return toolCall("TaskRead", "parent-read", {
          delegationId: taskDelegationId(body),
          limit: 5,
        });
      }
      if (parentTurns === 3) {
        return toolCall("TaskWait", "parent-wait", {
          delegationIds: [taskDelegationId(body)],
        });
      }
      return sse([{ role: "assistant", content: "Done." }], "stop");
    }),
  );

  const runtime = createRuntime({
    onEvent: (envelope) => {
      events.push(envelope);
      const event = envelope.event;
      if (
        event.type === "tool_end" &&
        envelope.parentToolCallId &&
        event.toolCallId === "child-read"
      ) {
        childReadDone.resolve();
      }
      if (event.type === "tool_end" && event.toolCallId === "parent-read") {
        readDone.resolve();
      }
    },
  });

  try {
    await runtime.prompt("Review the fixture");
  } finally {
    childReadDone.resolve();
    readDone.resolve();
  }

  expect(parentBodies).toHaveLength(4);
  // Declared as a core delegation tool, without a ToolSearch round trip.
  expect(
    parentBodies[0].tools?.some((tool) => tool.function?.name === "TaskRead"),
  ).toBe(true);

  // The default parent history still holds no child step: the TaskRead request
  // is built before this page was read, and the child rows are never replayed.
  const beforeRead = JSON.stringify(parentBodies[1]);
  expect(beforeRead).not.toContain("Reading the fixture now.");
  expect(beforeRead).not.toContain("export const a = 1;");

  // The TaskRead result the parent model received.
  const pageText = pendingToolOutput(parentBodies[2], "parent-read");
  expect(typeof pageText).toBe("string");
  const page = JSON.parse(pageText as string);
  expect(page).toMatchObject({
    agent: "explorer",
    status: "running",
    source: "live",
    offset: 0,
    returned: 3,
    hasMore: false,
    nextOffset: null,
  });
  expect(page.steps.map((step: { role: string }) => step.role)).toEqual([
    "user",
    "assistant",
    "tool",
  ]);
  expect(page.steps[0]).toMatchObject({ role: "user", text: "Inspect src/app.ts" });
  expect(page.steps[1]).toMatchObject({ text: "Reading the fixture now." });
  expect(page.steps[2]).toMatchObject({
    toolName: "Read",
    toolCallId: "child-read",
    status: "success",
  });
  expect(page.steps[2].result).toContain("export const a = 1;");
  expect(page.steps[2].args).toContain("src/app.ts");

  // TaskWait still converges on the final report only, and the parent model
  // never sees the intermediate turn even after the wait.
  const waitText = JSON.stringify(pendingToolOutput(parentBodies[3], "parent-wait"));
  expect(waitText).toContain("Found it: src/app.ts:1");
  expect(waitText).not.toContain("Reading the fixture now.");
  // The child's turn is still not replayed as its own message; the only copy
  // is the page the parent explicitly asked for.
  const afterWait = JSON.stringify(parentBodies[3]);
  expect(afterWait.split("Reading the fixture now.")).toHaveLength(2);

  // The settled record stays readable, and status follows the run.
  const settled = await toolByName(runtime, "TaskRead").execute("read-again", {
    delegationId: page.delegationId,
  });
  expect(settled.isError).toBeFalsy();
  expect(settled.details).toMatchObject({ status: "completed", source: "live", total: 4 });
  // A delegate inherits no delegation tool, TaskRead included.
  expect(
    childBodies[0].tools?.some((tool) => tool.function?.name === "TaskRead"),
  ).toBe(false);
  expect(childBodies[0].tools?.some((tool) => tool.function?.name === "Task")).toBe(
    false,
  );

  // The delegate's rows reached the transcript under its own Task call.
  expect(events.some((envelope) => envelope.parentToolCallId === "parent-task")).toBe(true);

  await runtime.dispose();
});

function taskRow(options: {
  callId: string;
  delegationId: string;
  agent?: string;
  resume?: string;
  status?: string;
  task?: string;
}): UiMessage {
  return {
    id: `task-${options.callId}`,
    role: "tool",
    content: "",
    createdAt: ISO,
    toolCallId: options.callId,
    toolName: "Task",
    toolArgs: {
      agent: options.agent ?? "explorer",
      task: options.task ?? "Inspect src/app.ts",
      ...(options.resume ? { resume: options.resume } : {}),
    },
    toolResult: {
      content: [{ type: "text", text: "started" }],
      details: {
        delegationId: options.delegationId,
        agent: options.agent ?? "explorer",
        status: options.status ?? "completed",
      },
    },
    toolStatus: "success",
  };
}

function childRow(callId: string, overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: `child-${callId}-${overrides.id ?? "row"}`,
    role: "assistant",
    content: "read src/app.ts",
    createdAt: ISO,
    status: "complete",
    parentToolCallId: callId,
    agentName: "explorer",
    ...overrides,
  };
}

it("reads a finished delegation from the rebuilt chain and keeps parallel delegates apart", async () => {
  const history: UiMessage[] = [
    taskRow({ callId: "task-a", delegationId: "deleg-a" }),
    childRow("task-a", { id: "a1", content: "a first step" }),
    childRow("task-a", { id: "a2" }),
    taskRow({ callId: "task-b", delegationId: "deleg-b" }),
    childRow("task-b", { id: "b1", content: "b only step" }),
  ];
  const runtime = createRuntime({ history });
  const read = toolByName(runtime, "TaskRead");

  const page = await read.execute("read-a", { delegationId: "deleg-a", limit: 40 });
  expect(page.isError).toBeFalsy();
  expect(page.details).toMatchObject({
    delegationId: "deleg-a",
    agent: "explorer",
    status: "completed",
    source: "chain",
    total: 3,
    returned: 3,
  });
  expect(page.details).toMatchObject({ steps: [
    { role: "user", text: "Inspect src/app.ts" }, { text: "a first step" }, { text: "read src/app.ts" },
  ] });
  expect(JSON.stringify(page.details)).not.toContain("b only step");

  const other = await read.execute("read-b", { delegationId: "deleg-b" });
  expect(other.details).toMatchObject({ delegationId: "deleg-b", total: 2 });
  expect(other.details).toMatchObject({ steps: [{ role: "user", text: "Inspect src/app.ts" }, { text: "b only step" }] });

  await runtime.dispose();
});

it("rejects an unknown or foreign delegation id with a typed tool error", async () => {
  const runtime = createRuntime({ history: [taskRow({ callId: "task-a", delegationId: "deleg-a" })] });
  const read = toolByName(runtime, "TaskRead");

  const unknown = await read.execute("read-x", {
    delegationId: "00000000-0000-4000-8000-000000000000",
  });
  expect(unknown.isError).toBe(true);
  expect(unknown.details).toMatchObject({
    error: { code: "SUBAGENT_CONTENT_UNKNOWN_DELEGATION" },
  });

  const path = await read.execute("read-path", { delegationId: "../src/app.ts" });
  expect(path.isError).toBe(true);
  expect(path.details).toMatchObject({
    error: { code: "SUBAGENT_CONTENT_INVALID_ARGUMENT" },
  });
  expect(String((path.content as Array<{ text: string }>)[0].text)).toContain(
    "does not read files",
  );

  await runtime.dispose();
});

it("reads every Task call of a resumed chain and counts rows attributed only by call id", async () => {
  const history: UiMessage[] = [
    taskRow({ callId: "task-1", delegationId: "deleg-1" }),
    childRow("task-1", { id: "one" }),
    taskRow({ callId: "task-2", delegationId: "deleg-2", resume: "deleg-1" }),
    childRow("task-2", { id: "two", content: "resumed step", agentName: "agents/explorer" }),
    {
      id: "legacy",
      role: "assistant",
      content: "legacy step without an agent name",
      createdAt: ISO,
      status: "complete",
      parentToolCallId: "task-2",
    },
  ];
  const runtime = createRuntime({ history });
  const read = toolByName(runtime, "TaskRead");

  // Either id resolves the chain; the page covers both runs in one sequence.
  const byLatest = await read.execute("read-latest", { delegationId: "deleg-2" });
  expect(byLatest.details).toMatchObject({
    status: "completed",
    source: "chain",
    total: 5,
    unattributedRows: 1,
  });
  expect(byLatest.details).toMatchObject({
    steps: [{ role: "user", text: "Inspect src/app.ts" }, { id: "one" },
      { role: "user", text: "Inspect src/app.ts" }, { id: "two" }, { id: "legacy" }],
    note: expect.stringContaining("1 step"),
  });

  const byFirst = await read.execute("read-first", { delegationId: "deleg-1" });
  expect(byFirst.details).toMatchObject({ total: 5 });

  await runtime.dispose();
});

it("keeps TaskRead available for restored history after the agent definition is removed", async () => {
  const bodies: ChatBody[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    bodies.push(body);
    return bodies.length === 1
      ? toolCall("TaskRead", "read-old-agent", { delegationId: "retained-agent" })
      : sse([{ role: "assistant", content: "The retained step is readable." }], "stop");
  }));
  const runtime = createRuntime({
    subagents: [],
    history: [
      taskRow({ callId: "old-task", delegationId: "retained-agent" }),
      childRow("old-task", { content: "retained child step" }),
    ],
  });
  try {
    await runtime.prompt("Read the previous subagent's recorded steps.");
    expect(bodies[0].tools?.some((tool) => tool.function?.name === "TaskRead")).toBe(true);
    expect(String(pendingToolOutput(bodies[1], "read-old-agent"))).toContain("retained child step");
    expect(String(pendingToolOutput(bodies[1], "read-old-agent"))).toMatch(/"source"\s*:\s*"chain"/);
  } finally {
    await runtime.dispose();
  }
});

it("lets the parent discover a user-created child and read its task, follow-up and answers", async () => {
  const bodies: ChatBody[] = [];
  let delegationId = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    bodies.push(body);
    if (bodies.length === 1) return sse([{ role: "assistant", content: "Initial child answer" }], "stop");
    if (bodies.length === 2) return sse([{ role: "assistant", content: "Follow-up child answer" }], "stop");
    if (bodies.length === 3) return toolCall("TaskList", "list-user-child", {});
    if (bodies.length === 4) return toolCall("TaskRead", "read-user-child", { delegationId });
    return sse([{ role: "assistant", content: "Reviewed the user's child conversation." }], "stop");
  }));
  const runtime = createRuntime({});
  try {
    const started = await runtime.controlSubagent({ sessionId: "taskread-fixture", operationId: "user-child-start",
      action: "start", agent: "explorer", task: "Inspect the initial code" }, "child-initial-turn");
    await vi.waitFor(() => expect(runtime.getStatus().isRunning).toBe(false));
    const continued = await runtime.controlSubagent({ sessionId: "taskread-fixture", operationId: "user-child-followup",
      action: "message", delegationId: started.delegationId, content: "Now inspect the failing tests" }, "child-followup-turn");
    delegationId = continued.delegationId;
    await vi.waitFor(() => expect(runtime.getStatus().isRunning).toBe(false));
    await runtime.prompt("Review my subagent conversation", "main-user", "main-turn");
    expect(bodies).toHaveLength(5);
    expect(JSON.stringify(bodies[2].messages)).not.toContain("Now inspect the failing tests");
    expect(String(pendingToolOutput(bodies[3], "list-user-child"))).toContain(delegationId);
    const page = JSON.parse(String(pendingToolOutput(bodies[4], "read-user-child")));
    expect(page.steps.map((step: { role: string; text?: string }) => [step.role, step.text])).toEqual([
      ["user", "Inspect the initial code"], ["assistant", "Initial child answer"],
      ["user", "Now inspect the failing tests"], ["assistant", "Follow-up child answer"],
    ]);
  } finally { await runtime.dispose(); }
});

it.each([true, false])("discovers and reads stopped history beyond the resume cache: definitions=%s", async (configured) => {
  const history: UiMessage[] = [
    taskRow({ callId: "old-task", delegationId: "old-child", status: "stopped", task: "Initial historical task" }),
    childRow("old-task", { id: "answer", content: "Initial historical answer" }),
    taskRow({ callId: "old-followup", delegationId: "old-followup-child", resume: "old-child", status: "stopped", task: "Historical follow-up" }),
    childRow("old-followup", { id: "followup-answer", content: "Historical follow-up answer" }),
    ...Array.from({ length: 44 }, (_, index) => {
      const row = taskRow({ callId: `new-task-${index}`, delegationId: `new-child-${index}` });
      return { ...row, createdAt: new Date(Date.parse(ISO) + index + 1).toISOString() };
    }),
  ];
  const bodies: ChatBody[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    bodies.push(body);
    if (bodies.length === 1) return toolCall("TaskList", "list-history", {});
    if (bodies.length === 2) return toolCall("TaskList", "list-earlier", { offset: 40 });
    if (bodies.length === 3) return toolCall("TaskRead", "read-history", { delegationId: "old-child", limit: 2 });
    if (bodies.length === 4) return toolCall("TaskRead", "read-followup", { delegationId: "old-followup-child", offset: 2 });
    return sse([{ role: "assistant", content: "Reviewed the stopped history." }], "stop");
  }));
  const runtime = createRuntime({ history, subagents: configured ? [explorer] : [] });
  try {
    await runtime.prompt("Find my older stopped child and review its conversation.");
    expect(bodies[0].tools?.some(tool => tool.function?.name === "TaskList")).toBe(true);
    expect(JSON.stringify(bodies[0].messages)).not.toContain("Historical follow-up answer");
    const first = String(pendingToolOutput(bodies[1], "list-history"));
    expect(first).toContain('"total":45');
    expect(first).toContain('"nextOffset":40');
    const earlier = String(pendingToolOutput(bodies[2], "list-earlier"));
    expect(earlier).toContain('"delegationId":"old-followup-child"');
    expect(earlier).toContain('"status":"stopped"');
    const initial = JSON.parse(String(pendingToolOutput(bodies[3], "read-history")));
    expect(initial).toMatchObject({ source: "chain", status: "stopped", total: 4, nextOffset: 2,
      steps: [{ role: "user", text: "Initial historical task" }, { role: "assistant", text: "Initial historical answer" }] });
    const followup = JSON.parse(String(pendingToolOutput(bodies[4], "read-followup")));
    expect(followup).toMatchObject({ total: 4, nextOffset: null,
      steps: [{ role: "user", text: "Historical follow-up" }, { role: "assistant", text: "Historical follow-up answer" }] });
    const listed = await toolByName(runtime, "TaskList").execute("check-resumable", {});
    expect(listed.details).not.toHaveProperty("resumable", expect.arrayContaining([
      expect.objectContaining({ delegationId: "old-followup-child" }),
    ]));
    const foreign = await toolByName(runtime, "TaskRead").execute("foreign", { delegationId: "another-session-child" });
    expect(foreign.isError).toBe(true);
  } finally { await runtime.dispose(); }
});

it("includes the model-created Task brief and resumed brief as user steps", async () => {
  const runtime = createRuntime({ history: [
    taskRow({ callId: "first", delegationId: "first-child" }),
    childRow("first", { content: "First answer" }),
    taskRow({ callId: "next", delegationId: "next-child", resume: "first-child" }),
    childRow("next", { content: "Next answer" }),
  ] });
  try {
    const page = await toolByName(runtime, "TaskRead").execute("read", { delegationId: "first-child" });
    expect(page.details).toMatchObject({ total: 4, steps: [
      { role: "user", text: "Inspect src/app.ts" }, { role: "assistant", text: "First answer" },
      { role: "user", text: "Inspect src/app.ts" }, { role: "assistant", text: "Next answer" },
    ] });
  } finally { await runtime.dispose(); }
});
