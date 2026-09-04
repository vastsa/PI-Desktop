# 18. Line-Anchored Edit Contract

> Decisions applied: ADR 0087. Amends D186, ADR 0069 §2, ADR 0043 §1.
> Source of truth for implementation: `crates/host-core/src/tools/hashline/`
> (new), `crates/host-core/src/tools/mod.rs`,
> `packages/agent-runtime/src/runtime.ts`.

## 1. Purpose

`Edit` names **positions** in a file and supplies **new content only**. It never
asks the model to reproduce existing bytes. Version correctness and read
provenance are proven by the host, not asserted by the model.

Three properties are enforced, in this order, before any byte is written:

1. **Version.** The `tag` the model supplies must hash the live file.
2. **Provenance.** Every line the edit anchors on must have been displayed to
   this session.
3. **Determinism.** The op must resolve to exactly one span. Ambiguity fails;
   it is never resolved by preference.

## 2. Frozen policy summary

| Topic | Decision |
|---|---|
| `Edit` parameters | `path`, `tag`, `ops` |
| Removed | `old_string`, `new_string`, and any mode switch between contracts |
| Tag | 4 uppercase hex, derived from the whole normalized file |
| Tag minted by | `Read`, `Grep`, `Write`, and every successful `Edit` |
| Anchor unit | 1-indexed original line numbers of the tagged snapshot |
| Body rows | `+`-prefixed final content only; no `-old`, no context rows |
| Sections per call | exactly one (`path` in args) |
| Named registers | session-scoped, survive across `Edit` calls |
| Anonymous register | call-local |
| Block ops | tree-sitter; decline when unresolvable, never approximate |
| Stale tag | recover only when provably unique and safe; otherwise reject |
| No-op apply | error |
| Snapshot store | in-memory, per session, bounded, dropped with the session |

## 3. Snapshot tags

### 3.1 Normalization

Before hashing, and before any line is addressed, file text is normalized:

1. A leading UTF-8 BOM is stripped and retained for restoration on write.
2. Line endings are detected and normalized to `LF`; the dominant original
   ending is retained for restoration on write.
3. Trailing `[ \t\r]` is removed from every line, including the last.

Step 3 applies to the **hash input only**, never to the content the file keeps.
It exists so that a `CRLF` file and a display that trimmed trailing whitespace
still mint the same tag as the bytes on disk.

Line addressing splits normalized text on `LF`. A terminal newline terminates
the preceding line and is not itself addressable content; a trailing empty
element produced by the split is dropped.

### 3.2 Computation

```text
tag(text) = uppercase_hex_4( low_16_bits( digest( normalize_for_hash(text) ) ) )
```

`digest` is the SHA-256 primitive already used by
`crates/host-core/src/review.rs`; the tag takes its low 16 bits. Reusing the
existing primitive keeps one hashing story in host-core and avoids a new
dependency. The cost is one whole-file digest per read and per write, which is
bounded by file size and measured in single-digit milliseconds for the file sizes
`Read` serves.

### 3.3 Collision policy

The tag has 65 536 values. Collisions are expected, not exceptional. The tag is
an **index, never an identity**:

- Snapshot deduplication requires **full-text equality**, not tag equality. Two
  distinct texts sharing a tag are two snapshots.
- Lookup by tag returns the most recently recorded matching version.
- Every decision that could corrupt a file — provenance validation, drift
  recovery, path recovery — additionally compares full text or validates
  surrounding context. A tag match alone never authorizes a write.

Fusing two texts under one tag would attach one text's displayed lines to the
other's content, which is the one way a 16-bit tag can cause real damage.

## 4. Session snapshot store

### 4.1 Shape

```text
session_id → canonical_path → [Snapshot]   (newest first)

Snapshot {
  text:        String,        // full normalized text, LF, no BOM
  tag:         String,        // 4 hex, uppercase
  recorded_at: Instant,
  seen_lines:  Option<BTreeSet<u32>>,   // 1-indexed lines actually displayed
}
```

`canonical_path` is the resolved path already produced by
`workspace::resolve_tool_path`, so workspace, scratch, and approved external
roots share one keyspace and a path spelled two ways resolves to one entry.

