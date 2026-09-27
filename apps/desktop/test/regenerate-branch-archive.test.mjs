import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const agentEndBlock = () => {
  const main = read("../electron/main/index.ts");
  const start = main.indexOf('if (event.type === "agent_end")');
  assert.ok(start > 0, "agent_end branch exists");
  const end = main.indexOf('if (event.type === "message_end"', start);
  assert.ok(end > start, "agent_end branch is bounded by the next event branch");
  return main.slice(start, end);
};

test("turn completion archives the regenerate branch in one host call", () => {
  const block = agentEndBlock();

  // The archive must not read the transcript, decide, and write it back: the
  // final assistant message can land in between (ADR 0060).
  assert.doesNotMatch(block, /"session\.replaceMessages"/);
  assert.doesNotMatch(block, /"session\.get"/);
  assert.doesNotMatch(block, /"session\.saveRevision"/);
  assert.doesNotMatch(block, /"session\.listRevisions"/);
  assert.match(block, /"session\.saveActiveRevision"/);
});

test("the outbox is drained before a branch is archived", () => {
  const block = agentEndBlock();

  assert.match(block, /persistenceOutbox\.size\(\) > 0/);
  assert.match(block, /await persistenceOutbox\.flush\(\(\) => host\)/);
  // An archive that misses the final message is wrong forever once the pager
  // restores it, so a still-pending outbox skips the archive instead.
  assert.match(block, /skipped regenerate branch archive/);
});

test("the host owns the branch root search and the pager stamp", () => {
  const host = read("../../../crates/host-core/src/sessions.rs");
  const rpc = read("../../../crates/host-core/src/rpc/mod.rs");
  const transcripts = read("../../../crates/host-core/src/transcripts.rs");

  assert.match(rpc, /"session\.saveActiveRevision" => \{/);
  assert.match(host, /pub fn save_active_branch_revision\(/);
  // The stamp rewrites one line and re-reads the file, so a concurrent append
  // survives; a full rewrite from a stale snapshot would delete it.
  assert.match(host, /transcripts::update_message\(db\.data_dir\(\), session_id, &record\)/);
  assert.match(transcripts, /pub fn update_message\(/);
  assert.match(transcripts, /fs::read_to_string\(&path\)/);
});

test("a transcript rewrite keeps each message's owning turn", () => {
  const host = read("../../../crates/host-core/src/sessions.rs");

  assert.match(host, /SELECT id, turn_id FROM messages/);
  assert.match(host, /owning_turns\.get\(&record\.id\)\.map\(String::as_str\)/);
});
