import assert from "node:assert/strict";
import test from "node:test";
import { createReviewFeedback, reviewFeedbackAnchor, reviewFeedbackRange, reviewFeedbackLines, serializeReviewFeedback, feedbackBelongsTo } from "../src/lib/review-feedback.ts";
import { stageReviewFeedback, readReviewFeedback, clearReviewFeedback, pruneReviewFeedback } from "../src/features/chat/composer/review-feedback-drafts.ts";

const change = { snapshotId: "snapshot-a", messageId: "tool-a", path: "src/a.ts", hunks: [{
  header: "@@ -8,2 +8,3 @@", lines: [
    { type: "context", text: "try {" }, { type: "del", text: "old();" },
    { type: "add", text: "new();" }, { type: "add", text: "recover();" },
  ],
}] };
test.afterEach(() => pruneReviewFeedback([]));
test("mixed selections keep independent before/after coordinates and exact code", () => {
  assert.deepEqual(reviewFeedbackLines(change.hunks[0]).map(({oldLine,newLine}) => [oldLine,newLine]), [[8,8],[9,null],[null,9],[null,10]]);
  const feedback = createReviewFeedback(change,"a","/project",0,3,1,"Preserve recovery");
  assert.equal(feedback.lines.length,3);
  assert.deepEqual(reviewFeedbackRange(feedback.lines), {old:"9",new:"9–10"});
  assert.equal(feedback.lines[0].text,"old();");
  const content=serializeReviewFeedback("Please fix",feedback);
  assert.match(content,/historical evidence, not current file coordinates/);
  assert.deepEqual(JSON.parse(content.slice(content.indexOf('{'))),feedback);
});
test("unavailable, empty, invalid and over-budget selections cannot be attached", () => {
  for (const candidate of [{...change,binary:true},{...change,truncated:true}, {...change,hunks:[{header:'bad',lines:change.hunks[0].lines}]}]) assert.equal(createReviewFeedback(candidate,"a","/project",0,0,0,"Fix"),null);
  for (const [start,end,comment] of [[-1,0,'Fix'],[0,99,'Fix'],[0,0,' '],[0,0,'x'.repeat(4001)]]) assert.equal(createReviewFeedback(change,"a","/project",0,start,end,comment),null);
});
test("pending comment survives remount, cannot overwrite another, and never crosses owner", () => {
  const feedback=createReviewFeedback(change,"a","/project",0,0,1,"Fix");
  assert.equal(stageReviewFeedback(feedback),true);
  assert.equal(stageReviewFeedback({...feedback,comment:'replacement'}),false);
  assert.equal(readReviewFeedback("a","/project"),feedback);
  assert.equal(readReviewFeedback("b","/project"),undefined);
  assert.equal(readReviewFeedback("a","/other"),undefined);
  assert.equal(feedbackBelongsTo(feedback,"b","/project"),false);
  clearReviewFeedback("a");
  assert.equal(readReviewFeedback("a","/project"),undefined);
  assert.equal(stageReviewFeedback(feedback),true);
  pruneReviewFeedback(["b"]);
  assert.equal(readReviewFeedback("a","/project"),undefined);
});

test("a later file snapshot cannot mutate the quoted historical code", () => {
  const source = structuredClone(change);
  const feedback = createReviewFeedback(source,"a","/project",0,0,1,"Keep this");
  source.hunks[0].lines[1].text = "a later edit";
  assert.equal(feedback.lines[1].text,"old();");
  assert.match(serializeReviewFeedback("",feedback), /snapshot-a/);
});
test("oversized code and missing owners fail closed", () => {
  const source = structuredClone(change);
  source.hunks[0].lines[0].text = "x".repeat(16001);
  assert.equal(createReviewFeedback(source,"a","/project",0,0,0,"Fix"),null);
  assert.equal(createReviewFeedback(change,"","/project",0,0,0,"Fix"),null);
  assert.equal(createReviewFeedback(change,"a","",0,0,0,"Fix"),null);
});

test("inline comment anchors to its final historical line and exact snapshot", () => {
  const feedback = createReviewFeedback(change, "a", "/project", 0, 3, 1, "Keep recovery");
  assert.deepEqual(reviewFeedbackAnchor(change, feedback), { hunk: 0, line: 3 });
  assert.equal(reviewFeedbackAnchor({...change, snapshotId: "later"}, feedback), null);
  assert.equal(reviewFeedbackAnchor({...change, messageId: "other"}, feedback), null);
  const deleted = createReviewFeedback(change, "a", "/project", 0, 1, 1, "Keep deleted code");
  assert.deepEqual(reviewFeedbackAnchor(change, deleted), { hunk: 0, line: 1 });
});
