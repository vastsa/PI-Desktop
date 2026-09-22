import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  lastReadLine,
  narrowToolResults,
  spillPath,
  TOOL_RESULT_TIER_CLEAR_AT_LEAST_CHARS,
  TOOL_RESULT_TIER_EXCLUDE_TOOLS,
  TOOL_RESULT_TIER_HEAD_CHARS,
  TOOL_RESULT_TIER_KEEP_MARKERS,
  TOOL_RESULT_TIER_KEEP_RECENT,
  TOOL_RESULT_TIER_MIN_CHARS,
  workingSetPathsFrom,
} from "./tool-result-tier.js";

const user = (text: string): AgentMessage =>
  ({ role: "user", content: text, timestamp: 1 }) as unknown as AgentMessage;

const assistant = (text: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "p",
    model: "m",
    stopReason: "stop",
  }) as unknown as AgentMessage;

/** An assistant tool call in the shape the stored messages use. */
const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  container: "arguments" | "args" = "arguments",
): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, [container]: args }],
    provider: "p",
    model: "m",
    stopReason: "toolUse",
  }) as unknown as AgentMessage;

const toolResult = (
  text: string,
  extra: Record<string, unknown> = {},
): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
    ...extra,
  }) as unknown as AgentMessage;

/** A `Read` payload the way host-core renders one: header, then `N: line`. */
function readWindow(lines: number, lineChars = 200): string {
  const body = Array.from(
    { length: lines },
    (_value, index) => `${index + 1}:${"x".repeat(lineChars)}`,
  ).join("\n");
  return `[src/app.ts#a1b2]\n${body}`;
}

/** A shell result whose output was spilled by the host's truncation marker. */
function spilledShell(lines: number): string {
  const body = Array.from({ length: lines }, () => "y".repeat(200)).join("\n");
  return (
    `${body}\n` +
    "[truncated: kept the first 4000 of 51234 lines; limit 4000 lines / 96KB. " +
    "Full output saved to C:\\data\\scratch\\s1\\tool-output\\bash-1-1.log — " +
    "Grep it, or Read it with offset/limit.]"
  );
}

const big = (chars: number): string => "x".repeat(chars);

/** Old oversized result first, then the protected recent ones. */
function oldReadWithRecentTail(
  lines = 200,
  extra: Record<string, unknown> = {},
): AgentMessage[] {
  return [
    toolCall("call-1", "Read", { file_path: "src/app.ts" }),
    toolResult(readWindow(lines), extra),
    ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
      toolResult(big(50)),
    ),
  ];
}

const textAt = (list: AgentMessage[], index: number): string => {
  const content = (list[index] as unknown as { content: unknown }).content;
  if (typeof content === "string") return content;
  return (content as Array<{ text: string }>)[0].text;
};

describe("recovery pointers", () => {
  it("reads the last file line a kept head shows, ignoring digits inside a line", () => {
    expect(lastReadLine("[p#a1b2]\n1:a\n2:b\n3:c")).toBe(3);
    // A file line that itself begins with digits and a colon: only the
    // rendered prefix counts, so the answer is still the row number.
    expect(lastReadLine("[p#a1b2]\n41:9: inner\n42:x")).toBe(42);
    // No numbered row at all: there is nothing to continue from.
    expect(lastReadLine("[p#a1b2]\nbody")).toBeUndefined();
  });

  it("finds the spill path in the host's own truncation sentence", () => {
    expect(
      spillPath(
        "tail\n[truncated: kept the last 10 of 99 lines; limit 4000 lines / 96KB. " +
          "Full output saved to /tmp/scratch/s1/tool-output/bash-1-1.log — Grep it, or Read it with offset/limit.]",
      ),
    ).toBe("/tmp/scratch/s1/tool-output/bash-1-1.log");
    // No spill, so no recovery path to name.
    expect(spillPath("[truncated: kept the first 10 of 99 lines; limit 4000 lines / 96KB. Narrow the request to see more.]")).toBeUndefined();
    expect(spillPath("ordinary output")).toBeUndefined();
  });
});

