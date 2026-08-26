import { describe, expect, it, vi } from "vitest";
import { buildSessionContext, estimateTokens } from "@earendil-works/pi-agent-core";
import {
  DesktopAgentRuntime,
  PATH_INSTRUCTION_RESOLUTION_TIMEOUT_MS,
  looksLikePseudoToolCall,
  type CompactionStrategy,
  type PluginToolDef,
  type RuntimeMatchConfig,
  type RuntimeProviderConfig,
} from "./runtime.js";
import type { ProjectInstructions } from "./project-instructions.js";
import { classifyAgentError } from "./agent-errors.js";
/**
 * The delegate loop itself is covered in `subagent.test.ts`; here only the
 * `Task` wiring around it is under test, so `SubagentRun` is replaced by a
 * recorder. Every other export stays real.
 */
const subagentRuns = vi.hoisted(() => ({
  calls: [] as any[],
  result: undefined as any,
  /** When true, run() waits for resolveRun() so tests control settlement. */
  deferred: false,
  instances: [] as Array<{ resolve: (r: unknown) => void; settled: boolean }>,
  /** Settles the oldest unresolved deferred run (tests control order). */
  resolveRun: undefined as ((result: unknown) => void) | undefined,
}));
vi.mock("./subagent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent.js")>();
  return {
    ...actual,
    SubagentRun: class {
      private signal?: AbortSignal;
      constructor(options: unknown) {
        subagentRuns.calls.push(options);
        // Per-instance: concurrent delegates must abort on their own signal.
        this.signal = (options as { signal?: AbortSignal }).signal;
      }
      run() {
        if (subagentRuns.deferred) {
          return new Promise((resolve) => {
            const instance = { resolve, settled: false };
            subagentRuns.instances.push(instance);
            subagentRuns.resolveRun = (result: unknown) => {
              const next = subagentRuns.instances.find((entry) => !entry.settled);
              if (next) {
                next.settled = true;
                next.resolve(result);
              }
            };
            this.signal?.addEventListener(
              "abort",
              () => {
                if (instance.settled) return;
                instance.settled = true;
                resolve({
                  agentName: "explorer",
                  status: "aborted",
                  report: "The delegated task was aborted.",
                  turns: 0,
                  toolCalls: 0,
                });
              },
              { once: true },
            );
          });
        }
        return Promise.resolve(
          subagentRuns.result ?? {
            agentName: "explorer",
            status: "completed",
            report: "done",
            turns: 1,
            toolCalls: 0,
          },
        );
      }
    },
  };
});
import { MAX_SUBAGENT_CONCURRENCY } from "@pi-desktop/shared";
import type {
  ContextCompactionRecord,
  ContextCompactionSettings,
  CommandShellOption,
  Mode,
  PlanExecution,
  SubagentDefinition,
  ThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
  modelConfig: {
    source: "pi",
    name: "Local Catalog Model",
    baseUrl: "https://catalog.invalid/v1",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: null, max: null },
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 256_000,
    maxTokens: 32_000,
  },
};

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

function createRuntime(
  overrides: Partial<{
    provider: RuntimeProviderConfig;
    mode: Mode | "chat";
    thinkingLevel: ThinkingLevel;
    history: UiMessage[];
    compaction: ContextCompactionRecord;
    compactionSettings: ContextCompactionSettings;
    compactionStrategy: CompactionStrategy;
    projectPath: string;
    scratchDir: string;
    projectInstructions: import("./project-instructions.js").ProjectInstructions;
    pluginTools: PluginToolDef[];
    subagents: SubagentDefinition[];
    subagentProviders: Record<string, RuntimeProviderConfig>;
    pluginSkills: import("./plugin-skills-prompt.js").PluginSkillDef[];
    commandShell: CommandShellOption;
    turnId: string;
    host: { call: ReturnType<typeof vi.fn>; onNotification?: ReturnType<typeof vi.fn> };
    onEvent: (envelope: unknown) => void;
  }> = {},
) {
  return new DesktopAgentRuntime({
    host: (overrides.host ?? { call: vi.fn() }) as never,
    sessionId: "session-1",
    mode: overrides.mode === "chat" ? "plan" : overrides.mode ?? "agent",
    turnId: overrides.turnId,
    provider: overrides.provider ?? provider,
    commandShell: overrides.commandShell ?? commandShell,
    thinkingLevel: overrides.thinkingLevel ?? "medium",
    history: overrides.history,
    compaction: overrides.compaction,
    compactionSettings: overrides.compactionSettings,
    compactionStrategy: overrides.compactionStrategy,
    projectPath: overrides.projectPath,
    scratchDir: overrides.scratchDir,
    pluginTools: overrides.pluginTools,
    subagents: overrides.subagents,
    subagentProviders: overrides.subagentProviders,
    projectInstructions: overrides.projectInstructions,
    pluginSkills: overrides.pluginSkills,
    onEvent: overrides.onEvent ?? vi.fn(),
  });
}

/** Minimal pi-ai assistant message; overrides carry the shape under test. */
function assistantMessage(overrides: {
  content: unknown[];
  stopReason?: string;
}) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: overrides.stopReason ?? "stop",
    timestamp: 2,
    content: overrides.content,
  };
}

function runtimeMatches(
  runtime: DesktopAgentRuntime,
  overrides: Partial<RuntimeMatchConfig> = {},
): boolean {
  return runtime.matches({
    mode: runtime.getMode(),
    provider: (runtime as any).provider,
    thinkingLevel: (runtime as any).thinkingLevel,
    pluginTools: (runtime as any).pluginTools,
    pluginSkills: (runtime as any).pluginSkills,
    projectInstructions: (runtime as any).baseProjectInstructions,
    projectPath: (runtime as any).projectPath,
    commandShell: (runtime as any).commandShell,
    subagents: (runtime as any).subagents,
    subagentProviders: (runtime as any).subagentProviders,
    ...overrides,
  });
}

