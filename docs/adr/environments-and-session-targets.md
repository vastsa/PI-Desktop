# ADR: Environments and composer session targets

- Status: Accepted
- Date: 2026-11-20
- Related: D689, [Remote git workspaces](remote-git-workspaces.md)

## Context

A repository can be shared by several sessions, while a session's tools need
their own branch and checkout. A named environment selects a paired Host and
provides setup configuration.

## Decision

The local Host stores environments, repository project markers, and per-session
workspace bindings in separate existing key-value namespaces. Every paired Host
exposes an implicit default environment. The composer resolves a target through
Electron main, which starts the remote prepare job, persists its id, and resumes
polling after a reconnect or restart. The existing durable prompt queue admits
new input until the binding is ready. Remote tools and files use the bound
checkout. Sessions without a ready binding fail closed in repository projects.

Forks prepare from the parent's local work branch and inherit its environment
and base branch. Scheduled sessions use the project's default branch and its
Host's default environment. The repository project is shared by sessions on the
same Host and repository.

## Consequences

The main clone provides common Git storage. A per-session checkout protects
working files and permits parent-only commits to survive a fork. SQLite and
RACP schema versions stay the same. A dedicated project per session would
duplicate navigation state. A new SQL table would require a schema migration.
