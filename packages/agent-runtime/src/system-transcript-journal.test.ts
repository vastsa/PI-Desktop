import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageEntry, CompactionEntry } from "./pi-runtime-types.js";
import type { UiMessage } from "@pi-desktop/shared";
import { getCurrentSystemPrompt, getCurrentTools, type SystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { orderSystemRows, readSystemMessage, SystemTranscriptJournal } from "./system-transcript-journal.js";
import { buildSessionContext } from "./session-context.js";
import { CONTEXT_BUDGET_SECTION, syncSystemSections, systemTranscriptCheckpoint } from "./system-transcript.js";
import { GOAL_PAUSE_NOTICE } from "./goals/goal-pause.js";

const tool = { name: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }) };
const initial: SystemMessage = { role: "system", content: "", sections: { runtime: "Instructions", skills: "First skill" }, toolsAdded: [tool], timestamp: 1 };
const user: AgentMessage = { role: "user", content: "Find files", timestamp: 2 };
function entry(message: AgentMessage, id = "user"): MessageEntry {
  return { type: "message", id, seq: 0, parentId: null, timestamp: message.timestamp, message };
}
const userRow: UiMessage = { id: "user", role: "user", content: "Find files", createdAt: new Date(2).toISOString() };

describe("model system journal", () => {
  it("restores the original order even when a user row was pre-persisted", async () => {
    const journal = new SystemTranscriptJournal();
    const rows = [userRow];
    const entries = [entry(user)];
    const delta: SystemMessage = { role: "system", content: "", toolsRemoved: [{ name: "Read" }], timestamp: 3 };
    await journal.persist([initial, user, delta], entries, async (row) => { rows.push(row); });
    expect(rows.map((row) => row.role)).toEqual(["user", "system", "system"]);
    const restored = new SystemTranscriptJournal();
    const messages = orderSystemRows(rows).map((row) => row.modelSystem ? restored.restore(row) : user);
    expect(messages).toEqual([initial, user, delta]);
    expect(getCurrentTools(messages)).toEqual([]);
    const append = vi.fn();
    await restored.persist(messages, entries, append);
    expect(append).not.toHaveBeenCalled();
  });

  it("retries failed persistence with the same id and never installs it before acknowledgement", async () => {
    const journal = new SystemTranscriptJournal();
    const entries = [entry(user)];
    const rows: UiMessage[] = [];
    await expect(journal.persist([initial, user], entries, async (row) => {
      rows.push(row); throw new Error("disk full");
    })).rejects.toMatchObject({ code: "LOCAL_REQUEST_ERROR", cause: new Error("disk full") });
    expect(entries).toHaveLength(1);
    await journal.persist([initial, user], entries, async (row) => { rows.push(row); });
    expect(rows[0].id).toBe(rows[1].id);
    expect(entries.map((item) => item.message.role)).toEqual(["system", "user"]);
  });

  it("does not persist a cloned system event twice, but keeps the same payload at a new timestamp", async () => {
    const journal = new SystemTranscriptJournal();
    const entries: MessageEntry[] = [];
    const rows: UiMessage[] = [];
    const append = async (row: UiMessage) => { rows.push(row); };

    await journal.persist([initial], entries, append);
    await journal.persist(structuredClone([initial]), entries, append);
    await journal.persist([{ ...initial, timestamp: initial.timestamp + 1 }], entries, append);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => readSystemMessage(row.modelSystem?.messageJson))).toEqual([
      initial,
      { ...initial, timestamp: initial.timestamp + 1 },
    ]);
    expect(entries).toHaveLength(2);
  });

  it("collapses exact duplicate system rows during replay without dropping distinct events", () => {
    const duplicate = { ...userRow, id: "system-duplicate", role: "system" as const, modelSystem: {
      version: 1 as const, messageJson: JSON.stringify(initial), beforeMessageId: userRow.id,
    } };
    const distinct = { ...duplicate, id: "system-distinct", modelSystem: {
      ...duplicate.modelSystem,
      messageJson: JSON.stringify({ ...initial, timestamp: initial.timestamp + 1 }),
    } };

    const replay = orderSystemRows([duplicate, { ...duplicate, id: "system-copy" }, distinct, userRow]);
    expect(replay.filter((row) => row.modelSystem)).toHaveLength(2);
    expect(replay.map((row) => row.id)).toContain("system-duplicate");
    expect(replay.map((row) => row.id)).toContain("system-distinct");
  });

  it("recognizes a reconstructed system event after restoring or remembering it", () => {
    const restored = new SystemTranscriptJournal();
    restored.restore({ ...userRow, id: "saved-system", role: "system", modelSystem: {
      version: 1, messageJson: JSON.stringify(initial),
    } });
    expect(restored.isPersisted(structuredClone(initial))).toBe(true);

    const remembered = new SystemTranscriptJournal();
    remembered.remember(initial, "checkpoint-system");
    expect(remembered.isPersisted(structuredClone(initial))).toBe(true);
  });

  it("replaces skill sections without rewriting the old prefix", () => {
    const original = [initial, user];
    const changed = syncSystemSections(original, { runtime: "Instructions", skills: "Second skill" });
    expect(changed.slice(0, 2)).toEqual(original);
    expect(changed.at(-1)).toMatchObject({ sections: { skills: "Second skill" } });
    expect(syncSystemSections(changed, { runtime: "Instructions", skills: "Second skill" })).toBe(changed);
    expect(syncSystemSections(changed, { runtime: "Instructions", skills: "" }).at(-1)).toMatchObject({ sections: { skills: "" } });
  });

  it("restores a compaction checkpoint once before the retained tail", async () => {
    const delta: SystemMessage = { role: "system", content: "", toolsRemoved: [{ name: "Read" }], timestamp: 3 };
    const systemMessage = systemTranscriptCheckpoint([initial, user, delta])!;
    const compaction: CompactionEntry = {
      type: "compaction", id: "cp", seq: 1, parentId: "user", timestamp: 4,
      summary: "Past work", tokensBefore: 100, retainedTail: [initial, user, delta],
      details: { systemMessageJson: JSON.stringify(systemMessage) }, fromHook: false,
    };
    const messages = buildSessionContext([entry(user), compaction]).messages;
    expect(messages.filter((message) => message.role === "system")).toEqual([systemMessage]);
    expect(messages[0]).toEqual(systemMessage);
    expect(getCurrentTools(messages)).toEqual([]);
    const journal = new SystemTranscriptJournal();
    journal.rememberCheckpoint(systemMessage);
    const append = vi.fn();
    await journal.persist(JSON.parse(JSON.stringify(messages)), [], append);
    expect(append).not.toHaveBeenCalled();
  });

  it("expires budget reminders at compaction without dropping active instructions or tools", () => {
    const checkpoint = systemTranscriptCheckpoint([initial, user, {
      role: "system", content: "", sections: { [CONTEXT_BUDGET_SECTION]: "Old window is nearly full" }, timestamp: 3,
    }]);
    expect(checkpoint?.sections).toEqual(initial.sections);
    expect(checkpoint?.toolsAdded).toEqual(initial.toolsAdded);
  });

  it("recognizes a restored checkpoint with text blocks without adding durable rows", async () => {
    const blocks: SystemMessage = { ...initial, content: [{ type: "text", text: "Extension instructions" }] };
    const checkpoint = systemTranscriptCheckpoint([blocks, user])!;
    const journal = new SystemTranscriptJournal();
    journal.rememberCheckpoint(JSON.stringify(checkpoint));
    const append = vi.fn();
    await journal.persist(JSON.parse(JSON.stringify([checkpoint, user])), [], append);
    expect(append).not.toHaveBeenCalled();
  });

  it("expires the owned pause section when active state is recomposed and at checkpoints", () => {
    const paused: SystemMessage = { role: "system", content: "", sections: { goal_pause: GOAL_PAUSE_NOTICE }, timestamp: 3 };
    const messages = [initial, user, paused];
    expect(getCurrentSystemPrompt(messages)).toContain(GOAL_PAUSE_NOTICE);
    expect(getCurrentSystemPrompt(syncSystemSections(messages, initial.sections as Record<string, string>))).not.toContain(GOAL_PAUSE_NOTICE);
    expect(JSON.stringify(systemTranscriptCheckpoint(messages))).not.toContain(GOAL_PAUSE_NOTICE);
  });

  it("reads legacy pause history without replaying its control or rewriting the saved row", async () => {
    const saved: UiMessage = { id: "legacy-pause", role: "system", content: "", createdAt: new Date(3).toISOString(),
      modelSystem: { version: 1, messageJson: JSON.stringify({ role: "system", content: GOAL_PAUSE_NOTICE, timestamp: 3 }) } };
    const before = JSON.stringify(saved);
    const journal = new SystemTranscriptJournal();
    const restored = journal.restore(saved);
    expect(getCurrentSystemPrompt([initial, restored])).not.toContain(GOAL_PAUSE_NOTICE);
    expect(JSON.stringify(saved)).toBe(before);
    const append = vi.fn(); await journal.persist([restored], [], append);
    expect(append).not.toHaveBeenCalled();
  });

  it.each([true, false])("expires legacy checkpoint controls with folded state=%s while preserving instructions and tools", (folded) => {
    const legacy = { ...initial, content: `Keep real hardware offline.\n\n${GOAL_PAUSE_NOTICE}\n\nExtension instructions remain.` };
    const cp: CompactionEntry = { type: "compaction", id: "cp", seq: 1, parentId: null, timestamp: 4,
      summary: "Past work", tokensBefore: 100, retainedTail: folded ? [] : [legacy],
      ...(folded ? { details: { systemMessageJson: JSON.stringify(legacy) } } : {}), fromHook: false };
    const messages = buildSessionContext([cp]).messages;
    const prompt = getCurrentSystemPrompt(messages);
    expect(prompt).not.toContain(GOAL_PAUSE_NOTICE);
    expect(prompt).toContain("Keep real hardware offline.");
    expect(prompt).toContain("Extension instructions remain.");
    expect(getCurrentTools(messages).map(item => item.name)).toEqual(["Read"]);
    expect(JSON.stringify(cp)).toContain(GOAL_PAUSE_NOTICE);
  });

  it("preserves quoted pause text and user safety constraints", () => {
    const quoted = { ...initial, content: `The user quoted: ${GOAL_PAUSE_NOTICE}` };
    expect(readSystemMessage(JSON.stringify(quoted)).content).toBe(quoted.content);
    const message: AgentMessage = { role: "user", content: GOAL_PAUSE_NOTICE, timestamp: 3 };
    expect(buildSessionContext([entry(message)]).messages).toEqual([message]);
  });

  it.each([null, {}, { ...initial, timestamp: -1 }, { ...initial, toolsAdded: [{ name: "Read", parameters: "bad" }] }])("rejects malformed saved state", (value) => {
    expect(() => readSystemMessage(value)).toThrow("Invalid persisted model system message");
  });
});
