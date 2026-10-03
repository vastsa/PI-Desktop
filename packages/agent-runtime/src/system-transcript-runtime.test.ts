import { describe, expect, it } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "", authKind: "none",
  modelConfig: modelConfigFromPi({ ...Object.values(DEEPSEEK_MODELS)[0], id: "fixture", provider: "fixture", baseUrl: "https://fixture.invalid/v1",
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } }),
  baseUrl: "https://fixture.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const skill = { id: "fixture/notes", name: "First catalog", description: "Summarize notes" };
function answer(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now() + 10, stopReason, content,
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function fixture(history: UiMessage[] = [], skills = [skill]) {
  const rows = [...history];
  const requests: Message[][] = [];
  const errors: unknown[] = [];
  let persistenceFailure: Error | undefined;
  let respond = () => answer([{ type: "text", text: "Done." }]);
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture", mode: "agent", provider, thinkingLevel: "off", history, pluginSkills: skills,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "session.appendMessage") {
        if (persistenceFailure) throw persistenceFailure;
        rows.push((params as { message: UiMessage }).message);
      }
      else throw new Error(`Unexpected host method: ${method}`);
      return undefined as T;
    } },
    onEvent: ({ event }) => {
      if (event.type === "error") errors.push(event.error);
      if (event.type === "tool_start") rows.push({
        id: event.toolCallId, role: "tool", content: "", toolCallId: event.toolCallId,
        toolName: event.toolName, toolArgs: event.args, createdAt: new Date().toISOString(),
      });
      if (event.type === "tool_end") {
        const row = rows.find((row) => row.id === event.toolCallId)!;
        row.toolResult = event.result; row.isError = event.isError; row.toolStatus = "success";
      }
      if (event.type === "message_end") {
        const index = rows.findIndex((row) => row.id === event.message.id);
        if (index < 0) rows.push(event.message); else rows[index] = event.message;
      }
    },
  });
  const agent = (runtime as unknown as { agent: Agent }).agent;
  agent.streamFunction = async (_model, context) => {
    requests.push(structuredClone(context.messages));
    const message = respond();
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  return {
    runtime, agent, rows, requests, errors,
    failPersistence: () => { persistenceFailure = new Error("disk full"); },
    respond: (next: () => AssistantMessage) => { respond = next; },
    prompt: async (id: string) => {
      rows.push({ id, role: "user", content: "Continue", createdAt: new Date().toISOString() });
      await runtime.prompt("Continue", id, `turn-${id}`);
    },
  };
}

describe("system state through the Desktop user path", () => {
  it("activates ToolSearch through Pi, retains its prefix, and restores the declarations after restart", async () => {
    const f = fixture();
    let requests = 0;
    f.respond(() => ++requests === 1
      ? answer([{ type: "toolCall", id: "search-call", name: "ToolSearch", arguments: { query: "BrowserPreview" } }], "toolUse")
      : answer([{ type: "text", text: "Ready." }]));
    try {
      await f.prompt("user-1");
      expect(f.requests).toHaveLength(2);
      const [before, after] = f.requests;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(getCurrentTools(before).some((tool) => tool.name === "BrowserPreview")).toBe(false);
      expect(getCurrentTools(after).some((tool) => tool.name === "BrowserPreview")).toBe(true);
      const activation = after.findIndex((message) => message.role === "toolResult" && message.toolName === "ToolSearch");
      expect(after.slice(activation + 1)).toContainEqual(expect.objectContaining({ role: "system", toolsAdded: expect.arrayContaining([expect.objectContaining({ name: "BrowserPreview" })]) }));
      expect(f.rows.filter((row) => row.modelSystem)).toHaveLength(2);
      await f.prompt("same-runtime-user");
      expect(getCurrentTools(f.requests[2]).some((tool) => tool.name === "BrowserPreview")).toBe(true);
      expect(f.rows.filter((row) => row.modelSystem)).toHaveLength(2);
      const restored = fixture(structuredClone(f.rows));
      try {
        await restored.prompt("user-2");
        const replay = restored.requests[0];
        expect(replay.filter((message) => message.role === "system")).toEqual(after.filter((message) => message.role === "system"));
        const resultIndex = replay.findIndex((message) => message.role === "toolResult" && message.toolName === "ToolSearch");
        expect(resultIndex).toBeGreaterThan(0);
        expect(replay.slice(resultIndex + 1)).toContainEqual(after.at(-1));
        expect(getCurrentTools(restored.requests[0]).some((tool) => tool.name === "BrowserPreview")).toBe(true);
        expect(restored.rows.filter((row) => row.modelSystem)).toHaveLength(2);
      } finally { await restored.runtime.dispose(); }
    } finally { await f.runtime.dispose(); }
  });

  it("stops before provider dispatch when the Host cannot save system state", async () => {
    const f = fixture();
    f.failPersistence();
    try {
      await f.prompt("user-1");
      expect(f.requests).toHaveLength(0);
      expect(f.errors).toContainEqual(expect.objectContaining({
        code: "INTERNAL", retriable: false, details: expect.objectContaining({ origin: "local", phase: "request-preparation" }),
      }));
    } finally { await f.runtime.dispose(); }
  });

  it("updates and revokes a skill catalog on the same runtime without rewriting previous requests", async () => {
    const otherSkill = { id: "fixture/other", name: "Unchanged entry", description: "Keep this instruction" };
    const f = fixture([], [skill, otherSkill]);
    try {
      await f.prompt("user-1");
      const before = f.requests[0];
      f.runtime.setPluginSkills([{ ...skill, name: "Updated catalog" }, otherSkill]);
      await f.prompt("user-2");
      const after = f.requests[1];
      expect(after.slice(0, before.length)).toEqual(before);
      expect(getCurrentSystemPrompt(after)).toContain("Updated catalog");
      expect(getCurrentSystemPrompt(after)).not.toContain("First catalog");
      expect(after.filter((message) => message.role === "system")).toHaveLength(2);
      const updates = after.filter((message) => message.role === "system");
      expect(updates.at(-1)?.sections).toEqual({ "skill:fixture/notes": "- `fixture/notes` — Updated catalog: Summarize notes" });
      expect(getCurrentSystemPrompt(after)).toContain("Unchanged entry");
      const restored = fixture(structuredClone(f.rows), [{ ...skill, name: "Updated catalog" }, otherSkill]);
      try {
        await restored.prompt("restored-user");
        expect(restored.requests[0].filter((message) => message.role === "system")).toEqual(updates);
      } finally { await restored.runtime.dispose(); }
      f.runtime.setPluginSkills([]);
      await f.prompt("user-3");
      expect(getCurrentSystemPrompt(f.requests[2])).not.toContain("Updated catalog");
      // Revocation includes a section delta and Pi's executable-tool removal.
      expect(f.rows.filter((row) => row.modelSystem)).toHaveLength(4);
      expect(getCurrentTools(f.requests[2]).some((tool) => tool.name === "Skill")).toBe(false);
    } finally { await f.runtime.dispose(); }
  });
});
