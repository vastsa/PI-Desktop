# ADR 0069: Make native-tool path mistakes recoverable

- Status: Accepted for implementation
- Date: 2026-08-10
- Amends: D185, D192
- Amended by: [ADR 0087](0087-line-anchored-edit-contract.md) (§2's byte-faithful
  `Read` content is replaced by line-numbered, tagged output)

## Context

Recent durable sessions showed repeated path-shape mismatches between the model
and the native tools: `Read` received a directory after a guessed file name did
not exist, and `Grep.path` was repeatedly given one explicit file even though the
host accepted only directories. Both were recoverable inspection mistakes reported
as generic execution failures. The transcript compounded this by deriving a
terminal failure for the activity group from any child error, so a recovered turn
could still read as failed.

## Decision

1. Preserve D185's Agent core and deferred-tool boundary: `Glob` and `Grep` stay on
   demand, and a new Agent prompt activates `Glob` through `ToolSearch` when a
   directory must be listed or a file name is uncertain.
2. Enforce and advertise one portable path contract: `Read.path` accepts an
   existing regular text file and never a directory, `Glob.path` accepts a
   directory, and `Grep.path` accepts either one file or a directory tree, with
   `include` still filtering a file's basename.
3. A directory passed to `Read` returns public `INVALID_ARGUMENT` rather than
   `TOOL_FAILED`, with `suggestedTool: "Glob"` and bounded `suggestedArgs` carrying
   the original path and `pattern: "**/*"` so the model can correct itself.
4. Host definitions, runtime TypeBox schemas, main-Agent guidance, and subagent
   guidance carry the same semantics; subagents, which never receive
   `ToolSearch`, are told only about tools their definition has.
5. A tool error stays visible and auto-expanded on its own ToolCallRow, and the
   activity group covers duration and step containment only. Terminal agent
   errors, the TurnOutcomeCard, sidebar state, and notifications remain the single
   turn-outcome surfaces.

No host protocol or storage-schema version changes; the tool result is already
structured JSON and the Grep input shape stays a string. The 2026-09-27 amendment
to ADR 0048 ships `Glob` and `Grep` in the first request, superseding decision 1's
deferral only.

## Consequences

- Single-file Grep calls stop failing on a directory-only contract.
- A mistaken directory Read yields an actionable correction, not an ambiguous
  execution failure.
- Recovered turns no longer look terminally failed while the failed call stays
  auditable in the expanded transcript.

## Alternatives

- Return `Glob` and `Grep` to the Agent core: rejected because it reverses D185's
  bounded first-request context.
- Silently run Glob when Read receives a directory: rejected because the audited
  tool name would disagree with the executed operation.
