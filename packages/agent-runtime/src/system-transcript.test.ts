import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, convertToLlm, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  Type,
  type AssistantMessage,
  type SystemMessage,
  type Tool,
} from "@earendil-works/pi-ai";
import { estimateContextTokens as estimateTranscriptTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  initialSystemTranscript,
  rebuildSystemTranscript,
  replaceSystemPrompt,
  syncSystemTools,
  systemPromptContent,
} from "./system-transcript.js";

const read: Tool = { name: "read", description: "Read text", parameters: Type.Object({ path: Type.String() }) };
const edit: Tool = { ...read, name: "edit", description: "Edit text" };
const initial: SystemMessage = {
  role: "system", content: "Base instructions", timestamp: 1_000,
  sections: { rules: "Keep these rules", obsolete: "Remove these rules" },
  toolsAdded: [read, edit],
};
const delta: SystemMessage = {
  role: "system", content: "Additional instructions", timestamp: 1_500,
  sections: { rules: "Updated rules", obsolete: null },
  toolsRemoved: [{ name: "edit" }],
};
const assistant: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "done" }],
  api: "openai-completions", provider: "local", model: "local-model", stopReason: "stop", timestamp: 2_000,
  usage: {
    input: 990, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const user: AgentMessage = { role: "user", content: "continue", timestamp: 2_100 };

function estimateContextTokens(messages: AgentMessage[]) {
  return estimateTranscriptTokens(convertToLlm(messages));
}

afterEach(() => vi.restoreAllMocks());

describe("system transcript helpers", () => {
  it("replays sections and tool removals without giving an unchanged prefix a new timestamp", () => {
    const previous = [initial, delta, assistant, user];
    const rebuilt = rebuildSystemTranscript(previous, [assistant, user]);
    expect(getCurrentSystemPrompt(rebuilt)).toBe(getCurrentSystemPrompt(previous));
    expect(rebuilt[0]).toMatchObject({
      content: "Base instructions\n\nAdditional instructions", timestamp: 1_500,
      sections: { rules: "Updated rules" }, toolsAdded: [read],
    });
    expect(getCurrentSystemMessage(rebuilt)?.sections).not.toHaveProperty("obsolete");
    expect(getCurrentTools(rebuilt)).toEqual([read]);
    expect(estimateContextTokens(rebuilt).usageTokens).toBe(1_000);
    expect(rebuildSystemTranscript(rebuilt, [assistant, user])[0]).toBe(rebuilt[0]);
  });

  it("does not resurrect usage predating a folded system delta", () => {
    const newer = { ...delta, timestamp: 3_000 };
    const rebuilt = rebuildSystemTranscript([initial, assistant, newer], [assistant]);
    expect(rebuilt[0]?.timestamp).toBe(3_000);
    expect(estimateContextTokens(rebuilt).lastUsageIndex).toBeNull();
  });

  it("keeps a complete recovery transcript and its deltas in place", () => {
    const previous = [initial, assistant, delta, user, { ...assistant, stopReason: "error" as const }];
    const retained = previous.slice(0, -1);
    expect(rebuildSystemTranscript(previous, retained)).toBe(retained);
    expect(syncSystemTools(retained, [read])).toBe(retained);
  });

  it("preserves object identity when setting either the same content or rendered prompt", () => {
    const messages = [initial, delta, assistant];
    expect(replaceSystemPrompt(messages, getCurrentSystemPrompt(messages))).toBe(messages);
    expect(replaceSystemPrompt(messages, systemPromptContent(messages))).toBe(messages);
  });

  it("invalidates usage only on a real content change and preserves structured sections and tools", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const changed = replaceSystemPrompt([initial, delta, assistant], "Replacement instructions");
    expect(changed[0]).toMatchObject({ content: "Replacement instructions", timestamp: 5_000, sections: { rules: "Updated rules" } });
    expect(getCurrentTools(changed)).toEqual([read]);
    expect(estimateContextTokens(changed).lastUsageIndex).toBeNull();
    expect(replaceSystemPrompt(changed, "Replacement instructions")).toBe(changed);
    expect(initial.content).toBe("Base instructions");
    const response = { ...assistant, timestamp: 6_000 };
    expect(estimateContextTokens(rebuildSystemTranscript(changed, [assistant, response])).usageTokens).toBe(1_000);
  });

  it("can clear content without clearing sections or tool declarations", () => {
    const changed = replaceSystemPrompt([initial, delta, assistant], "");
    expect(systemPromptContent(changed)).toBe("");
    expect(getCurrentSystemMessage(changed)?.sections).toEqual({ rules: "Updated rules" });
    expect(getCurrentTools(changed)).toEqual([read]);
  });

  it("restores a recovery prompt without flattening sections or backdating its response", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const messages = [initial, delta, assistant, user];
    const before = systemPromptContent(messages);
    const nudged = replaceSystemPrompt(messages, `${before}\n\nRecovery nudge`);
    const response = { ...assistant, timestamp: 6_000 };
    const restored = replaceSystemPrompt([...nudged, response], before);
    expect(getCurrentSystemPrompt(restored)).toBe(getCurrentSystemPrompt(messages));
    expect(getCurrentSystemMessage(restored)?.sections).toEqual({ rules: "Updated rules" });
    expect(restored[0]?.timestamp).toBeGreaterThan(response.timestamp);
    expect(estimateContextTokens(restored).usageTokens).toBe(0);
  });

  it("records tool additions, removals, and same-name schema replacements with fresh semantic time", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const replacement = { ...read, parameters: Type.Object({ file: Type.String() }) };
    const messages = [initial, assistant];
    const changed = syncSystemTools(messages, [replacement]);
    expect(changed[1]).toMatchObject({ timestamp: 5_000, toolsAdded: [replacement], toolsRemoved: [{ name: "read" }, { name: "edit" }] });
    expect(getCurrentTools(changed)).toEqual([replacement]);
    expect(estimateContextTokens(changed).usageTokens).toBe(0);
    expect(syncSystemTools(changed, [replacement])).toBe(changed);
    const response = { ...assistant, timestamp: 6_000 };
    expect(estimateContextTokens(rebuildSystemTranscript(changed, [assistant, response])).usageTokens).toBe(1_000);
    const cleared = syncSystemTools(changed, []);
    expect(getCurrentTools(rebuildSystemTranscript(cleared, [assistant]))).toEqual([]);
  });

  it("ignores executable-only tool changes instead of invalidating usage", () => {
    const messages = [initial, assistant];
    const executable = { ...read, label: "Read", execute: vi.fn() };
    expect(syncSystemTools(messages, [executable, edit])).toBe(messages);
    expect(estimateContextTokens(messages).usageTokens).toBe(1_000);
  });

  it("advances semantic time even if the clock shares a millisecond or moves backwards", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    expect(replaceSystemPrompt([initial, assistant], "changed")[0]?.timestamp).toBe(2_001);
    vi.spyOn(Date, "now").mockReturnValue(500);
    expect(syncSystemTools([initial, assistant], [read])[1]?.timestamp).toBe(2_001);
  });

  it("initializes restored history conservatively without inventing an old timestamp", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const messages = initialSystemTranscript("Current config", [read], [assistant]);
    expect(messages[0]).toMatchObject({ content: "Current config", toolsAdded: [read], timestamp: 5_000 });
    expect(estimateContextTokens(messages).usageTokens).toBe(0);
    const rebuilt = rebuildSystemTranscript(messages, [assistant]);
    expect(rebuilt[0]).toBe(messages[0]);
    expect(estimateContextTokens(rebuilt).usageTokens).toBe(0);
  });

  it("preserves the empty transcript when there is no system state", () => {
    const messages: AgentMessage[] = [];
    expect(initialSystemTranscript("", [], messages)).toBe(messages);
    expect(rebuildSystemTranscript([], messages)).toBe(messages);
    expect(syncSystemTools(messages, [])).toBe(messages);
    expect(replaceSystemPrompt(messages, "")).toBe(messages);
  });

  it("does not trigger duplicate tool deltas in the real pi agent loop after a rebuild", async () => {
    const tool: AgentTool = {
      ...read, label: "Read", execute: async () => ({ content: [{ type: "text", text: "text" }], details: {} }),
    };
    const requests: AgentMessage[][] = [];
    const agent = new Agent({
      initialState: { tools: [tool], messages: [initial, delta, user] },
      streamFn: async (_model, context) => {
        requests.push(context.messages);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: assistant });
        return stream;
      },
    });
    agent.state.messages = syncSystemTools(rebuildSystemTranscript(agent.state.messages, [user]), [tool]);
    const prefix = agent.state.messages[0];
    await agent.continue();
    expect(agent.state.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.filter((message) => message.role === "system")).toEqual([prefix]);
    expect(getCurrentTools(requests[0]!)).toEqual([toToolDeclaration(tool)]);
    expect(agent.state.messages.filter((message) => message.role === "system")).toEqual([prefix]);
  });
});
