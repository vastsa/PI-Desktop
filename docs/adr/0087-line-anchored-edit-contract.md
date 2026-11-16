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
(`crates/host-core/src/tools/mod.rs:1225`).

1. **The model must retype existing code.** Every edit's correctness depends on
   reproducing bytes it saw earlier.
2. **Ambiguity is the model's problem to solve.** A duplicated fragment forces
   the model to widen `old_string` until it is unique, which increases the
   retyped surface and therefore the chance of retyping it wrong.
3. **Nothing proves the model read what it is editing.** A unique match on a
   remembered fragment succeeds even when the model never displayed that region
   in this session, and even when the file changed after the read that informed
   the edit.

## Decision

### 1. `Edit` becomes a line-anchored patch tool

`Edit` takes `path`, `tag`, and `ops`. `old_string` / `new_string` are removed;
no compatibility shim, no per-model variant selection, no second write tool.

The operation surface is the full `hashline` surface: range replace (`PUT
N.=M:`), gap insert (`PUT <N:` / `PUT >N:` / `PUT >$:`), syntactic-block replace
and sibling insert (`PUT N*:` / `PUT >N*:`), capture-and-delete (`CUT N.=M` /
`CUT N*`), register paste (`PUT <N @name` / `PUT N.=M @name`), and the
file-level `REM` / `MV DEST`. Body rows are `+`-prefixed final content; `-old`
rows and bare context rows do not exist, because the range already expresses the
deletion.

### 2. Read and Grep mint tags; Read emits line numbers

`Read` prefixes each returned line with `N:` and prepends a `[path#TAG]` header.
This reverses ADR 0069's byte-faithful `content` decision, whose sole purpose
was to keep copied text matchable by `old_string`.

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

The store is in-memory, per session, bounded, and dropped with the session. It
is distinct from ADR 0043's review snapshots, which are on-disk, per tool call,
and exist for rollback; the two share only the hashing primitive already in
`crates/host-core/src/review.rs`.

### 4. Tree-sitter is added to host-core for block resolution

`PUT N*:`, `PUT >N*:`, and `CUT N*` need the line span of the syntactic
construct opening at line `N`. host-core gains `tree-sitter` plus a bounded
grammar set. Resolution is a pure function of (text, language, line) and returns
`None` for an unsupported language, an invalid line, a line with no opener, or a
file that does not parse; the tool then rejects the block op with an actionable
message naming the plain-range alternative.

Every resolved span is echoed back in the tool result so the model can see that
it anchored the wrong opener.

### 5. Registers are session-scoped and named; anonymous registers are call-local

Cross-file moves use named registers (`CUT 1* @fn` in one call, `PUT <1 @fn` in
the next), which is `hashline`'s own sanctioned cross-call mechanism. `Edit`
stays single-path: PI-Desktop's permission gate, review snapshot, artifacts row,
and mutation permit are all keyed on one `args.path`, and multi-section patches
would fork all four.

### 6. Failure is explicit, and recovery must be provable

A stale tag attempts snapshot recovery: every anchor is remapped through
unchanged lines from the tagged snapshot to the live file, surrounding context
is validated, and all anchors must move by one consistent offset. Anything
changed, split, or ambiguous fails closed with a mismatch error carrying current
content.

## Consequences

- The model stops retyping existing code to edit it.
- Edits against content the session never displayed become impossible instead of
- Edits against content the session never displayed become impossible instead of
  being undetectable. §4d's bounded loop guard stays, now allowing three counted
  failures per path before termination.
- `Read` output grows by the width of a line-number prefix, and its `content` is
  no longer byte-faithful.
- host-core gains a per-session memory cost bounded by the store's caps, plus
  tree-sitter and its grammars in the binary.

## Alternatives rejected

- **Add a tag to the existing `old_string` contract.** Fixes version and
  provenance but leaves the model retyping code, which is the larger cost.
- **Keep both contracts behind a mode switch.** Two prompts, two validators, two
  renderers, two audit shapes, and a per-model exclusion list to maintain
  forever, in exchange for tolerating models that cannot follow one documented
  syntax.
- **Add a second, separate line-anchored write tool.** Cheapest to build and the
  worst to own: two concurrent high-risk write tools fork the permission matrix,
  the review snapshot boundary, the artifacts ledger, and the mutation permit.
- **Unified diff / `apply_patch`.** Requires the model to compute hunk headers
  and retype context lines — both retyping and arithmetic.