`seen_lines == None` means "no provenance recorded" — the provenance gate is then
skipped rather than failing closed, so an externally minted or aged-out tag
degrades to version checking only.

### 4.2 Recording and read fusion

`record(path, text, seen_lines)` returns the tag and:

- If a retained version has the same tag **and** the same full text, that
  version is promoted to head, its recency refreshed, and `seen_lines` unioned
  in. The tag is reused.
- Otherwise a new version is unshifted onto the front of the path's history.

Read fusion is what makes paginated reading work: reading lines 1–2000 and then
1800–3600 of an unchanged file produces one tag whose `seen_lines` covers
1–3600, so a later `Edit` anywhere in that range validates without a third read.

### 4.3 Which lines count as seen

A line joins `seen_lines` only when the producer emitted it **in full**:

- `Read` records every line it returned, **excluding** lines clipped at
  `MAX_LINE_CHARS` (16,384). A clipped line was not displayed; its tail is exactly
  where a blind edit does damage.
- `Grep` in `content` mode records only its matched lines. `filesWithMatches`
  and `count` modes record nothing and mint a tag with `seen_lines` empty, which
  is not the same as `None`: the tag is usable for version checking, and every
  anchor will be rejected until something displays the lines.
- `Write` and a successful `Edit` record the post-write content with **all**
  lines seen: the session authored them.

An empty `seen_lines` set is treated as "nothing seen", so every anchor is
rejected. `None` is treated as "unknown", so no anchor is rejected. The
distinction is deliberate and must not be collapsed.

### 4.4 Bounds and lifecycle

| Bound | Value | Behavior at the limit |
|---|---|---|
| Paths per session | 64 | LRU eviction of the coldest path history |
| Versions per path | 4 | oldest dropped first |
| Retained text per session | 8 MiB | LRU path eviction until under the ceiling |
| Single-file retention | 2 MiB | file is hashed and tagged but its text is not retained; recovery is unavailable for it |

The store lives in host-core process memory under the existing session state
lock. It is dropped when the session is deleted, when the workspace is switched,
and at process exit. It is never persisted: a tag from a previous run is
unrecognized, which correctly forces a fresh `Read`.

Eviction is safe by construction. Losing a snapshot loses the ability to
*recover* from drift and the ability to *validate* provenance; both degrade to a
rejection or a warning, never to a wrong write.

## 5. Producer output shapes

### 5.1 `Read`

`content` becomes line-numbered and carries a section header. This reverses ADR
0069 §2's byte-faithful `content`, whose only purpose was `old_string` matching.

```text
[src/main.rs#A1B2]
41:fn main() {
42:    println!("hi");
43:}
```

- The header is the tag of the **whole file**, not of the returned window.
- Line numbers are absolute file lines, so `offset` does not shift them.
- The `N:` prefix is not counted against `MAX_LINE_CHARS`; clipping still applies
  to the line text and still excludes that line from `seen_lines`.
- Existing sibling fields (`path`, `root`, `offset`, `lineCount`, `totalLines`,
  `truncated`, `fileBytes`, `notice`) are unchanged. `tag` is added as a
  first-class field so consumers need not parse the header.

### 5.2 `Grep`

Each `matches[]` entry keeps `{path, line, text}` and the result gains a
`tags: { <path>: <tag> }` map plus a header line per file in the rendered form.
A grep hit is therefore a usable edit anchor for the matched line only.

### 5.3 `Write`

Returns `tag` and the `[path#TAG]` header of the content that actually landed,
so an immediately following `Edit` needs no `Read`.

`Write` continues to strip pasted `[path#TAG]` headers and `N:` line prefixes
from incoming `content`; with line-numbered `Read` output this stops being a
convenience and becomes required.

### 5.4 Post-write drift

The tag recorded after a write is computed from the bytes the write path reports
as landed, not from the bytes the tool intended. When a formatter or an external
writethrough transforms content on save, recording the intended text would
publish a tag for content that does not exist, and the next `Edit` would resolve
against a baseline the file has already left.

The intended text is still what the review record and the model-visible summary
describe, so a drifted write reports a one-line warning rather than a whole-file
diff.

