import { describe, expect, it } from "vitest";
import { MAX_RESUMABLE_READ_LINES, type UiMessage } from "@pi-desktop/shared";
import {
  chainRowsToMessages,
  extractReadFiles,
  formatResumableList,
  isChainWithinReadBudget,
  listedReadFiles,
  originalTaskFromTranscript,
  rebuildChainsFromTranscript,
  selectChainRows,
  seedDelegateMessages,
  taskObjectiveFromArgs,
  type DelegationChain,
  type ResumableChain,
} from "./delegation-history.js";
import { DelegationChainRegistry } from "./delegation-chain.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { buildProviderModel } from "./provider-binding.js";

function provider(): RuntimeProviderConfig {
  return {
    id: "test-provider",
    modelId: "test-model",
    apiStyle: "openai-completions",
    apiKey: "test-key",
  } as RuntimeProviderConfig;
}

function delegateAssistant(
  id: string,
  content: string,
  parentToolCallId: string,
): UiMessage {
  return {
    id,
    role: "assistant",
    content,
    status: "complete",
    createdAt: new Date(1_700_000_000_000).toISOString(),
    parentToolCallId,
    agentName: "explorer",
  };
}

function delegateTool(
  toolCallId: string,
  toolName: string,
  args: unknown,
  result: unknown,
  parentToolCallId: string,
): UiMessage {
  return {
    id: `row-${toolCallId}`,
    role: "tool",
    content: "",
    toolCallId,
    toolName,
    toolArgs: args,
    toolResult: result,
    toolStatus: "success",
    createdAt: new Date(1_700_000_001_000).toISOString(),
    parentToolCallId,
    agentName: "explorer",
  };
}

