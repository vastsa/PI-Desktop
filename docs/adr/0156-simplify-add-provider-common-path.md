# ADR 0156: Simplify the Add-Provider Common Path

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Updates ADR 0116 and ADR 0155

## Context

The add-provider dialog stacked Service, Name, Base URL, API key, and API
format before the model panes. Named Zhipu / Z.AI endpoints already know their
name, URL, and wire format, so those extra fields made the first-run path
look like a generic gateway form.

## Decision

A new dialog starts with only **Service**. After a named endpoint is chosen
(Zhipu / Z.AI API or Coding Plan, OpenCode Go), the common path is Service +
API key, plus a one-line host summary. Custom endpoint then shows Name, Base
URL, and API key. Name (named rows) and API format (custom rows) stay behind
Advanced. OpenCode Go is a Service option, not an API-format option.

No stepper, vendor-card grid, or extra `apiStyle` values. Persistence, catalog
matching, and Completions flags from ADR 0155 are unchanged.

## Consequences

- Adding a known service is pick + paste + choose models.
- Custom OpenAI-compatible gateways keep the previous Name / URL / key
  contract, with API format still available in Advanced.
- OpenCode Go is discoverable next to other named services.
