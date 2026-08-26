import { describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, SubagentDefinition } from "@pi-desktop/shared";
import {
  composeSubagentSystemPrompt,
  MAX_SUBAGENT_REPORT_CHARS,
  SubagentRun,
  type SubagentRunOptions,
} from "./subagent.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { classifyAgentError } from "./agent-errors.js";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

function definition(
  overrides: Partial<SubagentDefinition> = {},
): SubagentDefinition {
  return {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read", "Glob", "Grep"],
    maxTurns: 3,
    prompt: "Find the answer and report it.",
    source: "builtin",
    ...overrides,
  };
}

function createRun(overrides: Partial<SubagentRunOptions> = {}) {
  const events: AgentEventEnvelope[] = [];
  const run = new SubagentRun({
    definition: overrides.definition ?? definition(),
    sessionId: "session-1",
    turnId: "turn-1",
    parentToolCallId: "task-1",
    task: "Find where the permission dialog is rendered.",
    provider,
    thinkingLevel: "off",
    systemPrompt: "system",
    tools: [],
    onEvent: (envelope) => events.push(envelope),
    ...overrides,
  });
  return { run: run as unknown as Record<string, any>, events };
}

/** Minimal pi-ai assistant message shaped like the ones the loop emits. */
function assistantMessage(overrides: {
  content: unknown[];
  stopReason?: string;
  usage?: Record<string, unknown>;
}) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    stopReason: overrides.stopReason ?? "stop",
    timestamp: 1,
    usage: overrides.usage ?? {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: overrides.content,
  };
}

describe("composeSubagentSystemPrompt", () => {
  it("states the read-only boundary and keeps project guidance last", () => {
    const prompt = composeSubagentSystemPrompt({
      definition: definition(),
      guidance: ["Follow the project rules."],
    });

    expect(prompt).toContain('You are the "explorer" subagent');
    expect(prompt).toContain("Read, Glob, Grep");
    expect(prompt).toContain("no tools that change files");
    expect(prompt).toContain("Find the answer and report it.");
    expect(prompt.indexOf("Find the answer and report it.")).toBeLessThan(
      prompt.indexOf("Follow the project rules."),
    );
  });

  it("tells a mutating delegate to stay inside its task", () => {
    const prompt = composeSubagentSystemPrompt({
      definition: definition({ tools: ["Read", "Edit"] }),
    });

    expect(prompt).toContain("You may change files");
    expect(prompt).not.toContain("no tools that change files");
  });
});

