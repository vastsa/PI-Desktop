# ADR 0308: Remove the Pull Requests Destination and Listing Tool

- Status: Accepted
- Date: 2026-09-27
- Decision owners: PI-Desktop core

## Context

PI-Desktop had a Pull requests destination that ran `gh pr list` in the active
workspace and exposed the same listing through the optional local MCP control
catalog as `pulls/list`. The UI depended on the GitHub CLI and authentication
available to the Electron process; listing failures could leave the page with
no usable PR data. The page's review action only started an Agent prompt and
did not provide a dedicated GitHub review or write workflow.

The destination and its listing method form one narrow feature. Removing only
the page would leave an undocumented, otherwise unused GitHub capability in
the local MCP surface.

## Decision

Remove the Pull requests route, its global-search entry and page copy, the
`gh`-backed IPC handler, the `pulls/list` MCP catalog entry, the shared PR
summary type, and their dedicated tests and screenshots. Keep the general MCP
control plane, GitHub references in development workflows, and generic plugin
view icons unchanged.

## Consequences

- Users can no longer open a PR destination or call `pulls/list` through
  PI-Desktop's MCP control catalog. Existing local clients must stop relying on
  that operation.
- The change requires no data migration: PR summaries were fetched on demand
  and were not persisted.
- This decision does not remove user-directed GitHub work through other
  configured Agent tools, a terminal, or a browser.
