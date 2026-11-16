# ADR 0156: Simplify the Add-Provider Common Path

- Status: Accepted
- Date: 2026-09-05
- Updates: ADR 0116, ADR 0155

## Context

The add-provider dialog stacked Service, Name, Base URL, API key, and API format
before the model panes, so the first-run path looked like a generic gateway form
even for named endpoints that already know their name, URL, and wire format.

## Decision

A new dialog starts with **Service** only. Choosing a named endpoint (Zhipu / Z.AI
API or Coding Plan, OpenCode Go) reduces the common path to Service + API key plus
a one-line host summary, while Custom endpoint shows Name, Base URL, and API key.
Name for named rows and API format for custom rows stay behind Advanced, and
OpenCode Go is a Service option rather than an API-format option. Persistence,
catalog matching, and the Completions flags of ADR 0155 are unchanged.

## Consequences

- Adding a known service is pick, paste, choose models.
- Custom gateways keep the previous Name / URL / key contract.
