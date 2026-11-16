# ADR 0249: ChatGPT-Style Logical Project Groups

- Status: Accepted
- Date: 2026-09-13
- Amends: ADR 0233, ADR 0234, ADR 0016

## Context

The first multi-folder flow selected several directories but treated every
directory after the first as an independent sidebar project, which is not the
ChatGPT Project meaning of one named container owning its chats, instructions,
memory, and sources. Host-core still exposes one visible workspace at a time, so
a logical group cannot be built by giving the renderer a multi-root security
policy.

## Decision

1. A project group is a host-owned logical identity with a display name, an
   ordered list of local folder roots, and a primary root, which is always the
   first selected folder.
2. Group records and group-level instructions and memory live in the host-owned
   `kv` extension boundary, and existing path projects stay readable as legacy
   single-root groups, so no database reset or migration is required.
3. Sessions keep their primary project path, and the runtime resolves group
   instructions and memory from it before launching the agent.
4. The sidebar and Project archive render one row per group; expanding it shows
   all roots and the group's sessions instead of opening extra project tabs.
5. The host keeps the primary root as the default visible workspace, and a tool
   request under another registered root is canonicalized against that root;
   group membership never grants arbitrary filesystem access.
6. **Edit project** changes the group name and root list through the additive
   `project.group.update` capability, which can promote a registered root to
   primary; the primary root stays first and cannot be removed, and detaching a
   root that has chats leaves those chats as a standalone project.
7. Group creation, editing, shared instruction editing, and shared memory
   editing are additive IPC capabilities, and path-scoped legacy APIs remain.

## Consequences

- A group behaves like one ChatGPT-style project, sharing chats, instructions,
  and memory across its roots.
- Existing projects keep their paths, sessions, transcripts, and presentation
  metadata.
- Selecting a group still switches the one visible host workspace, and the
  native picker stays local-only.

## Alternatives

- Keep additional folders as independent tabs: rejected, it loses the logical
  project relationship.
- Move multi-root execution into the renderer or sidecar: rejected, it bypasses
  the host-owned filesystem boundary.