## 6. `Edit` request shape

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Existing regular file, workspace-relative or an approved absolute path. `Edit` never creates files; use `Write`. |
| `tag` | string | yes | 4 uppercase hex from the most recent `Read` / `Grep` / `Write` / `Edit` result for this path. |
| `ops` | string | yes | One or more operation headers with their body rows, newline separated. |

`ops` may optionally begin with a `[path#TAG]` header line. When present it must
agree with `path` and `tag`; a disagreement is `INVALID_ARGUMENT` rather than a
silent preference, because the two spellings disagreeing means the model has lost
track of which file it is editing.

## 7. Patch language

### 7.1 Grammar

```text
ops        := header_block+
header_block := op_header NEWLINE body_row*        // colon-terminated headers
              | op_line                            // colonless headers
op_header  := "PUT" SP locator ":"
op_line    := "PUT" SP locator SP register
            | "CUT" SP locator [SP register]
            | "REM"
            | "MV" SP dest
locator    := line ".=" line        // inclusive range
            | line "*"              // syntactic block opening at line
            | "<" line              // gap before line
            | ">" line              // gap after line
            | ">" "$"               // end of file
            | ">" line "*"          // gap after the block opening at line
line       := [1-9][0-9]*
register   := "@" [A-Za-z0-9_-]{1,32}
body_row   := "+" TEXT
dest       := path | quoted_path
```

### 7.2 Operations

| Header | Body | Meaning |
|---|---|---|
| `PUT N.=M:` | required | Replace original inclusive lines `N`–`M` with the body. `N.=N` for one line. |
| `PUT N*:` | required | Replace the syntactic block opening at line `N`. |
| `PUT <N:` | required | Insert the body before line `N`. `PUT <1:` is the file head. |
| `PUT >N:` | required | Insert the body after line `N`. |
| `PUT >$:` | required | Append at end of file. |
| `PUT >N*:` | required | Insert after the end of the block opening at `N`, at sibling depth. |
| `CUT N.=M` | none | Delete lines `N`–`M` and capture them. |
| `CUT N*` | none | Delete the block opening at `N` and capture it. |
| `CUT … @name` | none | Capture into the named register instead of the anonymous one. |
| `PUT <N @name` / `PUT >N @name` | none | Paste a register at the gap. |
| `PUT N.=M @name` / `PUT N* @name` | none | Paste a register over the range or resolved block. `@name` is mandatory in the span form. |
| `REM` | none | Delete the file named by `path`. |
| `MV DEST` | none | Move/rename to `DEST` after applying every other op to the source. |

### 7.3 Anchoring rules

1. All line numbers refer to the **tagged snapshot**. They are never shifted by
   earlier ops in the same call.
2. Ranges are inclusive and ordered (`N <= M`).
3. Ranges name only the lines being **changed**. A pure insertion uses a gap
   locator; a widened `PUT` that restates surviving lines is the single most
   damaging authoring mistake and is what §7.4's `+`-only body rules exist to
   prevent.
4. Two ops may not overlap, and two ops may not target the same original anchor.
5. A range may not start or end inside a collapsed or clipped region. Lines
   excluded from `seen_lines` are rejected by §9's provenance gate, which covers
   this case mechanically rather than by convention.

### 7.4 Body rows

A body row is `+` followed by the row's final text, with leading whitespace
preserved. A bare `+` is an empty line.

There is no `-old` row and no context row. The range already expresses the
deletion; the body is only what the file will contain. A literal leading `-` or
`+` in the content is written as `+- item` and `++ item`.

Colonless headers take **no** body rows. A body row under a register paste is
`INVALID_ARGUMENT`, not a silent discard.

### 7.5 Registers

| Register | Scope | Lifetime |
|---|---|---|
| anonymous | one `Edit` call | cleared when the call returns |
| `@name` | session | until overwritten, the session ends, or the store is dropped |

Cross-file moves use two calls: `CUT 1* @fn` on the source, then
`PUT <1 @fn` on the destination. This is the sanctioned form; `Edit` is
single-path by §13.2.