describe("SubagentRun event forwarding", () => {
  it("tags every forwarded row with the Task call and the agent name", () => {
    const { run, events } = createRun();

    run.handleEvent({
      type: "message_start",
      message: assistantMessage({ content: [{ type: "text", text: "Look" }] }),
    });
    run.handleEvent({
      type: "message_update",
      message: assistantMessage({
        content: [{ type: "text", text: "Looking at" }],
      }),
    });
    run.handleEvent({
      type: "tool_execution_start",
      toolCallId: "child-read",
      toolName: "Read",
      args: { path: "a.ts" },
    });
    run.handleEvent({
      type: "tool_execution_end",
      toolCallId: "child-read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });

    expect(events.map((event) => event.event.type)).toEqual([
      "message_start",
      "message_update",
      "tool_start",
      "tool_end",
    ]);
    for (const event of events) {
      expect(event.parentToolCallId).toBe("task-1");
      expect(event.agentName).toBe("explorer");
      expect(event.turnId).toBe("turn-1");
    }
    const started = events[0].event as { message: Record<string, unknown> };
    expect(started.message.parentToolCallId).toBe("task-1");
    expect(started.message.agentName).toBe("explorer");
    const update = events[1].event as { deltaText: string };
    expect(update.deltaText).toBe("ing at");
  });

  it("keeps turn and agent lifecycle events inside the delegate", () => {
    const { run, events } = createRun();

    run.handleEvent({ type: "turn_start" });
    run.handleEvent({ type: "turn_end" });
    run.handleEvent({ type: "agent_end", messages: [] });

    expect(events).toEqual([]);
    expect(run.turns).toBe(1);
  });
});

describe("SubagentRun reporting", () => {
  it("keeps the last non-empty assistant text as the report", () => {
    const { run } = createRun();

    run.handleEvent({
      type: "message_end",
      message: assistantMessage({
        content: [{ type: "text", text: "First pass done." }],
      }),
    });
    // A tool-call-only turn has no text and must not clear the report.
    run.handleEvent({
      type: "message_end",
      message: assistantMessage({
        content: [{ type: "toolCall", name: "Read", id: "child-read" }],
      }),
    });

    expect(run.lastReportText).toBe("First pass done.");
    expect(run.usage.totalTokens).toBe(30);
  });

  it("bounds a runaway report", () => {
    const { run } = createRun();
    const report = "x".repeat(MAX_SUBAGENT_REPORT_CHARS * 2);

    const result = run.result("completed", report);

    expect(result.report.length).toBeLessThanOrEqual(MAX_SUBAGENT_REPORT_CHARS);
    expect(result.report).toContain("[subagent report truncated]");
  });

  it("explains a truncated, aborted, or failed run in the parent's text", () => {
    const { run } = createRun();
    run.turns = 3;

    expect(run.result("truncated", "Half of the files checked.").report).toContain(
      "hit its 3-turn limit",
    );
    expect(run.result("truncated", "Half of the files checked.").report).toContain(
      "Half of the files checked.",
    );
    expect(run.result("aborted", "").report).toContain("was aborted after 3 turn");
    expect(
      run.result("failed", "", { code: "NETWORK_ERROR", message: "no route" })
        .report,
    ).toContain("no route");
  });

  it("reports no-report as a failure rather than an empty success", async () => {
    const { run } = createRun();
    run.agent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
    };

    const result = await (run as unknown as SubagentRun).run();

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("SUBAGENT_NO_REPORT");
  });

  it("returns aborted without prompting when the parent call is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run } = createRun({ signal: controller.signal });
    const prompt = vi.fn();
    run.agent = { prompt, waitForIdle: vi.fn(), abort: vi.fn() };

    const result = await (run as unknown as SubagentRun).run();

    expect(result.status).toBe("aborted");
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("SubagentRun provider rate-limit recovery", () => {
  it("retries five 429s silently and reuses one assistant row", async () => {
    const { run, events } = createRun();
    const failure = {
      ...assistantMessage({
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
      }),
      errorMessage: "upstream unavailable",
    };
    run.providerResponseStatus = 429;
    const state = {
      messages: [] as Array<Record<string, unknown>>,
    };
    const continueRun = vi.fn(async () => {
      state.messages = [...state.messages, failure];
      run.handleEvent({ type: "message_start", message: { ...failure, content: [] } });
      run.handleEvent({ type: "message_end", message: failure });
    });
    run.agent = {
      state,
      prompt: vi.fn(async () => {
        state.messages = [{ role: "user", content: "task" }, failure];
        run.handleEvent({ type: "message_start", message: failure });
        run.handleEvent({ type: "message_end", message: failure });
      }),
      waitForIdle: vi.fn(async () => undefined),
      continue: continueRun,
      abort: vi.fn(),
    };

    vi.useFakeTimers();
    try {
      const resultPromise = run.run();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(continueRun).toHaveBeenCalledTimes(5);
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("PROVIDER_RATE_LIMITED");
      expect(events.filter((event) => event.event.type === "message_start")).toHaveLength(1);
      expect(events.filter((event) => event.event.type === "message_end")).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "message_end",
            message: expect.objectContaining({
              status: "error",
              isError: true,
            }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SubagentRun turn cap", () => {
  it("terminates the delegate once it reaches maxTurns", async () => {
    const { run } = createRun({ definition: definition({ maxTurns: 2 }) });
    const context = { toolCall: { id: "child-1" } };

    run.turns = 1;
    await expect(run.afterToolCall(context)).resolves.toBeUndefined();

    run.turns = 2;
    await expect(run.afterToolCall(context)).resolves.toEqual({
      terminate: true,
    });
    expect(run.cappedTurns).toBe(true);
  });

  it("passes a parent tool failure through to the delegate", async () => {
    const { run } = createRun({
      resolveToolOutcome: () => ({ isError: true }),
    });

    await expect(
      run.afterToolCall({ toolCall: { id: "child-1" } }),
    ).resolves.toEqual({ isError: true });
  });
});

describe("SubagentRun watchdogs", () => {
  function holdAgent(
    run: Record<string, any>,
    onPrompt: () => void,
  ): { abort: ReturnType<typeof vi.fn> } {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = vi.fn(() => release());
    run.agent = {
      prompt: vi.fn(async () => {
        onPrompt();
        await pending;
      }),
      waitForIdle: vi.fn(async () => undefined),
      abort,
    };
    return { abort };
  }

  it("times out after inactivity and keeps the partial report", async () => {
    vi.useFakeTimers();
    try {
      const { run } = createRun({
        definition: definition({
          idleTimeoutSeconds: 10,
          maxDurationSeconds: 60,
        }),
      });
      const { abort } = holdAgent(run, () => {
        run.handleEvent({ type: "turn_start" });
        run.handleEvent({
          type: "message_start",
          message: assistantMessage({
            content: [{ type: "text", text: "Partial findings" }],
          }),
        });
      });

      const resultPromise = run.run();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.status).toBe("timed_out");
      expect(result.error).toEqual({
        code: "SUBAGENT_IDLE_TIMEOUT",
        message: "The subagent produced no activity for 10 seconds.",
      });
      expect(result.report).toContain("Partial findings");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses the idle watchdog while a tool is executing", async () => {
    vi.useFakeTimers();
    try {
      const { run } = createRun({
        definition: definition({
          idleTimeoutSeconds: 10,
          maxDurationSeconds: 60,
        }),
      });
      const { abort } = holdAgent(run, () => {
        run.handleEvent({ type: "turn_start" });
        run.handleEvent({
          type: "tool_execution_start",
          toolCallId: "long-tool",
          toolName: "Bash",
          args: { command: "long-running" },
        });
      });

      const resultPromise = run.run();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(abort).not.toHaveBeenCalled();

      run.handleEvent({
        type: "tool_execution_end",
        toolCallId: "long-tool",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.status).toBe("timed_out");
      expect(result.error?.code).toBe("SUBAGENT_IDLE_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the total duration limit during tool execution", async () => {
    vi.useFakeTimers();
    try {
      const { run } = createRun({
        definition: definition({
          idleTimeoutSeconds: 10,
          maxDurationSeconds: 20,
        }),
      });
      const { abort } = holdAgent(run, () => {
        run.handleEvent({ type: "turn_start" });
        run.handleEvent({
          type: "tool_execution_start",
          toolCallId: "long-tool",
          toolName: "Bash",
          args: { command: "long-running" },
        });
      });

      const resultPromise = run.run();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.status).toBe("timed_out");
      expect(result.error?.code).toBe("SUBAGENT_DURATION_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a gateway 502 in either phase from one bounded budget", () => {
    const { run } = createRun();
    const claim = (error: unknown, phase: string) =>
      (run as any).claimProviderRetry(error, phase);
    const gateway502 = classifyAgentError(
      'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
    );

    // The stream phase used to be refused outright for a delegate.
    expect(claim(gateway502, "stream")).toBe(1);
    expect(claim(gateway502, "request")).toBe(2);
    expect(claim(gateway502, "stream")).toBe(3);
    expect(claim(gateway502, "request")).toBeUndefined();

    const { run: fresh } = createRun();
    const freshClaim = (error: unknown, phase: string) =>
      (fresh as any).claimProviderRetry(error, phase);
    // Rate limits keep their own separate five-retry budget.
    const rateLimited = classifyAgentError("429: too many requests");
    expect(freshClaim(gateway502, "request")).toBe(1);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(freshClaim(rateLimited, "stream")).toBe(attempt);
    }
    expect(freshClaim(rateLimited, "stream")).toBeUndefined();
    // Permanent failures stay terminal.
    expect(freshClaim(classifyAgentError("401: invalid api key"), "request")).toBeUndefined();
  });

  it("does not impose a turn cap when maxTurns is omitted", async () => {
    const { run } = createRun({ definition: definition({ maxTurns: undefined }) });
    run.turns = 21;

    await expect(run.afterToolCall({ toolCall: { id: "child-1" } })).resolves.toBeUndefined();
    expect(run.cappedTurns).toBe(false);
  });
});
