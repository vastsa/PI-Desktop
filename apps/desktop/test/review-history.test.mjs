import assert from "node:assert/strict";
import test from "node:test";
import { reviewLineNumber, numberedReviewHunks, groupReviewFiles, readReviewPages, reviewFilePathLabel } from "../src/lib/review-history.ts";

function entry(id, path = "a.ts", root) {
  return { root, message: { id, role: "tool", content: "", createdAt: "2026-10-30", toolName: "Edit", toolStatus: "success", toolResult: { details: { root: "workspace", review: { version: 1, snapshotId: id, messageId: id, path, operation: "edit", status: "modified", state: "active", additions: 1, deletions: 1, hunks: [], reversible: true } } } } };
}
test("groups only the same execution root and path, deduplicating snapshots", () => {
  const a = entry("one", "src/a.ts", "D:/main"), b = entry("two", "src/a.ts", "D:/main");
  b.message.parentToolCallId = "task";
  const groups = groupReviewFiles([a, b, a, entry("child", "src/a.ts", "D:/delegate"), entry("other", "b.ts", "D:/main")]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].entries.map(e => e.change.snapshotId), ["one", "two"]);
  assert.equal(groups[0].additions, 2);
  assert.equal(groups[1].root, "D:/delegate");
});
test("unknown legacy delegate roots are never merged with the parent", () => {
  const child = entry("child"); child.message.parentToolCallId = "task";
  assert.equal(groupReviewFiles([entry("main"), child]).length, 2);
});
test("numbers additions, deletions, context, empty ranges, separate hunks and EOF markers", () => {
  const hunks = numberedReviewHunks([
    { header: "@@ -0,0 +1,2 @@", lines: [{ type: "add", text: "a" }, { type: "add", text: "b" }] },
    { header: "@@ -10,3 +12,2 @@", lines: [{ type: "context", text: "x" }, { type: "del", text: "old" }, { type: "del", text: "last" }, { type: "add", text: "new" }] },
    { header: "@@ -20 +21 @@", lines: [{ type: "del", text: "a" }, { type: "context", text: "\\ No newline at end of file" }, { type: "add", text: "b" }] },
  ]);
  assert.deepEqual(hunks[0].lines.map(l => [l.oldLine, l.newLine]), [[null, 1], [null, 2]]);
  assert.deepEqual(hunks[1].lines.map(l => [l.oldLine, l.newLine]), [[10, 12], [11, null], [12, null], [null, 13]]);
  assert.deepEqual(hunks[2].lines.map(l => [l.oldLine, l.newLine]), [[20, null], [null, null], [null, 21]]);
});
test("invalid headers do not fabricate line numbers", () => {
  assert.deepEqual(numberedReviewHunks([{ header: "unknown", lines: [{ type: "add", text: "a" }] }])[0].lines[0], { type: "add", text: "a", oldLine: null, newLine: null });
});
test("reads every history page using resolved turn identity, without touching chat state", async () => {
  const calls = [];
  const page = await readReviewPages(async input => {
    calls.push(input);
    return input.offset ? { turnId: "user1", changes: [entry("two") ] } : { turnId: "user1", changes: [entry("one")], nextOffset: 1 };
  }, { sessionId: "session", snapshotId: "one" }, () => true);
  assert.equal(page.changes.length, 2);
  assert.equal(calls[1].turnId, "user1");
  assert.equal(calls[1].snapshotId, undefined);
});
test("switching session cancels pagination and repeated cursors are errors", async () => {
  let active = true;
  await assert.rejects(readReviewPages(async () => { active = false; return { turnId: "u", changes: [], nextOffset: 1 }; }, { sessionId: "s" }, () => active), { name: "AbortError" });
  await assert.rejects(readReviewPages(async () => ({ turnId: "u", changes: [], nextOffset: 0 }), { sessionId: "s" }, () => true), /cursor/i);
});
test("outside-workspace path labels keep only three dots, slash and basename", () => {
  for (const path of ["/tmp/deep/review-open-tests-source.mjs", "D:/tmp/review-open-tests-source.mjs", "D:\\tmp\\review-open-tests-source.mjs", "\\\\server\\share\\review-open-tests-source.mjs", "../other/review-open-tests-source.mjs", "src/../../review-open-tests-source.mjs"]) {
    assert.equal(reviewFilePathLabel(path), ".../review-open-tests-source.mjs");
  }
  assert.equal(reviewFilePathLabel("src/local.ts"), "src/local.ts");
  assert.equal(reviewFilePathLabel("src/../local.ts"), "src/../local.ts");
});

test("one inline gutter uses old numbers only for deletions, new numbers otherwise", () => {
  const [hunk] = numberedReviewHunks([{ header: "@@ -8,2 +12,2 @@", lines: [{ type: "del", text: "old" }, { type: "add", text: "new" }, { type: "context", text: "same" }, { type: "context", text: "\\ No newline at end of file" }] }]);
  assert.deepEqual(hunk.lines.map(reviewLineNumber), [8, 12, 13, null]);
});

test("ten operation records across eight paths remain eight visible files", () => {
  const rows = Array.from({length:8}, (_, i) => entry(String(i), `file-${i}.ts`, '/project'));
  rows.push(entry('extra-one', 'file-0.ts', '/project'), entry('extra-two', 'file-1.ts', '/project'));
  const files = groupReviewFiles(rows);
  assert.equal(files.length, 8);
  assert.equal(files.reduce((total, file) => total + file.entries.length, 0), 10);
});

test("zero-counter files are excluded while either positive counter keeps the file visible", () => {
  const values = [[0, 0], [3, 0], [0, 4], [2, 5]];
  const rows = values.map(([additions, deletions], i) => {
    const row = entry(String(i), `file-${i}.ts`, '/project');
    Object.assign(row.message.toolResult.details.review, { additions, deletions });
    return row;
  });
  const files = groupReviewFiles(rows);
  assert.deepEqual(files.map(file => file.path), ['file-1.ts', 'file-2.ts', 'file-3.ts']);
  assert.deepEqual(groupReviewFiles([rows[0]]), []);
  assert.equal(rows.length, 4);
});

test("zero-counter operations remain in a visible file's complete operation chain", () => {
  const first = entry('zero', 'same.ts', '/project');
  Object.assign(first.message.toolResult.details.review, { additions: 0, deletions: 0 });
  const second = entry('positive', 'same.ts', '/project');
  const files = groupReviewFiles([first, second]);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].entries.map(row => row.change.snapshotId), ['zero', 'positive']);
  assert.deepEqual([files[0].additions, files[0].deletions], [1, 1]);
});