Two or more un-pasted anonymous `CUT`s in one call make the next anonymous paste
ambiguous. It fails with a message naming the register syntax rather than picking
the most recent capture.

A named register is captured content, not a live reference. Deleting or moving
the source file afterwards does not invalidate it.

## 8. Lowering and application

### 8.1 Intermediate representation

The parser lowers every op to a flat list of five edit kinds, all anchored on
original line numbers:

| Kind | Produced by |
|---|---|
| `insert{cursor, text, mode?}` | body rows of any `PUT` |
| `delete{anchor}` | every line consumed by a range or block |
| `cut{range, register?}` | `CUT` |
| `paste{target, register?}` | register `PUT` |
| `block{anchor, payloads, mode?, register?}` | any `N*` locator, before resolution |

A multi-line replacement decomposes into one `insert` per body row plus one
`delete` per consumed line. Because every anchor indexes the original snapshot,
all positions are computed once; no op observes another op's effect.

### 8.2 Block resolution

`block` edits carry no span at parse time. `resolve_blocks(text, path, line)`
runs before validation and returns an inclusive `{start, end}` or `None`.

Resolution returns `None` — and the op is rejected with an actionable message —
for any of:

- an extension outside the supported grammar set;
- a line number outside the file;
- a line that opens no multi-line construct (a bare statement, a closing
  delimiter, or the construct's last line);
- a file that does not parse cleanly.

Supported grammars in the first implementation:

`rust`, `typescript`, `tsx`, `javascript`, `jsx`, `json`, `markdown`, `css`,
`python`, `toml`, `yaml`, `html`, `bash`.

Additional grammars are additive and require no contract change. An unsupported
language loses block ops only; every range and gap op still works, and the
rejection message says so explicitly.

Two resolution rules are contract, not implementation detail:

- **Leading attached nodes are separate.** A decorator, attribute, or doc comment
  above a declaration is its own node. Anchoring the declaration line orphans
  them; anchoring the first decorator includes both. Standalone line comments are
  never swept into a block.
- **Markdown headings are block openers.** A block op on `##` covers that
  section through deeper headings up to the next same-or-higher heading.

Every resolution is echoed in the tool result as
`{anchorLine, start, end, op}` so a wrong-opener anchor is visible rather than
silently applied.

Block resolution runs against the text the tag names: the live file when the tag
matches, and the tagged snapshot when the file has drifted (so §10 can remap the
resulting span). When the tagged snapshot is needed and unavailable, the span
cannot be placed and the call is rejected.

### 8.3 Clipboard pre-pass

Before ordinary application, `cut` and `paste` are expanded:

1. `cut` captures the range's current lines into its register and lowers to one
   `delete` per line.
2. `paste` expands to one plain `insert` per captured line. A span target
   additionally expands to per-line `delete`s — **only after the register read
   succeeds**, so a paste from an empty register leaves no orphan deletes.

The pre-pass validates sequencing first and reports it with its own message:
pasting before any capture, and capturing over un-pasted anonymous content, are
distinct errors from a tag mismatch and must not be reported as one.

### 8.4 Replacement-boundary repair

A range that swallows one unchanged boundary row, or a body that restates a row
surviving just outside the range, is repaired by a bounded candidate search.
The repair is deliberately conservative:

- An exact restatement of a line immediately outside the range is normalized
  away on line equality alone.
- If the authored result still does not parse, the search may retain the range's
  first or effective-last row, and may combine that retention with echo removal.
- Retention never follows parse success alone: on a baseline that parsed,
  deleting the row must itself break syntax, and the candidate must also satisfy
  source-range structure and indentation evidence.
- **Distinct candidate texts tied at the minimum repair cost are rejected, not
  ranked.** A guess that is usually right is the failure mode this whole spec
  exists to remove.

Every repair emits a warning naming what it changed.

## 9. Validation gates

`Edit` resolves to exactly one of four outcomes. Let `expected` be the supplied
tag and `live` the tag of the current file.

| Branch | Condition | Behavior |
|---|---|---|
| **A. Direct** | `live == expected` | Run the provenance gate, then apply. Anchor numbers index the live file 1:1, so resolved block spans are echoed back. |
| **B. Position-stable** | `live != expected`, and every op targets only the file head or tail | Apply to live content with a drift warning. `>$` and `<1` cannot be moved by content drift, so a stale tag is not fatal here. |
| **C. Recovery** | `live != expected`, anchored ops present | Attempt §10. On success, apply with a recovery warning; resolved spans are **not** echoed, because line numbers moved. |
| **D. Reject** | recovery declined | `EDIT_TAG_MISMATCH` with the live tag, the anchor lines, and current content around them. |

### 9.1 Provenance gate

On branch A only, every anchor line is checked against the `seen_lines` of the
snapshot whose text equals the live content:

- `seen_lines` absent (`None`) → gate skipped.
- All anchors seen → apply.
- Otherwise → reject, and inline the real content of the unseen anchor lines.

The rejection is designed so an honest retry succeeds without another `Read`:

- At most **40** unseen lines are revealed, each clipped at **512** characters.
- When the reveal covered **every** unseen anchor line at **full width**, those
  lines are merged into `seen_lines`. The content in the error is itself the
  proof that the model has now seen them, so retrying the same `tag` applies.
- When the reveal was truncated by either cap, **no** line is merged and the
  message keeps its "re-read the range" instruction.

The asymmetry is load-bearing. Merging a truncated reveal would let a blind wide
edit be split into under-cap retries that each reveal a slice and eventually
apply without any read, and would let a minified line be laundered into
`seen_lines` while most of its width stayed unseen.

### 9.2 Path recovery

When `path` does not exist on disk but its **basename and tag** together match
exactly one file the session recorded, the edit is rebound to that file and a
warning is emitted. Requirements:

- basename and tag must both match;
- exactly one candidate — a tie declines;
- the authored path's own recorded snapshot is excluded, so a deleted file cannot
  recover onto its own history;
- rebinding happens **before** the write-permission gate, so a mistyped path
  resolves to its real, writable location instead of failing against a path the
  model never meant.

### 9.3 No-op and the repeat guard

An apply that produces text identical to the input is `EDIT_NO_CHANGE`, not
success.

§4d's repeat guard still stops a prompt that keeps failing on one path, but it
does not count every failure the same way. The three recoverable codes —
`EDIT_TAG_MISMATCH`, `EDIT_TAG_UNKNOWN`, `EDIT_LINES_UNSEEN` — each hand back
what the retry needs: the live tag, or the content of the lines the host refused
to write blind (§9.1). One honest retry is the designed response to them, so
each code gets **one free attempt per path** before it counts. Every other code
— malformed ops, an invalid range, a no-op apply — counts on its first
occurrence, because repeating one of those means the model is guessing.

| Sequence on one path within one prompt | Outcome |
|---|---|
| `EDIT_TAG_MISMATCH`, then `EDIT_LINES_UNSEEN` | Neither counts: two different honest failures, each with its own grace |
| `EDIT_TAG_MISMATCH` twice | The second counts as attempt 1 |
| `EDIT_PARSE_FAILED` twice | Attempt 2 — the turn stops |
| A failure, then a successful `Edit`, then a failure | Attempt 1 — a write that landed clears that path's history |

Counting a grace is per code, not per call, so a stale tag followed by unseen
lines is two distinct honest failures while the same code twice is not.

When the count does reach the limit the tool result carries `terminate: true`
and the agent loop stops after that batch. Stopping there must not leave a turn
that merely ends: the runtime finalizes the assistant row with
`MUTATION_RETRY_BUDGET_EXHAUSTED` — retriable, `details.kind` of `edit` or
`patch-command`, plus the last error code — and emits a matching error event, so
the user sees that the agent stopped on purpose and keeps the continue
affordance. A terminated turn with no message is indistinguishable from a model
that chose to say nothing.

## 10. Drift recovery

Recovery proves that every anchor still maps to one unchanged region, then
replays the ops against live content. It never edits the tagged snapshot and
writes that.

1. Look up the snapshot whose tag equals `expected`. Absent → decline.
2. Diff snapshot text against live text and build a map of **unchanged** lines
   only: `old_line → new_line`.
3. Every anchor must be present in the map. Missing → decline.
   For `cut` and span `paste`, **every captured interior line** is an anchor:
   changed interior content cannot be moved safely.
4. Validate each anchor's surrounding context:
   - if the anchor's text is unique in both the old and the new file, at least
     one adjacent non-anchor line must map at the same offset;
   - if the text is duplicated on either side, **both** adjacent non-anchor lines
     must map at the same offset.
5. All anchors must move by **one consistent offset**. Any divergence declines.
6. Replay against live content. An apply failure, or a replay that changes
   nothing, declines.

Recovery warnings distinguish cause, because the corrective action differs:

| Warning | Condition |
|---|---|
| external change | the tagged snapshot is still the head — something outside the session wrote the file |
| session chain | the tag names an older version — the model reused a stale tag from earlier in the session |
| line remap | anchors moved by a non-zero offset |

## 11. Errors

| code | retriable | meaning |
|---|---|---|
| `EDIT_TAG_REQUIRED` | no | `tag` missing or not 4 hex |
| `EDIT_TAG_MISMATCH` | yes after a `Read` | tag does not hash the live file and recovery declined; carries the live tag and current content at the anchors |
| `EDIT_TAG_UNKNOWN` | yes after a `Read` | tag is well-formed but this session recorded no such content for the path |
| `EDIT_LINES_UNSEEN` | yes | anchors reference lines never displayed; carries the revealed content |
| `EDIT_PARSE_FAILED` | no | malformed header, body row under a colonless header, missing body, `-`/context row |
| `EDIT_RANGE_INVALID` | no | reversed range, out-of-bounds line, overlapping ops, duplicate anchor |
| `EDIT_BLOCK_UNRESOLVED` | no | `N*` could not resolve; names the plain-range alternative |
| `EDIT_REGISTER_EMPTY` | no | paste from an unset register |
| `EDIT_REGISTER_AMBIGUOUS` | no | anonymous paste with more than one pending anonymous capture |
| `EDIT_REPAIR_AMBIGUOUS` | no | boundary repair candidates tied at minimum cost |
| `EDIT_NO_CHANGE` | no | apply produced identical text |
| `EDIT_AMPLIFICATION_LIMIT` | no | lowering exceeded the expansion cap |

All of these are `Edit`-scoped and additive to
[08-error-codes](08-error-codes.md) §3.4. Existing `INVALID_ARGUMENT`,
`TOOL_DENIED`, `PATH_OUTSIDE_WORKSPACE`, and `TOOL_FAILED` semantics are
unchanged; `Edit` no longer reports version or provenance problems as the generic
`TOOL_FAILED`, because both are recoverable with a specific next action.

`MUTATION_RETRY_BUDGET_EXHAUSTED` is not in this table because it is not an
`Edit` result: the tool call already failed with one of the codes above, and the
runtime adds that code to the assistant row it writes when the repeat guard ends
the turn (§9.3, [08-error-codes](08-error-codes.md) §3.3).

Every error message names one concrete next step. "Re-read and retry" without a
range is not an acceptable message when the host knows the range.

## 12. Limits

| Limit | Value | Behavior at the limit |
|---|---|---|
| `ops` payload | 256 KB | `INVALID_ARGUMENT` |
| Ops per call | 200 | `INVALID_ARGUMENT` |
| Expanded IR lines | 100 000 | `EDIT_AMPLIFICATION_LIMIT` |
| Unseen-line reveal | 40 lines | truncate the reveal, merge nothing |
| Reveal line width | 512 chars | clip, mark truncated, merge nothing |
| Register capture | 4096 lines / 1 MiB | `INVALID_ARGUMENT` on the `CUT` |
| Named registers per session | 16 | LRU eviction of the coldest |
| Block resolution parse | 4 MiB per file | decline the block op |
| Snapshot store | §4.4 | LRU eviction |

## 13. Interaction with existing subsystems

### 13.1 Review snapshots and rollback (ADR 0043)

`review::prepare_change` keys on `tool_name` and `args.path` only, both of which
survive unchanged, so pre-tool capture needs no modification for the common case.
Two additions are required:

- `MV DEST` produces a source deletion and a destination creation. It records as
  two review entries under one tool call, and rollback restores both or neither.
- `REM` records as a deletion whose rollback restores the captured bytes.

Rollback's post-tool hash check is unaffected: it uses the full digest, not the
16-bit tag. After a rollback the session snapshot store must be invalidated for
that path, or the model would hold a tag for content the rollback replaced.

### 13.2 Single-path `Edit`

The permission gate, review snapshot, artifacts row
(`crates/host-core/src/rpc/mod.rs:2550`), and per-session mutation permit are all
keyed on one `args.path`. `Edit` therefore stays single-path, and cross-file
moves use session-scoped named registers across two calls (§7.5).

### 13.3 Mutation ordering

§4d's serialization is unchanged and becomes more important: the snapshot store
is mutated by both producers and `Edit`, and two concurrent mutations on one
session could interleave a record between a validation and its write. The
existing per-session mutation permit already excludes that.

### 13.4 Renderer

`apps/desktop/src/lib/tool-presentation.ts:501` currently derives an Edit diff
from `old_string` / `new_string`. Those fields are gone. The Edit row renders
from the review record's hunks — which ADR 0043 already produces — and shows the
op headers verbatim as the model's stated intent. Resolved block spans and every
warning from §8.4, §9.2, and §10 are surfaced on the row, not swallowed.

### 13.5 Subagents

Subagents are separate sessions and therefore have separate snapshot stores and
separate registers. A parent cannot hand a subagent a tag, and a subagent must
`Read` before it edits. This is the correct default: provenance is per reader.

### 13.6 Tool descriptions and prompts

`builtin_tool_defs()` in host-core and `buildToolDefinitions()` in
`packages/agent-runtime/src/runtime.ts` must carry the same operation table,
body-row rules, and anti-patterns. The model-facing guidance is part of the
contract: the ops table, the `+`-only body rule, "ranges name changed lines
only", "re-ground after every edit", and the worked anti-patterns
(empty `PUT` used as a delete, range sized to post-edit content, `-`/context
rows, widened `PUT` for a pure insertion, `>N*` anchored on a closer, body rows
under a register paste).

## 14. Deliberate deviations from `oh-my-pi`'s `hashline`

| Deviation | Reason |
|---|---|
| Single section per `Edit` call, not a multi-section patch | four PI-Desktop subsystems key on one `args.path` (§13.2); named registers already cover cross-file moves |
| SHA-256 low 16 bits instead of `xxHash32` | reuses the primitive already in host-core; no new dependency |
| Snapshot store in-memory only, never persisted | a tag surviving a restart would outlive the reads that justified it |
| No `apply_patch` / `replace` fallback mode and no per-model exclusion list | ADR 0087 §1: one write contract |
| No internal URL schemes (`artifact://`, `xd://`, …) as `Edit` targets | out of scope; PI-Desktop's path rules stay as specified in §4 of 03-tools-and-permissions |
| 64 paths / 8 MiB store bounds instead of 30 / 64 MiB | host-core is a long-lived desktop process holding many sessions, not a per-invocation CLI |

## 15. Phasing

Each phase is independently shippable and leaves the contract coherent.

| Phase | Contents | Exit criterion |
|---|---|---|
| 1 | Snapshot store, `session_id` threaded into `execute_tool_with_path_access`, tags on `Read`/`Grep`/`Write`, line-numbered `Read` | tags round-trip; no `Edit` change yet |
| 2 | Ranges and gaps (`PUT N.=M:`, `PUT <N:`, `PUT >N:`, `PUT >$:`, `CUT N.=M`), tag validation, provenance gate, `REM`/`MV` | `old_string` removed; §9 branches A/B/D live |
| 3 | Drift recovery (§10) and path recovery (§9.2) | branch C live |
| 4 | tree-sitter block ops (`N*`, `>N*`) with resolution echo | block ops decline cleanly on unsupported languages |
| 5 | Registers (§7.5) and boundary repair (§8.4) | cross-call moves work; ties reject |

Phase 2 is the point of no return for the old contract and must ship with the
renderer change in §13.4 and the prompt change in §13.6 in the same release.
