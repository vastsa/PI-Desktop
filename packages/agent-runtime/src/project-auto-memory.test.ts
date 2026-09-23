import { describe, expect, it, vi } from "vitest";
import { autoMemoryPrompt, createAutoMemoryTool, loadAutoMemory } from "./project-auto-memory.js";

describe("project automatic memory tool", () => {
  it("binds the model action to the current session and forwards only allowed fields", async () => {
    const call = vi.fn(async (_method: string, _params?: unknown) => ({ memory: { content: "", entries: [] }, autoRecordEnabled: true }));
    const host = { call: <T = unknown>(method: string, params?: unknown): Promise<T> => call(method, params) as Promise<T> };
    const tool = createAutoMemoryTool(host, "real-session");
    await tool.execute("call-1", {
      action: "upsert", title: "Stack", content: "Use pnpm.",
      sessionId: "other-session", path: "/private", boundPath: "/private",
    });
    expect(call).toHaveBeenCalledWith("project.autoMemory.agentUpsert", {
      sessionId: "real-session", id: undefined, title: "Stack", content: "Use pnpm.",
      expectedTitle: undefined, expectedContent: undefined,
    });
    await tool.execute("call-2", { action: "list", sessionId: "other-session" });
    expect(call).toHaveBeenLastCalledWith("project.autoMemory.agentList", expect.objectContaining({ sessionId: "real-session" }));
    expect(call.mock.calls[1]?.[1]).not.toHaveProperty("boundPath");
  });

  it("lists, updates and deletes entries in the one project memory with stale-update preconditions", async () => {
    const entry = { id: "saved", title: "Stack", content: "Use pnpm." };
    const existingUserEntry = { id: "older", title: "User preference", content: "Prefer concise replies." };
    const call = vi.fn(async (method: string, _params?: unknown) => ({
      memory: { content: "Prefer concise replies.\n\nUse pnpm.", entries: method === "project.autoMemory.agentDelete"
        ? [existingUserEntry] : [existingUserEntry, entry] },
      autoRecordEnabled: true,
    }));
    const host = { call: <T = unknown>(method: string, params?: unknown): Promise<T> => call(method, params) as Promise<T> };
    expect((await loadAutoMemory(host, "session-1")).memory.entries).toEqual([existingUserEntry, entry]);
    const tool = createAutoMemoryTool(host, "session-1");
    const listed = await tool.execute("list", { action: "list" });
    const listedText = listed.content[0];
    if (listedText?.type !== "text") throw new Error("Expected text tool response");
    expect(JSON.parse(listedText.text)).toEqual([existingUserEntry, entry]);
    await expect(tool.execute("call", { action: "upsert", id: "saved", content: "Use yarn." })).rejects.toThrow("list memory first");
    await tool.execute("call", { action: "upsert", id: "saved", title: "Stack", content: "Use yarn.", expectedTitle: "Stack", expectedContent: "Use pnpm." });
    await tool.execute("call", { action: "delete", id: "saved", expectedTitle: "Stack", expectedContent: "Use pnpm." });
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "project.autoMemory.agentList", "project.autoMemory.agentList",
      "project.autoMemory.agentUpsert", "project.autoMemory.agentDelete",
    ]);
    expect(autoMemoryPrompt()).not.toContain("Use pnpm.");
    expect(tool.description).not.toMatch(/manual|AI note|automatic note/i);
    expect(autoMemoryPrompt()).not.toMatch(/manual|AI note|automatic note/i);
    expect(autoMemoryPrompt()).toContain("update a matching note instead of creating a duplicate");
  });
});
