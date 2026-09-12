# ADR 0087: Replace textual Edit matching with a line-anchored, tag-verified contract

- Status: Implemented (phases 1–2; block ops, drift recovery, and boundary repair remain phased)
- Date: 2026-08-15
- Deciders: PI-Desktop core
- Amends: D186, ADR 0069 §2 (`Read` output shape), ADR 0043 §1 (review keying)
- Supersedes: the `old_string` / `new_string` `Edit` contract in
  [03-tools-and-permissions §4d](../spec/03-runtime/03-tools-and-permissions.md)
- Related: [18-line-anchored-edit-contract](../spec/03-runtime/18-line-anchored-edit-contract.md) ·
  [02-agent-runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [16-tool-result-limits](../spec/03-runtime/16-tool-result-limits.md) ·
  [08-error-codes](../spec/03-runtime/08-error-codes.md) ·
  E2E-130 … E2E-139

## Context

`Edit` currently takes `old_string` / `new_string` and requires `old_string` to
match exactly one location in the file
(`crates/host-core/src/tools/mod.rs:1278`). `Read` deliberately returns
line-number-free bytes so that text copied out of its `content` still matches
(`crates/host-core/src/tools/mod.rs:1225`). Three failure modes follow from that
contract and none of them are fixable inside it:

1. **The model must retype existing code.** Every edit's correctness depends on
   reproducing bytes it saw earlier. One wrong space fails the call; the
   observed consequence is a re-read plus a regenerated edit, which §4d already
   codifies as the expected recovery path and caps at two attempts.
2. **Ambiguity is the model's problem to solve.** A duplicated fragment forces
   the model to widen `old_string` until it is unique, which increases the
   retyped surface and therefore the chance of retyping it wrong.
3. **Nothing proves the model read what it is editing.** A unique match on a
   remembered fragment succeeds even when the model never displayed that region
   in this session, and even when the file changed after the read that informed
   the edit. This is the failure class that silently produces plausible, wrong
   edits, and the current contract cannot detect it at all.

`Grep` already returns `{path, line, text}`; line numbers exist on the search
path but the edit path cannot consume them.

`oh-my-pi`'s `hashline` package solves exactly this by inverting what the model
supplies: the model reports **positions** (line numbers and gaps) plus **new
content only**, and the tool supplies the proof of version and provenance. The
anchor is a 4-hex fingerprint of the whole normalized file carried in a section
header (`[path#TAG]`), minted by whichever tool displayed the content.

## Decision

### 1. `Edit` becomes a line-anchored patch tool

`Edit` takes `path`, `tag`, and `ops`. `old_string` / `new_string` are removed;
no compatibility shim, no per-model variant selection, no second write tool. One
high-risk write contract keeps the permission matrix, review snapshots,
artifacts recording, audit surface, and per-session mutation serialization
single-valued.

The operation surface is the full `hashline` surface: range replace
(`PUT N.=M:`), gap insert (`PUT <N:` / `PUT >N:` / `PUT >$:`), syntactic-block
replace and sibling insert (`PUT N*:` / `PUT >N*:`), capture-and-delete
(`CUT N.=M` / `CUT N*`), register paste (`PUT <N @name` / `PUT N.=M @name`), and
the file-level `REM` / `MV DEST`. Body rows are `+`-prefixed final content;
`-old` rows and bare context rows do not exist, because the range already
expresses the deletion.

### 2. Read and Grep mint tags; Read emits line numbers

`Read` prefixes each returned line with `N:` and prepends a `[path#TAG]` header.
This reverses ADR 0069's byte-faithful `content` decision, whose sole purpose was
to keep copied text matchable by `old_string`. `Grep` gains the same header per
matched file. `Write` returns the post-write header so an immediately following
`Edit` needs no extra `Read`.

### 3. Host-core owns a session-scoped snapshot store

A bounded in-memory store maps `(session, canonical path)` to a short history of
full-file versions, each carrying its tag and the set of line numbers a producer
actually **displayed**. This makes two guarantees enforceable that the current
contract cannot express:

- **Version.** An `Edit` whose `tag` does not hash the live file is not applied
  on the model's word.
- **Provenance.** An `Edit` anchored on a line the session never displayed is
  rejected, with that line's real content inlined in the error so a straight
  retry can succeed without another `Read`.

The store is in-memory, per session, bounded, and dropped with the session. It is
distinct from ADR 0043's review snapshots, which are on-disk, per tool call, and
exist for rollback; the two share only the hashing primitive already in
`crates/host-core/src/review.rs`.

`execute_tool_with_path_access` therefore gains a session identity parameter.
Today only `BashExecutionOptions` carries `session_id`, so Read/Edit/Grep have no
way to reach per-session state; that is the one signature change the whole
feature rests on.

### 4. Tree-sitter is added to host-core for block resolution

`PUT N*:`, `PUT >N*:`, and `CUT N*` need the line span of the syntactic
construct opening at line `N`. host-core gains `tree-sitter` plus a bounded
grammar set. Resolution is a pure function of (text, language, line) and returns
`None` for an unsupported language, an invalid line, a line with no opener, or a
file that does not parse; the tool then rejects the block op with an actionable
message naming the plain-range alternative. Block ops degrade; they never guess.

Every resolved span is echoed back in the tool result so the model can see that
it anchored the wrong opener.

### 5. Registers are session-scoped and named; anonymous registers are call-local

Cross-file moves use named registers (`CUT 1* @fn` in one call, `PUT <1 @fn` in
the next), which is `hashline`'s own sanctioned cross-call mechanism. `Edit`
stays single-path: PI-Desktop's permission gate, review snapshot, artifacts row,
and mutation permit are all keyed on one `args.path`, and multi-section patches
would fork all four. The anonymous register lives only within one `Edit` call.

### 6. Failure is explicit, and recovery must be provable

A stale tag attempts snapshot recovery: every anchor is remapped through
unchanged lines from the tagged snapshot to the live file, surrounding context is
validated, and all anchors must move by one consistent offset. Anything
changed, split, or ambiguous fails closed with a mismatch error carrying current
content. Head/tail-only inserts are position-stable and apply with a warning
instead of failing. A no-op apply is an error.

## Consequences

- The model stops retyping existing code to edit it. The retyped surface shrinks
  to the lines it is actually writing, which removes the dominant `Edit` failure
  cause rather than prescribing a recovery for it.
- Edits against content the session never displayed become impossible instead of
- Edits against content the session never displayed become impossible instead of
  being undetectable. §4d's bounded loop guard stays, now allowing three counted
  failures per path before termination. It also stops counting the three
  recoverable codes on their first occurrence: each one hands the retry
  what it needs, so each gets one grace per path, and the failure that does
  exhaust the budget ends the turn with a visible `MUTATION_RETRY_BUDGET_EXHAUSTED`
  row rather than a silently completed turn.
- `Read` output grows by the width of a line-number prefix, and its `content` is
  no longer byte-faithful. Any consumer that copies `content` verbatim must strip
  prefixes; `Write` already needs the same stripping for pasted headers.
- host-core gains a per-session memory cost bounded by the store's caps, plus
  tree-sitter and its grammars in the binary. Grammar footprint is the price of
  block ops and is bounded by an explicit language list, not by "add grammars
  until every file works".
- Every model targeting PI-Desktop must learn one new syntax. There is no
  fallback contract, so a model that cannot produce it cannot edit; this is
  accepted deliberately over maintaining two prompts, two validators, two
  renderers, and two audit shapes indefinitely.
- The renderer's Edit diff rendering
  (`apps/desktop/src/lib/tool-presentation.ts:501`) can no longer derive a diff
  from `old_string`/`new_string` and must render from the review record's hunks,
  which ADR 0043 already produces.

## Alternatives rejected

- **Add a tag to the existing `old_string` contract.** Fixes version and
  provenance but leaves the model retyping code, which is the larger cost. It
  buys the cheaper half of the benefit for most of the same plumbing.
- **Keep both contracts behind a mode switch.** Two prompts, two validators, two
  renderers, two audit shapes, and a per-model exclusion list to maintain
  forever, in exchange for tolerating models that cannot follow one documented
  syntax.
- **Add a second, separate line-anchored write tool.** Cheapest to build and the
  worst to own: two concurrent high-risk write tools fork the permission matrix,
  the review snapshot boundary, the artifacts ledger, and the mutation permit.
- **Unified diff / `apply_patch`.** Requires the model to compute hunk headers
  and retype context lines — both retyping and arithmetic. `Bash` guidance
  already steers away from `git apply` and `patch` for this reason.
- **Multi-section patches in one `Edit` call.** Needed only for same-call
  cross-file moves, which session-scoped named registers already cover across
  two calls, and it would fork four subsystems keyed on a single `args.path`.
- **Block resolution by brace counting or indentation instead of tree-sitter.**
  Silently wrong on strings, comments, macros, JSX, and Markdown. A block op that
  is usually right is worse than one that declines.
