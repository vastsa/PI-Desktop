# ADR 0349: Project capability selections and app-owned instructions

- Status: Implemented candidate
- Date: 2026-11-04
- Deciders: PI-Desktop maintainers
- Related: [data storage](../spec/03-runtime/04-data-storage.md),
  [component spec](../spec/04-ux/08-component-spec.md)

## Context

A project previously inherited every enabled skill and MCP server in its scope.
Creating a project and then configuring its instructions required separate steps.
Users need a durable project-specific choice without granting capabilities that
are disabled globally, copying credentials, or modifying repository files.

## Decision

1. Store optional `capabilities: { skillIds?, mcpServerIds? }` on the existing
   host-owned `projectGroups` JSON record. Missing lists inherit the enabled,
   scoped catalog; an empty list selects none; an empty object restores both
   inherited lists. IDs are exact and case-sensitive. Unknown saved IDs survive
   catalog changes and remain removable in the editor.
2. Keep independent Markdown in `projectGroupInstructions`. Creation and editing
   accept optional top-level `capabilities` and `instructions`; omitted fields
   preserve saved values and empty Markdown clears them. Rust validates the
   complete operation and commits the group and instructions in one transaction.
   Legacy projects can be promoted while retaining instructions and memory; the
   response returns their new group ID. Remote groups use the same settings
   contract without editing local roots.
3. Reuse the existing key-value and configuration-sync boundaries. No new table,
   schema version, repository Markdown file, or extension API is introduced.
   Capabilities are limited to 512 IDs per list and 512 UTF-8 bytes per ID, with
   blank/control-character IDs rejected. Markdown is limited to 32 KiB UTF-8.
   Malformed persisted selections fail closed instead of becoming inheritance.
4. Main exposes a read-only, credential-free catalog of enabled/scoped choices.
   Enumeration does not connect MCP servers. Create and Edit use the same shared
   fields, with explicit inheritance, unavailable-choice removal, loading,
   retry, and stale-response protection. Reopening an existing project preserves
   untouched settings and saves explicitly supplied settings.
5. Read one group-context snapshot for a runtime launch. Filter skill catalogs
   and MCP discovery against the selection and existing enablement/scope rules.
   Recheck current selections at Skill/MCP dispatch, including after asynchronous
   preparation. Instructions and newly enabled catalog entries enter the next
   runtime launch; revocation also prevents subsequent dispatch in an active run.

## Consequences

Project preferences remain independent from global enablement and permissions.
Deleting, relocating, or synchronizing project settings follows existing host
ownership. Saving instructions never overwrites `AGENTS.md`. Catalog failure is
visible and does not discard saved IDs. This adds IPC/RPC fields and validation,
so renderer, Main, headless launch, native persistence, and sync need contract
and user-path coverage.

## Alternatives considered

- Write a Markdown/configuration file into every repository: rejected because
  it changes user files and cannot represent remote or multi-root ownership well.
- Treat selected IDs as grants: rejected because project preferences must not
  override disabled capabilities, project scope, or ordinary tool approval.
- Store a second renderer-owned settings database: rejected because it duplicates
  authoritative state and makes atomic saves and recovery unreliable.