describe("DesktopAgentRuntime configuration matching", () => {
  it("accepts no-auth providers and reuses only an exact pi configuration", async () => {
    const runtime = createRuntime();

    expect(runtimeMatches(runtime)).toBe(true);
    expect(runtimeMatches(runtime, { mode: "plan" })).toBe(false);
    expect(
      runtimeMatches(runtime, {
        provider: { ...provider, authKind: "api_key" },
      }),
    ).toBe(false);
    expect(
      runtimeMatches(runtime, {
        provider: { ...provider, modelId: "another-model" },
      }),
    ).toBe(false);
    expect(runtimeMatches(runtime, { thinkingLevel: "high" })).toBe(false);

    await runtime.dispose();
  });

  it("stops once at the next completed turn boundary", async () => {
    const runtime = createRuntime();
    const agent = (runtime as any).agent;
    agent.state.isStreaming = true;

    expect(runtime.requestGracefulStop()).toEqual({ requested: true });
    expect(await agent.shouldStopAfterTurn({})).toBe(true);
    expect(await agent.shouldStopAfterTurn({})).toBe(false);

    agent.state.isStreaming = false;
    expect(runtime.requestGracefulStop()).toEqual({ requested: false });
    await runtime.dispose();
  });

  it("keeps a vendor-account runtime across turns despite a fresh auth resolver", async () => {
    // The sidecar injects a new `resolveAuth` closure on every launch. If that
    // counted as a configuration change, an OAuth session would rebuild its
    // runtime — and lose its warm state — once per turn.
    const oauthProvider: RuntimeProviderConfig = {
      ...provider,
      apiKey: "",
      authKind: "oauth",
      resolveAuth: async () => ({ apiKey: "token-turn-1" }),
    };
    const runtime = createRuntime({ provider: oauthProvider });

    expect(
      runtimeMatches(runtime, {
        provider: {
          ...oauthProvider,
          resolveAuth: async () => ({ apiKey: "token-turn-2" }),
        },
      }),
    ).toBe(true);
    // Everything else about the row still has to match.
    expect(
      runtimeMatches(runtime, {
        provider: { ...oauthProvider, modelId: "another-model" },
      }),
    ).toBe(false);

    await runtime.dispose();
  });

  it("guides mutation tools away from patch repair loops", async () => {
    const runtime = createRuntime();
    const prompt = (runtime as any).agent.state.systemPrompt as string;

    expect(prompt).toContain("do not create or hand-edit unified-diff files");
    expect(prompt).toContain("Do not invoke shell apply_patch, git apply, or patch commands");
    expect(prompt).toContain("Never issue concurrent Write/Edit calls for the same path");
    expect(prompt).toContain("regenerate the change from that current content");

    const edit = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Edit",
    );
    expect(edit.description).toContain("do not repair an old patch");
    expect(edit.description).toContain("same path concurrently");

    await runtime.dispose();
  });

  it("requires visible progress updates and the user's language", async () => {
    const runtime = createRuntime();
    const prompt = (runtime as any).agent.state.systemPrompt as string;

    expect(prompt).toContain("answer in the same language the user writes in");
    expect(prompt).toContain(
      "never leave the user with no new text for more than one tool batch or 60 seconds",
    );
    // The observed failure: a 2830-character conclusion written into thinking
    // while the visible text stayed empty, twice in a row.
    expect(prompt).toContain("must be answered in your visible text");
    expect(prompt).toContain("Make the final message self-contained");
    expect(prompt).toContain("Carry the work through end to end");

    await runtime.dispose();
  });

  it("steers search through the scopeable tools instead of shell pipelines", async () => {
    const runtime = createRuntime();
    const prompt = (runtime as any).agent.state.systemPrompt as string;

    expect(prompt).toContain(
      "prefer the Read, Grep, and Glob tools over shell",
    );
    expect(prompt).toContain("`outputMode`");
    expect(prompt).toContain("always reports `totalLines`");
    expect(prompt).toContain(
      "paginates any supported text file however large",
    );
    expect(prompt).toContain(
      "Read accepts only an existing regular text file, never a directory",
    );
    expect(prompt).toContain(
      "in Agent mode, activate it with ToolSearch for the current prompt",
    );
    expect(prompt).toContain("Grep takes a file-or-directory `path`");
    expect(prompt).toContain("use `rg` only when it is available");
    expect(prompt).toContain("Workspace-relative paths are portable");
    expect(prompt).toContain(
      "an explicit path outside the workspace and session scratch roots asks for permission",
    );
    expect(prompt).toContain("Do not re-run a search whose answer you already have");
    expect(prompt).toContain("Never write a tool call as text");

    await runtime.dispose();
  });

  it("exposes bounded, scopeable search parameters to the model", async () => {
    const runtime = createRuntime({ mode: "chat" });
    const tools = (runtime as any).agent.state.tools as Array<any>;
    const byName = (name: string) => tools.find((tool) => tool.name === name);

    expect(byName("Read").parameters.properties).toEqual(
      expect.objectContaining({ offset: expect.any(Object), limit: expect.any(Object) }),
    );
    expect(byName("Glob").parameters.properties).toEqual(
      expect.objectContaining({ path: expect.any(Object), limit: expect.any(Object) }),
    );
    expect(byName("Grep").parameters.properties).toEqual(
      expect.objectContaining({
        path: expect.any(Object),
        include: expect.any(Object),
        outputMode: expect.any(Object),
        headLimit: expect.any(Object),
      }),
    );
    expect(byName("Grep").parameters.properties.outputMode.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ const: "filesWithMatches" }),
        expect.objectContaining({ const: "count" }),
      ]),
    );
    expect(byName("Read").description).toContain("never a directory");
    expect(byName("Read").parameters.properties.path.description).toContain(
      "Existing regular file only",
    );
    expect(byName("Glob").parameters.properties.path.description).toContain(
      "Directory to search",
    );
    expect(byName("Grep").description).toContain(
      "one file or a directory tree",
    );
    expect(byName("Grep").parameters.properties.path.description).toContain(
      "File or directory to search",
    );

    await runtime.dispose();
  });

  it("recognizes a tool call leaked into assistant text", () => {
    expect(
      looksLikePseudoToolCall(
        'to=multi_tool_use.parallel code:{"tool_uses":[{"recipient_name":"functions.Read"}]}',
      ),
    ).toBe(true);
    expect(looksLikePseudoToolCall('{"tool_uses": [{"recipient_name": "x"}]}')).toBe(
      true,
    );
    expect(
      looksLikePseudoToolCall("I will read the file and then run the tests."),
    ).toBe(false);
  });

  it("preserves host failure diagnostics while marking the agent tool result", async () => {
    const host = {
      call: vi.fn().mockResolvedValue({
        ok: false,
        isError: true,
        errorCode: "TOOL_FAILED",
        content: { exitCode: 7, stderr: "diagnostic" },
      }),
    };
    const runtime = createRuntime({ host });
    const bash = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Bash",
    );

    const result = await bash.execute("tool-failed", { command: "exit 7" });

    expect(result.details).toEqual({ exitCode: 7, stderr: "diagnostic" });
    expect(result.content[0].text).toContain('"exitCode": 7');
    await expect(
      (runtime as any).agent.afterToolCall({ toolCall: { id: "tool-failed" } }),
    ).resolves.toEqual({ isError: true });
    expect((runtime as any).failedHostToolCalls.size).toBe(0);

    await runtime.dispose();
  });

  it("terminates a repeated Edit mismatch after one recovery attempt", async () => {
    const host = {
      call: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({
          ok: false,
          isError: true,
          errorCode: "TOOL_FAILED",
          content: { error: "old_string not found" },
        }),
    };
    const runtime = createRuntime({ host });
    const agent = (runtime as any).agent;
    const edit = agent.state.tools.find((tool: any) => tool.name === "Edit");
    const args = {
      path: "src/example.ts",
      old_string: "stale",
      new_string: "fresh",
    };

    const first = await edit.execute("edit-1", args);
    await expect(
      agent.afterToolCall({ toolCall: { id: "edit-1" } }),
    ).resolves.toEqual({ isError: true });
    expect(first.terminate).toBeUndefined();

    const second = await edit.execute("edit-2", args);
    expect(second.terminate).toBe(true);
    await expect(
      agent.afterToolCall({ toolCall: { id: "edit-2" } }),
    ).resolves.toEqual({ isError: true, terminate: true });

    await runtime.dispose();
  });

  it("terminates repeated failed shell patch recovery", async () => {
    const host = {
      call: vi.fn().mockResolvedValue({
        ok: false,
        isError: true,
        errorCode: "TOOL_FAILED",
        content: { exitCode: 128, stderr: "corrupt patch" },
      }),
    };
    const runtime = createRuntime({ host });
    const agent = (runtime as any).agent;
    const bash = agent.state.tools.find((tool: any) => tool.name === "Bash");
    const firstArgs = { command: "apply_patch <<'PATCH'\n*** Begin Patch\nPATCH" };
    const secondArgs = {
      command: "git -C /tmp/project apply --check /tmp/change.patch",
    };

    const first = await bash.execute("patch-1", firstArgs);
    await expect(
      agent.afterToolCall({ toolCall: { id: "patch-1" } }),
    ).resolves.toEqual({ isError: true });
    expect(first.terminate).toBeUndefined();

    const second = await bash.execute("patch-2", secondArgs);
    expect(second.terminate).toBe(true);
    await expect(
      agent.afterToolCall({ toolCall: { id: "patch-2" } }),
    ).resolves.toEqual({ isError: true, terminate: true });

    await runtime.dispose();
  });

  it("spends one grace per recoverable Edit code before counting failures", async () => {
    const errorCodes = [
      "EDIT_TAG_MISMATCH",
      "EDIT_LINES_UNSEEN",
      "EDIT_TAG_MISMATCH",
      "EDIT_TAG_MISMATCH",
    ];
    let editCall = 0;
    const host = {
      call: vi.fn(async (method: string) => {
        if (method !== "tools.execute") return undefined;
        return {
          ok: false,
          isError: true,
          errorCode: errorCodes[editCall++],
          content: { error: "stale tag" },
        };
      }),
    };
    const runtime = createRuntime({ host });
    const agent = (runtime as any).agent;
    const edit = agent.state.tools.find((tool: any) => tool.name === "Edit");
    const args = { path: "src/example.ts", tag: "A1B2", ops: "PUT 1.=1:\n+fresh" };

    // Each recoverable code answers itself: the error carries the live tag or
    // the unseen content, so one honest retry per code is the designed path.
    const mismatch = await edit.execute("edit-1", args);
    expect(mismatch.terminate).toBeUndefined();
    const unseen = await edit.execute("edit-2", args);
    expect(unseen.terminate).toBeUndefined();

    // The same code twice is the model ignoring what the first error said.
    const repeat = await edit.execute("edit-3", args);
    expect(repeat.terminate).toBeUndefined();
    const exhausted = await edit.execute("edit-4", args);
    expect(exhausted.terminate).toBe(true);

    await runtime.dispose();
  });

  it("clears the mutation strike once an edit on that path lands", async () => {
    const results = [
      { ok: false, isError: true, errorCode: "EDIT_PARSE_FAILED", content: {} },
      { ok: true, isError: false, content: { tag: "C3D4" } },
      { ok: false, isError: true, errorCode: "EDIT_PARSE_FAILED", content: {} },
    ];
    let editCall = 0;
    const host = {
      call: vi.fn(async (method: string) => {
        if (method !== "tools.execute") return undefined;
        return results[editCall++];
      }),
    };
    const runtime = createRuntime({ host });
    const agent = (runtime as any).agent;
    const edit = agent.state.tools.find((tool: any) => tool.name === "Edit");
    const args = { path: "src/example.ts", tag: "A1B2", ops: "PUT 1.=1:\n+fresh" };

    const failed = await edit.execute("edit-1", args);
    expect(failed.terminate).toBeUndefined();
    const landed = await edit.execute("edit-2", args);
    expect(landed.isError).toBe(false);

    // Without the reset this failure would be strike two and end the turn.
    const afterSuccess = await edit.execute("edit-3", args);
    expect(afterSuccess.terminate).toBeUndefined();
    expect((runtime as any).mutationFailureCounts.get("src/example.ts")).toBe(1);

    await runtime.dispose();
  });

  it("reports a visible error row when the mutation guard ends the turn", async () => {
    const onEvent = vi.fn();
    const host = {
      call: vi.fn(async (method: string) => {
        if (method !== "tools.execute") return undefined;
        return {
          ok: false,
          isError: true,
          errorCode: "EDIT_PARSE_FAILED",
          content: { error: "missing body row" },
        };
      }),
    };
    const runtime = createRuntime({ host, onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    const edit = agent.state.tools.find((tool: any) => tool.name === "Edit");
    const args = { path: "src/example.ts", tag: "A1B2", ops: "PUT 1.=1:" };

    await edit.execute("edit-1", args);
    const second = await edit.execute("edit-2", args);
    expect(second.terminate).toBe(true);

    // pi-agent-core stops the loop on a terminating batch, so agent_end is the
    // last chance to say why instead of completing the turn in silence.
    await handleAgentEvent({ type: "agent_end", messages: [] });

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "error",
          isError: true,
          error: expect.objectContaining({
            code: "MUTATION_RETRY_BUDGET_EXHAUSTED",
            retriable: true,
            details: expect.objectContaining({
              kind: "edit",
              lastErrorCode: "EDIT_PARSE_FAILED",
            }),
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          code: "MUTATION_RETRY_BUDGET_EXHAUSTED",
        }),
      }),
    );
    expect((runtime as any).turnHadError).toBe(true);
    // One row per termination: a second agent_end must not repeat it.
    onEvent.mockClear();
    await handleAgentEvent({ type: "agent_end", messages: [] });
    const repeated = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(
      repeated.filter((event: any) => event.type === "error"),
    ).toHaveLength(0);

    await runtime.dispose();
  });

  it("recreates the runtime when project instructions change", async () => {
    const projectInstructions = {
      entries: [{ source: "AGENTS.md", content: "Run unit tests." }],
    };
    const runtime = createRuntime({ projectInstructions });

    expect((runtime as any).agent.state.systemPrompt).toContain(
      "# Project instructions\n\n",
    );
    expect((runtime as any).agent.state.systemPrompt).toContain(
      "Run unit tests.",
    );
    expect(runtimeMatches(runtime)).toBe(true);
    expect(
      runtimeMatches(runtime, {
        projectInstructions: {
          entries: [{ source: "AGENTS.md", content: "Run lint." }],
        },
      }),
    ).toBe(false);

    await runtime.dispose();
  });

  it("loads newly discovered nested instructions before a file tool runs", async () => {
    const host = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [
            {
              source: "packages/api/AGENTS.md",
              content: "Run API tests.",
            },
          ],
        })
        .mockResolvedValueOnce({ ok: true, content: "file contents" }),
    };
    const runtime = createRuntime({ host });
    const read = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Read",
    );

    await read.execute("tool-1", { path: "packages/api/handler.ts" });

    expect(host.call.mock.calls[0][0]).toBe("project.instructions.resolve");
    expect((runtime as any).agent.state.systemPrompt).toContain(
      "packages/api/AGENTS.md",
    );
    expect((runtime as any).agent.state.systemPrompt).toContain("Run API tests.");
    await runtime.dispose();
  });

  it.each([
    ["Read", { path: "packages/api/handler.ts" }],
    ["Write", { path: "packages/api/handler.ts", content: "export {};" }],
    ["Edit", {
      path: "packages/api/handler.ts",
      old_string: "before",
      new_string: "after",
    }],
    ["BrowserPreview", { path: "packages/api/index.html" }],
  ])("resolves path-scoped instructions before %s", async (toolName, params) => {
    const host = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [{ source: "packages/api/AGENTS.md", content: "Use API rules." }],
        })
        .mockResolvedValueOnce({ ok: true, content: "done" }),
    };
    const runtime = createRuntime({ host });
    let tool = (runtime as any).agent.state.tools.find(
      (candidate: any) => candidate.name === toolName,
    );
    if (!tool) {
      const search = (runtime as any).agent.state.tools.find(
        (candidate: any) => candidate.name === "ToolSearch",
      );
      await search.execute("search-1", { query: toolName });
      await (runtime as any).rebuiltAgentContext();
      tool = (runtime as any).agent.state.tools.find(
        (candidate: any) => candidate.name === toolName,
      );
    }

    await tool.execute(`tool-${toolName}`, params);

    expect(host.call.mock.calls[0][0]).toBe("project.instructions.resolve");
    expect((runtime as any).agent.state.systemPrompt).toContain("Use API rules.");
    await runtime.dispose();
  });

  it("replaces sibling-directory instructions for each file path", async () => {
    const host = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [
            { source: "AGENTS.md", content: "Use root rules." },
            { source: "packages/a/AGENTS.md", content: "Use A rules." },
          ],
        })
        .mockResolvedValueOnce({ ok: true, content: "A contents" })
        .mockResolvedValueOnce({
          entries: [
            { source: "AGENTS.md", content: "Use root rules." },
            { source: "packages/b/AGENTS.md", content: "Use B rules." },
          ],
        })
        .mockResolvedValueOnce({ ok: true, content: "B contents" }),
    };
    const runtime = createRuntime({ host });
    const read = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Read",
    );

    await read.execute("tool-a", { path: "packages/a/file.ts" });
    expect((runtime as any).agent.state.systemPrompt).toContain("Use A rules.");

    await read.execute("tool-b", { path: "packages/b/file.ts" });
    expect((runtime as any).agent.state.systemPrompt).toContain("Use B rules.");
    expect((runtime as any).agent.state.systemPrompt).not.toContain("Use A rules.");
    await runtime.dispose();
  });

  it("claims one instruction chain per target directory within a prompt", async () => {
    const host = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [{ source: "packages/api/AGENTS.md", content: "Use API rules." }],
        })
        .mockResolvedValue({ ok: true, content: "done" }),
    };
    const runtime = createRuntime({ host, projectPath: "/workspace/project" });
    const read = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Read",
    );

    await read.execute("tool-a", { path: "packages/api/handler.ts" });
    await read.execute("tool-b", { path: "packages/api/routes.ts" });

    expect(
      host.call.mock.calls.filter(
        (call: unknown[]) => call[0] === "project.instructions.resolve",
      ),
    ).toHaveLength(1);
    expect(host.call.mock.calls[0][1]).toEqual({
      sessionId: "session-1",
      path: "packages/api/handler.ts",
      projectPath: "/workspace/project",
    });
    expect(host.call.mock.calls[1][0]).toBe("tools.execute");
    expect(host.call.mock.calls[2][0]).toBe("tools.execute");
    await runtime.dispose();
  });

  it("claims a fallback so one resolver failure cannot stall every sibling read", async () => {
    const host = {
      call: vi
        .fn()
        .mockRejectedValueOnce(new Error("resolver unavailable"))
        .mockResolvedValue({ ok: true, content: "done" }),
    };
    const runtime = createRuntime({
      host,
      projectInstructions: {
        entries: [{ source: "AGENTS.md", content: "Use root rules." }],
      },
    });
    const read = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Read",
    );

    await read.execute("tool-a", { path: "packages/api/handler.ts" });
    await read.execute("tool-b", { path: "packages/api/routes.ts" });

    expect(
      host.call.mock.calls.filter(
        (call: unknown[]) => call[0] === "project.instructions.resolve",
      ),
    ).toHaveLength(1);
    expect((runtime as any).agent.state.systemPrompt).toContain("Use root rules.");
    await runtime.dispose();
  });

  it("keeps file tools moving when path instruction resolution times out", async () => {
    const host = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          entries: [
            { source: "AGENTS.md", content: "Use root rules." },
            { source: "packages/a/AGENTS.md", content: "Use A rules." },
          ],
        })
        .mockResolvedValueOnce({ ok: true, content: "A contents" })
        .mockRejectedValueOnce(new Error("parent host proxy timeout"))
        .mockResolvedValueOnce({ ok: true, content: "B contents" }),
    };
    const runtime = createRuntime({
      host,
      projectInstructions: {
        entries: [{ source: "AGENTS.md", content: "Use root rules." }],
      },
    });
    const read = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Read",
    );

    await read.execute("tool-a", { path: "packages/a/file.ts" });
    expect((runtime as any).agent.state.systemPrompt).toContain("Use A rules.");

    await read.execute("tool-b", { path: "packages/b/file.ts" });

    expect(host.call.mock.calls[2]).toEqual([
      "project.instructions.resolve",
      { sessionId: "session-1", path: "packages/b/file.ts" },
      PATH_INSTRUCTION_RESOLUTION_TIMEOUT_MS,
    ]);
    expect(host.call.mock.calls[3][0]).toBe("tools.execute");
    expect((runtime as any).agent.state.systemPrompt).toContain("Use root rules.");
    expect((runtime as any).agent.state.systemPrompt).not.toContain("Use A rules.");

  });

  it("uses the active shell dialect in prompts and runtime reuse", async () => {
    const powershell: CommandShellOption = {
      id: "windows-powershell",
      label: "Windows PowerShell",
      dialect: "powershell",
      available: true,
      isDefault: true,
    };
    const runtime = createRuntime({ commandShell: powershell });
    const systemPrompt = (runtime as any).agent.state.systemPrompt as string;
    const bash = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Bash",
    );

    expect(systemPrompt).toContain("Windows PowerShell");
    expect(systemPrompt).toContain("$env:PI_SCRATCH_DIR");
    expect(systemPrompt).not.toContain("Git Bash (POSIX bash on Windows)");
    expect(bash.description).toContain("Windows PowerShell");
    expect((bash.parameters as any).properties.timeout).toMatchObject({
      type: "number",
      minimum: 1,
      maximum: 300,
    });
    expect(runtimeMatches(runtime, { commandShell: powershell })).toBe(true);
    expect(runtimeMatches(runtime, { commandShell })).toBe(false);

    await runtime.dispose();
  });

  it("sends the default Bash timeout and preserves explicit overrides", async () => {
    const host = {
      call: vi.fn().mockResolvedValue({ ok: true, content: "done" }),
    };
    const runtime = createRuntime({ host });
    const bash = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Bash",
    );
    expect(bash.description).toContain("60-second timeout");
    expect((bash.parameters as any).properties.timeout.description).toContain(
      "defaults to 60 seconds",
    );

    await bash.execute("bash-default", { command: "printf default" });
    const defaultCall = host.call.mock.calls.at(-1)!;
    expect(defaultCall[0]).toBe("tools.execute");
    expect(defaultCall[1]).toMatchObject({
      toolName: "Bash",
      expectedCommandShellId: "bash",
      expectedCommandShellDialect: "posix",
      timeoutMs: 60_000,
    });

    await bash.execute("bash-timeout", { command: "printf timed", timeout: 1.25 });
    const timedCall = host.call.mock.calls.at(-1)!;
    expect(timedCall[1]).toMatchObject({
      expectedCommandShellId: "bash",
      expectedCommandShellDialect: "posix",
      timeoutMs: 1_250,
    });

    await runtime.dispose();
  });

  it("accepts Bash timeout bounds and rejects invalid values before host execution", async () => {
    const host = {
      call: vi.fn().mockResolvedValue({ ok: true, content: "done" }),
    };
    const runtime = createRuntime({ host });
    const bash = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Bash",
    );

    await bash.execute("bash-min", { command: "printf min", timeout: 1 });
    expect(host.call).toHaveBeenLastCalledWith(
      "tools.execute",
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    await bash.execute("bash-max", { command: "printf max", timeout: 300 });
    expect(host.call).toHaveBeenLastCalledWith(
      "tools.execute",
      expect.objectContaining({ timeoutMs: 300_000 }),
    );

    for (const timeout of [Number.NaN, Number.POSITIVE_INFINITY, 0.999, 300.001]) {
      await expect(
        bash.execute(`bash-invalid-${String(timeout)}`, {
          command: "printf invalid",
          timeout,
        }),
      ).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
    }
    expect(host.call).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it("routes matching Bash output through throttled progress and aborts", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(method: string, params: unknown) => void>();
      let finishExecution!: (value: unknown) => void;
      const execution = new Promise((resolve) => {
        finishExecution = resolve;
      });
      const host = {
        call: vi.fn((method: string) =>
          method === "tools.execute"
            ? execution
            : Promise.resolve({ ok: true, content: "abort requested" }),
        ),
        onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
          listeners.add(handler);
          return () => listeners.delete(handler);
        }),
      };
      const updates: unknown[] = [];
      const runtime = createRuntime({ host });
      const bash = (runtime as any).agent.state.tools.find(
        (tool: any) => tool.name === "Bash",
      );
      const controller = new AbortController();
      const pending = bash.execute(
        "bash-progress",
        { command: "printf progress" },
        controller.signal,
        (update: unknown) => updates.push(update),
      );
      await vi.advanceTimersByTimeAsync(0);

      for (const listener of listeners) {
        listener("tools.output", {
          sessionId: "other-session",
          toolCallId: "bash-progress",
          commandShellId: "bash",
          stream: "stdout",
          chunk: "ignored",
        });
        listener("tools.output", {
          sessionId: "session-1",
          toolCallId: "bash-progress",
          commandShellId: "bash",
          stream: "stdout",
          chunk: "progress ",
        });
        listener("tools.output", {
          sessionId: "session-1",
          toolCallId: "bash-progress",
          commandShellId: "bash",
          stream: "stderr",
          chunk: "warning",
        });
      }
      expect(updates).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(99);
      expect(updates).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(updates).toHaveLength(1);
      expect((updates[0] as any).content[0].text).toBe("progress warning");

      controller.abort();
      expect(host.call).toHaveBeenCalledWith("tools.abort", {
        sessionId: "session-1",
        toolCallId: "bash-progress",
      });
      expect(listeners.size).toBe(0);
      finishExecution({
        ok: false,
        isError: true,
        errorCode: "TOOL_ABORTED",
        content: { code: "TOOL_ABORTED" },
      });
      await expect(pending).resolves.toMatchObject({
        isError: true,
        details: { code: "TOOL_ABORTED" },
      });
      expect(listeners.size).toBe(0);

      await runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes streamed-output resources when the host dies or runtime is disposed", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(method: string, params: unknown) => void>();
      let closeHost!: () => void;
      let finishExecution!: (value: unknown) => void;
      const execution = new Promise((resolve) => {
        finishExecution = resolve;
      });
      const host = {
        call: vi.fn((method: string) =>
          method === "tools.execute"
            ? execution
            : Promise.resolve({ ok: true, content: "done" }),
        ),
        onNotification: vi.fn((handler: (method: string, params: unknown) => void) => {
          listeners.add(handler);
          return () => listeners.delete(handler);
        }),
        onClose: vi.fn((handler: () => void) => {
          closeHost = handler;
          return () => undefined;
        }),
      };
      const updates: unknown[] = [];
      const runtime = createRuntime({ host });
      const bash = (runtime as any).agent.state.tools.find(
        (tool: any) => tool.name === "Bash",
      );
      const pending = bash.execute(
        "bash-host-death",
        { command: "printf progress" },
        undefined,
        (update: unknown) => updates.push(update),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);
      closeHost();
      expect(listeners.size).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(updates).toHaveLength(0);
      finishExecution({ ok: true, content: "done" });
      await pending;

      await runtime.dispose();
      expect((runtime as any).activeToolProgressCleanups.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a tools.abort protocol error instead of hiding it", async () => {
    let finishExecution!: (value: { ok: boolean; content: unknown }) => void;
    const execution = new Promise<{ ok: boolean; content: unknown }>((resolve) => {
      finishExecution = resolve;
    });
    const host = {
      call: vi.fn((method: string) =>
        method === "tools.execute"
          ? execution
          : Promise.reject(new Error("tools.abort protocol failure")),
      ),
      onNotification: vi.fn(() => () => undefined),
    };
    const runtime = createRuntime({ host });
    const bash = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Bash",
    );
    const controller = new AbortController();
    const pending = bash.execute(
      "bash-abort-error",
      { command: "printf progress" },
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    finishExecution({ ok: false, content: { code: "TOOL_ABORTED" } });
      await expect(pending).rejects.toThrow("tools.abort protocol failure");
    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime deferred tool catalog", () => {
  it("keeps the first agent request on core tools plus discovery", async () => {
    const runtime = createRuntime({
      pluginTools: [
        {
          name: "plugin_demo_validate",
          description: "Validate a plugin package.",
          parameters: {},
        },
      ],
      pluginSkills: [
        {
          id: "demo/release-notes",
          name: "Release notes",
          description: "Draft release notes.",
        },
      ],
    });
    const tools = (runtime as any).agent.state.tools as Array<{ name: string }>;
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      "Read",
      "Bash",
      "Edit",
      "Write",
      "asktool",
      "EnterPlanMode",
      "EnterGoalMode",
      "new_context",
      "ToolSearch",
    ]);
    expect(names).not.toContain("BrowserPreview");
    expect(names).not.toContain("PluginCheck");
    expect(names).not.toContain("plugin_demo_validate");
    expect(names).not.toContain("Skill");

    const prompt = (runtime as any).agent.state.systemPrompt as string;
    expect(prompt).toContain("# On-demand tools");
    expect(prompt).toContain("BrowserPreview");
    expect(prompt).toContain("plugin_demo_validate");

    await runtime.dispose();
  });

  it("pauses asktool until the renderer resolves every question", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const askTool = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "asktool",
    );
    const pending = askTool.execute("ask-call-1", {
      questions: [
        { question: "Color?", options: ["Blue", "Green"] },
        { question: "Targets?", options: ["Web", "Desktop"], multiSelect: true },
      ],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = onEvent.mock.calls
      .map(([envelope]) => envelope as any)
      .map((envelope) => envelope.event)
      .find((event) => event.type === "asktool_request")?.request;
    expect(request).toMatchObject({
      sessionId: "session-1",
      toolCallId: "ask-call-1",
      questions: [
        { question: "Color?", options: ["Blue", "Green"] },
        { question: "Targets?", options: ["Web", "Desktop"], multiSelect: true },
      ],
    });
    expect(
      runtime.resolveAskTool({
        requestId: request.requestId,
        sessionId: "session-1",
        answers: [["Blue"], null],
      }),
    ).toEqual({ ok: true });
    await expect(pending).resolves.toMatchObject({
      content: [{ text: "Color?：Blue\n---\nTargets?：" }],
      details: { answers: [["Blue"], null] },
    });
    await runtime.dispose();
  });

  it("normalizes legacy chat onto the Plan core", async () => {
    const runtime = createRuntime({
      mode: "chat",
      pluginTools: [
        { name: "plugin_demo_run", description: "demo", parameters: {} },
      ],
      pluginSkills: [{ id: "demo.skill", name: "Demo skill" }],
    });
    const names = (runtime as any).agent.state.tools.map(
      (tool: any) => tool.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "Read",
        "Glob",
        "Grep",
        "BrowserPreview",
        "Bash",
        "SubmitPlan",
      ]),
    );
    expect(names).not.toContain("Write");
    expect(names).not.toContain("Edit");
    expect(names).not.toContain("Skill");
    expect(names).not.toContain("PluginCheck");
    expect(names).not.toContain("plugin_demo_run");
    expect(names).not.toContain("PluginScaffold");
    expect(names).not.toContain("PluginPack");

    await runtime.dispose();
  });

  it("activates matching tools for the next model turn", async () => {
    const runtime = createRuntime();
    const agent = (runtime as any).agent;
    const search = agent.state.tools.find(
      (tool: any) => tool.name === "ToolSearch",
    );

    const result = await search.execute("search-1", { query: "BrowserPreview" });
    expect(result.addedToolNames).toEqual(["BrowserPreview"]);
    expect(agent.state.tools.some((tool: any) => tool.name === "BrowserPreview")).toBe(
      false,
    );

    const next = await (runtime as any).prepareNextTurn({
      context: { systemPrompt: "", messages: [], tools: agent.state.tools },
      messages: [],
      newMessages: [],
      toolResults: [
        {
          role: "toolResult",
          toolCallId: "search-1",
          toolName: "ToolSearch",
          content: result.content,
          details: result.details,
          addedToolNames: result.addedToolNames,
          isError: false,
          timestamp: Date.now(),
        },
      ],
    });
    expect(next.context.tools.some((tool: any) => tool.name === "BrowserPreview")).toBe(
      true,
    );

    await runtime.dispose();
  });

  it("resets deferred capabilities at the beginning of a new prompt", async () => {
    const runtime = createRuntime();
    const agent = (runtime as any).agent;
    const search = agent.state.tools.find(
      (tool: any) => tool.name === "ToolSearch",
    );
    await search.execute("search-1", { query: "BrowserPreview" });
    await (runtime as any).prepareNextTurn({
      context: { systemPrompt: "", messages: [], tools: agent.state.tools },
      messages: [],
      newMessages: [],
      toolResults: [],
    });
    expect(agent.state.tools.some((tool: any) => tool.name === "BrowserPreview")).toBe(
      true,
    );

    (runtime as any).resetDeferredToolsForPrompt();
    expect(agent.state.tools.some((tool: any) => tool.name === "BrowserPreview")).toBe(
      false,
    );
  });
});

