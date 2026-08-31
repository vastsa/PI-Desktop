# 16. Tool Result Limits & Truncation

## 1. Goal

Keep agent context healthy and UI responsive by bounding tool outputs without silent data corruption.

## 2. Default limits

Budgets are per tool class, not one shared cap. A single 256KB cap governing
everything meant no cap in practice: measured sessions averaged 154KB per
`Read` and spent 56% of their whole context on read/search results, which
forced compaction and made the agent re-search what it had already found.

Read/Glob/Grep get the tighter budget because their results are re-fetchable on
demand (narrow the pattern, advance the offset); shell output is not.

Bash output passes two independent ceilings. The **capture** layer bounds what
the host retains in memory while the process streams, and is what the spill file
is written from. The **result** budget bounds what reaches the model. Capture is
deliberately the looser of the two: if it matched the result budget, a spilled
copy could never be fuller than the excerpt it exists to back.

| channel | limit | action when exceeded |
|---|---|---|
| Read / Glob / Grep result (`BUDGET_SEARCH`) | 48 KB, 2000 lines | bound the window + `notice` naming the next step |
| Bash stdout (`BUDGET_SHELL`) | 96 KB, 4000 lines, head | truncate + marker + spill |
| Bash stderr (`BUDGET_SHELL_ERR`) | 96 KB, 4000 lines, **tail** | truncate + marker + spill |
| any single line (`MAX_LINE_CHARS`) | 2000 chars | clip, count it in `notice` |
| Read window | 500 lines default (max 2000), `offset`/`limit`; `totalLines` always reported | paginate; never refuse on file size |
| Grep matches (`headLimit`) | 200 default | stop with `truncated: true` |
| Glob entries (`limit`) | 100 default, 1000 max | stop with `truncated: true` |
| Bash capture retention (`CAPTURE_MAX_BYTES` / `CAPTURE_MAX_LINES`) | 512 KB, 200000 lines | stop retaining; report omitted bytes and lines |
| spilled full output (`SPILL_MAX_BYTES`) | 512 KB | stop retaining; marker still names the file |
| Bash output stream | per-stream sequence | preserve stdout/stderr separation |
| Bash timeout | 60s default; 1–300s override | kill process tree + error |
| `Edit.ops` payload | 256 KB, 200 ops | `INVALID_ARGUMENT`; further Edit caps in [18](18-line-anchored-edit-contract.md) §12 |

A clipped line is not a displayed line. `Read` excludes every line it cut at
`MAX_LINE_CHARS` from the provenance set the `Edit` contract validates against
([18-line-anchored-edit-contract](18-line-anchored-edit-contract.md) §4.3), so a
minified or generated line must be narrowed into view before it can be edited.
Clipping therefore bounds context *and* blocks blind edits on the part that was
cut, instead of only the first.

Limits are host-enforced. Tool descriptions in `builtin_tool_defs()` carry the
numbers and the scoping parameters verbatim: a tool that looks incapable of the
scoped thing gets routed around through Bash, and hand-rolled shell pipelines
are what exhausted context in the first place.

Read never refuses on file size. The former >512KB rejection told the model to
"use Grep or Bash to sample it", which is exactly how an unpaginated read became
a `sed`/`awk` pipeline whose output nothing bounded.

## 3. Truncation marker format

Implemented markers (host-core `truncate_to`), appended for a head cut and
prepended for a tail cut:

```text
[truncated: kept the first 4000 of 51234 lines; limit 4000 lines / 96KB. Full output saved to <path> — Grep it, or Read it with offset/limit.]
[truncated: kept the last 1200 of 51234 lines; limit 4000 lines / 96KB. Narrow the request to see more.]
[truncated: no complete line fits the 96KB limit; kept 98304 bytes of a single 4200000-byte line. Full output saved to <path> — Grep it, or Read it with offset/limit.]
```

A marker always states which end survived, how much was kept out of the total,
the limit that applied, and where to get the rest. The spill sentence appears
only when a full copy was actually written.

Read/Glob/Grep do not embed a marker in their payload: the window metadata
(`offset`, `lineCount`, `totalLines`, `truncated`) plus a `notice` string carry
the same information as sibling fields, which keeps the payload itself
mechanically parseable. `Read` content is line-numbered and headed by
`[path#TAG]` (ADR 0087); it is no longer byte-faithful, so a consumer copying it
into `Write` must strip the header and the `N:` prefixes, which `Write` also does
defensively.

Checkpoint-only aggregate truncation uses the distinct model-context marker in
§4 so diagnostics can distinguish where information was shortened.

## 3a. Spill files

When Bash output exceeds its budget, the fuller copy (up to `SPILL_MAX_BYTES`)
is written to `<data_dir>/scratch/<session_id>/tool-output/<label>-<ms>-<seq>.log`
and named in the marker. That reuses the per-session scratch lifecycle
(`scratch::remove_session_dir` / `sweep`), so spills die with their session and
stale ones are swept at startup — no separate retention policy.

The directory is created on first spill, not on session start, so sessions that
stayed under budget leave nothing behind. A failed spill costs the hint only,
never the tool result.

