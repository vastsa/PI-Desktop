# ADR: Remote header variables accept the registry's `{name}` spelling

- Status: Proposed
- Date: 2026-09-20
- Related: ADR 0245, E2E-MCP-MARKET-SEMANTICS

## Context

The official MCP registry spells a remote header variable `{name}` and declares the
name in the header's `variables` map, with lower-case names such as `api_key` allowed,
while builtin catalog and stdio templates spell `${NAME}` in upper case and the registry
adapter knew only that spelling, so a record kept `Authorization: Bearer {api_key}` with
no `requiredEnv` entry and left an unresolved template at the parser boundary.

## Decision

The registry adapter resolves `{name}` only when that same header declares it in
`variables`, keeping undeclared braces literal and legacy `${NAME}` tokens working
without a variables map, and each header owns its definitions. The shared catalog
template gains optional `headerBindings`, mapping exact tokens per header to an editable
`requiredEnv` input or a fixed literal, where its presence — even empty — selects
explicit binding mode so `{name}` and `${NAME}` stay literal regardless of global
`requiredEnv` names, and only catalogs without it use the legacy global input scope,
with collision-safe names for same-named inputs in separate headers. Header templates
accept both spellings and consume the `$`, while URL templates keep the upper-case
`${NAME}` rule so a header declaration never makes bare `{name}` in a URL editable, and
`collectCatalogPlaceholders` and `resolveCatalogEntry` select the same pattern per
field. stdio templates keep `${NAME}` unchanged, bindings never enter the host
`McpServerInput` or persisted config, and `requiredEnv` names are validated against the
transport: variable names for `http`, environment-variable names for `stdio`.

## Consequences

- Declared editable header variables prompt and resolve by their own defaults, while
  fixed variables and unbound brace text prompt for nothing and header-local bindings
  prevent cross-header leakage.
- Bare URL tokens stay literal through mapping, resolution, and host persistence.
- Builtin catalog entries and stdio packages behave as before, and the catalog can
  express a header variable that is not an environment-variable name.
