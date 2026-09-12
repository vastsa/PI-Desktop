import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import {
  PLUGIN_COMPLETE_DEFAULT_TAIL,
  pluginLlmContextFromTranscript,
  serializePluginLlmContext,
} from "./plugin-session-context.js";

function msg(partial: Partial<UiMessage> & Pick<UiMessage, "id" | "role">): UiMessage {
  return {
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("pluginLlmContextFromTranscript", () => {
  it("omits subagent rows, aborted assistants, and empty user turns", () => {
    const { messages, truncated } = pluginLlmContextFromTranscript([
      msg({ id: "u1", role: "user", content: "Build it" }),
      msg({ id: "a1", role: "assistant", content: "Working", status: "complete" }),
      msg({
        id: "t1",
        role: "tool",
        toolName: "Read",
        toolResult: "file contents",
        parentToolCallId: "task-1",
      }),
      msg({ id: "a2", role: "assistant", content: "failed", status: "error" }),
      msg({ id: "u2", role: "user", content: "   " }),
    ]);
    expect(truncated).toBe(false);
    expect(messages).toEqual([
      { role: "user", content: "Build it" },
      { role: "assistant", content: "Working" },
    ]);
  });

  it("replaces pre-checkpoint history with the compaction summary", () => {
    const { messages } = pluginLlmContextFromTranscript(
      [
        msg({ id: "old", role: "user", content: "ancient" }),
        msg({ id: "keep", role: "user", content: "latest" }),
      ],
      {
        compaction: {
          id: "c1",
          summary: "Earlier work installed the CLI.",
          throughMessageId: "old",
          tokensBefore: 1200,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    );
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("1200 tokens"),
    });
    expect(messages.map((row) => row.content)).toContain("latest");
    expect(messages.map((row) => row.content).join("\n")).not.toContain("ancient");
  });

  it("strips an in-flight plugin tool row from the tail", () => {
    const { messages } = pluginLlmContextFromTranscript(
      [
        msg({ id: "u1", role: "user", content: "review this" }),
        msg({
          id: "t1",
          role: "tool",
          toolName: "plugin_pi_example_review",
          toolStatus: "running",
          toolResult: "",
        }),
      ],
      { stripToolName: "plugin_pi_example_review" },
    );
    expect(messages).toEqual([{ role: "user", content: "review this" }]);
  });

  it("caps total size from the oldest retained messages", () => {
    const { messages, truncated } = pluginLlmContextFromTranscript(
      [
        msg({ id: "u1", role: "user", content: "AAAA" }),
        msg({ id: "u2", role: "user", content: "BBBB" }),
        msg({ id: "u3", role: "user", content: "CCCC" }),
      ],
      { maxChars: 8 },
    );
    expect(truncated).toBe(true);
    expect(messages.at(-1)?.content).toBe("CCCC");
    expect(messages.reduce((sum, row) => sum + row.content.length, 0)).toBeLessThanOrEqual(8);
  });
});

describe("serializePluginLlmContext", () => {
  it("flattens roles into a tools-less transcript", () => {
    const text = serializePluginLlmContext([
      { role: "user", content: "Do the thing" },
      { role: "tool", toolName: "Read", content: "src/a.ts" },
    ]);
    expect(text).toContain("### User\nDo the thing");
    expect(text).toContain("### Tool Read\nsrc/a.ts");
    expect(PLUGIN_COMPLETE_DEFAULT_TAIL).toMatch(/respond/);
  });
});
