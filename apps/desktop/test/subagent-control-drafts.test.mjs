import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  clearSubagentControlDraft, prepareSubagentControlOperation, pruneSubagentControlDrafts,
  readSubagentControlDraft, restoreSubagentControlDrafts, snapshotSubagentControlDrafts,
  subscribeSubagentControlDrafts, writeSubagentControlDraft,
} from "../src/features/subagents/control-drafts.ts";

beforeEach(() => restoreSubagentControlDrafts([]));
const a = { sessionId: "session-a", delegationId: "chain-a" };

test("uncertain retries retain their operation and target until a real edit", () => {
  writeSubagentControlDraft(a, { text: "Change direction", agent: "fixer", model: "configured/model" });
  const first = prepareSubagentControlOperation(a, "attempt-a");
  assert.equal(prepareSubagentControlOperation(a, "attempt-b").operationId, first.operationId);
  assert.equal(prepareSubagentControlOperation(a, "attempt-b").operationDelegationId, "attempt-a");
  writeSubagentControlDraft(a, { text: "Change direction" });
  assert.equal(prepareSubagentControlOperation(a).operationId, first.operationId);
  writeSubagentControlDraft(a, { text: "New direction" });
  const next = prepareSubagentControlOperation(a, "attempt-b");
  assert.notEqual(next.operationId, first.operationId);
  assert.equal(next.operationDelegationId, "attempt-b");
});

test("acknowledging an older operation cannot erase a newer or another session's draft", () => {
  const b = { sessionId: "session-b", delegationId: "chain-a" };
  writeSubagentControlDraft(a, { text: "Submitted" });
  const submitted = prepareSubagentControlOperation(a);
  writeSubagentControlDraft(a, { text: "New edit" });
  writeSubagentControlDraft(b, { text: "Other session" });
  clearSubagentControlDraft(a, submitted.revision);
  assert.equal(readSubagentControlDraft(a).text, "New edit");
  assert.equal(readSubagentControlDraft(b).text, "Other session");
  clearSubagentControlDraft(a, readSubagentControlDraft(a).revision);
  assert.equal(readSubagentControlDraft(a).text, "");
  assert.equal(readSubagentControlDraft(b).text, "Other session");
});

test("explicit refresh checkpoints retain drafts and dedup identities without executing", () => {
  const creation = { sessionId: "session-a" };
  writeSubagentControlDraft(creation, { text: "Create", agent: "explorer", model: "configured/model" });
  writeSubagentControlDraft(a, { text: "Follow up" });
  const pending = prepareSubagentControlOperation(a, "attempt-a");
  const checkpoint = snapshotSubagentControlDrafts();
  assert.equal(checkpoint.length, 2);
  assert.ok(checkpoint.every((entry) => !("revision" in entry) && !("credentials" in entry) && !("tools" in entry)));
  restoreSubagentControlDrafts(JSON.parse(JSON.stringify(checkpoint)));
  assert.equal(readSubagentControlDraft(creation).model, "configured/model");
  assert.equal(readSubagentControlDraft(a).text, "Follow up");
  assert.equal(prepareSubagentControlOperation(a, "attempt-b").operationId, pending.operationId);
  assert.equal(readSubagentControlDraft(a).operationDelegationId, "attempt-a");
  assert.notEqual(readSubagentControlDraft(a).revision, pending.revision);
});

test("deleted-session pruning and disposed subscriptions have no lingering effects", () => {
  let changes = 0;
  const off = subscribeSubagentControlDrafts(() => changes++);
  writeSubagentControlDraft(a, { text: "Keep" });
  writeSubagentControlDraft({ sessionId: "deleted" }, { text: "Drop" });
  off();
  const observed = changes;
  pruneSubagentControlDrafts(["session-a"]);
  assert.equal(changes, observed);
  assert.equal(snapshotSubagentControlDrafts().length, 1);
  assert.equal(readSubagentControlDraft(a).text, "Keep");
});
