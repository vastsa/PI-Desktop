import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { prepareCompaction } from "./pi-runtime-compaction-plan.js";
import type { Entry } from "./pi-runtime-types.js";
import { describe, expect, it } from "vitest";

import { withPiFileOpToolNames } from "./pi-file-ops.js";

function toolCallWithArguments(
  name: string,
  args: Record<string, unknown>,
  id = "call-1",
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
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
    stopReason: "toolUse",
    timestamp: 2,
  } as AgentMessage;
}

function toolCallMessage(name: string, path: string, id = "call-1"): AgentMessage {
  return toolCallWithArguments(name, { path }, id);
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function messageEntry(id: string, message: AgentMessage, second: number): Entry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-09-22T00:00:0${second}.000Z`,
    message,
  } as unknown as Entry;
}

/** The name of the first content block, whatever the entry actually holds. */
function nameOf(entry: Entry): unknown {
  const message = (entry as { message?: { content?: Array<{ name?: unknown }> } }).message;
  return message?.content?.[0]?.name;
}

function toolCallNames(messages: AgentMessage[]): Array<string | undefined> {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      (message.content as Array<{ type: string; name?: string }>)
        .filter((block) => block.type === "toolCall")
        .map((block) => block.name),
    );
}

/** Small enough that the history ends up in `messagesToSummarize`. */
const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 };

function preparationOf(entries: Entry[], converted: boolean) {
  const prepared = converted
    ? prepareCompaction(withPiFileOpToolNames(entries), settings)
    : prepareCompaction(entries, settings);
  if (!prepared.ok) throw new Error("prepareCompaction refused the fixture");
  return prepared.value;
}

describe("withPiFileOpToolNames", () => {
  it("spells the tool calls pi's file-op collector reads the way pi spells them", () => {
    const entries = [
      messageEntry("a1", toolCallMessage("Read", "src/a.txt"), 1),
      messageEntry("a2", toolCallMessage("Write", "src/b.txt", "call-2"), 2),
      messageEntry("a3", toolCallMessage("Edit", "src/c.txt", "call-3"), 3),
    ];

    const mapped = withPiFileOpToolNames(entries);

    expect(mapped.map(nameOf)).toEqual(["read", "write", "edit"]);
  });

  it("leaves every other tool name untouched", () => {
    const entries = [
      messageEntry("a1", toolCallMessage("Grep", "src/a.txt"), 1),
      messageEntry("a2", toolCallMessage("Bash", "src/b.txt", "call-2"), 2),
      messageEntry("a3", toolCallMessage("plugin_x_tool", "src/c.txt", "call-3"), 3),
    ];

    // Nothing needed converting, so the array comes back as it was handed in.
    expect(withPiFileOpToolNames(entries)).toBe(entries);
    expect(entries.map(nameOf)).toEqual(["Grep", "Bash", "plugin_x_tool"]);
  });

  it("copies instead of mutating what it is handed", () => {
    const entries = [messageEntry("a1", toolCallMessage("Read", "src/a.txt"), 1)];

    const mapped = withPiFileOpToolNames(entries);

    expect(mapped).not.toBe(entries);
    expect(mapped[0]).not.toBe(entries[0]);
    // The stored history keeps our spelling.
    expect(nameOf(entries[0])).toBe("Read");
  });

  it("survives entries without a message and messages without content blocks", () => {
    const entries = [
      { type: "compaction", id: "c1", timestamp: "2026-09-22T00:00:01.000Z" } as unknown as Entry,
      messageEntry("a1", { role: "assistant", content: [] } as unknown as AgentMessage, 2),
      messageEntry("a2", { role: "toolResult", toolCallId: "call-1" } as unknown as AgentMessage, 3),
    ];

    expect(withPiFileOpToolNames(entries)).toBe(entries);
  });
});

describe("pi's file-op collection through the adapter", () => {
  const entries = [
    messageEntry("u1", userMessage("read src/a.txt and then edit src/a.ts", 1), 1),
    messageEntry("a1", toolCallMessage("Read", "src/a.txt"), 2),
    messageEntry("a2", toolCallMessage("Edit", "src/a.ts", "call-2"), 3),
    messageEntry("u2", userMessage("latest question", 4), 4),
  ];

  it("collects the files a checkpoint used to report as empty", () => {
    const preparation = preparationOf(entries, true);

    expect(preparation).toBeDefined();
    expect([...preparation!.fileOps.read]).toEqual(["src/a.txt"]);
    expect([...preparation!.fileOps.edited]).toEqual(["src/a.ts"]);
  });

  it("collects nothing from the same history without the adapter", () => {
    // The regression this adapter exists for: pi's collector switches on
    // `read` / `write` / `edit`, so our capitalized names matched nothing.
    const preparation = preparationOf(entries, false);

    expect(preparation).toBeDefined();
    expect(preparation!.fileOps.read.size).toBe(0);
    expect(preparation!.fileOps.edited.size).toBe(0);
    expect(preparation!.fileOps.written.size).toBe(0);
  });

  it("names the summarized tool calls the way pi reads them", () => {
    const preparation = preparationOf(entries, true);

    expect(toolCallNames(preparation!.messagesToSummarize)).toEqual(["read", "edit"]);
  });

  it("records Read, Write, and Edit paths sent under argument aliases", () => {
    // Models keep the spelling they sent. Strong models send `file_path`;
    // weaker ones send `filepath` / `file` (D273 / issue #454). The stored
    // tool call is not folded, so the checkpoint collector has to read them.
    const entries = [
      messageEntry("u1", userMessage("touch the files", 1), 1),
      messageEntry("a1", toolCallWithArguments("Read", { file_path: "src/a.txt" }), 2),
      messageEntry("a2", toolCallWithArguments("Edit", { filepath: "src/b.ts" }, "call-2"), 3),
      messageEntry("a3", toolCallWithArguments("Write", { file: "src/c.ts" }, "call-3"), 4),
      messageEntry("u2", userMessage("latest question", 5), 5),
    ];

    const preparation = preparationOf(entries, true);

    expect(preparation).toBeDefined();
    expect([...preparation!.fileOps.read]).toEqual(["src/a.txt"]);
    expect([...preparation!.fileOps.edited]).toEqual(["src/b.ts"]);
    expect([...preparation!.fileOps.written]).toEqual(["src/c.ts"]);
  });

  it("uses the key the call ran with: path first, then aliases in normalizeToolParams order", () => {
    const entries = [
      messageEntry("u1", userMessage("touch the files", 1), 1),
      messageEntry(
        "a1",
        toolCallWithArguments("Read", {
          file: "from-file",
          fileName: "from-fileName",
          filename: "from-filename",
          filepath: "from-filepath",
          filePath: "from-filePath",
          file_path: "from-file_path",
          path: "src/canonical.txt",
        }),
        2,
      ),
      messageEntry(
        "a2",
        toolCallWithArguments("Write", {
          path: "",
          file_path: "src/not-used.ts",
          file: "src/ignored.ts",
        }, "call-2"),
        3,
      ),
      messageEntry(
        "a3",
        toolCallWithArguments("Edit", {
          filepath: "src/lower.ts",
          filePath: "src/camel.ts",
        }, "call-3"),
        4,
      ),
      messageEntry(
        "a4",
        toolCallWithArguments("Read", {
          filename: "src/name.ts",
          fileName: "src/nameCamel.ts",
          file: "src/bare.ts",
        }, "call-4"),
        5,
      ),
      messageEntry(
        "a5",
        toolCallWithArguments("Read", {
          fileName: "src/only-fileName.ts",
          file: "src/bare.ts",
        }, "call-5"),
        6,
      ),
      messageEntry("a6", toolCallWithArguments("Read", { file: "src/only-file.ts" }, "call-6"), 7),
      messageEntry(
        "a7",
        toolCallWithArguments("Write", { path: "", file_path: "", file: 12 }, "call-7"),
        8,
      ),
      messageEntry("u2", userMessage("latest question", 9), 9),
    ];

    const preparation = preparationOf(entries, true);

    expect(preparation).toBeDefined();
    expect([...preparation!.fileOps.read]).toEqual([
      "src/canonical.txt",
      "src/name.ts",
      "src/only-fileName.ts",
      "src/only-file.ts",
    ]);
    // `path: ""` wins over `file_path` at execution too, so nothing was written.
    expect([...preparation!.fileOps.written]).toEqual([]);
    expect([...preparation!.fileOps.edited]).toEqual(["src/lower.ts"]);
  });
});
