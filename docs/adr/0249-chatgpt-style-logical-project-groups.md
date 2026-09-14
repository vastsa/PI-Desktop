# ADR 0249: ChatGPT-Style Logical Project Groups

- Status: Accepted
- Date: 2026-09-13
- Deciders: PI-Desktop maintainers
- Amends: ADR 0233, ADR 0234, ADR 0016

## Context

The first multi-folder project flow selected several directories but treated
every directory after the first as an independent sidebar project. That does
not match the user-facing meaning of a ChatGPT Project: one named container
should own its chats, instructions, memory, and attached sources.

PI-Desktop still has a frozen security boundary in which host-core exposes one
visible workspace to the agent at a time. A logical project group must therefore
not be implemented by making the renderer or sidecar own a multi-root security
policy.

## Decision

1. A project group is a host-owned logical identity with a display name, an
   ordered list of local folder roots, and a primary root. The first selected
   folder is always primary.
2. Group records and group-level instructions/memory are stored through the
   host-owned `kv` extension boundary. Existing path projects remain readable
   as legacy single-root groups, so no user database reset or migration is
   required.
3. Sessions created for a group continue to carry their primary project path
   for compatibility. The runtime resolves group instructions and memory from
   that path before launching the agent, so all chats in the logical group see
   the same project context.
4. The sidebar and Project archive render one row per logical group. Expanding
   a row shows all roots and the group's sessions; additional roots are not
   opened as independent project tabs.
5. The host keeps the primary root as the default visible workspace for builtin
   file tools. A tool request using an absolute path under another registered
   group root is canonicalized and may use that root as its containment base;
   group membership never grants arbitrary external filesystem access.
6. The project overflow action is named **Edit project**. The editor can change
   the group name and adjust its root list through the additive
   `project.group.update` capability. The primary root remains first and cannot
   be removed; a root with existing chats cannot be detached.
7. Group creation, editing, shared instruction editing, and shared memory editing
   are additive IPC capabilities. Legacy path-scoped instruction and memory
   APIs remain available for legacy single-root groups.

## Consequences

- A named group behaves like one ChatGPT-style project in the UI: its chats,
  instructions, and memory are shared across the selected roots.
- Existing projects retain their paths, sessions, transcripts, and renderer
  presentation metadata.
- The first folder remains meaningful as the default execution root and cannot
  be reordered in this iteration. Additional roots can be adjusted from Edit
  project, subject to chat-preservation and host ownership checks, and are
  available only through explicit absolute paths that pass host canonical
  containment.
- Selecting another group still changes the one visible host workspace; a
  background session remains bound to its own primary path.
- The native picker remains local-only. Remote project sources are not implied.

## Alternatives considered

- **Keep additional folders as independent tabs:** rejected because it loses the
  logical project relationship and duplicates the ChatGPT Project identity.
- **Move multi-root execution into the renderer or sidecar:** rejected because it
  bypasses the host-owned filesystem and permission boundary.
- **Add a new relational schema immediately:** rejected because the existing
  host `kv` extension boundary can durably store this configuration without
  changing the schema version.