describe("DesktopAgentRuntime mode and tool composition", () => {
  it("switches one pi Agent between Agent and Plan tool sets", async () => {
    const runtime = createRuntime({
      pluginTools: [
        {
          name: "plugin_demo_run",
          description: "demo",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const agent = (runtime as any).agent;
    const initialAgent = agent;
    const agentTools = agent.state.tools.map((tool: any) => tool.name);
    expect(agentTools).toEqual(
      expect.arrayContaining([
        "Read",
        "Write",
        "Edit",
        "Bash",
        "EnterPlanMode",
        "ToolSearch",
      ]),
    );
    expect(agentTools).not.toContain("SubmitPlan");
    expect(agentTools).not.toContain("SubmitGoal");

    runtime.setMode("plan");
    expect((runtime as any).agent).toBe(initialAgent);
    expect(runtime.getMode()).toBe("plan");
    const planTools = agent.state.tools.map((tool: any) => tool.name);
    expect(planTools).toEqual(
      expect.arrayContaining([
        "Read",
        "Glob",
        "Grep",
        "BrowserPreview",
        "Bash",
        "SubmitPlan",
      ]),
    );
    expect(planTools).not.toEqual(
      expect.arrayContaining(["Write", "Edit", "plugin_demo_run"]),
    );
    expect(planTools).not.toContain("EnterPlanMode");
    expect(planTools).not.toContain("SubmitGoal");
    expect(agent.state.systemPrompt).toContain("SubmitPlan");
    expect(agent.state.systemPrompt).toContain("Do not use Write, Edit, plugin tools");
    expect(agent.state.systemPrompt).not.toContain("plugin_demo_run");
    expect(agent.state.systemPrompt).not.toContain("PluginCheck");

    runtime.setMode("agent");
    expect((runtime as any).agent).toBe(initialAgent);
    expect(agent.state.tools.map((tool: any) => tool.name)).toContain("EnterPlanMode");
    await runtime.dispose();
  });

  it("gives Goal mode the read-only core plus only SubmitGoal", async () => {
    const runtime = createRuntime({
      mode: "goal",
      pluginTools: [
        {
          name: "plugin_demo_run",
          description: "demo",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const agent = (runtime as any).agent;
    const goalTools = agent.state.tools.map((tool: any) => tool.name);

    expect(goalTools).toEqual(
      expect.arrayContaining([
        "Read",
        "Glob",
        "Grep",
        "BrowserPreview",
        "Bash",
        "SubmitGoal",
      ]),
    );
    expect(goalTools).not.toContain("Write");
    expect(goalTools).not.toContain("Edit");
    expect(goalTools).not.toContain("plugin_demo_run");
    expect(goalTools).not.toContain("SubmitPlan");
    expect(goalTools).not.toContain("EnterGoalMode");
    expect(runtime.getStatus().planningState).toBe("planning");
    expect(agent.state.systemPrompt).toContain("SubmitGoal");
    expect(agent.state.systemPrompt).toContain("acceptance criteria");

    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime plan transitions", () => {
  it("guards transition batches and terminates after durable plan submission", async () => {
    const host = { call: vi.fn() };
    const runtime = createRuntime({ host, turnId: "turn-1" });
    const agent = (runtime as any).agent;
    const beforeToolCall = agent.beforeToolCall as Function;

    const mixedBatch = {
      assistantMessage: {
        content: [
          { type: "toolCall", id: "enter-call", name: "EnterPlanMode", arguments: {} },
          { type: "toolCall", id: "read-call", name: "Read", arguments: { path: "a.txt" } },
        ],
      },
      toolCall: { id: "enter-call", name: "EnterPlanMode", arguments: {} },
      args: {},
      context: {},
    };
    await expect(beforeToolCall(mixedBatch)).resolves.toMatchObject({ block: true });

    host.call.mockResolvedValueOnce({ ok: true, state: "planning" });
    const enterTool = agent.state.tools.find((tool: any) => tool.name === "EnterPlanMode");
    const enterResult = await enterTool.execute("enter-call", {});
    expect(enterResult.terminate).toBeUndefined();
    expect(runtime.getMode()).toBe("plan");
    expect(agent.state.tools.map((tool: any) => tool.name)).toContain("SubmitPlan");
    expect(host.call).toHaveBeenNthCalledWith(1, "plans.enter", {
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "enter-call",
      kind: "plan",
    });

    const exactMarkdown = "  # Implement it\n\n1. Make the change.  \n";
    const proposal = {
      id: "proposal-1",
      sessionId: "session-1",
      turnId: "durable-turn-1",
      toolCallId: "submit-call-1",
      kind: "plan",
      title: "Implement it",
      markdown: exactMarkdown,
      plan: exactMarkdown,
      question: "Approve implementation?",
      artifact: {
        relativePath: ".pi/plan/proposal-1.md",
        sha256: "abc123",
        sizeBytes: 31,
      },
      version: 1,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    host.call.mockResolvedValueOnce({ status: "pending", proposal });
    const submitTool = agent.state.tools.find((tool: any) => tool.name === "SubmitPlan");
    expect(submitTool.description).toContain("immutable historical checkpoints");
    expect(submitTool.description).toContain("new full snapshot in this turn");
    const submitResult = await submitTool.execute("submit-call-1", {
      title: proposal.title,
      markdown: proposal.markdown,
      question: proposal.question,
    });
    expect(submitResult.terminate).toBe(true);
    expect(runtime.getMode()).toBe("plan");
    expect(runtime.getStatus().planningState).toBe("awaiting_approval");
    expect(agent.state.tools.map((tool: any) => tool.name)).toContain("SubmitPlan");
    expect(host.call).toHaveBeenLastCalledWith(
      "plans.submit",
      expect.objectContaining({
        sessionId: "session-1",
        toolCallId: "submit-call-1",
        kind: "plan",
        title: proposal.title,
        markdown: proposal.markdown,
        question: proposal.question,
      }),
    );
    expect(host.call).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  it("routes the Goal contract through the same host approval with kind goal", async () => {
    const host = { call: vi.fn() };
    const runtime = createRuntime({ host, turnId: "turn-1" });
    const agent = (runtime as any).agent;

    host.call.mockResolvedValueOnce({ ok: true, state: "planning" });
    const enterTool = agent.state.tools.find(
      (tool: any) => tool.name === "EnterGoalMode",
    );
    await enterTool.execute("enter-goal-call", {});
    expect(runtime.getMode()).toBe("goal");
    expect(host.call).toHaveBeenNthCalledWith(1, "plans.enter", {
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "enter-goal-call",
      kind: "goal",
    });

    const markdown = "# Goal\n\nCheckout works.\n\n## Acceptance criteria\n- tests pass\n";
    const proposal = {
      id: "proposal-goal-1",
      sessionId: "session-1",
      turnId: "durable-turn-1",
      toolCallId: "submit-goal-call",
      kind: "goal",
      title: "Checkout works",
      markdown,
      plan: markdown,
      question: "Approve this goal?",
      artifact: {
        relativePath: ".pi/goal/proposal-goal-1.md",
        sha256: "def456",
        sizeBytes: 42,
      },
      version: 1,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    host.call.mockResolvedValueOnce({ status: "pending", proposal });
    const submitTool = agent.state.tools.find(
      (tool: any) => tool.name === "SubmitGoal",
    );
    expect(submitTool.description).toContain("acceptance criteria");
    const submitResult = await submitTool.execute("submit-goal-call", {
      title: proposal.title,
      markdown: proposal.markdown,
      question: proposal.question,
    });

    expect(submitResult.terminate).toBe(true);
    expect(runtime.getMode()).toBe("goal");
    expect(runtime.getStatus().planningState).toBe("awaiting_approval");
    expect(host.call).toHaveBeenLastCalledWith(
      "plans.submit",
      expect.objectContaining({
        sessionId: "session-1",
        toolCallId: "submit-goal-call",
        kind: "goal",
        markdown: proposal.markdown,
      }),
    );

    await runtime.dispose();
  });

  it("blocks a submit tool that does not belong to the active contract mode", async () => {
    const runtime = createRuntime({ mode: "goal" });
    const beforeToolCall = (runtime as any).agent.beforeToolCall as Function;

    await expect(
      beforeToolCall({
        assistantMessage: {
          content: [
            { type: "toolCall", id: "s1", name: "SubmitPlan", arguments: {} },
          ],
        },
        toolCall: { id: "s1", name: "SubmitPlan", arguments: {} },
        args: {},
        context: {},
      }),
    ).resolves.toMatchObject({
      block: true,
      reason: "SubmitPlan is available only in Plan mode.",
    });

    await expect(
      beforeToolCall({
        assistantMessage: {
          content: [
            { type: "toolCall", id: "e1", name: "EnterGoalMode", arguments: {} },
          ],
        },
        toolCall: { id: "e1", name: "EnterGoalMode", arguments: {} },
        args: {},
        context: {},
      }),
    ).resolves.toMatchObject({ block: true });

    await runtime.dispose();
  });

  it("executes an approved plan in the same runtime without a visible user event", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const originalAgent = agent;
    agent.continue = vi.fn(async () => undefined);
    agent.waitForIdle = vi.fn(async () => undefined);
    runtime.setMode("plan");

    const execution: PlanExecution = {
      id: "execution-1",
      proposalId: "proposal-1",
      sessionId: "session-1",
      kind: "plan",
      plan: "# Approved\n\nUse the exact snapshot.",
      title: "Approved plan",
      question: "Proceed?",
      artifact: {
        relativePath: ".pi/plan/proposal-1.md",
        sha256: "abc123",
        sizeBytes: 31,
      },
      targetPermissionMode: "auto",
      state: "running",
    };

    const result = await runtime.executeApprovedPlan(execution, "execution-turn-1");

    expect(result).toEqual({ turnId: "execution-turn-1" });
    expect((runtime as any).agent).toBe(originalAgent);
    expect(runtime.getMode()).toBe("agent");
    expect(runtime.getStatus().planningState).toBe("inactive");
    expect(agent.continue).toHaveBeenCalledOnce();
    const internal = (runtime as any).fullEntries.at(-1).message;
    expect(internal.role).toBe("user");
    expect(internal.content).toContain(execution.artifact.relativePath);
    expect(internal.content).toContain(execution.plan);
    expect(
      onEvent.mock.calls.some(
        ([envelope]) => (envelope as any).event?.message?.role === "user",
      ),
    ).toBe(false);

    await runtime.dispose();
  });

  it("re-runs a silent turn during approved plan execution", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    // The shape that ended a real plan execution: a conclusion written into
    // reasoning, empty visible text, no tool call. Recovery is armed inside
    // `message_end`, so an entry point that never acts on it leaves the run
    // with no `turn_end`, no `agent_end`, and nothing for the user to retry.
    const silentMessage = assistantMessage({
      content: [{ type: "thinking", thinking: "the plan is already done" }],
    });
    const recoveredMessage = assistantMessage({
      content: [{ type: "text", text: "Implemented the approved plan." }],
    });

    let attempts = 0;
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        agent.state.messages = [
          { role: "user", content: "execute the approved plan", timestamp: 1 },
          silentMessage,
        ];
      } else {
        // The silent assistant is popped before the re-run, and the nudge is
        // on the prompt that re-run actually sends.
        expect(agent.state.messages).toHaveLength(1);
        expect(agent.state.systemPrompt).toContain("<no_output_recovery>");
      }
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({
        type: "message_end",
        message: attempts === 1 ? silentMessage : recoveredMessage,
      });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });

    const execution: PlanExecution = {
      id: "execution-silent",
      proposalId: "proposal-silent",
      sessionId: "session-1",
      kind: "plan",
      plan: "# Approved\n\nDo the work.",
      title: "Approved plan",
      question: "Proceed?",
      artifact: {
        relativePath: ".pi/plan/proposal-silent.md",
        sha256: "abc123",
        sizeBytes: 24,
      },
      targetPermissionMode: "auto",
      state: "running",
    };

    await runtime.executeApprovedPlan(execution, "execution-turn-silent");

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(agent.continue).toHaveBeenCalledTimes(2);
    // The run closes exactly once, carrying the recovered text; the empty turn
    // leaves neither a bubble nor an error row behind.
    expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("agent_end");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === "message_end" && event.message?.status === "complete",
      ),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "complete",
          content: "Implemented the approved plan.",
        }),
      }),
    );
    // One-shot: the nudge does not ride along on later turns.
    expect(agent.state.systemPrompt).not.toContain("<no_output_recovery>");

    await runtime.dispose();
  });

  it("starts each approved plan execution from clean recovery state", async () => {
    const runtime = createRuntime();
    const agent = (runtime as any).agent;
    // A run-end suppression left over from a previous turn would swallow this
    // execution's own `turn_end` and `agent_end`, ending it invisibly.
    (runtime as any).suppressSilentTurnRunEnd = true;
    (runtime as any).silentTurnRerunAttempted = true;
    (runtime as any).pendingSilentTurnRerun = true;
    agent.continue = vi.fn(async () => undefined);
    agent.waitForIdle = vi.fn(async () => undefined);

    const execution: PlanExecution = {
      id: "execution-clean",
      proposalId: "proposal-clean",
      sessionId: "session-1",
      kind: "plan",
      plan: "# Approved\n\nDo the work.",
      title: "Approved plan",
      question: "Proceed?",
      artifact: {
        relativePath: ".pi/plan/proposal-clean.md",
        sha256: "abc123",
        sizeBytes: 24,
      },
      targetPermissionMode: "auto",
      state: "running",
    };

    await runtime.executeApprovedPlan(execution, "execution-turn-clean");

    expect((runtime as any).suppressSilentTurnRunEnd).toBe(false);
    expect((runtime as any).silentTurnRerunAttempted).toBe(false);
    expect((runtime as any).pendingSilentTurnRerun).toBe(false);

    await runtime.dispose();
  });

  it("tells an approved goal execution to verify every acceptance criterion", async () => {
    const runtime = createRuntime({ mode: "goal" });
    const agent = (runtime as any).agent;
    agent.continue = vi.fn(async () => undefined);
    agent.waitForIdle = vi.fn(async () => undefined);

    const execution: PlanExecution = {
      id: "execution-goal-1",
      proposalId: "proposal-goal-1",
      sessionId: "session-1",
      kind: "goal",
      plan: "# Goal\n\nCheckout works.\n\n## Acceptance criteria\n- tests pass\n",
      title: "Checkout works",
      question: "Approve this goal?",
      artifact: {
        relativePath: ".pi/goal/proposal-goal-1.md",
        sha256: "def456",
        sizeBytes: 42,
      },
      targetPermissionMode: "auto",
      state: "running",
    };

    await runtime.executeApprovedPlan(execution, "execution-turn-2");

    expect(runtime.getMode()).toBe("agent");
    const internal = (runtime as any).fullEntries.at(-1).message;
    expect(internal.content).toContain("<approved-goal-markdown>");
    expect(internal.content).toContain(execution.artifact.relativePath);
    expect(internal.content).toContain("verify every acceptance criterion");
    expect(internal.content).not.toContain("Execute the approved implementation plan");

    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime thinking configuration", () => {
  it("clamps the requested level and exposes model reasoning capability", async () => {
    const runtime = createRuntime({ thinkingLevel: "minimal" });
    const agent = (runtime as any).agent;

    expect(agent.state.thinkingLevel).toBe("low");
    expect(agent.state.model.reasoning).toBe(true);
    expect(agent.state.model.thinkingLevelMap.minimal).toBeNull();
    expect(agent.state.model.thinkingLevelMap.xhigh).toBeNull();

    await runtime.dispose();
  });

  it("forces off for providers without reasoning support", async () => {
    const noReasoning: RuntimeProviderConfig = {
      ...provider,
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
      modelConfig: undefined,
    };
    const runtime = createRuntime({
      provider: noReasoning,
      thinkingLevel: "high",
    });
    const agent = (runtime as any).agent;

    expect(agent.state.thinkingLevel).toBe("off");
    expect(agent.state.model.reasoning).toBe(false);

    await runtime.dispose();
  });

  it("applies the complete pi model record while preserving endpoint identity", async () => {
    const mimo: RuntimeProviderConfig = {
      ...provider,
      modelId: "mimo-v2.5-pro-think",
      supportedThinkingLevels: ["off", "high"],
      modelConfig: {
        source: "pi",
        name: "MiMo-V2.5-Pro",
        baseUrl: "https://api.xiaomimimo.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        headers: { "X-Catalog-Model": "mimo-v2.5-pro" },
        compat: {
          thinkingFormat: "deepseek",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
    };
    const runtime = createRuntime({ provider: mimo, thinkingLevel: "off" });
    const model = (runtime as any).agent.state.model;

    expect(model.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(model.name).toBe("MiMo-V2.5-Pro");
    expect(model.baseUrl).toBe(provider.baseUrl);
    expect(model.contextWindow).toBe(1_048_576);
    expect(model.maxTokens).toBe(131_072);
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({
      input: 0.435,
      output: 0.87,
      cacheRead: 0.0036,
      cacheWrite: 0,
    });
    expect(model.headers).toEqual({ "X-Catalog-Model": "mimo-v2.5-pro" });
    expect((runtime as any).thinkingLevel).toBe("off");

    await runtime.dispose();
  });

  it("preserves adaptive model metadata without desktop-side rewrites", async () => {
    const adaptive: RuntimeProviderConfig = {
      ...provider,
      apiStyle: "anthropic_messages",
      modelId: "claude-opus-4-6",
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "max"],
      modelConfig: {
        source: "pi",
        name: "Claude Opus 4.6",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap: { max: "max" },
      },
    };
    const runtime = createRuntime({ provider: adaptive, thinkingLevel: "off" });
    const agent = (runtime as any).agent;

    expect(agent.state.thinkingLevel).toBe("off");
    expect(agent.state.model.compat.forceAdaptiveThinking).toBe(true);
    expect(agent.state.model.thinkingLevelMap).toEqual({ max: "max" });

    await runtime.dispose();
  });

  it("recreates the runtime when the pi model record changes", async () => {
    const mimo: RuntimeProviderConfig = {
      ...provider,
      modelConfig: {
        ...provider.modelConfig!,
        compat: { thinkingFormat: "deepseek" },
      },
    };
    const runtime = createRuntime({ provider: mimo, thinkingLevel: "medium" });

    expect(runtimeMatches(runtime)).toBe(true);
    expect(
      runtimeMatches(runtime, {
        provider: { ...mimo, modelConfig: undefined },
      }),
    ).toBe(false);

    await runtime.dispose();
  });

  it("restores assistant thinking blocks into the pi transcript", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "answer",
          thinking: "private plan",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
      ],
    });
    const agent = (runtime as any).agent;
    const assistant = agent.state.messages.find(
      (message: any) => message.role === "assistant",
    );

    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "private plan" },
      { type: "text", text: "answer" },
    ]);

    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime tool history restore (D120)", () => {
  const toolRow = (overrides: Partial<UiMessage> = {}): UiMessage => ({
    id: "tool-1",
    role: "tool",
    content: "",
    createdAt: new Date().toISOString(),
    status: "complete",
    toolName: "Grep",
    toolCallId: "call-1",
    toolStatus: "success",
    toolArgs: { pattern: "renderFormContent" },
    toolResult: {
      content: [{ type: "text", text: "index.html:2924 match" }],
      details: { count: 1 },
    },
    ...overrides,
  });

  it("restores tool call/result pairs adjacent to their assistant turn", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "user-1",
          role: "user",
          content: "optimize the form",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Let me find the render code.",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        toolRow(),
        {
          id: "assistant-2",
          role: "assistant",
          content: "Found it.",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
      ],
    });
    const messages = (runtime as any).agent.state.messages;

    expect(messages.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(messages[1].stopReason).toBe("toolUse");
    expect(messages[1].content).toEqual([
      { type: "text", text: "Let me find the render code." },
      {
        type: "toolCall",
        id: "call-1",
        name: "Grep",
        arguments: { pattern: "renderFormContent" },
      },
    ]);
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Grep",
      content: [{ type: "text", text: "index.html:2924 match" }],
      details: { count: 1 },
      isError: false,
    });
    expect(messages[3].stopReason).toBe("stop");

    await runtime.dispose();
  });

  it("keeps call-only assistant turns as carriers and drops truly empty ones", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "assistant-empty-with-tools",
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        toolRow({ id: "tool-a", toolCallId: "call-a" }),
        toolRow({ id: "tool-b", toolCallId: "call-b" }),
        {
          id: "assistant-empty",
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
      ],
    });
    const messages = (runtime as any).agent.state.messages;

    expect(messages.map((m: any) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    expect(messages[0].content.map((b: any) => b.id)).toEqual([
      "call-a",
      "call-b",
    ]);

    await runtime.dispose();
  });

  it("synthesizes a carrier for tool rows whose assistant row was lost", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "user-1",
          role: "user",
          content: "hello",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        toolRow(),
      ],
    });
    const messages = (runtime as any).agent.state.messages;

    expect(messages.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(messages[1].content).toEqual([
      {
        type: "toolCall",
        id: "call-1",
        name: "Grep",
        arguments: { pattern: "renderFormContent" },
      },
    ]);
    expect(messages[1].stopReason).toBe("toolUse");

    await runtime.dispose();
  });

  it("restores interrupted tool rows as errored results", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Running it now.",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        toolRow({
          toolStatus: "running",
          toolResult: undefined,
        }),
      ],
    });
    const messages = (runtime as any).agent.state.messages;

    expect(messages[1]).toMatchObject({
      role: "toolResult",
      isError: true,
      content: [
        {
          type: "text",
          text: "[tool call was interrupted before a result was recorded]",
        },
      ],
    });

    await runtime.dispose();
  });

  it("restores deferred tool activation markers from persisted results", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Loading the preview tool.",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        toolRow({
          toolName: "ToolSearch",
          toolResult: {
            content: [{ type: "text", text: "Activated BrowserPreview." }],
            details: { activated: ["BrowserPreview"] },
            addedToolNames: ["BrowserPreview"],
          },
        }),
      ],
    });
    const messages = (runtime as any).agent.state.messages;

    expect(messages[1]).toMatchObject({
      role: "toolResult",
      addedToolNames: ["BrowserPreview"],
    });

    await runtime.dispose();
  });

  it("skips tool rows without a call id and keeps plain restores unchanged", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "answer",
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        toolRow({ toolCallId: undefined }),
      ],
    });
    const messages = (runtime as any).agent.state.messages;

    expect(messages.map((m: any) => m.role)).toEqual(["assistant"]);
    expect(messages[0].content).toEqual([{ type: "text", text: "answer" }]);
    expect(messages[0].stopReason).toBe("stop");

    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime assistant thinking events", () => {
  it("normalizes thinking blocks and emits independent thinking deltas", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);

    await handleAgentEvent({
      type: "message_start",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "plan " }],
      },
    });
    await handleAgentEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan done" },
          { type: "text", text: "answer" },
        ],
      },
    });
    await handleAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan done" },
          { type: "text", text: "answer" },
        ],
      },
    });

    const events = onEvent.mock.calls.map(([envelope]) => envelope as any);
    expect(events[0].event.message.thinking).toBe("plan ");
    expect(events[1].event.deltaText).toBe("answer");
    expect(events[1].event.deltaThinking).toBe("done");
    expect(events[1].event.message).toMatchObject({
      content: "answer",
      thinking: "plan done",
    });
    expect(events[2].event.message).toMatchObject({
      content: "answer",
      thinking: "plan done",
      status: "complete",
    });

    await runtime.dispose();
  });

  it("recognizes the Bedrock prompt-too-long response and defers the terminal error", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);

    await handleAgentEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    await handleAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage:
          "400: prompt is too long: 1077172 tokens > 1000000 maximum (Service: BedrockRuntime)",
      },
    });
    await handleAgentEvent({ type: "turn_end" });
    await handleAgentEvent({ type: "agent_end", messages: [] });

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "error",
          error: expect.objectContaining({ code: "CONTEXT_TOO_LARGE" }),
        }),
      }),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "agent_end")).toBe(false);
    expect((runtime as any).pendingOverflow).toBe(true);

    await runtime.dispose();
  });

  it("does not recover provider overflow when automatic compaction is disabled", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({
      onEvent,
      compactionSettings: {
        enabled: false,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    });
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);

    await handleAgentEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    await handleAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage:
          "400: prompt is too long: 1077172 tokens > 1000000 maximum",
      },
    });

    expect((runtime as any).pendingOverflow).toBe(false);
    expect(onEvent.mock.calls.map(([envelope]) => (envelope as any).event)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "CONTEXT_TOO_LARGE" }),
      }),
    );
    await runtime.dispose();
  });

  it("removes the failed overflow assistant before compacting and retries once", async () => {
    const runtime = createRuntime();
    const agent = (runtime as any).agent;
    const user = { role: "user", content: "hello", timestamp: 1 };
    const failed = {
      role: "assistant",
      content: [],
      stopReason: "error",
      timestamp: 2,
    };
    agent.prompt = vi.fn(async () => {
      agent.state.messages = [user, failed];
      (runtime as any).pendingOverflow = true;
      (runtime as any).suppressOverflowRunEnd = true;
    });
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => undefined);
    (runtime as any).automaticCompactionNeeded = vi.fn(() => false);
    (runtime as any).runCompaction = vi.fn(async () => {
      expect(agent.state.messages).toEqual([user]);
      return true;
    });

    await runtime.prompt("hello", "user-1");

    expect((runtime as any).runCompaction).toHaveBeenCalledOnce();
    expect((runtime as any).runCompaction).toHaveBeenCalledWith("overflow", true);
    expect(agent.continue).toHaveBeenCalledOnce();
    expect((runtime as any).overflowRecoveryAttempted).toBe(true);
    await runtime.dispose();
  });

  it("turns a provider model failure into an error message and event", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);

    await handleAgentEvent({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
      },
    });
    await handleAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: '404: {"error":{"message":"model not found"}}',
      },
    });

    const events = onEvent.mock.calls.map(([envelope]) => envelope as any);
    expect(events.at(-2)?.event).toMatchObject({
      type: "message_end",
      message: {
        status: "error",
        isError: true,
        error: {
          code: "MODEL_NOT_CONFIGURED",
          message: '404: {"error":{"message":"model not found"}}',
          retriable: false,
          details: {
            phase: "stream",
            providerStatus: 404,
          },
        },
      },
    });
    expect(events.at(-1)?.event).toMatchObject({
      type: "error",
      error: {
        code: "MODEL_NOT_CONFIGURED",
        retriable: false,
      },
    });

    await runtime.dispose();
  });

  it("retries one transient stream failure without duplicating the assistant bubble", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    const failedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial response" }],
      api: "openai-completions",
      provider: "local",
      model: "local-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "terminated",
      timestamp: 2,
    };
    const successfulMessage = {
      role: "assistant",
      content: [{ type: "text", text: "recovered response" }],
      api: "openai-completions",
      provider: "local",
      model: "local-model",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    };

    agent.prompt = vi.fn(async () => {
      agent.state.messages = [
        { role: "user", content: "hello", timestamp: 1 },
        failedMessage,
      ];
      await handleAgentEvent({ type: "message_start", message: failedMessage });
      await handleAgentEvent({ type: "message_end", message: failedMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => {
      expect(agent.state.messages).toHaveLength(1);
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({ type: "message_end", message: successfulMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });

    await runtime.prompt("hello", "user-1");

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(agent.continue).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "message_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "complete",
          content: "recovered response",
        }),
      }),
    );

    await runtime.dispose();
  });

  it("shares one bounded transient budget across setup and stream phases", async () => {
    const runtime = createRuntime({ onEvent: vi.fn() });
    const claim = (runtime as any).claimProviderRetry.bind(runtime);
    const gateway502 = classifyAgentError(
      'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
    );
    expect(gateway502).toMatchObject({ code: "PROVIDER_ERROR", retriable: true });

    // A gateway fault that moves between phases draws from one counter.
    expect(claim(gateway502, "request")).toBe(1);
    expect(claim(gateway502, "stream")).toBe(2);
    expect(claim(gateway502, "request")).toBe(3);
    expect(claim(gateway502, "stream")).toBeUndefined();

    (runtime as any).resetRunRecoveryState();
    // A mid-stream 502 is now retried; it used to be excluded outright.
    expect(claim(gateway502, "stream")).toBe(1);

    (runtime as any).resetRunRecoveryState();
    // The 429 budget stays separate and is not drained by transient failures.
    const rateLimited = classifyAgentError("429: too many requests");
    expect(claim(gateway502, "request")).toBe(1);
    expect(claim(rateLimited, "request")).toBe(1);
    expect(claim(rateLimited, "stream")).toBe(2);

    (runtime as any).resetRunRecoveryState();
    // Permanent failures never claim a retry, whatever the phase.
    for (const message of [
      "401: invalid api key",
      "404: unknown model",
      "413: context length exceeded",
      "400: invalid request body",
    ]) {
      expect(claim(classifyAgentError(message), "request")).toBeUndefined();
      expect(claim(classifyAgentError(message), "stream")).toBeUndefined();
    }

    await runtime.dispose();
  });

  it("retries a mid-stream rate-limit (429) failure in the same turn", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    const rateLimitedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial response" }],
      api: "openai-completions",
      provider: "local",
      model: "local-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "upstream unavailable",
      timestamp: 2,
    };
    (runtime as any).providerResponseStatus = 429;
    const successfulMessage = {
      role: "assistant",
      content: [{ type: "text", text: "recovered response" }],
      api: "openai-completions",
      provider: "local",
      model: "local-model",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    };

    agent.prompt = vi.fn(async () => {
      agent.state.messages = [
        { role: "user", content: "hello", timestamp: 1 },
        rateLimitedMessage,
      ];
      await handleAgentEvent({ type: "message_start", message: rateLimitedMessage });
      await handleAgentEvent({ type: "message_end", message: rateLimitedMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => {
      expect(agent.state.messages).toHaveLength(1);
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({ type: "message_end", message: successfulMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });

    vi.useFakeTimers();
    try {
      const prompt = runtime.prompt("hello", "user-1");
      await vi.runAllTimersAsync();
      await prompt;
    } finally {
      vi.useRealTimers();
    }

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(agent.continue).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "message_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "complete",
          content: "recovered response",
        }),
      }),
    );

    await runtime.dispose();
  });

  it("surfaces repeated 429s only after exhausting the five-retry budget", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    const rateLimitedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial response" }],
      api: "openai-completions",
      provider: "local",
      model: "local-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: '429: {"error":{"type":"rate_limit_error"}}',
      timestamp: 2,
    };

    agent.prompt = vi.fn(async () => {
      agent.state.messages = [
        { role: "user", content: "hello", timestamp: 1 },
        rateLimitedMessage,
      ];
      await handleAgentEvent({ type: "message_start", message: rateLimitedMessage });
      await handleAgentEvent({ type: "message_end", message: rateLimitedMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => {
      agent.state.messages = [...agent.state.messages, rateLimitedMessage];
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({ type: "message_end", message: rateLimitedMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });

    vi.useFakeTimers();
    try {
      const prompt = runtime.prompt("hello", "user-1");
      await vi.runAllTimersAsync();
      await prompt;
    } finally {
      vi.useRealTimers();
    }

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(agent.continue).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "error",
          isError: true,
          error: expect.objectContaining({
            code: "PROVIDER_RATE_LIMITED",
            retriable: true,
            details: expect.objectContaining({
              phase: "stream",
              retryAttempt: 5,
            }),
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          code: "PROVIDER_RATE_LIMITED",
          retriable: true,
        }),
      }),
    );

    await runtime.dispose();
  });

  it("recovers a silent turn with one automatic re-run", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    // The observed shape: a full conclusion in reasoning, empty visible text,
    // no tool call — the turn ends and the user sees nothing.
    const silentMessage = assistantMessage({
      content: [{ type: "thinking", thinking: "the answer is provider B" }],
    });
    const recoveredMessage = assistantMessage({
      content: [{ type: "text", text: "provider B, because …" }],
    });

    let promptDuringRerun: string | undefined;
    agent.prompt = vi.fn(async () => {
      agent.state.messages = [
        { role: "user", content: "which provider?", timestamp: 1 },
        silentMessage,
      ];
      await handleAgentEvent({ type: "message_start", message: silentMessage });
      await handleAgentEvent({ type: "message_end", message: silentMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => {
      promptDuringRerun = agent.state.systemPrompt;
      // The silent assistant must be gone: agentLoopContinue rejects a
      // transcript that ends with one.
      expect(agent.state.messages).toHaveLength(1);
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({
        type: "message_end",
        message: recoveredMessage,
      });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });

    await runtime.prompt("which provider?", "user-1");

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(agent.continue).toHaveBeenCalledOnce();
    expect(promptDuringRerun).toContain("<no_output_recovery>");
    // One-shot: the nudge does not ride along on later prompts.
    expect(agent.state.systemPrompt).not.toContain("<no_output_recovery>");
    expect(events.some((event) => event.type === "error")).toBe(false);
    // One bubble, and the user never sees the empty turn it replaced.
    expect(events.filter((event) => event.type === "message_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "message_end" && event.message?.status === "complete",
      ),
    ).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("agent_end");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "complete",
          content: "provider B, because …",
        }),
      }),
    );

    await runtime.dispose();
  });

  it("reports an empty response when the re-run stays silent", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    const silentMessage = assistantMessage({ content: [] });

    agent.prompt = vi.fn(async () => {
      agent.state.messages = [
        { role: "user", content: "continue", timestamp: 1 },
        silentMessage,
      ];
      await handleAgentEvent({ type: "message_start", message: silentMessage });
      await handleAgentEvent({ type: "message_end", message: silentMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => {
      await handleAgentEvent({ type: "agent_start" });
      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      await handleAgentEvent({ type: "message_end", message: silentMessage });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });

    await runtime.prompt("continue", "user-1");

    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    // Exactly one re-run, then the failure becomes visible instead of looping.
    expect(agent.continue).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          status: "error",
          isError: true,
          error: expect.objectContaining({
            code: "EMPTY_MODEL_RESPONSE",
            retriable: true,
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "EMPTY_MODEL_RESPONSE" }),
      }),
    );
    // An assistant message with nothing in it is not worth resending.
    expect((runtime as any).fullEntries).toHaveLength(0);

    await runtime.dispose();
  });

  it("treats a tool-calling turn with no text as normal work", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    const toolTurn = assistantMessage({
      content: [
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ],
      stopReason: "toolUse",
    });

    agent.prompt = vi.fn(async () => {
      agent.state.messages = [
        { role: "user", content: "read it", timestamp: 1 },
        toolTurn,
      ];
      await handleAgentEvent({ type: "message_start", message: toolTurn });
      await handleAgentEvent({ type: "message_end", message: toolTurn });
      await handleAgentEvent({ type: "turn_end" });
      await handleAgentEvent({ type: "agent_end", messages: [] });
    });
    agent.waitForIdle = vi.fn(async () => undefined);
    agent.continue = vi.fn(async () => undefined);

    await runtime.prompt("read it", "user-1");

    expect(agent.continue).not.toHaveBeenCalled();
    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({ status: "complete" }),
      }),
    );

    await runtime.dispose();
  });

  it("does not restore failed assistant details into model context", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "failed-1",
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          status: "error",
          isError: true,
          error: {
            code: "PROVIDER_ERROR",
            message: "upstream detail",
            retriable: true,
          },
        },
      ],
    });

    expect((runtime as any).agent.state.messages).toEqual([]);
    await runtime.dispose();
  });

  it("creates an assistant error message when a prompt rejects before streaming", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const error = {
      code: "NETWORK_ERROR",
      message: "fetch failed",
      retriable: true,
    };

    (runtime as any).finalizeCurrentAssistant("error", error);

    const events = onEvent.mock.calls.map(([envelope]) => envelope as any);
    expect(events.at(-2)?.event).toMatchObject({
      type: "message_start",
      message: { role: "assistant", status: "error", error },
    });
    expect(events.at(-1)?.event).toMatchObject({
      type: "message_end",
      message: { role: "assistant", status: "error", error },
    });
    await runtime.dispose();
  });

  it("keeps timing and an output estimate when a streamed answer is aborted", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    (runtime as any).streamStartedAt = Date.now() - 2_000;
    (runtime as any).currentAssistant = {
      id: "assistant-aborted",
      role: "assistant",
      content: "A partial answer that remains visible",
      thinking: "Brief reasoning",
      createdAt: new Date().toISOString(),
      status: "streaming",
    };

    (runtime as any).finalizeCurrentAssistant("aborted");

    const terminal = onEvent.mock.calls.at(-1)?.[0] as any;
    expect(terminal.event).toMatchObject({
      type: "message_end",
      message: {
        status: "aborted",
        responseDurationMs: expect.any(Number),
        responseOutputTokens: expect.any(Number),
      },
    });
    expect(terminal.event.message.responseDurationMs).toBeGreaterThanOrEqual(2_000);
    expect(terminal.event.message.responseOutputTokens).toBeGreaterThan(0);
    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime compaction restore", () => {
  it("restores summary plus retained tail while keeping the full transcript", async () => {
    const retained = { role: "user" as const, content: "recent", timestamp: 2 };
    const runtime = createRuntime({
      history: [
        {
          id: "user-1",
          role: "user",
          content: "old",
          createdAt: "2026-07-28T00:00:00Z",
          status: "complete",
        },
        {
          id: "user-2",
          role: "user",
          content: "recent",
          createdAt: "2026-07-28T00:00:01Z",
          status: "complete",
        },
      ],
      compaction: {
        id: "compact-1",
        summary: "Older work was summarized.",
        firstKeptMessageId: "user-2",
        throughMessageId: "user-2",
        tokensBefore: 200_000,
        retainedTail: [retained],
        createdAt: "2026-07-28T00:00:02Z",
      },
    });

    const agentMessages = (runtime as any).agent.state.messages;
    expect(agentMessages.map((message: any) => message.role)).toEqual([
      "compactionSummary",
      "user",
    ]);
    expect(agentMessages[0].summary).toBe("Older work was summarized.");
    expect((runtime as any).fullEntries).toHaveLength(2);
    await runtime.dispose();
  });

  it("does not reuse pre-compaction provider usage for the retained tail budget", async () => {
    const runtime = createRuntime({
      history: [
        {
          id: "user-1",
          role: "user",
          content: "old",
          createdAt: "2026-07-28T00:00:00Z",
          status: "complete",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "recent answer",
          createdAt: "2026-07-28T00:00:01Z",
          status: "complete",
        },
      ],
      compaction: {
        id: "compact-1",
        summary: "Older work was summarized.",
        firstKeptMessageId: "assistant-1",
        throughMessageId: "assistant-1",
        tokensBefore: 250_000,
        retainedTail: [
          {
            role: "assistant",
            content: [{ type: "text", text: "recent answer" }],
            api: "openai-completions",
            provider: "local",
            model: "local-model",
            stopReason: "stop",
            timestamp: 2,
            usage: {
              input: 249_000,
              output: 1_000,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 250_000,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        ],
        createdAt: "2026-07-28T00:00:02Z",
      },
    });

    const budget = (runtime as any).contextBudget(
      (runtime as any).agent.state.messages,
    );
    expect(budget.tokens).toBeLessThan(1_000);
    expect(budget.tokens).not.toBe(250_000);
    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime per-turn context protection", () => {
  const toolResult = {
    role: "toolResult" as const,
    toolCallId: "tool-call-1",
    toolName: "Read",
    content: [{ type: "text" as const, text: "large result" }],
    isError: false,
    timestamp: 2,
  };
  const assistant = {
    role: "assistant" as const,
    content: [],
    api: "openai-completions" as const,
    provider: "local",
    model: "local-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse" as const,
    timestamp: 1,
  };
  const nextTurn = {
    message: assistant,
    toolResults: [toolResult],
    context: { systemPrompt: "base", messages: [], tools: [] },
    newMessages: [assistant, toolResult],
  };

  it("derives the hard limit from provider-request headroom", async () => {
    const runtime = createRuntime();

    expect((runtime as any).contextBudget([])).toMatchObject({
      tokens: 0,
      hardLimit: 224_000,
      requestHeadroom: 32_000,
      keepRecentTokens: 44_800,
    });

    await runtime.dispose();
  });

  it("clamps the retained tail for a small model context window", async () => {
    const runtime = createRuntime({
      provider: {
        ...provider,
        modelConfig: {
          ...provider.modelConfig!,
          contextWindow: 32_000,
          maxTokens: 8_000,
        },
      },
    });

    expect((runtime as any).contextBudget([])).toMatchObject({
      hardLimit: 16_000,
      requestHeadroom: 16_000,
      keepRecentTokens: 8_000,
    });

    await runtime.dispose();
  });

  it("compacts a long tool loop at the hard boundary, reminding once on the way", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const prepareNextTurn = (runtime as any).prepareNextTurn.bind(runtime);
    const handleAgentEvent = (runtime as any).handleAgentEvent.bind(runtime);
    vi.spyOn(runtime as any, "contextBudget")
      .mockReturnValueOnce({
        tokens: 205_000,
        hardLimit: 224_000,
        requestHeadroom: 32_000,
      })
      .mockReturnValueOnce({
        tokens: 210_000,
        hardLimit: 224_000,
        requestHeadroom: 32_000,
      })
      .mockReturnValue({
        tokens: 100_000,
        hardLimit: 224_000,
        requestHeadroom: 32_000,
      });
    const runCompaction = vi
      .spyOn(runtime as any, "runCompaction")
      .mockResolvedValue(true);

    await handleAgentEvent({ type: "turn_end", message: assistant, toolResults: [toolResult] });
    const below = await prepareNextTurn(nextTurn);
    await handleAgentEvent({ type: "turn_end", message: assistant, toolResults: [toolResult] });
    const stillBelow = await prepareNextTurn(nextTurn);
    await handleAgentEvent({ type: "turn_end", message: assistant, toolResults: [toolResult] });

    // 19k left of a 224k limit is inside the first reminder tier, so the model
    // is told once. The claim then holds for the rest of this window.
    expect(below.context.systemPrompt).toContain("<context_budget>");
    expect(below.context.systemPrompt).toContain("new_context");
    expect(stillBelow.context.systemPrompt).not.toContain("<context_budget>");
    // The reminder rides on the turn's context only; nothing is persisted.
    expect((runtime as any).agent.state.systemPrompt).not.toContain(
      "<context_budget>",
    );
    expect(runCompaction).not.toHaveBeenCalled();

    vi.spyOn(runtime as any, "contextBudget")
      .mockReturnValueOnce({
        tokens: 225_000,
        hardLimit: 224_000,
        requestHeadroom: 32_000,
      })
      .mockReturnValue({
        tokens: 40_000,
        hardLimit: 224_000,
        requestHeadroom: 32_000,
      });
    const hard = await prepareNextTurn(nextTurn);

    expect(hard.context.systemPrompt).not.toContain("<context_budget>");
    expect(runCompaction).toHaveBeenCalledOnce();
    expect(runCompaction).toHaveBeenCalledWith("threshold", false);
    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(events.filter((event) => event.type === "turn_end")).toHaveLength(3);
    expect(events.some((event) => event.type === "agent_end")).toBe(false);

    await runtime.dispose();
  });

  it("lets the model ask for a new window, and compacts at the next boundary", async () => {
    const runtime = createRuntime();
    const tool = (runtime as any).agent.state.tools.find(
      (candidate: any) => candidate.name === "new_context",
    );

    // Codex's tool takes no arguments: the model cannot steer the checkpoint,
    // it can only ask for one.
    expect(tool).toBeDefined();
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([]);
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text).toContain("A new context window will start");
    expect((runtime as any).pendingModelCompaction).toBe(true);

    // Well under the hard limit, so only the model's request drives this.
    vi.spyOn(runtime as any, "contextBudget").mockReturnValue({
      tokens: 10_000,
      hardLimit: 224_000,
      requestHeadroom: 32_000,
      keepRecentTokens: 44_800,
    });
    const runCompaction = vi
      .spyOn(runtime as any, "runCompaction")
      .mockResolvedValue(true);

    await (runtime as any).prepareNextTurn(nextTurn);
    expect(runCompaction).toHaveBeenCalledWith("threshold", false);
    expect((runtime as any).pendingModelCompaction).toBe(false);

    // The request is consumed, so the next boundary compacts nothing.
    await (runtime as any).prepareNextTurn(nextTurn);
    expect(runCompaction).toHaveBeenCalledOnce();

    await runtime.dispose();
  });

  it("does not fail the turn when a model-requested compaction fails", async () => {
    const runtime = createRuntime();
    (runtime as any).pendingModelCompaction = true;
    vi.spyOn(runtime as any, "contextBudget").mockReturnValue({
      tokens: 10_000,
      hardLimit: 224_000,
      requestHeadroom: 32_000,
      keepRecentTokens: 44_800,
    });
    vi.spyOn(runtime as any, "runCompaction").mockResolvedValue(false);

    // Nothing is over the boundary, so a failed courtesy compaction is not a
    // reason to refuse the request the way the hard-limit guard is.
    await expect(
      (runtime as any).prepareNextTurn(nextTurn),
    ).resolves.toBeDefined();
    await runtime.dispose();
  });

  it("warns once more right before the boundary, then not again", async () => {
    const runtime = createRuntime();
    vi.spyOn(runtime as any, "contextBudget").mockReturnValue({
      tokens: 223_000,
      hardLimit: 224_000,
      requestHeadroom: 32_000,
      keepRecentTokens: 44_800,
    });

    const first = await (runtime as any).prepareNextTurn(nextTurn);
    const second = await (runtime as any).prepareNextTurn(nextTurn);

    expect(first.context.systemPrompt).toContain(
      "the next request compacts this conversation",
    );
    expect(second.context.systemPrompt).not.toContain("<context_budget>");
    // Installing a checkpoint opens a new window, so both tiers come back.
    (runtime as any).contextReminderClaimed = false;
    (runtime as any).contextFallbackReminderClaimed = false;
    const afterCheckpoint = await (runtime as any).prepareNextTurn(nextTurn);
    expect(afterCheckpoint.context.systemPrompt).toContain("<context_budget>");

    await runtime.dispose();
  });

  it("keeps only user messages in the model context past a boundary", async () => {
    const runtime = createRuntime();
    const toolAssistant = {
      ...assistant,
      content: [
        {
          type: "toolCall" as const,
          id: "large-tool-call",
          name: "Read",
          arguments: { path: "large.log" },
        },
      ],
      stopReason: "toolUse" as const,
    };
    const largeToolResult = {
      ...toolResult,
      toolCallId: "large-tool-call",
      content: [{ type: "text" as const, text: "x".repeat(200_000) }],
    };
    (runtime as any).fullEntries = [
      {
        type: "message",
        id: "old-user",
        seq: 0,
        parentId: null,
        timestamp: Date.parse("2026-07-28T00:00:00Z"),
        message: { role: "user", content: "old context", timestamp: 1 },
      },
      {
        type: "message",
        id: "current-user",
        seq: 1,
        parentId: "old-user",
        timestamp: Date.parse("2026-07-28T00:00:01Z"),
        message: { role: "user", content: "inspect the log", timestamp: 2 },
      },
      {
        type: "message",
        id: "tool-assistant",
        seq: 2,
        parentId: "current-user",
        timestamp: Date.parse("2026-07-28T00:00:02Z"),
        message: toolAssistant,
      },
      {
        type: "message",
        id: "large-tool-call",
        seq: 3,
        parentId: "tool-assistant",
        timestamp: Date.parse("2026-07-28T00:00:03Z"),
        message: largeToolResult,
      },
    ];

    const entries = (runtime as any).entriesWithCompaction();
    const budget = (runtime as any).contextBudget(
      entries.map((entry: any) => entry.message),
    );
    const preparation = (runtime as any).prepareCompactionInput(entries, budget);

    expect(preparation.ok).toBe(true);
    // Everything is summarized as one range, so nothing leaves the context
    // without the summary covering it.
    expect(preparation.value.isSplitTurn).toBe(false);
    expect(preparation.value.turnPrefixMessages).toEqual([]);
    expect(
      preparation.value.messagesToSummarize.map((message: any) => message.role),
    ).toEqual(["user", "user", "assistant", "toolResult"]);
    // The anchor becomes the next boundary.
    expect(preparation.value.firstKeptEntryId).toBe("large-tool-call");
    expect(
      preparation.value.retainedTail.map((message: any) => message.content),
    ).toEqual(["old context", "inspect the log"]);

    const checkpoint = (runtime as any).createCheckpoint(
      preparation.value,
      "large-tool-call",
      "Older work was summarized.",
    );
    const compacted = buildSessionContext(
      (runtime as any).entriesWithCompaction(checkpoint),
    ).messages;
    expect(compacted.map((message: any) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    // No assistant message means no toolCall block, so no orphaned tool call can
    // reach a provider.
    expect(
      compacted.flatMap((message: any) =>
        Array.isArray(message.content)
          ? message.content.filter((block: any) => block.type === "toolCall")
          : [],
      ),
    ).toEqual([]);
    await runtime.dispose();
  });

  it("truncates the oldest retained user message instead of dropping it", async () => {
    const runtime = createRuntime();
    // Four 8k-token user messages against the 20k retention cap: the two newest
    // fit whole, the third crosses the budget, the oldest is out of reach.
    const asks = ["oldest", "third", "second", "newest"].map(
      (label, index) => ({
        type: "message",
        id: `ask-${index}`,
        parentId: index === 0 ? null : `ask-${index - 1}`,
        timestamp: `2026-07-30T00:00:0${index}Z`,
        message: {
          role: "user",
          content: `${label}:${"x".repeat(32_000 - label.length - 1)}`,
          timestamp: index + 1,
        },
      }),
    );
    (runtime as any).fullEntries = asks;

    const entries = (runtime as any).entriesWithCompaction();
    const budget = (runtime as any).contextBudget(
      entries.map((entry: any) => entry.message),
    );
    const preparation = (runtime as any).prepareCompactionInput(entries, budget);
    const retained = preparation.value.retainedTail;

    expect(retained).toHaveLength(3);
    expect(
      retained.reduce(
        (sum: number, message: any) => sum + estimateTokens(message),
        0,
      ),
    ).toBeLessThanOrEqual(20_000);
    // Chronological order, oldest first, with only the boundary message cut.
    expect(
      retained.map((message: any) => message.content.slice(0, 6)),
    ).toEqual(["third:", "second", "newest"]);
    expect(retained[0].content).toContain("[checkpoint truncated:");
    expect(retained[1].content).not.toContain("[checkpoint truncated:");
    await runtime.dispose();
  });

  it("still sees the user messages an earlier checkpoint retained", async () => {
    const runtime = createRuntime();
    (runtime as any).fullEntries = [
      {
        type: "message",
        id: "anchor-user",
        seq: 0,
        parentId: null,
        timestamp: Date.parse("2026-07-31T00:00:00Z"),
        message: { role: "user", content: "anchor ask", timestamp: 1 },
      },
      {
        type: "message",
        id: "later-user",
        seq: 1,
        parentId: "anchor-user",
        timestamp: Date.parse("2026-07-31T00:00:01Z"),
        message: { role: "user", content: "later ask", timestamp: 2 },
      },
    ];
    (runtime as any).activeCompaction = {
      id: "checkpoint-1",
      summary: "First summary.",
      firstKeptMessageId: "anchor-user",
      throughMessageId: "anchor-user",
      tokensBefore: 240_000,
      retainedTail: [
        { role: "user", content: "remembered ask", timestamp: 0 },
      ],
      details: { generation: 1 },
      providerId: "local",
      modelId: "local-model",
      createdAt: "2026-07-31T00:00:00Z",
    };

    const entries = (runtime as any).entriesWithCompaction();
    const budget = (runtime as any).contextBudget(
      buildSessionContext(entries).messages,
    );
    const preparation = (runtime as any).prepareCompactionInput(entries, budget);

    // "anchor ask" is the message the previous checkpoint was filed against, so
    // it sits behind the boundary and "First summary." already covers it. pi
    // 0.84 starts the compactable range at the checkpoint entry (replaying its
    // retained tail as virtual entries) instead of walking back to the anchor,
    // so the one-entry overlap 0.82 produced is gone. What matters to this test
    // still holds: the retained user message survives into the next tail.
    expect(
      preparation.value.retainedTail.map((message: any) => message.content),
    ).toEqual(["remembered ask", "later ask"]);
    await runtime.dispose();
  });

  it("summarizes an atomic parallel tool batch rather than carrying it forward", async () => {
    const constrainedProvider: RuntimeProviderConfig = {
      ...provider,
      modelConfig: {
        ...provider.modelConfig!,
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    };
    const runtime = createRuntime({ provider: constrainedProvider });
    const resultSizes = [2_687, 90_920, 41_099, 155_573];
    const toolCalls = resultSizes.map((_, index) => ({
      type: "toolCall" as const,
      id: `parallel-tool-${index}`,
      name: "Read",
      arguments: { path: `large-${index}.txt` },
    }));
    const toolCarrier = {
      ...assistant,
      content: toolCalls,
      usage: {
        ...assistant.usage,
        input: 110_000,
        totalTokens: 110_000,
      },
      stopReason: "toolUse" as const,
    };
    const largeResults = resultSizes.map((size, index) => ({
      ...toolResult,
      toolCallId: `parallel-tool-${index}`,
      content: [
        { type: "text" as const, text: `${index}${"x".repeat(size - 1)}` },
      ],
      details: { duplicatedDiagnostic: "x".repeat(size) },
    }));
    (runtime as any).fullEntries = [
      {
        type: "message",
        id: "old-user",
        seq: 0,
        parentId: null,
        timestamp: Date.parse("2026-07-29T00:00:00Z"),
        message: { role: "user", content: "inspect the repository", timestamp: 1 },
      },
      {
        type: "message",
        id: "parallel-carrier",
        seq: 1,
        parentId: "old-user",
        timestamp: Date.parse("2026-07-29T00:00:01Z"),
        message: toolCarrier,
      },
      ...largeResults.map((message, index) => ({
        type: "message",
        id: message.toolCallId,
        seq: index + 2,
        parentId:
          index === 0
            ? "parallel-carrier"
            : largeResults[index - 1].toolCallId,
        timestamp: Date.parse(`2026-07-29T00:00:0${index + 2}Z`),
        message,
      })),
    ];

    const entries = (runtime as any).entriesWithCompaction();
    const budget = (runtime as any).contextBudget(
      entries.map((entry: any) => entry.message),
    );
    const preparation = (runtime as any).prepareCompactionInput(entries, budget);
    const retainedTail = preparation.value.retainedTail;

    expect(budget.tokens).toBeGreaterThan(budget.hardLimit);
    expect(preparation.ok).toBe(true);
    expect(preparation.value.firstKeptEntryId).toBe("parallel-tool-3");
    // The batch that used to force a full-tail retention is now summary input.
    expect(
      preparation.value.messagesToSummarize.map((message: any) => message.role),
    ).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "toolResult",
    ]);
    expect(retainedTail.map((message: any) => message.role)).toEqual(["user"]);
    expect(retainedTail[0].content).toBe("inspect the repository");
    // The visible transcript keeps the complete results either way.
    expect(
      (runtime as any).fullEntries.at(-1).message.content[0].text,
    ).toHaveLength(155_573);
    expect((runtime as any).fullEntries.at(-1).message.details).toEqual({
      duplicatedDiagnostic: "x".repeat(155_573),
    });
    await runtime.dispose();
  });

  it("rechecks the hard budget after a reported successful compaction", async () => {
    const runtime = createRuntime();
    vi.spyOn(runtime as any, "contextBudget").mockReturnValue({
      tokens: 225_000,
      hardLimit: 224_000,
      requestHeadroom: 32_000,
      keepRecentTokens: 44_800,
    });
    vi.spyOn(runtime as any, "runCompaction").mockResolvedValue(true);

    await expect((runtime as any).prepareNextTurn(nextTurn)).rejects.toThrow(
      "checkpoint remained above the safe model context budget",
    );
    await runtime.dispose();
  });

  it("persists a retained-tail fallback when automatic summary generation fails", async () => {
    const onEvent = vi.fn();
    const host = { call: vi.fn().mockResolvedValue(undefined) };
    const runtime = createRuntime({
      host,
      onEvent,
      history: [
        {
          id: "old-user",
          role: "user",
          content: "older task context",
          createdAt: "2026-07-28T00:00:00Z",
          status: "complete",
        },
        {
          id: "recent-user",
          role: "user",
          content: "continue the task",
          createdAt: "2026-07-28T00:00:01Z",
          status: "complete",
        },
      ],
    });
    vi.spyOn(runtime as any, "generateCompaction").mockResolvedValue({
      ok: false,
      error: {
        code: "summarization_failed",
        message: "provider terminated the summary request",
      },
    });

    await expect((runtime as any).runCompaction("threshold", false)).resolves.toBe(
      true,
    );

    const checkpoint = host.call.mock.calls[0]?.[0] === "session.appendCompaction"
      ? (host.call.mock.calls[0]?.[1] as any).compaction
      : undefined;
    expect(checkpoint).toEqual(
      expect.objectContaining({
        throughMessageId: "recent-user",
        details: expect.objectContaining({
          fallback: "retained_tail",
          failureCode: "CONTEXT_COMPACTION_FAILED",
        }),
      }),
    );
    expect((runtime as any).fullEntries).toHaveLength(2);
    expect((runtime as any).agent.state.messages[0]).toEqual(
      expect.objectContaining({ role: "compactionSummary" }),
    );
    expect(onEvent.mock.calls.map(([envelope]) => (envelope as any).event)).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        ok: true,
        fallback: "retained_tail",
      }),
    );
    expect(
      onEvent.mock.calls.some(
        ([envelope]) => (envelope as any).event.type === "error",
      ),
    ).toBe(false);
    await runtime.dispose();
  });

  it("shrinks a terminal checkpoint tail when a new prompt leaves no history to summarize", async () => {
    const host = { call: vi.fn().mockResolvedValue(undefined) };
    const runtime = createRuntime({
      host,
      history: [
        {
          id: "old-user",
          role: "user",
          content: "older task context",
          createdAt: "2026-07-28T00:00:00Z",
          status: "complete",
        },
        {
          id: "recent-user",
          role: "user",
          content: "recent context",
          createdAt: "2026-07-28T00:00:01Z",
          status: "complete",
        },
      ],
      compaction: {
        id: "compact-1",
        summary: "The previous task summary.",
        throughMessageId: "recent-user",
        tokensBefore: 220_000,
        retainedTail: [
          { role: "user", content: "recent context", timestamp: 2 },
        ],
        createdAt: "2026-07-28T00:00:02Z",
      },
    });
    const generateCompaction = vi.spyOn(
      runtime as any,
      "generateCompaction",
    );

    await expect((runtime as any).runCompaction("threshold", false)).resolves.toBe(
      true,
    );

    expect(generateCompaction).not.toHaveBeenCalled();
    expect(host.call).toHaveBeenCalledWith(
      "session.appendCompaction",
      expect.objectContaining({
        compaction: expect.objectContaining({
          details: expect.objectContaining({ fallback: "retained_tail" }),
          summary: expect.stringContaining("The previous task summary."),
        }),
      }),
    );
    await runtime.dispose();
  });

  it("keeps manual compaction failures terminal instead of silently dropping context", async () => {
    const host = { call: vi.fn().mockResolvedValue(undefined) };
    const onEvent = vi.fn();
    const runtime = createRuntime({ host, onEvent });
    vi.spyOn(runtime as any, "generateCompaction").mockResolvedValue({
      ok: false,
      error: {
        code: "summarization_failed",
        message: "summary unavailable",
      },
    });

    await expect((runtime as any).runCompaction("manual", false)).resolves.toBe(
      false,
    );
    expect(host.call).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.map(([envelope]) => (envelope as any).event)).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "manual",
        ok: false,
        error: expect.objectContaining({ code: "CONTEXT_COMPACTION_FAILED" }),
      }),
    );
    await runtime.dispose();
  });

  it("does not issue another model turn when hard-limit compaction fails", async () => {
    const runtime = createRuntime();
    vi.spyOn(runtime as any, "contextBudget").mockReturnValue({
      tokens: 225_000,
      hardLimit: 224_000,
      requestHeadroom: 32_000,
    });
    vi.spyOn(runtime as any, "runCompaction").mockResolvedValue(false);

    await expect((runtime as any).prepareNextTurn(nextTurn)).rejects.toThrow(
      "CONTEXT_COMPACTION_FAILED",
    );
    await runtime.dispose();
  });

  it("withdraws the compaction tool when automatic protection is disabled", async () => {
    const runtime = createRuntime();
    const before = (runtime as any).agent.state.tools.map(
      (tool: any) => tool.name,
    );
    expect(before).toContain("new_context");

    runtime.setCompactionSettings({
      enabled: false,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });

    const after = (runtime as any).agent.state.tools.map(
      (tool: any) => tool.name,
    );
    // With protection off there is no checkpoint to ask for, so the tool would
    // only ever return a promise the host does not keep.
    expect(after).toEqual(before.filter((name: string) => name !== "new_context"));
    await runtime.dispose();
  });

  it("keeps a preflight-rejected user message in reusable runtime context", async () => {
    const onEvent = vi.fn();
    const runtime = createRuntime({ onEvent });
    const agent = (runtime as any).agent;
    agent.prompt = vi.fn();
    vi.spyOn(runtime as any, "automaticCompactionNeeded").mockReturnValue(true);
    vi.spyOn(runtime as any, "runCompaction").mockResolvedValue(false);

    await runtime.prompt("oversized request", "user-preflight");

    expect(agent.prompt).not.toHaveBeenCalled();
    expect((runtime as any).fullEntries).toEqual([
      expect.objectContaining({
        id: "user-preflight",
        message: expect.objectContaining({
          role: "user",
          content: "oversized request",
        }),
      }),
    ]);
    expect(agent.state.messages).toEqual([
      expect.objectContaining({ role: "user", content: "oversized request" }),
    ]);
    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          role: "assistant",
          status: "error",
          error: expect.objectContaining({ code: "CONTEXT_COMPACTION_FAILED" }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "CONTEXT_COMPACTION_FAILED" }),
      }),
    );
    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime inline context compaction", () => {
  const history: UiMessage[] = [
    {
      id: "old-user",
      role: "user",
      content: "older task context",
      createdAt: "2026-07-28T00:00:00Z",
      status: "complete",
    },
    {
      id: "recent-user",
      role: "user",
      content: "continue the task",
      createdAt: "2026-07-28T00:00:01Z",
      status: "complete",
    },
  ];
  const nextTurn = {
    context: { systemPrompt: "base", messages: [], tools: [] },
    newMessages: [],
  };
  const SUMMARY = "Older work was summarized.";

  /** Past the hard boundary, so the next turn cannot be issued as-is. */
  function overBudget(tokens = 240_000) {
    return {
      tokens,
      hardLimit: 224_000,
      requestHeadroom: 32_000,
      keepRecentTokens: 1,
    };
  }

  function summaryResult(summary = SUMMARY) {
    return {
      ok: true,
      value: { summary, tokensBefore: 240_000 },
    };
  }

  /** Over the boundary until the checkpoint's summary is part of the context. */
  function budgetSpy(runtime: DesktopAgentRuntime) {
    return vi.spyOn(runtime as any, "contextBudget").mockImplementation(
      ((messages: unknown) =>
        JSON.stringify(messages).includes(SUMMARY)
          ? { ...overBudget(), tokens: 40_000 }
          : overBudget()) as never,
    );
  }

  it("compacts at the turn boundary rather than ahead of it", async () => {
    const host = { call: vi.fn().mockResolvedValue(undefined) };
    const onEvent = vi.fn();
    const runtime = createRuntime({ host, onEvent, history });
    budgetSpy(runtime);
    const generateCompaction = vi
      .spyOn(runtime as any, "generateCompaction")
      .mockResolvedValue(summaryResult());

    // A running tool is an idle provider connection, but compaction has no
    // off-critical-path variant: nothing may happen here.
    await (runtime as any).handleAgentEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Read",
      args: {},
    });
    expect(generateCompaction).not.toHaveBeenCalled();
    expect(host.call).not.toHaveBeenCalled();

    await (runtime as any).prepareNextTurn(nextTurn);

    expect(generateCompaction).toHaveBeenCalledOnce();
    expect(host.call).toHaveBeenCalledWith(
      "session.appendCompaction",
      expect.objectContaining({
        compaction: expect.objectContaining({
          summary: SUMMARY,
          throughMessageId: "recent-user",
        }),
      }),
    );
    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(events).toContainEqual({ type: "compaction_start", reason: "threshold" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "threshold",
        ok: true,
        mark: {
          id: expect.any(String),
          throughMessageId: "recent-user",
          generation: 1,
          summaryTokens: 7,
          summarized: true,
        },
      }),
    );
    await runtime.dispose();
  });

  it("counts checkpoint generations so the inspector can show how often a session compacted", async () => {
    const runtime = createRuntime({
      host: { call: vi.fn().mockResolvedValue(undefined) },
      history,
    });
    const preparation = {
      firstKeptEntryId: "recent-user",
      tokensBefore: 160_000,
      retainedTail: [],
    };

    const first = (runtime as any).createCheckpoint(
      preparation,
      "recent-user",
      "first summary",
    );
    expect((first.details as { generation: number }).generation).toBe(1);

    (runtime as any).activeCompaction = first;
    const second = (runtime as any).createCheckpoint(
      preparation,
      "recent-user",
      "second summary",
      undefined,
      { readFiles: ["a.ts"] },
    );
    expect(second.details).toEqual({ readFiles: ["a.ts"], generation: 2 });
    await runtime.dispose();
  });

  it("reports the session as running while it compacts", async () => {
    const runtime = createRuntime({
      host: { call: vi.fn().mockResolvedValue(undefined) },
      history,
    });
    budgetSpy(runtime);
    let release: (value: unknown) => void = () => {};
    vi.spyOn(runtime as any, "generateCompaction").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const pending = (runtime as any).prepareNextTurn(nextTurn);
    await Promise.resolve();

    expect(runtime.getStatus().isRunning).toBe(true);

    release(summaryResult());
    await pending;
    expect(runtime.getStatus().isRunning).toBe(false);
    await runtime.dispose();
  });

  it("does not compact when automatic protection is disabled", async () => {
    const runtime = createRuntime({
      host: { call: vi.fn().mockResolvedValue(undefined) },
      history,
      compactionSettings: {
        enabled: false,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    });
    budgetSpy(runtime);
    const generateCompaction = vi.spyOn(runtime as any, "generateCompaction");

    await (runtime as any).prepareNextTurn(nextTurn);

    expect(generateCompaction).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("rolls the context over without a summary request in the fresh-window family", async () => {
    const host = { call: vi.fn().mockResolvedValue(undefined) };
    const onEvent = vi.fn();
    const runtime = createRuntime({
      host,
      onEvent,
      history,
      compactionStrategy: "fresh_window",
    });
    vi.spyOn(runtime as any, "contextBudget").mockImplementation(
      ((messages: unknown) =>
        JSON.stringify(messages).includes("context rollover")
          ? { ...overBudget(), tokens: 40_000 }
          : overBudget()) as never,
    );
    const generateCompaction = vi.spyOn(runtime as any, "generateCompaction");

    await (runtime as any).prepareNextTurn(nextTurn);

    // The point of this family: the window is bought back without paying for a
    // summary, so no provider request is made at all.
    expect(generateCompaction).not.toHaveBeenCalled();
    const compaction = host.call.mock.calls.find(
      ([method]) => method === "session.appendCompaction",
    )?.[1].compaction;
    expect(compaction.summary).toContain("[context rollover:");
    expect(compaction.retainedTail).toEqual([]);
    expect(compaction.usage).toBeUndefined();
    expect(compaction.details).toMatchObject({
      strategy: "fresh_window",
      generation: 1,
    });
    // Nothing but the rollover notice survives, matching Codex clearing history.
    expect(
      buildSessionContext((runtime as any).entriesWithCompaction()).messages.map(
        (message: any) => message.role,
      ),
    ).toEqual(["compactionSummary"]);
    const events = onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "threshold",
        ok: true,
      }),
    );
    await runtime.dispose();
  });

  it("stamps the summary family on its checkpoint too", async () => {
    const host = { call: vi.fn().mockResolvedValue(undefined) };
    const runtime = createRuntime({ host, history });
    budgetSpy(runtime);
    vi.spyOn(runtime as any, "generateCompaction").mockResolvedValue(
      summaryResult(),
    );

    await (runtime as any).prepareNextTurn(nextTurn);

    expect(
      host.call.mock.calls.find(
        ([method]) => method === "session.appendCompaction",
      )?.[1].compaction.details,
    ).toMatchObject({ strategy: "summary" });
    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime plugin skills (D174)", () => {
  const pluginSkills = [
    {
      id: "demo.hello/release-notes",
      name: "Release notes",
      description: "Draft release notes from the changelog.",
    },
  ];

  it("advertises the catalog and loads the Skill tool on demand", async () => {
    const runtime = createRuntime({
      pluginSkills,
      projectInstructions: {
        entries: [{ source: "AGENTS.md", content: "Run unit tests." }],
      },
    });
    const agent = (runtime as any).agent;
    const prompt = agent.state.systemPrompt as string;

    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("`demo.hello/release-notes`");
    // Only the catalog line travels up front; the body loads on demand.
    expect(prompt).not.toContain("Skill: Release notes");
    expect(agent.state.tools.some((tool: any) => tool.name === "Skill")).toBe(false);
    const search = agent.state.tools.find(
      (tool: any) => tool.name === "ToolSearch",
    );
    await search.execute("search-1", { query: "Skill" });
    await (runtime as any).rebuiltAgentContext();
    expect(agent.state.tools.some((tool: any) => tool.name === "Skill")).toBe(true);
    // The user's own instructions come last, so they keep the final word.
    expect(prompt.indexOf("# Skills")).toBeLessThan(
      prompt.indexOf("# Project instructions"),
    );

    await runtime.dispose();
  });

  it("omits the Skill tool and section when no plugin taught a skill", async () => {
    const runtime = createRuntime();
    const agent = (runtime as any).agent;

    expect(agent.state.systemPrompt).not.toContain("# Skills");
    expect(agent.state.tools.some((tool: any) => tool.name === "Skill")).toBe(false);

    await runtime.dispose();
  });

  it("keeps the catalog through a nested instruction reload", async () => {
    const host = {
      call: vi.fn().mockResolvedValue({
        entries: [{ source: "src/AGENTS.md", content: "Use tabs." }],
      }),
    };
    const runtime = createRuntime({ pluginSkills, host });

    await (runtime as any).loadPathInstructions("Read", { path: "src/a.ts" });

    const prompt = (runtime as any).agent.state.systemPrompt;
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("Use tabs.");

    await runtime.dispose();
  });

  it("does not reuse a runtime whose skill catalog changed", async () => {
    const runtime = createRuntime({ pluginSkills });

    expect(runtimeMatches(runtime, { pluginSkills })).toBe(true);
    // Revoking agent.prompt.inject empties the catalog.
    expect(runtimeMatches(runtime, { pluginSkills: [] })).toBe(false);
    expect(
      runtimeMatches(runtime, {
        pluginSkills: [...pluginSkills, { id: "demo.hello/other", name: "Other" }],
      }),
    ).toBe(false);
    // A renamed skill rewrites the catalog line the model reads.
    expect(
      runtimeMatches(runtime, {
        pluginSkills: [{ ...pluginSkills[0], name: "Renamed" }],
      }),
    ).toBe(false);

    await runtime.dispose();
  });

  it("routes a Skill call to the host tool bridge", async () => {
    const host = {
      call: vi.fn().mockResolvedValue({ ok: true, content: "# Skill: Release notes" }),
    };
    const runtime = createRuntime({ pluginSkills, host });
    const search = (runtime as any).agent.state.tools.find(
      (entry: any) => entry.name === "ToolSearch",
    );
    await search.execute("search-1", { query: "Skill" });
    await (runtime as any).rebuiltAgentContext();
    const tool = (runtime as any).agent.state.tools.find(
      (entry: any) => entry.name === "Skill",
    );

    const result = await tool.execute("call-1", { id: "demo.hello/release-notes" });

    expect(host.call).toHaveBeenCalledWith(
      "tools.execute",
      expect.objectContaining({
        toolName: "Skill",
        args: { id: "demo.hello/release-notes" },
      }),
    );
    expect(result.content).toEqual([
      { type: "text", text: "# Skill: Release notes" },
    ]);

    await runtime.dispose();
  });
});