function taskRow(
  taskCallId: string,
  delegationId: string,
  task: string,
  options: { resume?: string; description?: string } = {},
): UiMessage {
  return {
    id: `row-${taskCallId}`,
    role: "tool",
    content: "",
    toolCallId: taskCallId,
    toolName: "Task",
    toolArgs: {
      agent: "explorer",
      task,
      ...(options.description ? { description: options.description } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
    },
    toolResult: { details: { delegationId, agent: "explorer" } },
    toolStatus: "success",
    createdAt: new Date(1_700_000_000_000).toISOString(),
  };
}

describe("selectChainRows", () => {
  it("keeps only the chain's own calls and agent", () => {
    const rows: UiMessage[] = [
      delegateAssistant("a1", "first", "call-1"),
      delegateAssistant("a2", "sibling", "call-other"),
      delegateAssistant("a3", "second", "call-2"),
      {
        id: "p1",
        role: "assistant",
        content: "parent",
        status: "complete",
        createdAt: new Date(1_700_000_000_000).toISOString(),
      },
    ];
    const selected = selectChainRows(rows, {
      toolCallIds: ["call-1", "call-2"],
      agentName: "explorer",
    });
    expect(selected.map((row) => row.id)).toEqual(["a1", "a3"]);
  });

  it("drops rows whose agent name differs on a shared call id", () => {
    const rows: UiMessage[] = [
      delegateAssistant("a1", "explorer", "call-1"),
      { ...delegateAssistant("a2", "reviewer", "call-1"), agentName: "reviewer" },
    ];
    expect(
      selectChainRows(rows, { toolCallIds: ["call-1"], agentName: "explorer" }),
    ).toHaveLength(1);
  });
});

describe("extractReadFiles", () => {
  it("counts read-only tools and ignores mutating ones", () => {
    const rows: UiMessage[] = [
      delegateTool(
        "t1",
        "Read",
        { path: "a.ts" },
        { content: [{ type: "text", text: "x\ny" }] },
        "call-1",
      ),
      delegateTool(
        "t2",
        "Read",
        { path: "a.ts" },
        { content: [{ type: "text", text: "x" }] },
        "call-1",
      ),
      delegateTool("t3", "Edit", { path: "b.ts" }, { ok: true }, "call-1"),
      delegateTool(
        "t4",
        "Grep",
        { pattern: "foo" },
        { content: [{ type: "text", text: "hit" }] },
        "call-1",
      ),
    ];
    const reads = extractReadFiles(rows);
    // A repeated path is listed once; Grep's pattern is its target.
    expect(reads.files).toEqual(["a.ts", "foo"]);
    // 2 lines for the first Read, 1 for the single-line result, 1 for Grep.
    expect(reads.lineCount).toBe(4);
  });

  it("reads text out of a block-shaped tool result", () => {
    const rows: UiMessage[] = [
      delegateTool(
        "t1",
        "Read",
        { file_path: "c.ts" },
        { content: [{ type: "text", text: "one\ntwo\nthree" }] },
        "call-1",
      ),
    ];
    expect(extractReadFiles(rows)).toEqual({
      files: ["c.ts"],
      lineCount: 3,
    });
  });
});

describe("originalTaskFromTranscript", () => {
  it("recovers the first Task brief", () => {
    const transcript = [
      taskRow("call-1", "d1", "  explore the parser  "),
      taskRow("call-2", "d2", "continue", { resume: "d1" }),
    ];
    expect(originalTaskFromTranscript(transcript, { toolCallIds: ["call-1"] })).toBe(
      "explore the parser",
    );
  });

  it("returns undefined when the row is gone", () => {
    expect(
      originalTaskFromTranscript([], { toolCallIds: ["missing"] }),
    ).toBeUndefined();
  });
});

describe("taskObjectiveFromArgs", () => {
  it("prefers the short description over the full brief", () => {
    expect(
      taskObjectiveFromArgs({ description: "  audit  ", task: "long brief" }),
    ).toBe("audit");
    expect(taskObjectiveFromArgs({ task: " long brief " })).toBe("long brief");
    expect(taskObjectiveFromArgs(undefined)).toBe("");
  });
});

describe("seedDelegateMessages", () => {
  it("prepends the original task once and keeps tool pairs ordered", () => {
    const rows: UiMessage[] = [
      delegateAssistant("a1", "looking", "call-1"),
      delegateTool("t1", "Read", { path: "a.ts" }, { content: "body" }, "call-1"),
      delegateAssistant("a2", "done", "call-1"),
    ];
    const messages = seedDelegateMessages({
      originalTask: "explore the parser",
      rows,
      provider: provider(),
      model: buildProviderModel(provider()),
    });
    expect(messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "explore the parser" }],
    });
    // The assistant row that made the call carries it; the tool result follows
    // it directly, so the replay stays a well-formed provider transcript.
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const assistantWithCall = messages[1];
    expect(
      assistantWithCall.role === "assistant" &&
        assistantWithCall.content.some(
          (block) => block.type === "toolCall" && block.name === "Read",
        ),
    ).toBe(true);
  });

  it("does not duplicate an original task that is already the first user row", () => {
    const rows: UiMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "explore the parser",
        status: "complete",
        createdAt: new Date(1_700_000_000_000).toISOString(),
        parentToolCallId: "call-1",
        agentName: "explorer",
      },
      delegateAssistant("a1", "looking", "call-1"),
    ];
    const messages = seedDelegateMessages({
      originalTask: "explore the parser",
      rows,
      provider: provider(),
      model: buildProviderModel(provider()),
    });
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("keeps an orphan tool row well-formed with a synthesized carrier", () => {
    const rows: UiMessage[] = [
      delegateTool("t1", "Read", { path: "a.ts" }, { content: "body" }, "call-1"),
    ];
    const messages = seedDelegateMessages({
      originalTask: "explore",
      rows,
      provider: provider(),
      model: buildProviderModel(provider()),
    });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "Read",
      isError: false,
    });
  });

  it("skips a failed assistant row but still replays its tool pair", () => {
    const rows: UiMessage[] = [
      {
        ...delegateAssistant("a1", "boom", "call-1"),
        status: "error",
        isError: true,
      },
      delegateTool("t1", "Read", { path: "a.ts" }, { content: "body" }, "call-1"),
    ];
    const messages = seedDelegateMessages({
      originalTask: "explore",
      rows,
      provider: provider(),
      model: buildProviderModel(provider()),
    });
    const assistants = messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(
      assistants[0].role === "assistant" &&
        assistants[0].content.some((block) => block.type === "text"),
    ).toBe(false);
  });
});

