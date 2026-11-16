# ADR: Remote header variables accept the registry's `{name}` spelling

- Status: Proposed
- Date: 2026-09-20
- Deciders: Pending maintainer review
- Related: ADR 0245, E2E-MCP-MARKET-SEMANTICS

## Context

The official MCP registry spells a remote header variable `{name}` and declares
the name in the header's `variables` map. Its schema describes `variables` as
the values that replace "keys in the input `value` that are wrapped in
`{curly_braces}`".

## Decision

1. The registry adapter resolves `{name}` only when that same header declares it
   in `variables`; undeclared braces remain literal.
2. Add optional `headerBindings` to the shared catalog template.
3. Header templates accept both spellings and consume the `$`, so a `${NAME}`
   header resolves without a stray dollar.
4. stdio templates keep the `${NAME}` spelling and the upper-case name rule.
5. `requiredEnv` names are validated against the transport: variable names for
   `http`, environment-variable names for `stdio`.

## Consequences

- Declared editable header variables yield prompts and resolve according to
  their own defaults and requiredness.
- Builtin catalog entries and stdio packages behave exactly as before.
- The catalog can express a header variable that is not an environment variable
  name, which is what the registry publishes.
