# ADR 0308: Remove the Pull Requests Destination and Listing Tool

- Status: Accepted
- Date: 2026-09-27

## Context

A Pull requests destination ran `gh pr list` in the active workspace and also
exposed that listing as `pulls/list` in the local MCP control catalog, so the UI
depended on GitHub CLI authentication in the Electron process. Removing only the
page would have left an undocumented, otherwise unused GitHub capability in the
MCP surface.

## Decision

Remove the Pull requests route, its global-search entry and page copy, the
`gh`-backed IPC handler, the `pulls/list` MCP catalog entry, the shared PR
summary type, and their tests, while keeping the general MCP control plane,
GitHub references in development workflows, and generic plugin view icons.

## Consequences

- Users can no longer open a PR destination or call `pulls/list` through the
  MCP control catalog, so existing local clients must stop relying on it.
- No data migration is needed because PR summaries were fetched on demand.
- User-directed GitHub work through other Agent tools, a terminal, or a browser
  is unaffected.