Grep can read spill files, because an explicit `path` argument stops parent
ignore files from applying — the same rule that lets `path` reach into
`node_modules` or `dist`.

## 4. Model-facing vs UI-facing

- model receives truncated payload with marker
- Renderer receives ordered `stdout` and `stderr` chunks while Bash runs; the
  final model/UI result remains the bounded combined payload.
- UI may offer “open full output in viewer” for Bash/Read later (post-MVP optional)
- full raw output is not required to persist forever; session may store truncated form in MVP
- the per-result host cap does not bound a parallel batch in aggregate, and it
  does not need to during context compaction: an active-turn checkpoint retains
  only the latest user message while an active turn continues, and a
  completed-turn checkpoint retains none, so no tool result crosses the
  boundary at all (D203/D275). Completed turns carry no user message past the
  boundary; tool output reaches the next context solely through the checkpoint
  summary.
- the one active user message a checkpoint may truncate crosses the 20,000-token
  retention limit. It keeps a 75/25 head/tail share of its text with this marker
  in between, rather than being dropped:

```text
[checkpoint truncated: this message crossed the retained context budget]
```

- checkpoint-only truncation never rewrites the original transcript message
  or its UI/diagnostic result; it changes only future reconstructed model
  context

## 5. Partial result flags

Every bounded tool reports `truncated: boolean`. Read/Glob/Grep additionally
report what was bounded and how to continue:

```ts
type ReadResult = {
  path: string; root: "workspace" | "scratch" | "external"
  content: string          // "[path#TAG]" header + "N:"-prefixed window
  tag: string              // 4 hex, whole-file; the Edit anchor
  offset: number; lineCount: number
  totalLines: number       // always reported via fast pre-scan
  fileBytes: number
  truncated: boolean
  notice?: string          // next offset, budget stop, clipped-line count
}

type GrepResult =
  | { matches: { path: string; line: number; text: string }[]; tags: Record<string, string>; count: number; files: number; truncated: boolean; notice?: string }
  | { files: string[]; count: number; truncated: boolean; notice?: string }        // outputMode: filesWithMatches
  | { counts: { path: string; count: number }[]; count: number; truncated: boolean; notice?: string }  // outputMode: count

type GlobResult = { matches: string[]; count: number; truncated: boolean; notice?: string }
```

`tags` is present only in `content` mode, because only that mode displays lines.
The other two modes are searchable but not editable anchors.

For an approved external path, `path` is absolute; `Read` also reports
`root: "external"`. `Glob` and `Grep` use absolute paths for their external
matches. The sidecar emits `filesWithMatches`; host-core also normalizes the
common `files_with_matches` and `files-with-matches` provider spellings.

`notice` is model-facing prose, not a stable contract: it names the next offset,
the budget that stopped the scan, or how many lines were clipped. `truncated`
and the counts are the stable signals.

## 6. Priority rules

1. never omit truncation marker when truncated
2. Bash stdout keeps its head; Bash stderr keeps its **tail**, because a failing
   command's actionable message is the last thing it printed and dropping it for
   96KB of progress noise is what makes the model retry blindly
3. binary files: do not dump raw binary into model; return metadata error
   `TOOL_BINARY_CONTENT`. Detected by extension blacklist plus a sniff of the
   first 4KB (any NUL byte, or >30% non-printable). Grep skips binary files
   silently rather than matching lossily-decoded bytes
4. a single line longer than the whole budget yields a char-boundary-safe prefix
   (or suffix, for a tail cut), never an empty payload
5. aggregate checkpoint truncation must preserve every provider-valid assistant
   tool-call/result pair and re-estimate the resulting tail before persistence
6. relevance ordering for Glob and Grep is file modification time, newest first,
   so a capped result keeps the half more likely to be asked about
7. Timeout and abort close both output streams only after the complete process
   tree has been shut down; no orphan process may continue writing output

## 7. Acceptance criteria

- [x] oversize Bash output truncates with marker and spills the fuller copy
- [x] Bash stderr retains its final lines when truncated
- [x] Grep stops at `headLimit` with `truncated: true`
- [x] Grep and Read clip lines at 2000 chars, and a clipped line is excluded
  from the `Edit` provenance set
- [x] Read paginates a multi-megabyte file instead of refusing it, and reports
  the next offset
- [x] Read refuses binary content with `TOOL_BINARY_CONTENT`
- [x] an explicit `path` reaches into an ignored tree (`node_modules`, spill dir)
- [x] Glob and Grep order results by modification time, newest first
- [x] truncated results still valid UTF-8 text
- [x] the capture ceiling sits above the result budget, so a spilled copy can be
  fuller than the excerpt it backs, and reports the bytes and lines it omitted
- [ ] stdout and stderr stream separately with stable per-tool sequence values
- [ ] Bash uses the 60s default and rejects an override outside 1–300s
- [ ] timeout/abort stops the complete process tree and emits no later chunks
- [ ] an oversized parallel result batch compacts to a bounded marked tail,
  survives restart, and leaves the original transcript results unchanged
