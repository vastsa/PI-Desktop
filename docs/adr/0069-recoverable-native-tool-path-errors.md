# ADR 0069: Make native-tool path mistakes recoverable

- Status: Accepted for implementation
- Date: 2026-08-10
- Deciders: PI-Desktop core
- Amends: D185, D192
- Amended by: [ADR 0087](0087-line-anchored-edit-contract.md) (§2's byte-faithful
  `read` content is replaced by line-numbered, tagged output)
- Related: [02-agent-runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [03-tools-and-permissions](../spec/03-runtime/03-tools-and-permissions.md) ·
  [08-component-spec §9](../spec/04-ux/08-component-spec.md) · E2E-019e ·
  E2E-083 · E2E-095

## Context

Recent durable sessions showed a repeated path-shape mismatch between the
model and the native tools. `read` was called with a directory after a guessed
file name did not exist, and `grep.path` was repeatedly given one explicit file
even though the host accepted only directories. These were recoverable
inspection mistakes, but they were reported as generic execution failures.

The transcript compounded the problem. A failed tool row correctly retained
its own error, while the containing activity group also derived a terminal
failure from any child error. A later successful search and final answer could
therefore leave a completed turn labeled `Failed after ...`.

## Decision

1. Preserve D185's Agent core and deferred-tool boundary. `glob` and `grep`
   remain on demand; each new Agent prompt must activate `glob` through
   `tool_search` when a directory must be listed or a file name is uncertain.
2. Enforce and advertise one portable path contract:
   - `read.path` accepts an existing regular text file, never a directory.
   - `glob.path` accepts a directory.
   - `grep.path` accepts either one file or a directory tree. An explicit file
     is searched directly, and `include` still filters its basename.
3. A directory passed to `read` returns public `INVALID_ARGUMENT`, not
   `TOOL_FAILED`. Its result includes `suggestedTool: "glob"` and bounded
   `suggestedArgs` with the original path and `pattern: "**/*"` so the model can
   correct the call without guessing.
4. Host definitions, runtime TypeBox schemas, main-Agent guidance, and
   subagent guidance carry the same path semantics. Subagents do not receive
   `tool_search`, so their guidance refers only to tools actually available to
   the definition.
5. A tool error remains visible and auto-expanded on its own ToolCallRow. The
   activity group represents processing duration and step containment only; it
   never infers terminal turn failure from child rows. Terminal agent errors,
   the TurnOutcomeCard, sidebar state, and notifications remain the single
   turn-outcome surfaces.

No host protocol or storage-schema version changes. The existing tool result
is already a structured JSON value, and the grep input shape remains a string.

## Consequences

- Common single-file grep calls stop failing on a directory-only contract.
- A mistaken directory read receives an actionable, non-retriable correction
  rather than an ambiguous execution failure.
- Recovered turns no longer look terminally failed, while the original failed
  call remains auditable in the expanded transcript.
- Deferred search keeps the measured first-request context reduction from
  D185; the prompt must make the per-user-prompt activation boundary explicit.

## Alternatives considered

### Put `glob` and `grep` back in the Agent core

Rejected. It reverses D185's bounded first-request context decision, and the
observed failure can be corrected without paying both schemas on every prompt.

### Silently execute `glob` when `read` receives a directory

Rejected. It would make the audited tool name disagree with the executed
operation and return a result shape outside read's contract.

### Keep `grep` directory-only

Rejected. A direct file path is unambiguous, cheaper than walking its parent,
and common across coding-agent tool conventions.

### Mark the activity group failed after the turn settles

Rejected. Settlement does not mean every intermediate tool call succeeded;
the dedicated terminal outcome surfaces already own turn failure.
