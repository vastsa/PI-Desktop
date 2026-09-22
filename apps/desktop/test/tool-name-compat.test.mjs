import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_TOOL_NAMES,
  LEGACY_TOOL_NAME_ALIASES,
} from "@pi-desktop/shared";
import {
  canonicalToolName,
  getToolAction,
  getToolDisplayName,
  getToolPromptName,
} from "../src/lib/tool-display.ts";
import { reviewChangeFromMessage } from "../src/lib/workspace-review.ts";

// The rename moved the wire identity of every built-in tool to lowercase
// snake_case (`read`, `task_wait`, D621). The labels did not move with it:
// `read` and the legacy `Read` are one tool that a reader sees as `Read`, and
// `task_wait` / `TaskWait` both read as `Task Wait`. Stored transcripts,
// permission rules and user configuration keep the pre-rename spelling, so the
// legacy path has to stay alive at the read boundary. This file pins that
// decoupling — `tool-display.test.mjs` covers the canonical spelling alone.

/** A successful workspace edit as the host durably stores it (ReviewChange). */
function reviewedToolMessage(toolName) {
  return {
    id: "msg-1",
    role: "tool",
    toolName,
    toolStatus: "success",
    toolResult: {
      details: {
        path: "src/main.ts",
        root: "workspace",
        review: {
          version: 1,
          snapshotId: "snap-1",
          messageId: "msg-1",
          path: "src/main.ts",
          status: "modified",
          operation: "edit",
          state: "active",
          additions: 2,
          deletions: 1,
          hunks: [],
        },
      },
    },
  };
}

test("a legacy tool name is one tool with its canonical name", () => {
  const aliases = new Map(LEGACY_TOOL_NAME_ALIASES);
  // The presentation layer leans on this table: were it emptied, one tool would
  // show two different labels depending on which build wrote the transcript.
  assert.equal(aliases.get("Read"), "read");
  assert.equal(aliases.get("Write"), "write");
  assert.equal(aliases.get("Edit"), "edit");
  assert.equal(aliases.get("Bash"), "bash");
  assert.equal(aliases.get("Grep"), "grep");
  assert.equal(aliases.get("Glob"), "glob");
  assert.equal(aliases.get("Task"), "task");
  assert.equal(aliases.get("TaskWait"), "task_wait");
  assert.equal(aliases.get("TaskList"), "task_list");
  assert.equal(aliases.get("TaskStop"), "task_stop");
  assert.equal(aliases.get("Skill"), "skill");
  assert.equal(aliases.get("BrowserPreview"), "browser_preview");

  for (const [legacy, canonical] of LEGACY_TOOL_NAME_ALIASES) {
    assert.equal(canonicalToolName(legacy), canonical, `${legacy} canonical`);
    assert.equal(
      getToolAction(legacy),
      getToolAction(canonical),
      `${legacy} action`,
    );
    assert.equal(
      getToolDisplayName(legacy),
      getToolDisplayName(canonical),
      `${legacy} label`,
    );
  }

  // Normalizing a canonical name is the identity, and pure case variants of
  // ours are already the same tool.
  for (const canonical of CANONICAL_TOOL_NAMES) {
    assert.equal(canonicalToolName(canonical), canonical, `${canonical} is canonical`);
    assert.equal(getToolAction(canonical), getToolAction(canonical.toUpperCase()));
    assert.equal(
      getToolDisplayName(canonical),
      getToolDisplayName(canonical.toUpperCase()),
    );
  }
  assert.equal(getToolAction("READ"), getToolAction("read"));
  assert.equal(getToolDisplayName("rEaD"), "Read");
});

test("the label is what the reader sees, not the wire name", () => {
  assert.equal(getToolDisplayName("read"), "Read");
  assert.equal(getToolDisplayName("Read"), "Read");
  assert.equal(getToolDisplayName("write"), "Write");
  assert.equal(getToolDisplayName("Write"), "Write");
  assert.equal(getToolDisplayName("edit"), "Edit");
  assert.equal(getToolDisplayName("bash"), "Bash");
  assert.equal(getToolDisplayName("grep"), "Grep");
  assert.equal(getToolDisplayName("glob"), "Glob");
  assert.equal(getToolDisplayName("task"), "Task");
  assert.equal(getToolDisplayName("task_wait"), "Task Wait");
  assert.equal(getToolDisplayName("TaskWait"), "Task Wait");
  assert.equal(getToolDisplayName("task_list"), "Task List");
  assert.equal(getToolDisplayName("task_stop"), "Task Stop");
  assert.equal(getToolDisplayName("browser_preview"), "Browser Preview");
  // Delegation identity survived the rename: the start tool and its lifecycle
  // tools keep their own presentation.
  assert.equal(getToolAction("task"), "delegate");
  assert.equal(getToolAction("task_wait"), "delegate");
  assert.equal(getToolAction("TaskStop"), "delegate");
});

test("a name that is not ours is handed back unchanged", () => {
  for (const name of [
    "plugin_tasks_list",
    "plugin_issue_tracker_create",
    "mcp__srv__tool",
    "PowerShell",
    "exec_command",
  ]) {
    assert.equal(canonicalToolName(name), name, `${name} is not ours to rename`);
  }
  // A provider namespace is dropped; what is left is still not renamed.
  assert.equal(canonicalToolName("functions.exec_command"), "exec_command");
  assert.equal(canonicalToolName("functions.subagent"), "subagent");
  // The loose suffix matching that gives a borrowed verb a presentation is
  // unchanged, and a plugin tool that merely mentions tasks is not a delegate.
  assert.equal(getToolAction("plugin_tasks_list"), "list");
  assert.equal(getToolAction("CreateTask"), "use");
  assert.equal(getToolAction("functions.subagent"), "delegate");
});

test("a stored review change opens under either tool spelling", () => {
  for (const toolName of ["Write", "write", "Edit", "edit"]) {
    const change = reviewChangeFromMessage(reviewedToolMessage(toolName));
    assert.equal(change?.snapshotId, "snap-1", `${toolName} keeps its change`);
  }
  // Only the two writing tools own a review record, in either spelling.
  for (const toolName of ["Read", "read", "plugin_write"]) {
    assert.equal(reviewChangeFromMessage(reviewedToolMessage(toolName)), null);
  }
  // The record must still be a successful workspace edit.
  assert.equal(
    reviewChangeFromMessage({
      ...reviewedToolMessage("write"),
      role: "assistant",
    }),
    null,
  );
});

test("a prompt names our tool by its label and keeps a foreign name as reported", () => {
  assert.equal(getToolPromptName("read"), "Read");
  assert.equal(getToolPromptName("Read"), "Read");
  assert.equal(getToolPromptName("task_wait"), "Task Wait");
  assert.equal(getToolPromptName("TaskWait"), "Task Wait");
  assert.equal(getToolPromptName("browser_preview"), "Browser Preview");
  // Someone else's identity is passed through, including a namespaced one: the
  // user has to be able to see which tool is asking.
  assert.equal(getToolPromptName("plugin_tasks_list"), "plugin_tasks_list");
  assert.equal(getToolPromptName("mcp__srv__tool"), "mcp__srv__tool");
  assert.equal(getToolPromptName("PowerShell"), "PowerShell");
  assert.equal(getToolPromptName("functions.exec_command"), "functions.exec_command");
});
