# ADR: Remote header variables accept the registry's `{name}` spelling

- Status: Proposed
- Date: 2026-09-20
- Deciders: Pending maintainer review
- Related: ADR 0245, E2E-MCP-MARKET-SEMANTICS

## Context

The official MCP registry spells a remote header variable `{name}` and declares
the name in the header's `variables` map. Its schema describes `variables` as
the values that replace "keys in the input `value` that are wrapped in
`{curly_braces}`". Declared names may use lower case, such as `api_key`.
The regression fixtures cover both cases; this ADR does not assert the
frequency of either spelling in the live registry.

The builtin catalog and stdio templates spell a template variable `${NAME}` in
upper case. The registry adapter and the catalog template matcher knew only
that spelling. In the reproduced mapping and resolution path, a registry
record using the official spelling retained `Authorization: Bearer {api_key}`
and had no `requiredEnv` entry. This establishes an unresolved template at
the parser boundary. The tests do not establish rendered install-sheet
behavior, actual HTTP transmission, or a user's observed response status.

## Decision

1. The registry adapter resolves `{name}` only when that same header declares
   it in `variables`; undeclared braces remain literal. Legacy `${NAME}` tokens
   keep working without a variables map. Names need not be upper case when
   declared by the registry. Each header owns its variable definitions.
2. Add optional `headerBindings` to the shared catalog template. Each header
   maps exact tokens to an editable `requiredEnv` input or a fixed literal.
   Presence of `headerBindings`, including an empty map, selects explicit
   binding mode for all headers. A header absent from that map has no bound
   tokens: both `{name}` and `${NAME}` remain literal, regardless of global
   `requiredEnv` names or defaults. Only catalogs with no `headerBindings`
   metadata use the legacy global input scope.
   Same-named inputs in separate headers get distinct collision-safe names.
   Variable `default` prefills the editable input; omitted `isRequired` means
   optional. A fixed `value` is not editable and its content is never parsed
   again as a template. Bindings do not enter the host `McpServerInput` or
   persisted server config, so the runtime protocol remains unchanged.
3. Header templates accept both spellings and consume the `$`, so a `${NAME}`
   header resolves without a stray dollar. URL templates keep the legacy
   `${NAME}` spelling with upper-case names. A header declaration never makes
   bare `{name}` text in a URL editable or substitutable, including when the
   header has a default. `collectCatalogPlaceholders` and `resolveCatalogEntry`
   select the same pattern for each field, so discovery and resolution agree.
4. stdio templates keep the `${NAME}` spelling and the upper-case name rule.
   A brace pair inside a command or an argument is never rewritten, and the
   existing stdio contract is unchanged.
5. `requiredEnv` names are validated against the transport: variable names for
   `http`, environment-variable names for `stdio`.

## Consequences

- Declared editable header variables yield prompts and resolve according to
  their own defaults and requiredness. Fixed variables and unbound brace text
  do not create prompts. Header-local bindings prevent cross-header leakage
  of defaults, optional flags, and literal values. Bare URL tokens remain
  literal through mapping, resolution and host persistence; explicit legacy
  `${NAME}` URL templates retain their existing behavior.
- Builtin catalog entries and stdio packages behave exactly as before.
- The catalog can express a header variable that is not an environment variable
  name, which is what the registry publishes.
