# ADR 0253: Remove the subagent turn limit

- Status: Accepted
- Date: 2026-09-15
- Deciders: PI-Desktop core
- Related: D423, ADR 0062, ADR 0063, ADR 0089, ADR 0119, ADR 0126, ADR 0166,
  ADR 0189, ADR 0210, `03-runtime/02-agent-runtime.md` §5f,
  `04-ux/06-settings-ia.md` §7, E2E-155,
  E2E-SUBAGENT-legacy-turn-limit-frontmatter-is-ignored
- Supersedes: the `maxTurns` clauses of ADR 0062, ADR 0063, ADR 0119, ADR 0126,
  ADR 0166, and ADR 0210. Historical ADR files are retained. This record removes
  the field those records described; it does not change their other clauses.

## Context

ADR 0062 introduced subagents as bounded workers and gave a definition a
`maxTurns` frontmatter cap. ADR 0119 made the key optional — omission, `none`
and `0` meant unlimited, and an explicit value was clamped to 80. ADR 0126 and
ADR 0063 carried the field into the parser and the Subagent editor. ADR 0166
then withdrew the idle and duration watchdogs but deliberately kept `maxTurns`
as the remaining definition-level kill switch, and D328 recorded that "explicit
`maxTurns` and the concurrency cap of 10 stay". ADR 0210 reused the same loose
key-spelling rules for the sibling `maxTokens` cap.

The cap could not be reasoned about correctly, because the parent cannot see the
delegate's live work. It cannot tell a delegate that is one turn from
converging from one that never will, so the only honest cap would be "large
enough", which is no cap at all. The shipped values were arbitrary (60, 50, 40,
80), the editor defaulted to unlimited anyway, and the failure mode was worse
than the problem it solved: a delegate that reached the cap was killed
mid-task and surfaced as `truncated` with a partial report — a state that reads
as a failure to the user and to the parent model, and that neither can resume.

The kill paths that remain are all explicit and observable: the parent agent's
`task_stop`, the user's Stop, and a terminal parent error aborting leftovers
(ADR 0189). A turn count is none of those.

## Decision

1. **Delete the mechanism.** A delegate has no turn limit. It ends when it
   finishes, when the parent calls `task_stop`, when the user Stops, or when a
   terminal parent error aborts it. There is no `truncated` outcome and no
   turn-related termination path.

2. **Remove `maxTurns` from the contract.** The field leaves
   `SubagentDefinition`, the frontmatter parser and its invalid/clamped
   warnings, `MAX_SUBAGENT_MAX_TURNS`, `UserSubagentRecord` /
   `UserSubagentInput`, the host-core registry (record, input, frontmatter
   parse, document render, `MAX_TURNS_CEILING`), the five built-in documents,
   `SUBAGENT_PRESETS`, and the Subagent editor's Advanced disclosure. The
   host-core input struct keeps ignoring unknown fields, so a renderer that
   still sends `maxTurns` does not fail.

3. **Legacy documents keep loading.** `maxTurns`, `max-turns` and `max_turns`
   become unrecognized frontmatter keys and are ignored exactly like every
   other unknown key: no error, no warning, the definition still resolves, and
   nothing rewrites the user's file. A definition that declared a cap therefore
   loses it silently.

4. **Remove the `truncated` status.** `SubagentRunStatus` drops it, and the
   renderer's `SubagentOutcome` union, the `chat.subagentStatus` catalog entry
   in every locale, and the delegation topology's "finished with warnings"
   count drop it with it. `timed_out` stays in the type even though the
   watchdogs that produced it are withdrawn (D328), because no other record
   withdraws it.

5. **No protocol and no schema change.** `PROTOCOL_VERSION` stays 11 and
   `SCHEMA_VERSION` stays 16. The removal is tolerated in both directions: an
   older renderer's extra `maxTurns` field is ignored by host-core (the input
   struct does not deny unknown fields), a newer renderer simply omits it, and
   `truncated` is a value the sidecar can no longer emit. Storage was never
   involved — the registry parses Markdown frontmatter and no column stores the
   cap.

## Consequences

- A looping delegate now runs until the user Stops it, or the parent calls
  `task_stop`. That exposure already existed for every definition that omitted
  `maxTurns`, which was the default and the editor's own starting state, and
  D328 shipped with it.
- Existing user documents that relied on the cap lose it without a prompt. The
  migration path is the one this ADR documents: stop the delegate with Stop or
  `task_stop`, and put the stopping condition in the prompt body, where a
  delegate is already told when its work is done.
- Settings no longer offers a "no limit" spelling for turns because there is no
  limit left to express. The Advanced disclosure keeps the model, thinking,
  output limit and scope fields.
- The built-in definitions lose one frontmatter line each and no longer carry a
  number that had no derivation.
- E2E-155 steps and the topology's warning count change with the status and the
  built-in backstops. The new ignore contract is covered by
  E2E-SUBAGENT-legacy-turn-limit-frontmatter-is-ignored and by unit tests in
  `packages/shared`, `packages/agent-runtime`, and `crates/host-core`.

## Alternatives rejected

- **Raise the ceiling, or make every builtin unlimited.** Keeps a knob that
  cannot be set correctly, keeps the `truncated` state and its user-visible
  copy, and still kills a delegate mid-task at an arbitrary point.
- **Keep parsing the key and warn on it.** Unknown frontmatter keys are already
  ignored silently, so a warning would make `maxTurns` the only key with a
  special diagnostic while the definition still ignored it. D328's
  `idle-timeout` / `max-duration` precedent is the opposite case: those keys
  still exist, they are simply not armed, so they keep their parse warnings.
- **Keep the field and never enforce it.** A contract field that does nothing
  is worse than no field: the editor would keep offering it, the settings API
  would keep round-tripping it, and `truncated` would stay in the status union
  as dead surface the UI must still render.
