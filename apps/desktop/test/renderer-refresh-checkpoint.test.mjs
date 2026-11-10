import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { parseRendererRefreshCheckpoint, MAX_REFRESH_CHECKPOINT_BYTES } = await import("../src/features/app/renderer-refresh-checkpoint.ts");
const base = () => ({ version: 1, page: "chat", sessionId: "session-a",
  composerDrafts: [{ key: "session-a", draft: { text: "UNSENT", fileReferences: [
    { path: "attachments/fixture", name: "Fixture", kind: "image", mimeType: "image/png", token: "[image]",
      plugin: { kind: "attachment", pluginId: "fixture-plugin", id: "fixture-attachment", size: 5 } },
  ] }, workspacePath: "fixture-project" }],
  subagentDrafts: [{ sessionId: "session-a", delegationId: "delegate-a", text: "DIRECTION", agent: "explorer",
    model: "fixture-provider:model", operationId: "operation-a", operationDelegationId: "delegate-a" }],
  panels: [{ sessionId: "session-a", context: { open: true, tabs: [
    { id: "subagents", kind: "subagents" }, { id: "file-fixture", kind: "file", resource: "src/fixture.ts", line: 4, column: 2 },
  ], activeTabId: "file-fixture", fileRequest: { path: "FORGED-PATH", seq: 900 } } }],
});
test("a versioned checkpoint retains drafts, attachment ownership, dedup identity and panel positions", () => {
  const saved = base();
  const restored = parseRendererRefreshCheckpoint(JSON.stringify(saved));
  assert.deepEqual(restored.composerDrafts, saved.composerDrafts);
  assert.deepEqual(restored.subagentDrafts, saved.subagentDrafts);
  assert.equal(restored.panels[0].context.activeTabId, "file-fixture");
  assert.deepEqual(restored.panels[0].context.fileRequest, { path: "src/fixture.ts", seq: 1, line: 4, column: 2 });
});
test("unknown fields never become credentials, messages, runtime state or commands", () => {
  const saved = { ...base(), credentials: "SECRET-SENTINEL", messages: [{ role: "user", content: "RUN" }],
    commands: [{ action: "start", task: "RUN" }], runningSessions: { "session-a": true } };
  saved.subagentDrafts[0].permissions = ["all"];
  saved.panels[0].context.tabs[0].credentials = "SECRET-SENTINEL";
  const raw = JSON.stringify(parseRendererRefreshCheckpoint(JSON.stringify(saved)));
  assert.doesNotMatch(raw, /SECRET-SENTINEL|permissions|commands|runningSessions|messages/);
});
test("invalid, oversized and foreign-version checkpoints fail instead of truncating drafts", () => {
  for (const change of [
    (value) => { value.version = 2; },
    (value) => { value.composerDrafts[0].draft.fileReferences[0].plugin.size = -1; },
    (value) => { value.subagentDrafts[0].operationId = "bad operation"; },
    (value) => { value.panels[0].context.tabs[0].kind = "execute"; },
  ]) { const value = base(); change(value); assert.throws(() => parseRendererRefreshCheckpoint(JSON.stringify(value))); }
  assert.throws(() => parseRendererRefreshCheckpoint("not JSON"));
  const value = base(); value.composerDrafts[0].draft.text = "x".repeat(MAX_REFRESH_CHECKPOINT_BYTES);
  assert.throws(() => parseRendererRefreshCheckpoint(JSON.stringify(value)), /too large/);
});
