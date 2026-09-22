# ADR 0300: The compaction boundary is reversible (recall over the transcript)

- Status: Accepted for implementation
- Date: 2026-09-21
- Deciders: PI-Desktop core
- Amends: ADR 0064 (extends its checkpoint contract with a readable boundary)
- Related: ADR 0030 (hard boundary), ADR 0049 (retained-tail recovery),
  ADR 0136 (active task boundary), ADR 0282 (summary retry and sizing),
  ADR 0299 (delegate context budget)

## Context

ADR 0064 makes a checkpoint final for the model: after compaction the model
context is the summary plus, at most, one retained user message, and every
other row stays only in the visible transcript. The runtime keeps a synchronous
copy of pi's session-context projection (`buildSessionContext`,
`packages/agent-runtime/src/session-context.ts:39`) which renders exactly that:
the newest checkpoint's summary, then the retained tail.

Two consequences followed from that design and neither was ever decided:

- The second budget reminder told the model the opposite of the truth once a
  summary existed. `contextFallbackReminder()` fired at 2,000 remaining tokens
  with "unsummarized detail will not be available afterwards" — a sentence about
  a one-way door, in a session whose transcript is complete on disk and whose
  checkpoint records the range it covers.
- A checkpoint's opaque `details` carried the summary and the retained tail, and
  nothing else. After restart, the only account of what a boundary covered was
  the summary text itself, so a model asked about a symbol, file or command that
  the summary compressed away had no read path and no way to know the data was
  still there.

The visible transcript has always been complete: compaction never rewrites a
message row (spec 16 §2, `aggregate checkpoint truncation never rewrites`). The
missing piece was a read path, not durability.

## Decision

1. **The model can read its own transcript back.** Two tools are registered in
   the **core** tool set: `recall` (`RECALL_TOOL_NAME`,
   `packages/agent-runtime/src/recall-tools.ts:31`) searches the session's
   complete transcript, and `recall_project` searches every session of the
   bound project. They are core rather than on-demand because a capability the
   model has to discover is one it will not reach for while recovering a detail
   a summary dropped.

2. **The host owns the read semantics.** Search splits the query into words and
   requires every word to appear; ranking is by how many query words matched and
   how often. Reads page one message by character offset
   (`read_message_text`, `crates/host-core/src/transcripts.rs:1660`), which is
   how a tool result — absent from the word index — is read back. Matching is
   literal on non-ASCII text: a CJK query matches the CJK string without ASCII
   folding. The tool descriptions state this rule instead of leaving the model
   to infer it, and an empty answer says what to try instead.

3. **Host reads back the state that the edge calls happened.** `recall_transcript`
   (`crates/host-core/src/transcripts.rs:1409`), `read_message_text`,
   `search_project_messages` (`crates/host-core/src/sessions.rs:3704`) and
   `read_project_messages` (`crates/host-core/src/sessions.rs:3888`) are exposed
   through five RPC methods — `session.recall`, `session.readMessage`,
   `search.query`, `session.readProject` and `session.appendSleep`
   (`crates/host-core/src/rpc/mod.rs:2274`–`:2397`). Project search resolves a
   session's project from the stored binding, so a session bound to another
   project reads as not found and session existence never leaks across projects.

4. **A `sleep` transcript line is a durable digest, not a message.**
   `SleepRecord` (`crates/host-core/src/transcripts.rs:98`) and `append_sleep`
   (`:717`) add one line kind. The layout scan ignores it and it never counts as
   a message, so a digest can be recorded without changing message counts,
   pagination or the transcript projection.

5. **A checkpoint carries a mechanical ledger of what it covers.** The record's
   opaque `details.ledger` (`packages/agent-runtime/src/runtime.ts:1006`,
   written by `buildLedger`, `:6436`) holds file names read and modified,
   commands, message and tool-call counts, the goal and the unresolved items.
   The projection renders it as a bounded block after the summary, so the next
   window keeps an account of the boundary that is one `recall` call away. A
   checkpoint written before the ledger existed projects the recall pointer and
   nothing else.

6. **The projection states the read path it actually has.** `RECALL_POINTER`
   (`packages/agent-runtime/src/session-context.ts:39`) names the tools and the
   fact that the complete transcript is readable. It is appended because the
   tools exist; the sentence and the mechanism are the same decision.

7. **One budget reminder.** The second reminder is removed rather than
   rephrased: its sentence is false here. The remaining reminder asks the model
   to write durable state down at `clamp(hardLimit * 0.15, 8k, 32k)`; the
   rollover and fallback wording names where the messages went and how to read
   them again instead of telling the model the transcript is available "to the
   user". The hard boundary always warns.

8. **A failed summary still describes its range.** When summary generation
   fails, both degraded layers build the checkpoint through one shared helper
   and describe the range they cover instead of persisting a notice with an
   empty tail. An empty tail can never be persisted for a completed turn: it
   would restore as an empty context after a runtime rebuild.

9. **Optional fields stay optional.** `tokensAfter` and the ledger live behind
   optional record fields (`packages/shared/src/types/sessions.ts`), and
   `contextCompactionMark` (`packages/shared/src/context-compaction.ts:47`)
   carries only what the renderer needs, so old checkpoints, old marks and old
   readers keep working without a migration.

## Consequences

- A model that lost a detail to a summary can ask for it again. The summary
  stops being the only surviving account of the compacted range.
- The core tool set grows by two tools, which costs prompt tokens for every
  session. The alternative — a discoverable tool — was rejected because the
  moment of need is exactly when a model is least likely to search for one.
- Recall reads are host-side file scans, not provider requests: reading a
  compacted-away message back is cheap compared with re-running the work.
- Word-AND search misses paraphrases. That is a real limit of the lexical
  channel and is stated in the tool description; a semantic channel was
  measured and deliberately not included.
- Removing the sharper reminder removes a warning. The remaining reminder and
  the hard boundary keep the pre-boundary warning path; only the sentence that
  was untrue is gone.
- The ledger is derived from the transcript at checkpoint time, so it describes
  what happened, not what the summary chose to mention. It is bounded text, so
  it cannot grow without limit.

## Not decided here / out of scope

- **Semantic or embedding recall.** Measured separately and frozen: it needs a
  model asset and a host channel for a gain the lexical channel already gets on
  the queries that matter here.
- **Recall across projects.** `recall_project` is scoped to the session's bound
  project; there is no cross-project search surface.
- **Transcript presentation.** No new row kind for a recall result; the answer
  reaches the model only. The `sleep` line is not rendered as a message.
- **Auto-summarizing recalled spans.** A recalled message is returned as text;
  the model decides what to keep.
- **Compaction of the recalled text.** Recall is a tool result and participates
  in the normal tool-result limits; there is no second compaction mechanism.

## References

- `docs/adr/0064-codex-parity-context-compaction.md`
- `docs/adr/0030-*`, `docs/adr/0049-*`, `docs/adr/0136-*`, `docs/adr/0282-*`
- `docs/spec/03-runtime/02-agent-runtime.md` §5.1
- `docs/spec/03-runtime/06-host-rpc-protocol.md` §4 Sessions
- `docs/spec/06-delivery/04-e2e-test-plan.md` — E2E-CONTEXT-recall-reads-a-compacted-away-message
