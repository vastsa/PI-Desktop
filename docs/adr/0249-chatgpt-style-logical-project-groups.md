# ADR 0249: ChatGPT-Style Logical Project Groups

- Status: Accepted
- Date: 2026-09-13
- Deciders: PI-Desktop maintainers
- Amends: ADR 0233, ADR 0234, ADR 0016

## Context

The first multi-folder project flow selected several directories but treated
every directory after the first as an independent sidebar project. That does not
match the user-facing meaning of a ChatGPT Project: one named container should
own its chats, instructions, memory, and attached sources.

## Decision

1. A project group is a host-owned logical identity with a display name, an
   ordered list of local folder roots, and a primary root.
2. Group records and group-level instructions/memory are stored through the
   host-owned `kv` extension boundary.
3. Sessions created for a group continue to carry their primary project path for
   compatibility.
4. The sidebar and Project archive render one row per logical group.
5. The host keeps the primary root as the default visible workspace for builtin
   file tools.
6. The project overflow action is named **Edit project**.
7. Group creation, editing, shared instruction editing, and shared memory
   editing are additive IPC capabilities.

## Consequences

- A named group behaves like one ChatGPT-style project in the UI: its chats,
  instructions, and memory are shared across the selected roots.
- Existing projects retain their paths, sessions, transcripts, and renderer
  presentation metadata.
- The first folder remains meaningful as the default execution root and cannot
  be reordered in this iteration.
- Selecting another group still changes the one visible host workspace; a
  background session remains bound to its own primary path.
- The native picker remains local-only.

## Alternatives considered

- **Keep additional folders as independent tabs:** rejected because it loses the
  logical project relationship and duplicates the ChatGPT Project identity.
- **Move multi-root execution into the renderer or sidecar:** rejected because
  it bypasses the host-owned filesystem and permission boundary.
- **Add a new relational schema immediately:** rejected because the existing
  host `kv` extension boundary can durably store this configuration without
  changing the schema version.
