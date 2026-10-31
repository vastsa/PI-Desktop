import { parseMcpServerIds, parseMcpToolNames } from "./mcp-tool-selection.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { systemTranscriptCheckpoint } from "./system-transcript.js";
import { readSystemMessage } from "./system-transcript-journal.js";
import type { UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { DesktopAgentRuntime, type PluginToolDef, type RuntimeProviderConfig } from "./runtime.js";

function flashProvider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash")!;
  return { id: "flash-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}
const pluginTools: PluginToolDef[] = ["plugin_alpha", "plugin_beta"].map((name) => ({
  name, description: `${name} synthetic probe`, parameters: { type: "object", properties: {}, required: [] }, risk: "low",
}));
type Payload = { tools: { function: { name: string } }[]; messages: { role: string; content?: unknown }[] };
type Call = { name: string; args?: Record<string, unknown> };
async function wireFixture(calls: Call[], beforeReply?: () => Promise<void>) {
  const requests: Payload[] = [];
  const fetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const call = calls.shift();
    await beforeReply?.();
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(),
      type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] }
      : { role: "assistant", content: "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return { requests, close: async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
function runtimeFixture(history: UiMessage[] = [], tools = pluginTools, provider = flashProvider(), denied = false, mode: "agent" | "plan" = "agent") {
  const rows = structuredClone(history);
  const executed: string[] = [];
  const errors: unknown[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixed-tools", mode, provider, thinkingLevel: "off", history: rows, pluginTools: tools,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "session.appendMessage") rows.push((params as { message: UiMessage }).message);
      else if (method === "tools.execute") {
        executed.push((params as { toolName: string }).toolName);
        return denied ? { ok: false, denied: true, content: "Permission denied" } as T
          : { ok: true, content: "Synthetic success" } as T;
      } else throw new Error(`Unexpected host method: ${method}`);
      return undefined as T;
    } },
    onEvent: ({ event }) => {
      if (event.type === "error") errors.push(event.error);
      if (event.type === "tool_start") rows.push({ id: event.toolCallId, role: "tool", content: "",
        toolCallId: event.toolCallId, toolName: event.toolName, toolArgs: event.args, createdAt: new Date().toISOString() });
      if (event.type === "tool_end") {
        const row = rows.find((row) => row.id === event.toolCallId)!;
        row.toolResult = event.result; row.isError = event.isError; row.toolStatus = event.isError ? "error" : "success";
      }
      if (event.type === "message_end") {
        const index = rows.findIndex((row) => row.id === event.message.id);
        if (index < 0) rows.push(event.message); else rows[index] = event.message;
      }
    },
  });
  return { runtime, rows, executed, errors, prompt: async (id = "user-1") => {
    rows.push({ id, role: "user", content: "Run the synthetic probes", createdAt: new Date().toISOString() });
    await runtime.prompt("Run the synthetic probes", id, `turn-${id}`);
  } };
}
afterEach(() => vi.unstubAllGlobals());
describe("fixed Flash declarations through runtime and HTTP/SSE", () => {
  it("rejects a declared but inactive tool without invoking Host", async () => {
    const wire = await wireFixture([{ name: "plugin_beta" }]);
    const f = runtimeFixture();
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual([]);
      expect(f.rows.find((row) => row.toolName === "plugin_beta")).toMatchObject({ isError: true });
      expect(JSON.stringify(wire.requests[1].messages)).toContain("Call ToolSearch to activate plugin_beta");
      expect(wire.requests[1].tools).toEqual(wire.requests[0].tools);
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it.each([false, true])("restores only activated tools after restart (checkpoint=%s)", async (checkpoint) => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture();
    let history: UiMessage[];
    let declared: Payload["tools"];
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      declared = wire.requests.at(-1)!.tools;
      history = structuredClone(f.rows);
      if (checkpoint) {
        const system = systemTranscriptCheckpoint(history.filter((row) => row.modelSystem)
          .map((row) => readSystemMessage(row.modelSystem!.messageJson)))!;
        history = [{ id: "checkpoint", role: "system", content: "", createdAt: new Date().toISOString(),
          modelSystem: { version: 1, messageJson: JSON.stringify(system) } }];
      }
    } finally { await f.runtime.dispose(); await wire.close(); }
    const resumed = await wireFixture([{ name: "plugin_alpha" }, { name: "plugin_beta" }]);
    const restored = runtimeFixture(history!);
    try {
      await restored.prompt("restored-user");
      expect(restored.errors).toEqual([]);
      expect(restored.executed).toEqual(["plugin_alpha"]);
      expect(resumed.requests[0].tools).toEqual(declared!);
      expect([...restored.rows].reverse().find((row) => row.toolName === "plugin_beta")).toMatchObject({ isError: true });
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it.each(["schema", "removed", "route"])("does not revive activation after a %s change", async (change) => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture();
    let history: UiMessage[];
    try { await f.prompt(); history = structuredClone(f.rows); }
    finally { await f.runtime.dispose(); await wire.close(); }
    const tools = change === "removed" ? pluginTools.slice(1) : change === "schema"
      ? [{ ...pluginTools[0], description: "Changed schema epoch" }, pluginTools[1]] : pluginTools;
    const provider = change === "route" ? { ...flashProvider(), baseUrl: "https://relay.invalid/v1" } : flashProvider();
    const resumed = await wireFixture([{ name: "plugin_alpha" }]);
    const restored = runtimeFixture(history!, tools, provider);
    try {
      await restored.prompt("changed-user");
      expect(restored.errors).toEqual([]);
      expect(restored.executed).toEqual([]);
      if (change === "removed") expect(resumed.requests[0].tools.map((tool) => tool.function.name)).not.toContain("plugin_alpha");
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it("still requires Host approval after ToolSearch activation", async () => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }, { name: "plugin_alpha" }]);
    const f = runtimeFixture([], pluginTools, flashProvider(), true);
    try {
      await f.prompt();
      expect(f.executed).toEqual(["plugin_alpha"]);
      expect(f.rows.find((row) => row.toolName === "plugin_alpha")).toMatchObject({ isError: true });
      expect(JSON.stringify(wire.requests.at(-1)?.messages)).toContain("Permission denied");
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it("replays a successful activation if stopped before its next declaration checkpoint", async () => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture();
    let history: UiMessage[];
    try {
      await f.prompt();
      const first = f.rows.find((row) => row.modelSystem)!;
      history = structuredClone(f.rows.filter((row) => !row.modelSystem || row === first));
    } finally { await f.runtime.dispose(); await wire.close(); }
    const resumed = await wireFixture([{ name: "plugin_alpha" }, { name: "plugin_beta" }]);
    const restored = runtimeFixture(history!);
    try {
      await restored.prompt("resumed-user");
      expect(restored.executed).toEqual(["plugin_alpha"]);
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it("migrates legacy on-demand history without granting the rest of the catalog", async () => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture([], pluginTools, { ...flashProvider(), baseUrl: "https://relay.invalid" });
    let history: UiMessage[];
    try { await f.prompt(); history = structuredClone(f.rows); }
    finally { await f.runtime.dispose(); await wire.close(); }
    const resumed = await wireFixture([{ name: "plugin_alpha" }, { name: "plugin_beta" }]);
    const restored = runtimeFixture(history!);
    try {
      await restored.prompt("migrated-user");
      expect(restored.executed).toEqual(["plugin_alpha"]);
      expect(resumed.requests[0].tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["plugin_alpha", "plugin_beta"]));
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it("retains the Plan execution guard for predeclared tools", async () => {
    const wire = await wireFixture([{ name: "Write", args: { path: "fixture", content: "denied" } }]);
    const f = runtimeFixture();
    try {
      f.runtime.setMode("plan");
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual([]);
      expect(f.rows.find((row) => row.toolName === "Write")).toMatchObject({ isError: true });
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it("keeps the complete request prefix while searching and executing two different tools", async () => {
    const wire = await wireFixture([
      { name: "ToolSearch", args: { query: "plugin_alpha" } }, { name: "plugin_alpha" },
      { name: "ToolSearch", args: { query: "plugin_beta" } }, { name: "plugin_beta" },
    ]);
    const f = runtimeFixture();
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual(["plugin_alpha", "plugin_beta"]);
      expect(wire.requests).toHaveLength(5);
      expect(wire.requests[0].tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["plugin_alpha", "plugin_beta"]));
      for (let index = 1; index < wire.requests.length; index++) {
        expect(wire.requests[index].tools).toEqual(wire.requests[0].tools);
        const previous = wire.requests[index - 1].messages;
        expect(wire.requests[index].messages.slice(0, previous.length)).toEqual(previous);
      }
    } finally { await f.runtime.dispose(); await wire.close(); }
  });
});

describe("explicit MCP selection", () => {
  const selectedTools: PluginToolDef[] = Array.from({ length: 6 }, (_, i) => ({
    name: `mcp_chosen_probe_${i}`, mcpServerId: "chosen",
    description: "Read-only MCP probe", parameters: { type: "object", properties: {}, required: [] }, risk: "low",
  }));
  const otherTool: PluginToolDef = {
    ...selectedTools[0], name: "mcp_chosen_similar_probe", mcpServerId: "chosen-similar",
  };
  it.each([false, true])("activates every selected-server tool before the first request (fixed=%s)", async (fixed) => {
    const wire = await wireFixture([{ name: selectedTools[5].name }, { name: otherTool.name }]);
    const provider = fixed ? flashProvider() : { ...flashProvider(), baseUrl: "https://relay.invalid/v1" };
    const f = runtimeFixture([], [...selectedTools, otherTool], provider);
    try {
      await f.runtime.prompt({ text: "Read the selected probe", mcpServerIds: ["chosen"] }, "selected-user");
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual([selectedTools[5].name]);
      const names = wire.requests[0].tools.map(t => t.function.name);
      for (const tool of selectedTools) expect(names).toContain(tool.name);
      if (!fixed) expect(names).not.toContain(otherTool.name);
      expect(f.rows.some(row => row.toolName === "ToolSearch")).toBe(false);
      expect(f.rows.find(row => row.toolName === otherTool.name)).toMatchObject({ isError: true });
      wire.requests.length = 0;
      await f.runtime.prompt("Continue", "next-user");
      for (const tool of selectedTools) expect(wire.requests[0].tools.map(t => t.function.name)).toContain(tool.name);
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it.each([false, true])("activates only the requested tool from the selected server (fixed=%s)", async (fixed) => {
    const wire = await wireFixture([{ name: selectedTools[5].name }, { name: selectedTools[0].name }]);
    const provider = fixed ? flashProvider() : { ...flashProvider(), baseUrl: "https://relay.invalid/v1" };
    const f = runtimeFixture([], [...selectedTools, otherTool], provider);
    try {
      await f.runtime.prompt({ text: "Read", mcpServerIds: ["chosen"], mcpToolNames: [selectedTools[5].name] });
      expect(f.executed).toEqual([selectedTools[5].name]);
      const names = wire.requests[0].tools.map(t => t.function.name);
      expect(names).toContain(selectedTools[5].name);
      if (!fixed) expect(names).not.toContain(selectedTools[0].name);
      expect(f.rows.find(row => row.toolName === selectedTools[0].name)).toMatchObject({ isError: true });
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it.each(["missing", "mcp_chosen_similar_probe"])("rejects an unavailable or differently owned tool: %s", async (name) => {
    const wire = await wireFixture([]);
    const f = runtimeFixture([], [...selectedTools, otherTool]);
    try {
      await expect(f.runtime.prompt({ text: "Read", mcpServerIds: ["chosen"], mcpToolNames: [name] })).rejects.toMatchObject({ errorCode: "COMPOSER_MCP_UNAVAILABLE" });
      expect(wire.requests).toHaveLength(0);
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it("does not activate an unknown server or send a provider request", async () => {
    const wire = await wireFixture([]);
    const f = runtimeFixture([], selectedTools);
    try {
      await expect(f.runtime.prompt({ text: "Read", mcpServerIds: ["missing"] })).rejects.toMatchObject({ errorCode: "COMPOSER_MCP_UNAVAILABLE" });
      expect(wire.requests).toHaveLength(0);
      expect(f.executed).toEqual([]);
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it("selected tools still require Host permission", async () => {
    const wire = await wireFixture([{ name: selectedTools[0].name }]);
    const f = runtimeFixture([], selectedTools, flashProvider(), true);
    try {
      await f.runtime.prompt({ text: "Read", mcpServerIds: ["chosen"] });
      expect(f.rows.find(row => row.toolName === selectedTools[0].name)).toMatchObject({ isError: true });
      expect(JSON.stringify(wire.requests.at(-1)?.messages)).toContain("Permission denied");
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it("cannot expose selected MCP tools in Plan mode", async () => {
    const wire = await wireFixture([]);
    const f = runtimeFixture([], selectedTools, flashProvider(), false, "plan");
    try {
      await expect(f.runtime.prompt({ text: "Read", mcpServerIds: ["chosen"] })).rejects.toMatchObject({ errorCode: "TOOL_DENIED" });
      expect(wire.requests).toHaveLength(0);
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it.each([false, true])("restores explicitly activated tools after a runtime restart (fixed=%s)", async (fixed) => {
    const provider = { ...flashProvider(), ...(fixed ? {} : { baseUrl: "https://relay.invalid/v1" }) };
    const wire = await wireFixture([]);
    const f = runtimeFixture([], selectedTools, provider);
    let history: UiMessage[] = [];
    try {
      await f.runtime.prompt({ text: "Read", mcpServerIds: ["chosen"] });
      history = structuredClone(f.rows);
    } finally { await f.runtime.dispose(); await wire.close(); }
    const resumed = await wireFixture([{ name: selectedTools[5].name }]);
    const restored = runtimeFixture(history, selectedTools, provider);
    try {
      await restored.prompt("resumed-user");
      expect(restored.executed).toEqual([selectedTools[5].name]);
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it.each([false, true])("does not activate steering cancelled before consumption (specific=%s)", async (specific) => {
    let arrived!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const wire = await wireFixture([], async () => {
      if (!first) return;
      first = false; arrived(); await gate;
    });
    const f = runtimeFixture([], selectedTools, { ...flashProvider(), baseUrl: "https://relay.invalid/v1" });
    try {
      const running = f.runtime.prompt("Wait", "user", "turn-cancel");
      await ready;
      f.runtime.steer({ text: "Use selected MCP", mcpServerIds: ["chosen"], ...(specific ? { mcpToolNames: [selectedTools[5].name] } : {}) }, "turn-cancel", {
        id: "cancelled-steering", role: "user", content: "Use selected MCP", createdAt: new Date().toISOString(),
      });
      await f.runtime.abort();
      release();
      await running;
      await f.runtime.prompt("New request");
      expect(f.executed).toEqual([]);
      expect(wire.requests.at(-1)?.tools.map(t => t.function.name)).not.toContain(selectedTools[5].name);
    } finally { release(); await f.runtime.dispose(); await wire.close(); }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("activates steering selections when the queued user message is consumed (fixed=%s, specific=%s)", async (fixed, specific) => {
    let arrived!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const calls: Call[] = [];
    const wire = await wireFixture(calls, async () => {
      if (!first) return;
      first = false; arrived(); await gate;
    });
    const f = runtimeFixture([], selectedTools, { ...flashProvider(), ...(fixed ? {} : { baseUrl: "https://relay.invalid/v1" }) });
    try {
      const running = f.runtime.prompt("Wait for followup", "user", "turn-steer");
      await ready;
      f.runtime.steer({ text: "Use selected MCP", mcpServerIds: ["chosen"], ...(specific ? { mcpToolNames: [selectedTools[5].name] } : {}) }, "turn-steer", {
        id: "steering-user", role: "user", content: "Use selected MCP", createdAt: new Date().toISOString(),
      });
      if (!fixed) expect(wire.requests[0].tools.map(t => t.function.name)).not.toContain(selectedTools[5].name);
      expect(f.executed).toEqual([]);
      calls.push({ name: selectedTools[5].name }); release();
      await running;
      expect(f.errors).toEqual([]);
      expect(wire.requests[1].tools.map(t => t.function.name)).toContain(selectedTools[5].name);
      expect(f.executed).toEqual([selectedTools[5].name]);
      if (specific && !fixed) expect(wire.requests[1].tools.map(t => t.function.name)).not.toContain(selectedTools[0].name);
    } finally { release(); await f.runtime.dispose(); await wire.close(); }
  });

});

describe("MCP selection boundary", () => {
  it.each([null, "chosen", {}, [1], [""], [" "]])("rejects invalid selection %j", value => {
    expect(() => parseMcpServerIds(value)).toThrow("Invalid MCP server selection");
  });
  it("preserves legacy absence and deduplicates exact IDs", () => {
    expect(parseMcpServerIds(undefined)).toBeUndefined();
    expect(parseMcpServerIds(["chosen", "chosen", "chosen-other"])).toEqual(["chosen", "chosen-other"]);
  });
});

describe("MCP tool selection boundary", () => {
  it.each([null, "search", [], [""], [1], [{}]])("rejects malformed tool selections: %j", value => {
    expect(() => parseMcpToolNames(value)).toThrow("Invalid MCP tool selection");
  });
  it("preserves omitted selections and deduplicates exact names", () => {
    expect(parseMcpToolNames(undefined)).toBeUndefined();
    expect(parseMcpToolNames(["search", "search"])).toEqual(["search"]);
  });
});