describe("narrowToolResults", () => {
  it("shortens an old Read result and points at the next line of that file", () => {
    const messages = oldReadWithRecentTail();
    const result = narrowToolResults(messages);

    expect(result.narrowed).toBe(1);
    const narrowed = textAt(result.messages, 1);
    expect(narrowed.length).toBeLessThan(TOOL_RESULT_TIER_HEAD_CHARS + 400);
    expect(narrowed).toContain("[tool result narrowed:");
    expect(narrowed).toContain('Continue with Read path="src/app.ts" offset=');
    // The pointer names a real continuation: the head ends at row N, so the
    // reader resumes at N + 1.
    const lastLine = lastReadLine(narrowed);
    expect(lastLine).toBeDefined();
    expect(narrowed).toContain(`offset=${(lastLine ?? 0) + 1}`);
    // Untouched rows come back by reference, so nothing else was rewritten.
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[2]).toBe(messages[2]);
  });

  it("shortens a spilled shell result and points at the spill file", () => {
    const messages = [
      toolCall("call-1", "Bash", { command: "npm test" }),
      toolResult(spilledShell(200), { toolName: "Bash" }),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50), { toolName: "Bash" }),
      ),
    ];
    const result = narrowToolResults(messages);

    expect(result.narrowed).toBe(1);
    const narrowed = textAt(result.messages, 1);
    expect(narrowed).toContain("[tool result narrowed:");
    expect(narrowed).toContain(
      "C:\\data\\scratch\\s1\\tool-output\\bash-1-1.log",
    );
    expect(narrowed).toContain("Read it with offset/limit, or Grep it");
  });

  it("leaves a result whole when no recovery path can be named", () => {
    const messages = [
      // A Grep result: re-running it is not guaranteed to return the same
      // lines, so the pointer would not be exact.
      toolCall("call-1", "Grep", { pattern: "needle" }),
      toolResult(big(20_000), { toolName: "Grep" }),
      // A shell result that was never spilled: nothing holds a fuller copy.
      toolCall("call-2", "Bash", { command: "ls -R" }),
      toolResult(big(20_000), { toolName: "Bash", toolCallId: "call-2" }),
      // A Read result whose call named no path.
      toolCall("call-3", "Read", {}),
      toolResult(readWindow(200), { toolCallId: "call-3" }),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    const result = narrowToolResults(messages);

    expect(result.narrowed).toBe(0);
    expect(result.savedChars).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("leaves a result with more than one text block whole", () => {
    const messages = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "Read",
        content: [
          { type: "text", text: readWindow(100) },
          { type: "text", text: readWindow(100) },
        ],
        timestamp: 2,
      } as unknown as AgentMessage,
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    const result = narrowToolResults(messages);

    expect(result.narrowed).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("never shortens user messages, assistant prose, or small results", () => {
    const messages = [
      user(big(20_000)),
      assistant(big(20_000)),
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      toolResult(readWindow(3)),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    const result = narrowToolResults(messages);

    expect(result.narrowed).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("keeps tool-search activation evidence intact", () => {
    const messages = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      toolResult(readWindow(200), { addedToolNames: ["Read"] }),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    expect(narrowToolResults(messages).narrowed).toBe(0);
  });

  it("never shortens a result whose text carries a keep marker", () => {
    expect(TOOL_RESULT_TIER_KEEP_MARKERS).toContain("[keep]");
    const body = `${readWindow(200)}\n[KEEP]`;
    const messages = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      toolResult(body),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    expect(narrowToolResults(messages).narrowed).toBe(0);
  });

  it("never shortens results of excluded tools, blind to a missing tool name", () => {
    expect(TOOL_RESULT_TIER_EXCLUDE_TOOLS).toContain("TaskWait");
    const excluded = [
      toolCall("call-1", "TaskWait", {}),
      toolResult(readWindow(200), { toolName: "TaskWait" }),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    expect(narrowToolResults(excluded).narrowed).toBe(0);

    // Without a tool name the exclusion cannot match, but the pass then has no
    // recovery path either, so the result still comes back whole.
    const unnamed = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      toolResult(readWindow(200), { toolName: undefined }),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    expect(narrowToolResults(unnamed).narrowed).toBe(0);
  });

  it("keeps working-set results whole and narrows the rest", () => {
    const messages = [
      toolCall("call-1", "Read", { file_path: "src/in-play.ts" }),
      toolResult(readWindow(200), { toolCallId: "call-1" }),
      toolCall("call-2", "Read", { file_path: "src/old.ts" }),
      toolResult(readWindow(200), { toolCallId: "call-2" }),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    const result = narrowToolResults(messages, {
      workingSetPaths: ["src/in-play.ts"],
    });

    expect(result.narrowed).toBe(1);
    expect(textAt(result.messages, 1)).toBe(readWindow(200));
    expect(textAt(result.messages, 3)).toContain("[tool result narrowed:");
  });

  it("works from the paths the batch's own calls named", () => {
    const messages = [
      toolCall("a", "Read", { file_path: "one.ts" }, "args"),
      toolCall("b", "Read", { path: "two.ts/" }),
      toolCall("c", "Edit", { filePath: "C:\\work\\three.ts" }),
    ];
    expect(workingSetPathsFrom(messages)).toEqual([
      "one.ts",
      "two.ts",
      "C:/work/three.ts",
    ]);
  });

  it("returns the original array when the saving misses clearAtLeastChars", () => {
    expect(TOOL_RESULT_TIER_CLEAR_AT_LEAST_CHARS).toBe(8_000);
    const messages = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      // Over minChars, but narrowing it saves less than the floor.
      toolResult(readWindow(25, 200)),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    const result = narrowToolResults(messages);

    expect(result.narrowed).toBe(0);
    expect(result.savedChars).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("reports the characters a pass saved, pointer included", () => {
    const messages = oldReadWithRecentTail();
    const before = textAt(messages, 1).length;
    const result = narrowToolResults(messages);

    expect(result.savedChars).toBeGreaterThanOrEqual(
      TOOL_RESULT_TIER_CLEAR_AT_LEAST_CHARS,
    );
    expect(result.savedChars).toBe(before - textAt(result.messages, 1).length);
  });

  it("is deterministic and idempotent", () => {
    const first = narrowToolResults(oldReadWithRecentTail());
    const second = narrowToolResults(oldReadWithRecentTail());
    expect(textAt(second.messages, 1)).toBe(textAt(first.messages, 1));

    // A second pass over an already-narrowed view is a no-op: the head is below
    // minChars, so nothing else moves.
    const again = narrowToolResults(first.messages);
    expect(again.narrowed).toBe(0);
  });

  it("returns the same array when there are no tool results at all", () => {
    const messages = [user("hi"), assistant("hello")];
    const result = narrowToolResults(messages);
    expect(result.messages).toBe(messages);
    expect(result.narrowed).toBe(0);
    expect(result.savedChars).toBe(0);
  });

  it("appends the pointer once, at the end, when content is a string", () => {
    const body = readWindow(200);
    const messages = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "Read",
        content: body,
        timestamp: 2,
      } as unknown as AgentMessage,
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    const result = narrowToolResults(messages);
    const narrowed = textAt(result.messages, 1);

    expect(narrowed.endsWith("]")).toBe(true);
    expect(narrowed.split("[tool result narrowed:").length - 1).toBe(1);
    expect(narrowed.startsWith(body.slice(0, 100))).toBe(true);
  });

  it("uses the documented defaults when no option is passed", () => {
    expect(TOOL_RESULT_TIER_MIN_CHARS).toBe(4_000);
    expect(TOOL_RESULT_TIER_HEAD_CHARS).toBe(1_200);
    expect(TOOL_RESULT_TIER_KEEP_RECENT).toBe(6);

    // A result just over the default minimum, with nothing keeping it: still a
    // no-op below the clear-at-least floor.
    const messages = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      toolResult(readWindow(25, 200)),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    expect(narrowToolResults(messages).narrowed).toBe(0);

    // The same shape, larger: it narrows, and only the oldest result moved.
    const large = [
      toolCall("call-1", "Read", { file_path: "src/app.ts" }),
      toolResult(readWindow(400, 200)),
      ...Array.from({ length: TOOL_RESULT_TIER_KEEP_RECENT }, () =>
        toolResult(big(50)),
      ),
    ];
    const result = narrowToolResults(large);
    expect(result.narrowed).toBe(1);
    for (let index = 2; index < large.length; index += 1) {
      expect(result.messages[index]).toBe(large[index]);
    }
  });
});
