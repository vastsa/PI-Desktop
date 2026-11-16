import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  type AssistantMessage,
  type SystemMessage,
  type Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { estimateContextTokens as estimateTranscriptTokens } from "@earendil-works/pi-ai/utils/estimate";
import { convertToLlm } from "./pi-runtime-messages.js";
import {
  syncSystemSections,
  initialSystemTranscript,
  rebuildSystemTranscript,
  replaceSystemPrompt,
  systemTranscriptCheckpoint,
  systemPromptContent,
  removeTrailingAssistantMessages,
} from "./system-transcript.js";

const read: Tool = { name: "Read", description: "Read text", parameters: Type.Object({ path: Type.String() }) };
const edit: Tool = { ...read, name: "Edit", description: "Edit text" };
const initial: SystemMessage = {
  role: "system", content: "", timestamp: 1_000,
  sections: { runtime: "Base instructions", rules: "Keep these rules", obsolete: "Remove these rules" },
  toolsAdded: [read, edit],
};
const delta: SystemMessage = {
  role: "system", content: "", timestamp: 1_500,
  sections: { rules: "Updated rules", obsolete: null },
  toolsRemoved: [{ name: "Edit" }],
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
  it("removes failed trailing responses across cleanup deltas without changing system state", () => {
    const messages = [initial, user, assistant, delta, { ...assistant, timestamp: 3_000 }];
    const cleaned = removeTrailingAssistantMessages(messages);
    expect(cleaned).toEqual([initial, user, delta]);
    expect(getCurrentTools(cleaned)).toEqual(getCurrentTools(messages));
    expect(messages).toHaveLength(5);
    expect(removeTrailingAssistantMessages([user, assistant])).toEqual([user]);
    expect(removeTrailingAssistantMessages([assistant, user, delta])).toEqual([assistant, user, delta]);
  });
  it("updates only the changed skill entry and preserves unrelated sections", () => {
    const previous: AgentMessage[] = [{
      role: "system", content: "", timestamp: 1,
      sections: { runtime: "Base", skills: "Load skills", "skill:a": "A", "skill:b": "B", context: "Context", extension: "Keep" },
    }, assistant];
    const desired = { runtime: "Base", skills: "Load skills", "skill:a": "A updated", "skill:b": "B", context: "Context" };
    const updated = syncSystemSections(previous, desired);
    expect(updated.slice(0, previous.length)).toEqual(previous);
    expect(updated.at(-1)).toMatchObject({ sections: { "skill:a": "A updated" } });
    expect(getCurrentSystemMessage(updated)?.sections).toHaveProperty("extension", "Keep");
    expect(syncSystemSections(updated, desired)).toBe(updated);
    const revoked = syncSystemSections(updated, { runtime: "Base", context: "Context" });
    expect(revoked.at(-1)).toMatchObject({ sections: { skills: null, "skill:a": null, "skill:b": null } });
    expect(getCurrentSystemPrompt(revoked)).not.toContain("A updated");
    expect(getCurrentSystemPrompt(revoked)).toContain("Keep");
  });

  it("upgrades aggregate catalogs once and restores per-skill checkpoints without duplicate deltas", () => {
    const legacy: AgentMessage[] = [{ role: "system", content: "", timestamp: 1,
      sections: { runtime: "Base", skills: "Old full catalog", context: "Context" } }];
    const desired = { runtime: "Base", skills: "Load skills", "skill:z": "Z", context: "Context" };
    const upgraded = syncSystemSections(legacy, desired);
    expect(getCurrentSystemPrompt(upgraded)).not.toContain("Old full catalog");
    const added = syncSystemSections(upgraded, { ...desired, "skill:a": "A" });
    expect(systemPromptContent(added)).toBe("Base\n\nLoad skills\n\nA\n\nZ\n\nContext");
    const restored = [systemTranscriptCheckpoint(added)!];
    expect(syncSystemSections(restored, { ...desired, "skill:a": "A" })).toBe(restored);
    expect(systemPromptContent(restored)).toBe(systemPromptContent(added));
    const replaced = replaceSystemPrompt(restored, "Temporary prompt");
    expect(getCurrentSystemPrompt(replaced)).toBe("Temporary prompt");
  });

  it("replays sections and tool removals without giving an unchanged prefix a new timestamp", () => {
    const previous = [initial, delta, assistant, user];
    const rebuilt = rebuildSystemTranscript(previous, [assistant, user]);
    expect(getCurrentSystemPrompt(rebuilt)).toBe(getCurrentSystemPrompt(previous));
    expect(rebuilt).toEqual(previous);
    expect(systemTranscriptCheckpoint(rebuilt)).toMatchObject({
      content: "", timestamp: 1_500,
      sections: { runtime: "Base instructions", rules: "Updated rules" }, toolsAdded: [read],
    });
    expect(getCurrentSystemMessage(rebuilt)?.sections).not.toHaveProperty("obsolete");
    expect(getCurrentTools(rebuilt)).toEqual([read]);
    expect(estimateContextTokens(rebuilt).usageTokens).toBe(1_000);
    expect(rebuildSystemTranscript(rebuilt, [assistant, user])[0]).toBe(rebuilt[0]);
  });

  it("keeps an earlier usage anchor and estimates an appended delta", () => {
    const newer = { ...delta, timestamp: 3_000 };
    const rebuilt = rebuildSystemTranscript([initial, assistant, newer], [assistant]);
    expect(rebuilt.at(-1)?.timestamp).toBe(3_000);
    expect(estimateContextTokens(rebuilt).trailingTokens).toBeGreaterThan(0);
  });

  it("keeps a complete recovery transcript and its deltas in place", () => {
    const previous = [initial, assistant, delta, user, { ...assistant, stopReason: "error" as const }];
    const retained = previous.slice(0, -1);
    expect(rebuildSystemTranscript(previous, retained)).toBe(retained);
  });

  it("preserves object identity when setting either the same content or rendered prompt", () => {
    const messages = [initial, delta, assistant];
    expect(replaceSystemPrompt(messages, getCurrentSystemPrompt(messages))).toBe(messages);
    expect(replaceSystemPrompt(messages, systemPromptContent(messages))).toBe(messages);
  });

  it("accounts for a real content change and preserves structured sections and tools", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const changed = replaceSystemPrompt([initial, delta, assistant], "Replacement instructions");
    expect(changed.at(-1)).toMatchObject({ content: "", timestamp: 5_000, sections: { runtime: "Replacement instructions" } });
    expect(getCurrentTools(changed)).toEqual([read]);
    expect(estimateContextTokens(changed).trailingTokens).toBeGreaterThan(0);
    expect(replaceSystemPrompt(changed, "Replacement instructions")).toBe(changed);
    expect(initial.sections?.runtime).toBe("Base instructions");
    const response = { ...assistant, timestamp: 6_000 };
    expect(estimateContextTokens(rebuildSystemTranscript(changed, [assistant, response])).usageTokens).toBe(1_000);
  });

  it("can clear content without clearing sections or tool declarations", () => {
    const changed = replaceSystemPrompt([initial, delta, assistant], "");
    expect(systemPromptContent(changed)).toBe("");
    expect(getCurrentSystemMessage(changed)?.sections).toEqual({ runtime: "", rules: "Updated rules" });
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
    expect(getCurrentSystemMessage(restored)?.sections).toEqual({ runtime: "Base instructions", rules: "Updated rules" });
    expect(restored.at(-1)?.timestamp).toBeGreaterThan(response.timestamp);
    expect(estimateContextTokens(restored).trailingTokens).toBeGreaterThan(0);
  });

  it("advances semantic time even if the clock shares a millisecond or moves backwards", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    expect(replaceSystemPrompt([initial, assistant], "changed").at(-1)?.timestamp).toBe(2_001);
    vi.spyOn(Date, "now").mockReturnValue(500);
    expect(replaceSystemPrompt([initial, assistant], "another change").at(-1)?.timestamp).toBe(2_001);
  });

  it("initializes restored history conservatively without inventing an old timestamp", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const messages = initialSystemTranscript("Current config", [read], [assistant]);
    expect(messages.at(-1)).toMatchObject({ sections: { runtime: "Current config" }, toolsAdded: [read], timestamp: 5_000 });
    expect(estimateContextTokens(messages).trailingTokens).toBeGreaterThan(0);
    const rebuilt = rebuildSystemTranscript(messages, [assistant]);
    expect(rebuilt[0]).toBe(messages[0]);
    expect(estimateContextTokens(rebuilt).trailingTokens).toBeGreaterThan(0);
  });

  it("preserves the empty transcript when there is no system state", () => {
    const messages: AgentMessage[] = [];
    expect(initialSystemTranscript("", [], messages)).toBe(messages);
    expect(rebuildSystemTranscript([], messages)).toBe(messages);
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
    agent.state.messages = rebuildSystemTranscript(agent.state.messages, [user]);
    const prefix = agent.state.messages.filter((message) => message.role === "system");
    await agent.continue();
    expect(agent.state.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.filter((message) => message.role === "system")).toEqual(prefix);
    expect(getCurrentTools(requests[0]!)).toEqual([toToolDeclaration(tool)]);
    expect(agent.state.messages.filter((message) => message.role === "system")).toEqual(prefix);
  });
});