describe("rebuildChainsFromTranscript", () => {
  it("groups resume links into one chain with the latest objective", () => {
    const transcript: UiMessage[] = [
      taskRow("call-1", "d1", "explore the parser", { description: "explore" }),
      delegateAssistant("a1", "found a", "call-1"),
      taskRow("call-2", "d2", "now cover the lexer", { resume: "d1" }),
      delegateAssistant("a2", "covered b", "call-2"),
    ];
    const chains = rebuildChainsFromTranscript(transcript);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      delegateSessionId: "d1",
      agentName: "explorer",
      toolCallIds: ["call-1", "call-2"],
      delegationIds: ["d1", "d2"],
      latestDelegationId: "d2",
      latestObjective: "now cover the lexer",
      originalTask: "explore the parser",
    });
  });

  it("starts a new chain when a Task call carries no resume link", () => {
    const transcript: UiMessage[] = [
      taskRow("call-1", "d1", "first"),
      taskRow("call-2", "d2", "second"),
    ];
    expect(rebuildChainsFromTranscript(transcript)).toHaveLength(2);
  });

  it("ignores a resume whose parent row is gone", () => {
    const transcript: UiMessage[] = [
      taskRow("call-1", "d1", "continue", { resume: "missing" }),
    ];
    expect(rebuildChainsFromTranscript(transcript)).toEqual([]);
  });

  it("accumulates read files and lines across the chain", () => {
    const transcript: UiMessage[] = [
      taskRow("call-1", "d1", "explore"),
      delegateTool(
        "t1",
        "Read",
        { path: "a.ts" },
        { content: [{ type: "text", text: "x\ny" }] },
        "call-1",
      ),
      taskRow("call-2", "d2", "more", { resume: "d1" }),
      delegateTool(
        "t2",
        "Read",
        { path: "b.ts" },
        { content: [{ type: "text", text: "z" }] },
        "call-2",
      ),
    ];
    const [chain] = rebuildChainsFromTranscript(transcript);
    expect(chain.readFiles).toEqual(["a.ts", "b.ts"]);
    expect(chain.readLineCount).toBe(3);
  });
});

describe("read budget", () => {
  it("gates a chain on its cumulative read lines", () => {
    expect(isChainWithinReadBudget({ readLineCount: MAX_RESUMABLE_READ_LINES })).toBe(
      true,
    );
    expect(
      isChainWithinReadBudget({ readLineCount: MAX_RESUMABLE_READ_LINES + 1 }),
    ).toBe(false);
  });
});

describe("listedReadFiles", () => {
  it("caps the listing and reports the omitted count", () => {
    const files = ["a", "b", "c", "d"];
    expect(listedReadFiles(files, 2)).toEqual({
      files: ["a", "b"],
      omitted: 2,
    });
    expect(listedReadFiles(files, 9)).toEqual({ files, omitted: 0 });
  });
});

describe("formatResumableList", () => {
  const chain = (overrides: Partial<ResumableChain> = {}): ResumableChain => ({
    delegateSessionId: "s1",
    toolCallIds: ["call-1"],
    delegationIds: ["d1"],
    agentName: "explorer",
    readFiles: ["a.ts"],
    readLineCount: 10,
    latestDelegationId: "d1",
    latestObjective: "explore",
    lastActivityAt: 1,
    ...overrides,
  });

  it("renders an empty string with nothing reusable", () => {
    expect(formatResumableList([])).toBe("");
  });

  it("names the delegation and the files it read", () => {
    const text = formatResumableList([chain()]);
    expect(text).toContain("explorer / d1: explore");
    expect(text).toContain("Files read: a.ts");
  });

  it("says so when a chain read nothing", () => {
    const text = formatResumableList([chain({ readFiles: [] })]);
    expect(text).toContain("Files read: none recorded");
  });

  it("collapses a long file list", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const text = formatResumableList([chain({ readFiles: files })]);
    expect(text).toContain("(+1 more)");
  });
});

describe("chain shape", () => {
  it("carries the fields the registry relies on", () => {
    const chain: DelegationChain = {
      delegateSessionId: "s1",
      toolCallIds: [],
      delegationIds: [],
      agentName: "explorer",
      readFiles: [],
      readLineCount: 0,
      lastActivityAt: 0,
    };
    expect(chain.latestStatus).toBeUndefined();
  });
});

