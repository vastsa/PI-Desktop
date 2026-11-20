# ADR: GitHub tools for the Agent through the hosted MCP server

- Status: Accepted
- Date: 2026-11-20
- Related: D691, [Built-in GitHub connector](github-connector.md)

## Context

A GitHub connection can provide Issue and Pull Request tools to desktop
sessions. Existing user-configured MCP servers must keep their own credentials.

## Decision

Electron main adds an in-memory record for the GitHub-hosted MCP endpoint
with the `issues,pull_requests` toolsets. The MCP OAuth hook supplies the
connector token only to that specific built-in record. An existing server
named `github` takes precedence. Connectors settings can disable the built-in
server. A credential change closes its cached connections and refreshes the
workspaces' tool lists. Calls use the existing MCP tool permission rules.

## Consequences

The same credential can serve the desktop's GitHub REST operations and the
built-in MCP server. Existing user records keep their own credentials and
tools. The compatibility of third-party GitHub OAuth device-flow tokens
remains an acceptance item after an OAuth App is registered. The manual probe
reports whether the hosted server can initialize and list its tools.
