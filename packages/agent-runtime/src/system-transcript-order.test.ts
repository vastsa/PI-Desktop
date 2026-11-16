import { describe, expect, it } from "vitest";
import { Agent, type AgentTool, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, type SystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { rebuildSystemTranscript } from "./system-transcript.js";

const read = { name: "Read", description: "Read a file", parameters: Type.Object({}) };
const search = { name: "Search", description: "Search files", parameters: Type.Object({}) };
const initial: SystemMessage = { role: "system", content: "Instructions", toolsAdded: [read], timestamp: 1 };
const user: AgentMessage = { role: "user", content: "Find a file", timestamp: 2 };
const result: AgentMessage = {
  role: "toolResult", toolCallId: "search-1", toolName: "ToolSearch",
  content: [{ type: "text", text: "Search activated" }], isError: false, timestamp: 3,
};

describe("chronological system updates", () => {
  it("lets the Pi loop append schema changes and preserves the complete prefix", async () => {
    const executable = (tool: typeof read): AgentTool => ({ ...tool, label: tool.name, execute: async () => ({ content: [], details: {} }) });
    const requests: AgentMessage[][] = [];
    const agent = new Agent({
      initialState: { tools: [executable(read)], messages: [initial, user] },
      streamFn: async (_model, context) => {
        requests.push([...context.messages]);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: {
          role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: Date.now(),
          api: "openai-completions", provider: "fixture", model: "fixture",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
        return stream;
      },
    });
    await agent.continue();
    const before = [...agent.state.messages];
    const replacement = { ...read, parameters: Type.Object({ file: Type.String() }) };
    agent.state.tools = [executable(replacement), executable(search)];
    await agent.prompt("Continue");
    expect(requests).toHaveLength(2);
    expect(requests[1].slice(0, before.length)).toEqual(before);
    expect(requests[1].slice(before.length)).toContainEqual(expect.objectContaining({
      role: "system", toolsAdded: [replacement, search], toolsRemoved: [{ name: "Read" }],
    }));
    expect(getCurrentTools(requests[1])).toEqual([replacement, search]);
    await agent.prompt("Again");
    expect(requests[2].filter((message) => message.role === "system")).toHaveLength(2);
  });

  it("does not move a retained tool update ahead of its activation result", () => {
    const update: SystemMessage = { role: "system", content: "", toolsAdded: [search], timestamp: 4 };
    const before = [initial, user, result, update];
    const after = rebuildSystemTranscript(before, [user, result]);
    expect(after).toEqual(before);
    expect(after[0]).toBe(initial);
    expect(after.at(-1)).toBe(update);
  });
});
