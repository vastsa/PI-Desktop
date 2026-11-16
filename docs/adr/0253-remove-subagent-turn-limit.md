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
and `0` meant unlimited, and an explicit value was clamped to 80.

## Decision

1. **Delete the mechanism.** A delegate has no turn limit.

2. **Remove `maxTurns` from the contract.** The field leaves
   `SubagentDefinition`, the frontmatter parser and its invalid/clamped
   warnings, `MAX_SUBAGENT_MAX_TURNS`, `UserSubagentRecord` /
   `UserSubagentInput`, the host-core registry (record, input, frontmatter
   parse, document render, `MAX_TURNS_CEILING`), the five built-in documents,
   `SUBAGENT_PRESETS`, and the Subagent editor's Advanced disclosure.

3. **Legacy documents keep loading.** `maxTurns`, `max-turns` and `max_turns`
   become unrecognized frontmatter keys and are ignored exactly like every other
   unknown key: no error, no warning, the definition still resolves, and nothing
   rewrites the user's file.

4. **Remove the `truncated` status.** `SubagentRunStatus` drops it, and the
   renderer's `SubagentOutcome` union, the `chat.subagentStatus` catalog entry
   in every locale, and the delegation topology's "finished with warnings" count
   drop it with it.

5. **No protocol and no schema change.** `PROTOCOL_VERSION` stays 11 and
   `SCHEMA_VERSION` stays 16.

## Consequences

- A looping delegate now runs until the user Stops it, or the parent calls
  `TaskStop`.
- Existing user documents that relied on the cap lose it without a prompt.
- Settings no longer offers a "no limit" spelling for turns because there is no
  limit left to express.
- The built-in definitions lose one frontmatter line each and no longer carry a
  number that had no derivation.
- E2E-155 steps and the topology's warning count change with the status and the
  built-in backstops.

## Alternatives rejected

- **Raise the ceiling, or make every builtin unlimited.** Keeps a knob that
  cannot be set correctly, keeps the `truncated` state and its user-visible
  copy, and still kills a delegate mid-task at an arbitrary point.
- **Keep parsing the key and warn on it.** Unknown frontmatter keys are already
  ignored silently, so a warning would make `maxTurns` the only key with a
  special diagnostic while the definition still ignored it.
- **Keep the field and never enforce it.** A contract field that does nothing is
  worse than no field: the editor would keep offering it, the settings API would
  keep round-tripping it, and `truncated` would stay in the status union as dead
  surface the UI must still render.