describe("DesktopAgentRuntime subagents", () => {
  const explorer: SubagentDefinition = {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read", "Glob", "Grep"],
    maxTurns: 6,
    prompt: "Report file paths and line numbers.",
    source: "builtin",
  };
  const pinned: SubagentDefinition = {
    name: "reviewer",
    description: "Review a diff.",
    tools: ["Read", "Bash"],
    model: { providerId: "remote", modelId: "remote-model" },
    maxTurns: 4,
    prompt: "Review the change.",
    source: "user",
    filePath: "/home/.agents/subagents/reviewer.md",
  };

  function taskTool(runtime: DesktopAgentRuntime) {
    return (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "Task",
    );
  }

  it("offers Task as a core Agent-mode tool that advertises every definition", async () => {
    const runtime = createRuntime({ subagents: [explorer, pinned] });
    const tool = taskTool(runtime);

    // Core, so delegation needs no ToolSearch round trip first.
    expect(tool).toBeDefined();
    expect((runtime as any).deferredToolNames.has("Task")).toBe(false);
    expect(tool.description).toContain(
      "- explorer (tools: Read, Glob, Grep): Search the workspace and report findings.",
    );
    expect(tool.description).toContain("- reviewer (tools: Read, Bash): Review a diff.");

    await runtime.dispose();
  });

  it("is the only tool allowed to run in parallel", async () => {
    const runtime = createRuntime({ subagents: [explorer] });
    const catalog = (runtime as any).toolCatalog as Map<string, any>;

    expect(catalog.get("Task").executionMode).toBe("parallel");
    for (const [name, tool] of catalog) {
      if (name === "Task") continue;
      expect(tool.executionMode).toBe("sequential");
    }

    await runtime.dispose();
  });

  it("withholds Task without definitions and in contract modes", async () => {
    const withoutDefinitions = createRuntime();
    expect(taskTool(withoutDefinitions)).toBeUndefined();
    await withoutDefinitions.dispose();

    // Plan and Goal are read-only contract negotiations (D198): a delegate
    // with Bash or Edit would drive straight through them.
    for (const mode of ["plan", "goal"] as const) {
      const runtime = createRuntime({ mode, subagents: [explorer] });
      expect(taskTool(runtime)).toBeUndefined();
      expect((runtime as any).toolCatalog.has("Task")).toBe(false);
      await runtime.dispose();
    }
  });

  it("rebuilds the Task catalog on a mode switch", async () => {
    const runtime = createRuntime({ subagents: [explorer] });

    runtime.setMode("plan");
    expect((runtime as any).toolCatalog.has("Task")).toBe(false);
    runtime.setMode("agent");
    expect(taskTool(runtime)).toBeDefined();

    await runtime.dispose();
  });

  it("treats a differing definition set as a different configuration", async () => {
    const runtime = createRuntime({ subagents: [explorer] });

    expect(runtimeMatches(runtime)).toBe(true);
    expect(runtimeMatches(runtime, { subagents: [] })).toBe(false);
    expect(
      runtimeMatches(runtime, {
        subagents: [{ ...explorer, maxTurns: 12 }],
      }),
    ).toBe(false);
    expect(
      runtimeMatches(runtime, {
        subagentProviders: { "remote/remote-model": provider },
      }),
    ).toBe(false);

    await runtime.dispose();
  });

  it("rejects an unknown agent and an empty brief as tool errors", async () => {
    const runtime = createRuntime({ subagents: [explorer] });
    const agent = (runtime as any).agent;
    const tool = taskTool(runtime);

    const unknown = await tool.execute("task-1", {
      agent: "Researcher",
      task: "Find it.",
    });
    expect(unknown.content[0].text).toContain('Unknown subagent "Researcher"');
    expect(unknown.content[0].text).toContain("explorer");
    await expect(
      agent.afterToolCall({ toolCall: { id: "task-1" } }),
    ).resolves.toEqual({ isError: true });

    const empty = await tool.execute("task-2", { agent: "explorer", task: "  " });
    expect(empty.content[0].text).toContain("needs a non-empty `task` brief");
    await expect(
      agent.afterToolCall({ toolCall: { id: "task-2" } }),
    ).resolves.toEqual({ isError: true });

    await runtime.dispose();
  });

  it("refuses to silently downgrade an unresolved pinned model", async () => {
    const runtime = createRuntime({ subagents: [pinned] });
    const tool = taskTool(runtime);

    const result = await tool.execute("task-1", {
      agent: "reviewer",
      task: "Review src/app.ts.",
    });

    expect(result.content[0].text).toContain("pins remote/remote-model");
    expect(result.content[0].text).toContain("not configured");
    await expect(
      (runtime as any).agent.afterToolCall({ toolCall: { id: "task-1" } }),
    ).resolves.toEqual({ isError: true });

    await runtime.dispose();
  });

  it("resolves the provider and guidance each definition asks for", async () => {
    const remote: RuntimeProviderConfig = {
      ...provider,
      id: "remote",
      name: "Remote",
      modelId: "remote-model",
      modelConfig: undefined,
    };
    const runtime = createRuntime({
      subagents: [explorer, pinned],
      subagentProviders: { "remote/remote-model": remote },
      scratchDir: "/scratch/session-1",
      projectInstructions: {
        entries: [{ source: "AGENTS.md", content: "Use project rules." }],
      } as ProjectInstructions,
    });

    // No pin means the session's own provider; a pin means exactly that model.
    expect((runtime as any).subagentProvider(explorer).modelId).toBe("local-model");
    expect((runtime as any).subagentProvider(pinned).modelId).toBe("remote-model");

    const readOnly = ((runtime as any).subagentGuidance(explorer) as string[]).join(
      "\n\n",
    );
    expect(readOnly).toContain("prefer Read, Grep, and Glob");
    expect(readOnly).toContain(
      "Read accepts only an existing regular text file, never a directory",
    );
    expect(readOnly).toContain("Grep takes a file-or-directory `path`");
    expect(readOnly).not.toContain("use Edit for one small unique replacement");
    expect(readOnly).toContain("Use project rules.");

    const withShell = ((runtime as any).subagentGuidance(pinned) as string[]).join(
      "\n\n",
    );
    expect(withShell).toContain("bash");
    expect(withShell).toContain("/scratch/session-1");

    await runtime.dispose();
  });

  it("starts the delegate in the background and returns a delegation id", async () => {
    const remote: RuntimeProviderConfig = {
      ...provider,
      id: "remote",
      name: "Remote",
      modelId: "remote-model",
      modelConfig: undefined,
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    };
    const runtime = createRuntime({
      subagents: [pinned],
      subagentProviders: { "remote/remote-model": remote },
      thinkingLevel: "high",
    });
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    subagentRuns.resolveRun = undefined;
    const tool = taskTool(runtime);

    const result = await tool.execute("task-1", {
      agent: "reviewer",
      task: "Review src/app.ts.",
      description: "review app",
    });

    expect(subagentRuns.calls).toHaveLength(1);
    const options = subagentRuns.calls[0];
    expect(options.parentToolCallId).toBe("task-1");
    expect(options.provider.modelId).toBe("remote-model");
    expect(options.task).toBe("Review src/app.ts.");
    expect(options.tools.map((entry: any) => entry.name)).toEqual([
      "Read",
      "Bash",
    ]);
    // The remote provider advertises no reasoning, so the session level is
    // clamped rather than passed through.
    expect(options.thinkingLevel).toBe("off");
    expect(options.systemPrompt).toContain('You are the "reviewer" subagent');
    expect(options.systemPrompt).toContain("Review the change.");
    // Task is non-blocking (ADR 0089): it returns a started notice, not the
    // report, and the delegate is still running.
    expect(result.content[0].text).toContain("Delegation");
    expect(result.content[0].text).toContain("in the background");
    expect(result.details).toMatchObject({
      agent: "reviewer",
      status: "running",
    });
    const delegationId = (result.details as any).delegationId as string;
    expect(delegationId.length).toBeGreaterThan(0);
    expect((runtime as any).delegations.get(delegationId).status).toBe(
      "running",
    );
    // A started delegation is not a tool error.
    await expect(
      (runtime as any).agent.afterToolCall({ toolCall: { id: "task-1" } }),
    ).resolves.toBeUndefined();

    // Settle the delegate; the registry records the outcome for TaskWait.
    subagentRuns.resolveRun!({
      agentName: "reviewer",
      status: "completed",
      report: "src/app.ts:12 misses the null check.",
      turns: 2,
      toolCalls: 3,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    });
    await vi.waitFor(() => {
      expect((runtime as any).delegations.get(delegationId).status).toBe(
        "completed",
      );
    });
    subagentRuns.deferred = false;

    await runtime.dispose();
  });

  it("converges through TaskWait with reports and statuses", async () => {
    const runtime = createRuntime({ subagents: [explorer] });
    subagentRuns.calls.length = 0;
    subagentRuns.result = {
      agentName: "explorer",
      status: "failed",
      report: "The explorer subagent failed after 1 turn(s): no route.",
      turns: 1,
      toolCalls: 0,
      error: { code: "NETWORK_ERROR", message: "no route" },
    };
    const task = taskTool(runtime);
    const wait = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "TaskWait",
    );
    expect(wait).toBeDefined();
    expect((runtime as any).deferredToolNames.has("TaskWait")).toBe(false);

    const started = await task.execute("task-1", {
      agent: "explorer",
      task: "Find it.",
    });
    const delegationId = (started.details as any).delegationId as string;
    // A failed delegate is no longer a failed Task call: the failure is
    // reported through TaskWait, which also carries the partial report.
    await expect(
      (runtime as any).agent.afterToolCall({ toolCall: { id: "task-1" } }),
    ).resolves.toBeUndefined();

    const converged = await wait.execute("wait-1", {
      delegationIds: [delegationId],
    });
    expect(converged.content[0].text).toContain("explorer");
    expect(converged.content[0].text).toContain("failed");
    expect(converged.content[0].text).toContain(
      "The explorer subagent failed after 1 turn(s): no route.",
    );
    expect(converged.details).toMatchObject({
      status: "completed",
      delegations: [
        {
          delegationId,
          agent: "explorer",
          status: "failed",
          startedAt: expect.any(Number),
          completedAt: expect.any(Number),
        },
      ],
    });

    subagentRuns.result = {
      agentName: "explorer",
      status: "truncated",
      report: "Hit the turn limit. Checked 4 of 9 files.",
      turns: 6,
      toolCalls: 6,
    };
    const second = await task.execute("task-2", {
      agent: "explorer",
      task: "Find it.",
    });
    const secondId = (second.details as any).delegationId as string;
    const truncated = await wait.execute("wait-2", {
      delegationIds: [secondId],
    });
    expect(truncated.details).toMatchObject({
      delegations: [{ delegationId: secondId, status: "truncated" }],
    });

    subagentRuns.result = {
      agentName: "explorer",
      status: "timed_out",
      report: "The explorer subagent timed out after 2 turn(s).",
      turns: 2,
      toolCalls: 1,
      error: {
        code: "SUBAGENT_IDLE_TIMEOUT",
        message: "The subagent produced no activity for 600 seconds.",
      },
    };
    const third = await task.execute("task-3", {
      agent: "explorer",
      task: "Find it one more time.",
    });
    const thirdId = (third.details as any).delegationId as string;
    const timedOut = await wait.execute("wait-3", {
      delegationIds: [thirdId],
    });
    expect(timedOut.content[0].text).toContain("timed out");
    expect(timedOut.details).toMatchObject({
      delegations: [
        {
          delegationId: thirdId,
          status: "timed_out",
          error: { code: "SUBAGENT_IDLE_TIMEOUT" },
        },
      ],
    });

    await runtime.dispose();
  });

  it("waits for running delegates with mode all/any and stops them with TaskStop", async () => {
    const runtime = createRuntime({ subagents: [explorer] });
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    subagentRuns.resolveRun = undefined;
    const task = taskTool(runtime);
    const wait = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "TaskWait",
    );
    const stop = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "TaskStop",
    );
    expect(stop).toBeDefined();

    const first = await task.execute("task-1", {
      agent: "explorer",
      task: "Find it.",
    });
    const second = await task.execute("task-2", {
      agent: "explorer",
      task: "Find it too.",
    });
    const firstId = (first.details as any).delegationId as string;
    const secondId = (second.details as any).delegationId as string;

    // mode "any" with minCompleted 1 converges as soon as one settles.
    const waiting = wait.execute("wait-1", {
      mode: "any",
      minCompleted: 1,
      timeoutSeconds: 5,
    });
    subagentRuns.resolveRun!({
      agentName: "explorer",
      status: "completed",
      report: "Found it in src/app.ts:12.",
      turns: 1,
      toolCalls: 2,
    });
    const converged = await waiting;
    expect(converged.details.status).toBe("completed");
    expect(converged.content[0].text).toContain("src/app.ts:12");

    // TaskStop stops the still-running second delegate and reports "stopped".
    const stopped = await stop.execute("stop-1", { delegationIds: [secondId] });
    expect(stopped.details.stopped).toHaveLength(1);
    await vi.waitFor(() => {
      expect((runtime as any).delegations.get(secondId).status).toBe("stopped");
    });
    const afterStop = await wait.execute("wait-2", {
      delegationIds: [secondId],
    });
    expect(afterStop.content[0].text).toContain("stopped");
    expect(firstId).not.toBe(secondId);
    subagentRuns.deferred = false;

    await runtime.dispose();
  });

  it("caps running delegates per session at MAX_SUBAGENT_CONCURRENCY", async () => {
    const runtime = createRuntime({ subagents: [explorer] });
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    subagentRuns.resolveRun = undefined;
    const tool = taskTool(runtime);
    const MAX = MAX_SUBAGENT_CONCURRENCY;

    const ids: string[] = [];
    for (let index = 0; index < MAX; index += 1) {
      const result = await tool.execute(`task-${index}`, {
        agent: "explorer",
        task: "Find it.",
      });
      ids.push((result.details as any).delegationId as string);
    }
    const over = await tool.execute("task-over", {
      agent: "explorer",
      task: "Find it.",
    });
    expect(over.content[0].text).toContain(
      `${MAX} subagents are already running`,
    );
    await expect(
      (runtime as any).agent.afterToolCall({ toolCall: { id: "task-over" } }),
    ).resolves.toEqual({ isError: true });
    expect((runtime as any).runningDelegations()).toHaveLength(MAX);

    // Freeing one slot (via stop) makes room again.
    const stop = (runtime as any).agent.state.tools.find(
      (tool: any) => tool.name === "TaskStop",
    );
    await stop.execute("stop-1", { delegationIds: [ids[0]] });
    await vi.waitFor(() => {
      expect((runtime as any).runningDelegations()).toHaveLength(MAX - 1);
    });
    const again = await tool.execute("task-again", {
      agent: "explorer",
      task: "Find it.",
    });
    expect((again.details as any).delegationId).toBeDefined();
    subagentRuns.deferred = false;

    await runtime.dispose();
  });

  it("aborts running delegates when the run ends or the runtime is disposed", async () => {
    const runtime = createRuntime({ subagents: [explorer] });
    subagentRuns.calls.length = 0;
    subagentRuns.instances.length = 0;
    subagentRuns.deferred = true;
    subagentRuns.resolveRun = undefined;
    const tool = taskTool(runtime);

    const started = await tool.execute("task-1", {
      agent: "explorer",
      task: "Find it.",
    });
    const delegationId = (started.details as any).delegationId as string;
    expect((runtime as any).runningDelegations()).toHaveLength(1);

    // agent_end (the run finishing) is the safety net: leftover delegates are
    // stopped rather than left to work without a parent.
    await (runtime as any).handleAgentEvent({ type: "agent_end" });
    await vi.waitFor(() => {
      expect((runtime as any).delegations.get(delegationId).status).toBe(
        "aborted",
      );
    });
    expect((runtime as any).runningDelegations()).toHaveLength(0);

    subagentRuns.deferred = false;
    await runtime.dispose();
  });

  it("scopes a mutating delegate's tool calls with its permission", async () => {
    const mutator: SubagentDefinition = {
      name: "fixer",
      description: "Implement a multi-file change.",
      tools: ["Read", "Edit", "Write"],
      permission: "accept-edits",
      maxTurns: 6,
      prompt: "Implement it.",
      source: "builtin",
    };
    const host = {
      call: vi.fn((method: string) => {
        if (method === "project.instructions.resolve") {
          return Promise.resolve(undefined);
        }
        if (method === "tools.execute") {
          return Promise.resolve({ ok: true, content: {} });
        }
        return Promise.resolve({ ok: true, content: {} });
      }),
    };
    const runtime = createRuntime({
      subagents: [mutator],
      host: host as never,
    });
    subagentRuns.calls.length = 0;
    const tool = taskTool(runtime);

    await tool.execute("task-1", { agent: "fixer", task: "Do it." });
    const options = subagentRuns.calls[0];
    // The delegate's tools are wrapped; the wrapper forwards the permission
    // scope into the host RPC while the call runs, then clears it.
    const wrappedRead = options.tools.find((entry: any) => entry.name === "Read");
    await wrappedRead.execute("read-1", { path: "src/app.ts" }, undefined, undefined);
    expect(host.call).toHaveBeenCalledWith(
      "tools.execute",
      expect.objectContaining({ permissionScope: "accept-edits" }),
    );
    expect((runtime as any).delegatePermissionScopes.has("read-1")).toBe(false);

    // Definitions without a permission stay unwrapped: the delegate's tools
    // are the catalog's own tools, so their RPC carries no scope.
    const plainRuntime = createRuntime({ subagents: [explorer] });
    subagentRuns.calls.length = 0;
    await taskTool(plainRuntime).execute("task-2", {
      agent: "explorer",
      task: "Find it.",
    });
    const plainOptions = subagentRuns.calls[0];
    expect(
      plainOptions.tools.some((entry: any) => entry.name === "Read"),
    ).toBe(true);

    await runtime.dispose();
    await plainRuntime.dispose();
  });

  it("keeps subagent rows out of the parent model context", async () => {
    const history: UiMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "Review the diff.",
        createdAt: "2026-08-06T00:00:00.000Z",
        status: "complete",
      },
      {
        id: "assistant-child",
        role: "assistant",
        content: "Reading src/app.ts",
        createdAt: "2026-08-06T00:00:01.000Z",
        status: "complete",
        parentToolCallId: "task-1",
        agentName: "reviewer",
      },
      {
        id: "assistant-parent",
        role: "assistant",
        content: "The reviewer found one issue.",
        createdAt: "2026-08-06T00:00:02.000Z",
        status: "complete",
      },
    ];
    const runtime = createRuntime({ subagents: [explorer], history });

    const ids = ((runtime as any).fullEntries as Array<any>).map(
      (entry) => entry.id,
    );
    expect(ids).toContain("user-1");
    expect(ids).toContain("assistant-parent");
    expect(ids).not.toContain("assistant-child");

    await runtime.dispose();
  });
});
