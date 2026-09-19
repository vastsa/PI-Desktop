# ADR 0298: Remote header variables accept the registry's `{name}` spelling

- Status: Accepted
- Date: 2026-09-21
- Deciders: PI-Desktop runtime and UX maintainers
- Related: ADR 0245, E2E-MCP-MARKET-SEMANTICS

## Context

The official MCP registry spells a remote header variable `{name}` and declares
the name in the header's `variables` map. Its schema describes `variables` as
the values that replace "keys in the input `value` that are wrapped in
`{curly_braces}`". The spelling is not upper case: a survey of 4,000 registry services found
1,177 headers across 230 services using it, 1,175 of them with a lower-case
name (`api_key`, `mcp_token`), and none using the `${NAME}` form.

The builtin catalog and stdio templates spell a template variable `${NAME}` in
upper case. The registry adapter and the catalog template matcher knew only
that spelling, so a registry record using the official one produced a header
whose value was sent literally — `Authorization: Bearer {api_key}` — and no
`requiredEnv` entry, so the install sheet never asked for the credential. The
entry still listed and installed, which made the failure silent: the user saw a
401 with no prompt explaining it.

## Decision

1. The registry adapter extracts a variable name from either spelling and reads
   the header's `variables` map for its description and whether it is required.
   A variable name is not required to be upper case.
2. The catalog template matcher accepts both spellings for `http` entries and
   consumes the `$`, so a `${NAME}` header resolves without a stray dollar.
   `collectCatalogPlaceholders` and `resolveCatalogEntry` share the pattern, so
   an accepted header is always one that resolves.
3. stdio templates keep the `${NAME}` spelling and the upper-case name rule.
   A brace pair inside a command or an argument is never rewritten, and the
   existing stdio contract is unchanged.
4. `requiredEnv` names are validated against the transport: variable names for
   `http`, environment-variable names for `stdio`.

## Consequences

- A registry record that uses the official spelling now yields a credential
  prompt and installs with the value substituted into the header.
- Builtin catalog entries and stdio packages behave exactly as before.
- The catalog can express a header variable that is not an environment variable
  name, which is what the registry publishes.
