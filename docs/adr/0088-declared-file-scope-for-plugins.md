# ADR 0088: Plugin file access is declared per mode, and deletion is recoverable

- Status: Accepted (Implemented 2026-08-15)
- Date: 2026-08-15
- Related: ADR 0008, D009

## Context

ADR 0008 put plugin main code in a `utilityProcess`, but permissions still gate
only the `pi.*` surface, so the granularity of that gate is the whole design
until capability sandboxing (ADR 0008, D009) lands. That granularity was three
workspace-wide switches — `fs.read.workspace`, `fs.write.workspace`,
`fs.delete.workspace` — reaching `.env`, `.git/config`, and, through `fs.glob`
in a loop, the whole workspace. Lexical prefix containment let a workspace
symlink point at `~/.ssh`, and a missing grants argument auto-granted the entire
manifest. The permissions matrix had always promised confirm-on-first-use; this
record delivers it, plus recoverable deletion, because the risks of read, write,
and delete are not symmetric.

## Decision

### 1. `manifest.fs` declares scope; permission names stay flat strings

`permissions` stays `readonly string[]` and gains `fs.read`, `fs.write`, and
`fs.delete` for "may this plugin touch files at all", while a sibling `fs` block
carries per-mode `root`, `scope`, and `own`. Flat strings are kept because
permissions travel as strings through install review, grants, and the separately
versioned marketplace catalog; whole-tree patterns are refused for write and
delete, and an absent scope means every access falls to the user.

### 2. Four gates, in a fixed order

Every `pi.fs.*` call checks the declared-and-granted permission, then realpath
containment of root and target (a path that does not exist reports `NOT_FOUND`
rather than an escape attempt), then an unconditional deny-list of credentials,
history, and the host's own data directory, and finally declared scope or user
consent. `pi.fs.glob` answers to the same rules, so a name is a read too.

### 3. Deletion has two tiers, and always goes to the trash

`own: true` deletes only paths the host recorded in a host-owned write ledger
when the plugin wrote them, falling to consent once the file's mtime has moved;
a declared `scope` covers everybody else's files and is shown with the
permissions. Both tiers use `shell.trashItem` rather than `rm`, keep
`recursive: false`, and answer to a rolling brake of 50 deletes per 60s per
plugin.

### 4. Consent is a native dialog, and never more durable than the session

Out-of-scope access asks Deny / Allow once / Allow this session; a session grant
covers the containing directory and dies with the process, and a host with no
consent service refuses.

### 5. `root: "userSelected"`

`pi.fs.requestDirectory()` returns a memory-only handle that grants that
directory without manifest scope while containment and the deny-list still
apply, which restores bulk file workflows with zero standing power.

### 6. Migration is a breaking downgrade

Legacy `fs.write.workspace` becomes `fs.write` with an empty scope and
`fs.delete.workspace` becomes `fs.delete` with `own: true`, so capability is
reduced and no hole opens; the Plugins page marks downgraded plugins.

## Consequences

- Writes and deletes outside declared scope prompt, and a denial is audited as
  `PERMISSION_DENIED`; plugins predating `manifest.fs` lose write and delete
  reach on the next load, visibly rather than silently.
- Reads stay generous, which is a bet on the egress allowlist in
  `manifest.net.domains`.
- A malicious plugin can still call `node:fs` directly; this bounds the `pi.*`
  surface and leaves the sandbox case to ADR 0008 D009.

## Alternatives

- Host-owned quarantine directory with an undo UI — rejected: it copies the
  user's files to offer recovery the OS already provides.
- Objects inside `permissions` — rejected: permissions are strings end to end
  across review, grants, and catalog.
