import type { AgentTool, AgentToolResult, ToolCallHooks } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { CodemodeModelHost } from "./model-globals.js";
import { NestedToolRunner, type NestedToolEvent, type NestedToolHost } from "./nested-calls.js";
import { createCodemodeTool, type CodemodeDetails } from "./tool.js";

type Emitted = { event: NestedToolEvent; parent: string };

function textTool(
  name: string,
  executionMode: "parallel" | "sequential",
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>,
): AgentTool {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    executionMode,
    execute: async (_id, args, signal) => ({
      content: [{ type: "text", text: await run(args as Record<string, unknown>, signal) }],
      details: {},
    }),
  };
}

function harness(tools: AgentTool[], hooks: ToolCallHooks = {}, models?: CodemodeModelHost) {
  const emitted: Emitted[] = [];
  const tracked = new Set<string>();
  const settled: AssistantMessage[] = [];
  const host: NestedToolHost = {
    tools: () => tools,
    hooks: () => hooks,
    issuingMessage: (toolCall) => ({
      role: "assistant",
      content: [toolCall],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    }),
    emit: (event, parent) => emitted.push({ event, parent }),
    track: (id) => tracked.add(id),
    untrack: (id) => tracked.delete(id),
    settleBatch: (message) => settled.push(message),
  };
  const runner = new NestedToolRunner(host);
  const terminated: string[] = [];
  const tool = createCodemodeTool({
    runner,
    callableTools: () => tools,
    ...(models ? { models } : {}),
    onTerminate: (id) => terminated.push(id),
  });
  const run = (code: string, signal?: AbortSignal) =>
    tool.execute("code-1", { code }, signal) as Promise<AgentToolResult<CodemodeDetails>>;
  return { run, emitted, tracked, settled, terminated };
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

describe("codemode tool", () => {
  it("runs nested calls through the session pipeline and returns only script output", async () => {
    const read = textTool("Read", "parallel", async (args) => `contents of ${String(args.value)}`);
    const { run, emitted, tracked, settled } = harness([read]);
    const result = await run(`
      const [a, b] = await Promise.all([tools.Read({ value: "a" }), tools.Read({ value: "b" })]);
      return [a, b].map((s) => s.length);
    `);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Script completed");
    expect(text(result)).toContain("[13,13]");
    expect(text(result)).not.toContain("contents of a");
    expect(result.details.calls.map((call) => [call.id, call.name, call.status])).toEqual([
      ["code-1/1", "Read", "ok"],
      ["code-1/2", "Read", "ok"],
    ]);
    // Lineage: every nested event names the script call as its immediate parent.
    expect(emitted.map(({ event, parent }) => [event.type, event.toolCallId, parent])).toEqual(
      expect.arrayContaining([
        ["tool_start", "code-1/1", "code-1"],
        ["tool_end", "code-1/1", "code-1"],
        ["tool_start", "code-1/2", "code-1"],
        ["tool_end", "code-1/2", "code-1"],
      ]),
    );
    expect(tracked.size).toBe(0);
    expect(settled).toHaveLength(2);
  });

  it("applies the session's beforeToolCall gate to nested calls", async () => {
    const bash = textTool("Bash", "sequential", async () => "ran");
    const { run } = harness([bash], {
      beforeToolCall: async ({ toolCall }) =>
        toolCall.name === "Bash" ? { block: true, reason: "Call ToolSearch to activate Bash before using it." } : undefined,
    });
    const result = await run(`
      try { await tools.Bash({}); return "not blocked"; }
      catch (error) { return "blocked: " + error.message; }
    `);
    expect(text(result)).toContain("blocked: Call ToolSearch to activate Bash");
    expect(result.details.calls[0]).toMatchObject({ name: "Bash", status: "error" });
  });

  it("serializes exclusive tools while parallel-safe reads overlap", async () => {
    let active = 0;
    let maxSequential = 0;
    let readActive = 0;
    let maxRead = 0;
    const gate = () => new Promise<void>((resolve) => setImmediate(resolve));
    const bash = textTool("Bash", "sequential", async () => {
      active += 1;
      maxSequential = Math.max(maxSequential, active);
      await gate();
      active -= 1;
      return "ok";
    });
    const read = textTool("Read", "parallel", async () => {
      readActive += 1;
      maxRead = Math.max(maxRead, readActive);
      await gate();
      await gate();
      readActive -= 1;
      return "ok";
    });
    const { run } = harness([bash, read]);
    await run(`
      await Promise.all([tools.Bash({}), tools.Bash({}), tools.Bash({})]);
      await Promise.all([tools.Read({}), tools.Read({}), tools.Read({})]);
    `);
    expect(maxSequential).toBe(1);
    expect(maxRead).toBeGreaterThan(1);
  });

  it("serializes Write and Edit even when the Host could batch them", async () => {
    let active = 0;
    let max = 0;
    const gate = () => new Promise<void>((resolve) => setImmediate(resolve));
    const writer = (name: string) => textTool(name, "parallel", async () => {
      active += 1;
      max = Math.max(max, active);
      await gate();
      active -= 1;
      return "ok";
    });
    const { run } = harness([writer("Write"), writer("Edit")]);
    await run(`await Promise.all([tools.Write({}), tools.Edit({}), tools.Write({})]);`);
    expect(max).toBe(1);
  });

  it("rejects a failed call even when it carries structured content", async () => {
    const structured: AgentTool = {
      ...textTool("mcp_probe", "sequential", async () => "unused"),
      outputSchema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "remote failure" }], details: {}, structuredContent: { ok: false }, isError: true }),
    };
    const { run } = harness([structured]);
    const result = await run(`try { await tools.mcp_probe({}); return "resolved"; } catch (error) { return "rejected: " + error.message; }`);
    expect(text(result)).toContain("rejected: remote failure");
  });

  it("does not wedge the exclusive queue when building a call fails", async () => {
    const bash = textTool("Bash", "sequential", async () => "ran");
    const emitted: NestedToolEvent[] = [];
    const tracked = new Set<string>();
    let issued = 0;
    const runner = new NestedToolRunner({
      tools: () => [bash],
      hooks: () => ({}),
      issuingMessage: (toolCall) => {
        issued += 1;
        if (issued === 1) throw new Error("synthetic issue failure");
        return {
          role: "assistant", content: [toolCall], api: "openai-completions", provider: "test", model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now(),
        };
      },
      emit: (event) => emitted.push(event),
      track: (id) => tracked.add(id),
      untrack: (id) => tracked.delete(id),
      settleBatch: () => undefined,
    });
    const tool = createCodemodeTool({ runner, callableTools: () => [bash] });
    const result = await tool.execute("code-1", { code: `
      const first = await tools.Bash({}).then(() => "ok", (error) => "error: " + error.message);
      const second = await tools.Bash({});
      return first + " | " + second;
    ` }) as AgentToolResult<CodemodeDetails>;
    expect(text(result)).toContain("error: synthetic issue failure | ran");
    expect(tracked.size).toBe(0);
    // The failed call never started, so it has neither start nor end events.
    expect(emitted.map((event) => [event.type, event.toolCallId])).toEqual([
      ["tool_start", "code-1/2"],
      ["tool_end", "code-1/2"],
    ]);
  });

  it("reports completed side effects when the script fails later", async () => {
    const write = textTool("Write", "sequential", async () => "written");
    const { run } = harness([write]);
    const result = await run(`
      await tools.Write({ value: "x" });
      throw new Error("boom");
    `);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Error: boom");
    expect(text(result)).toContain("completed side effects are not undone");
    expect(text(result)).toContain("Write (ok)");
  });

  it("propagates cancellation to an in-flight nested call", async () => {
    let observed: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const slow = textTool("Bash", "sequential", (_args, signal) => {
      observed = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted by host")), { once: true });
      });
    });
    const { run } = harness([slow]);
    const controller = new AbortController();
    const pending = run(`await tools.Bash({});`, controller.signal);
    await startedPromise;
    controller.abort();
    const result = await pending;
    expect(observed?.aborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.details.errorKind).toBe("aborted");
  });

  it("enforces the nested call cap", async () => {
    const read = textTool("Read", "parallel", async () => "x");
    const { run } = harness([read]);
    const result = await run(`
      let count = 0;
      try { for (let i = 0; i < 300; i++) { await tools.Read({}); count++; } }
      catch (error) { return count + " " + error.message; }
    `);
    expect(text(result)).toContain("256 codemode scripts may start at most 256 nested calls.");
  });

  it("bounds output to the requested token budget", async () => {
    const { run } = harness([]);
    const result = await run(`// @options: {"max_output_tokens": 100}\ntext("a".repeat(5000));`);
    expect(text(result)).toContain("Warning: output truncated");
    expect(text(result).length).toBeLessThan(1_000);
    expect(result.details.truncated).toBe(true);
  });

  it("caps the VM heap", async () => {
    const { run } = harness([]);
    const result = await run(`const parts = []; while (true) parts.push("x".repeat(1 << 20) + parts.length);`);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/out of memory/i);
  }, 60_000);

  it("exposes model capabilities without bindings and records model calls", async () => {
    const requests: unknown[] = [];
    const models: CodemodeModelHost = {
      list: () => [{ kind: "chat", providerId: "acct-1", id: "model-a", contextWindow: 1000, maxTokens: 100, reasoning: false, input: ["text"] }],
      complete: async (request) => {
        requests.push(request);
        return { text: "summary" };
      },
    };
    const { run } = harness([], {}, models);
    const result = await run(`
      const listed = await models.list();
      const done = await models.complete({ prompt: "summarize", maxOutputTokens: 99999 });
      return { listed, done, classify: "classify" in models };
    `);
    const value = JSON.parse(text(result).split("Output:\n")[1] ?? "{}") as Record<string, unknown>;
    expect(value).toEqual({
      listed: [{ kind: "chat", providerId: "acct-1", id: "model-a", contextWindow: 1000, maxTokens: 100, reasoning: false, input: ["text"] }],
      done: { text: "summary", model: { providerId: "acct-1", id: "model-a" } },
      classify: false,
    });
    expect(requests).toEqual([{ prompt: "summarize", maxOutputTokens: 16_384 }]);
    expect(result.details.calls).toEqual([
      expect.objectContaining({ name: "models.complete", kind: "model", status: "ok", arguments: { model: "acct-1/model-a" } }),
    ]);
  });

  it("routes models.generateImages through the nested GenerateImages call only when callable", async () => {
    const images = textTool("GenerateImages", "sequential", async () => "saved 1 image");
    const withImages = harness([images], {}, { list: () => [] });
    const ok = await withImages.run(`return await models.generateImages({ value: "cat" });`);
    expect(text(ok)).toContain("saved 1 image");
    expect(withImages.emitted.some(({ event }) => event.type === "tool_start" && event.toolName === "GenerateImages")).toBe(true);

    const without = harness([], {}, { list: () => [] });
    const missing = await without.run(`return "generateImages" in models;`);
    expect(text(missing)).toContain("false");
  });

  it("searches and describes only callable tools", async () => {
    const read = textTool("Read", "parallel", async () => "x");
    const { run } = harness([read]);
    const result = await run(`return { found: await searchTools("read test"), none: await searchTools("bash"), sample: await describeTool("Read") };`);
    const value = JSON.parse(text(result).split("Output:\n")[1] ?? "{}") as { found: unknown; none: unknown; sample: string };
    expect(value.found).toEqual([{ name: "Read", description: "Read test tool" }]);
    expect(value.none).toEqual([]);
    expect(value.sample).toContain("Read");
  });

  it("reports missing sandbox assets as a sandbox failure with no nested calls", async () => {
    const tool = createCodemodeTool({
      runner: new NestedToolRunner({
        tools: () => [], hooks: () => ({}), issuingMessage: () => { throw new Error("unused"); },
        emit: () => undefined, track: () => undefined, untrack: () => undefined, settleBatch: () => undefined,
      }),
      callableTools: () => [],
      assets: { wasmPath: "/nonexistent/quickjs.wasm", workerUrl: new URL("file:///nonexistent/codemode-worker.js") },
    });
    const result = await tool.execute("code-1", { code: "return 1" }) as AgentToolResult<CodemodeDetails>;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Script sandbox failed");
    expect(text(result)).toContain("No nested calls were made.");
    expect(result.details.errorKind).toBe("sandbox");
  });

  it("rejects malformed options before starting a worker", async () => {
    const { run } = harness([]);
    const result = await run(`// @options: {"unknown": 1}\nreturn 1;`);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("The script did not start.");
  });
});