/** A persisted `Task` row, as the settlement projection rewrites it. */
function restartedTaskRow(
  toolCallId: string,
  details: Record<string, unknown>,
  options: {
    toolStatus?: UiMessage["toolStatus"];
    args?: Record<string, unknown>;
  } = {},
): UiMessage {
  return {
    id: `row-${toolCallId}`,
    role: "tool",
    content: "",
    toolCallId,
    toolName: "Task",
    toolArgs: { agent: "explorer", task: "explore the parser", ...options.args },
    toolResult: { details },
    toolStatus: options.toolStatus ?? "success",
    createdAt: new Date(1_700_000_000_000).toISOString(),
  };
}

/** The same gate the live runtime uses, over chains rebuilt from the transcript. */
function resolveRebuilt(
  chains: DelegationChain[],
  resume: string,
  agentName = "explorer",
) {
  const registry = new DelegationChainRegistry();
  registry.hydrate(chains);
  return registry.resolveResume({
    resume,
    agentName,
    runningDelegationIds: new Set(),
  });
}

describe("rebuildChainsFromTranscript restart status (ADR 0279)", () => {
  it("keeps a completed or failed status a settled Task row recorded", () => {
    for (const status of ["completed", "failed"]) {
      const chains = rebuildChainsFromTranscript([
        restartedTaskRow("call-1", {
          delegationId: "d1",
          agent: "explorer",
          status,
        }),
      ]);
      expect(chains).toHaveLength(1);
      expect(chains[0].latestStatus).toBe(status);
      expect(resolveRebuilt(chains, "d1").ok).toBe(true);
    }
  });

  it("keeps a stopped or aborted chain out of the resumable set", () => {
    for (const status of ["stopped", "aborted"]) {
      const chains = rebuildChainsFromTranscript([
        restartedTaskRow("call-1", {
          delegationId: "d1",
          agent: "explorer",
          status,
        }),
      ]);
      expect(chains[0].latestStatus).toBe(status);
      expect(resolveRebuilt(chains, "d1")).toEqual({
        ok: false,
        error: { kind: "not-resumable", status },
      });
    }
  });

  it("normalizes a Task row the app closed mid-run to interrupted", () => {
    const chains = rebuildChainsFromTranscript([
      restartedTaskRow("call-1", {
        delegationId: "d1",
        agent: "explorer",
        status: "running",
      }),
    ]);
    expect(chains[0].latestStatus).toBe("interrupted");
    expect(resolveRebuilt(chains, "d1")).toEqual({
      ok: false,
      error: { kind: "not-resumable", status: "interrupted" },
    });
  });

  it("normalizes an errored Task row without a status to failed", () => {
    const chains = rebuildChainsFromTranscript([
      restartedTaskRow(
        "call-1",
        { delegationId: "d1", agent: "explorer" },
        { toolStatus: "error" },
      ),
    ]);
    expect(chains[0].latestStatus).toBe("failed");
    expect(resolveRebuilt(chains, "d1").ok).toBe(true);
  });

  it("ignores a Task row that never produced a delegationId", () => {
    const rejected = restartedTaskRow(
      "call-1",
      { error: 'Unknown subagent "Researcher".' },
      { toolStatus: "error", args: { agent: "Researcher", task: "Find it." } },
    );
    expect(rebuildChainsFromTranscript([rejected])).toEqual([]);
    expect(
      rebuildChainsFromTranscript([
        rejected,
        delegateAssistant("a1", "found a", "call-1"),
      ]),
    ).toEqual([]);
  });
});

describe("rebuildChainsFromTranscript agent normalization (ADR 0279)", () => {
  it("normalizes the recorded agent so a restarted session still selects its rows", () => {
    for (const recorded of ["Explorer", "explorer.md", "EXPLORER "]) {
      const task = restartedTaskRow(
        "call-1",
        { delegationId: "d1", agent: "explorer", status: "completed" },
        { args: { agent: recorded } },
      );
      const read = delegateTool(
        "t1",
        "Read",
        { path: "src/app.ts" },
        { content: [{ type: "text", text: "body" }] },
        "call-1",
      );
      const transcript = [task, read];
      const chains = rebuildChainsFromTranscript(transcript);

      expect(chains).toHaveLength(1);
      expect(chains[0].agentName).toBe("explorer");
      // The delegate's own rows only match under the normalized name.
      expect(chains[0].readFiles).toEqual(["src/app.ts"]);
      expect(
        selectChainRows(transcript, {
          toolCallIds: ["call-1"],
          agentName: "explorer",
        }),
      ).toHaveLength(1);
      expect(resolveRebuilt(chains, "d1").ok).toBe(true);
    }
  });
});

