# ADR 0087: Replace textual Edit matching with a line-anchored, tag-verified contract

- Status: Implemented (phases 1–2; block ops, drift recovery, and boundary repair remain phased)
- Date: 2026-08-15
- Amends: D186, ADR 0069 §2 (`Read` output shape), ADR 0043 §1 (review keying)
- Supersedes: the `old_string` / `new_string` `Edit` contract in
  [03-tools-and-permissions §4d](../spec/03-runtime/03-tools-and-permissions.md)
- Related: [18-line-anchored-edit-contract](../spec/03-runtime/18-line-anchored-edit-contract.md)

## Context

`Edit` takes `old_string` / `new_string` and requires an exact single match, while
`Read` returns line-number-free bytes so copied text still matches. Three failures
follow and none are fixable inside that contract: the model must retype existing
code, ambiguity becomes the model's problem to widen a fragment, and nothing
proves the model ever read the region it is editing — the failure class that
silently produces plausible, wrong edits. `Grep` already returns line numbers, but
the edit path cannot consume them.

## Decision

### 1. `Edit` becomes a line-anchored patch tool

`Edit` takes `path`, `tag`, and `ops`; `old_string` / `new_string` are removed with
no compatibility shim, no per-model variant, and no second write tool, so the
permission matrix, review snapshots, artifacts, audit surface, and mutation
serialization stay single-valued. The surface is the full `hashline` one — range
replace (`PUT N.=M:`), gap insert (`PUT <N:` / `PUT >N:` / `PUT >$:`), block
replace and sibling insert (`PUT N*:` / `PUT >N*:`), capture-and-delete
(`CUT N.=M` / `CUT N*`), register paste (`PUT <N @name` / `PUT N.=M @name`), and
`REM` / `MV DEST` — with `+`-prefixed final content only, since the range already
expresses the deletion.

### 2. Read and Grep mint tags; Read emits line numbers

`Read` prefixes each line with `N:` and prepends a `[path#TAG]` header holding a
4-hex fingerprint of the whole normalized file, reversing ADR 0069's
byte-faithful `content` decision. `Grep` gains the same header per matched file,
and `Write` returns the post-write header so an immediately following `Edit`
needs no extra `Read`.

### 3. Host-core owns a session-scoped snapshot store

A bounded in-memory store maps `(session, canonical path)` to a short history of
full-file versions, each carrying its tag and the line numbers a producer
displayed, which makes version drift and unread provenance rejectable instead of
undetectable. It is distinct from ADR 0043's on-disk review snapshots and shares
only the hashing primitive; `execute_tool_with_path_access` gains the session
identity parameter it needs.

### 4. Tree-sitter is added to host-core for block resolution

`PUT N*:`, `PUT >N*:`, and `CUT N*` need the span of the construct opening at line
`N`, resolved as a pure function of text, language, and line that returns `None`
for an unsupported language, invalid line, opener-less line, or unparsed file.
Block ops degrade with a message naming the plain-range alternative, never guess,
and echo every resolved span back.

### 5. Registers are session-scoped and named; anonymous registers are call-local

Cross-file moves use named registers across two calls, while `Edit` stays
single-path because the permission gate, review snapshot, artifacts row, and
mutation permit are keyed on one `args.path`. The anonymous register lives only
within one call.

### 6. Failure is explicit, and recovery must be provable

A stale tag attempts snapshot recovery: anchors are remapped through unchanged
lines, surrounding context is validated, and all anchors must move by one
consistent offset. Anything changed, split, or ambiguous fails closed with a
mismatch error carrying current content, head/tail-only inserts apply with a
warning, and a no-op apply is an error.

## Consequences

- The model stops retyping existing code and unread-anchored edits become
  impossible; the §4d loop guard allows three counted failures per path before a
  visible `MUTATION_RETRY_BUDGET_EXHAUSTED` end of turn.
- `Read` output grows by a line-number prefix and is no longer byte-faithful, so
  consumers must strip prefixes and the renderer's Edit diff must come from the
  review record's hunks.
- host-core pays a bounded per-session memory cost plus tree-sitter and an
  explicit grammar list, and every model must learn one new syntax with no
  fallback contract.

## Alternatives rejected

- **Add a tag to the existing `old_string` contract.** It fixes version and
  provenance but still leaves the model retyping code, the larger cost.
- **Block resolution by brace counting or indentation.** Silently wrong on
  strings, comments, macros, JSX, and Markdown; declining beats usually right.
