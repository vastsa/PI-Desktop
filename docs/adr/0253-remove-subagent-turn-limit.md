# ADR 0253: Remove the subagent turn limit

- Status: Accepted
- Date: 2026-09-15
- Related: ADR 0062, ADR 0063, ADR 0089, ADR 0119, ADR 0126, ADR 0166,
  ADR 0189, ADR 0210, D328, D423
- Supersedes: the `maxTurns` clauses of ADR 0062, ADR 0063, ADR 0119, ADR 0126,
  ADR 0166, and ADR 0210. Historical ADR files are retained. This record removes
  the field those records described; it does not change their other clauses.

## Context

ADR 0062 gave a definition a `maxTurns` cap, later made optional and clamped, and
ADR 0166 kept it as the last definition-level kill switch. The parent cannot see a
delegate's live work, so it cannot distinguish a delegate one turn from converging
from one that never will, which leaves no honest cap but "large enough". Reaching
the cap killed a delegate mid-task as `truncated` with a partial report that
neither the user nor the parent model could resume.

## Decision

1. **Delete the mechanism.** A delegate has no turn limit; it ends when it
   finishes, when the parent calls `TaskStop`, when the user Stops, or when a
   terminal parent error aborts it, and there is no `truncated` outcome or
   turn-related termination path.
2. **Remove `maxTurns` from the contract.** The field leaves
   `SubagentDefinition`, the frontmatter parser and its warnings, the shared
   subagent types, the host-core registry, the built-in documents, the presets,
   and the Subagent editor's Advanced disclosure, while the host-core input
   struct keeps ignoring unknown fields.
3. **Legacy documents keep loading.** `maxTurns`, `max-turns`, and `max_turns`
   become unrecognized frontmatter keys that are ignored like any other, so a
   definition that declared a cap loses it silently and nothing rewrites the
   user's file.
4. **Remove the `truncated` status.** It leaves `SubagentRunStatus`, the
   renderer outcome union, the localized status catalog, and the topology's
   warning count, while `timed_out` stays in the type because no other record
   withdraws it.
5. **No protocol and no schema change.** `PROTOCOL_VERSION` stays 11 and
   `SCHEMA_VERSION` stays 16, older renderers sending the field are tolerated,
   and no column ever stored the cap.

## Consequences

- A looping delegate runs until the user Stops it or the parent calls
  `TaskStop`, which is the exposure every definition omitting `maxTurns` already
  had.
- Existing documents lose their cap without a prompt; the stopping condition
  belongs in the prompt body, where a delegate already reads when its work is
  done.
- Settings and the built-in documents drop the field, and callers must treat the
  legacy frontmatter keys as silently ignored.

## Alternatives

- Raise the ceiling or keep the field unenforced: rejected because it preserves a
  knob that cannot be set correctly, plus a dead contract surface.
- Warn on the legacy key: rejected because unknown frontmatter keys are already
  ignored silently, and `idle-timeout` / `max-duration` differ, since those keys
  still exist and are merely unarmed.