describe("rebuildChainsFromTranscript settled copies and replay (ADR 0279)", () => {
  it("rebuilds a Task call once and lets the settled copy win", () => {
    const immediate = restartedTaskRow("call-1", {
      delegationId: "d1",
      agent: "explorer",
      status: "running",
    });
    const settled = restartedTaskRow("call-1", {
      delegationId: "d1",
      agent: "explorer",
      status: "completed",
    });
    const chains = rebuildChainsFromTranscript([
      immediate,
      delegateAssistant("a1", "found a", "call-1"),
      settled,
    ]);

    expect(chains).toHaveLength(1);
    expect(chains[0].toolCallIds).toEqual(["call-1"]);
    expect(chains[0].delegationIds).toEqual(["d1"]);
    expect(chains[0].latestStatus).toBe("completed");
    expect(resolveRebuilt(chains, "d1").ok).toBe(true);
  });

  it("resolves every delegationId on a rebuilt chain, resume links included", () => {
    const transcript: UiMessage[] = [
      restartedTaskRow("call-1", {
        delegationId: "d1",
        agent: "explorer",
        status: "completed",
      }),
      delegateAssistant("a1", "found a", "call-1"),
      restartedTaskRow(
        "call-2",
        { delegationId: "d2", agent: "explorer", status: "completed" },
        { args: { resume: "d1" } },
      ),
      delegateAssistant("a2", "covered b", "call-2"),
    ];
    const chains = rebuildChainsFromTranscript(transcript);

    expect(chains).toHaveLength(1);
    expect(chains[0].delegationIds).toEqual(["d1", "d2"]);
    const registry = new DelegationChainRegistry();
    registry.hydrate(chains);
    for (const delegationId of ["d1", "d2"]) {
      expect(registry.lookup(delegationId)?.delegateSessionId).toBe("d1");
    }
    expect(
      registry
        .resumableList({ runningDelegationIds: new Set() })
        .map((entry) => entry.latestDelegationId),
    ).toEqual(["d2"]);
  });

  it("gates a rebuilt chain on the lines its own rows read", () => {
    const text = Array.from({ length: MAX_RESUMABLE_READ_LINES + 1 }, () => "x").join(
      "\n",
    );
    const transcript: UiMessage[] = [
      restartedTaskRow("call-1", {
        delegationId: "d1",
        agent: "explorer",
        status: "completed",
      }),
      delegateTool(
        "t1",
        "Read",
        { path: "huge.ts" },
        { content: [{ type: "text", text }] },
        "call-1",
      ),
    ];
    const [chain] = rebuildChainsFromTranscript(transcript);

    expect(chain.readLineCount).toBe(MAX_RESUMABLE_READ_LINES + 1);
    expect(isChainWithinReadBudget(chain)).toBe(false);
    expect(resolveRebuilt([chain], "d1")).toEqual({
      ok: false,
      error: { kind: "over-budget" },
    });
  });

  it("replays a delegate tool row with the arguments its call recorded", () => {
    const rows: UiMessage[] = [
      delegateAssistant("a1", "reading src/app.ts", "call-1"),
      delegateTool(
        "t1",
        "Read",
        { path: "src/app.ts", offset: 3 },
        { content: [{ type: "text", text: "body" }] },
        "call-1",
      ),
    ];
    const messages = chainRowsToMessages(rows, provider(), buildProviderModel(provider()));
    const assistant = messages.find((message) => message.role === "assistant");

    expect(
      assistant?.role === "assistant" ? assistant.content : [],
    ).toContainEqual({
      type: "toolCall",
      id: "t1",
      name: "Read",
      arguments: { path: "src/app.ts", offset: 3 },
    });
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
  });
});
