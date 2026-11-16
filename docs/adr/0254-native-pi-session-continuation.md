# ADR 0254: Continue native Pi sessions in their canonical JSONL

- Status: Accepted
- Date: 2026-09-14
- Decision: D421
- Supersedes: baseline D007 only for session discovery; one-shot import remains available

## Context

PI-Desktop historically imported Pi sessions by flattening them into
Desktop-owned transcripts, which preserves neither the native tree, compaction,
and custom entries nor the ability to accept turns sent later from either
application. The coding-agent SDK already owns the v3 session format and the
native model, auth, and resource lifecycle.

## Decision

1. The Node agent sidecar exposes a source-discriminated `pi-native` adapter that
   discovers files below Pi's agent session directory and below each
   `sessionDir` Pi resolves, projects immutable byte snapshots through
   `SessionManager.inMemory`, and opens a persistent `SessionManager` only when a
   prompt is accepted.
2. Native identity is an opaque composite of canonical file path and native
   header id, and paths never cross the preload boundary; Electron merges native
   summaries with Rust-owned Desktop summaries, while Rust stays the exclusive
   SQLite and Desktop-transcript owner.
3. Continuation uses `createAgentSession` with Pi `ModelRuntime`,
   `SettingsManager`, `DefaultResourceLoader`, the saved provider, model, and
   thinking level, and the original `SessionManager`, with no Desktop provider
   fallback and no `UiMessage` reconstruction.
4. The slice covers list, detail, refresh, a text-only Agent prompt without tools
   (`noTools: "all"`), stop, and renderer-local pin/archive, with fork and side
   chat added by the amendments; rename, delete, move, revision, Plan/Goal,
   queue, collaboration, attachment, and transcript rewrite stay rejected.
5. A cooperative sidecar lease serializes Desktop writers: the adapter verifies
   canonical file identity and full-byte fingerprint before each SDK append and
   that exactly one expected line with the right entry and parent was added
   after it, failing closed on divergence. A stale lease is reclaimed only for a
   dead local PID whose target is unchanged or a complete append-only
   extension, and live, remote, malformed, or uncertain ownership is never
   stolen.
6. Any version other than exactly v3, a missing trailing newline, missing cwd,
   unavailable saved provider or auth, untrusted project resources, corrupt
   identity, or another live lease keeps the session browseable and read-only
   with an explicit reason, and projection never repairs or migrates the source.

## Consequences

- Native branches, compaction data, custom and context messages, and unknown
  entries survive untouched because reads are in memory and writes are SDK
  append-only, with `context_edit` entries covered by the same lease and
  parent-chain guard.
- Native compact and session-addressed queue push/list fail with
  `NATIVE_PI_UNSUPPORTED` before host access, so a native path never creates a
  host queue entry.
- An uncooperative Pi writer can still race inside the OS append; the adapter
  detects the divergence, preserves bytes, and requires a reload, so full mutual
  exclusion needs every Pi client to adopt the lease protocol.

## Amendment: native side-chat forks (2026-09-14)

The `sidechat:` panel and tab described here were removed by ADR 0268; the
`session.fork` capability they routed to remains and is used by the Fork action.

`session/fork` is source-discriminated: Desktop sources keep the Rust
`session.fork` contract, while `native-pi:` sources route to a sidecar
`native.session.fork` that returns the child as an ordinary `SessionDetail`, and
the renderer never supplies or receives a file path. A native fork branches the
parent snapshot through the SDK (`createBranchedSession`), so ancestry, label
re-chaining, compaction re-parenting, and unknown entries follow SDK rules. The
child is a new v3 JSONL in the parent's session directory whose header
`parentSession` points at the canonical source path, published by writing a
complete temporary file and hardlinking it after verifying the staged inode and
content hash. A failed fork exposes no partial child, clobbers nothing, and
removes only files this operation wrote; an altered staging or published file
fails closed with `NATIVE_PI_SESSION_CHANGED` and its bytes are preserved.

A child with no saved model records the parent session's saved provider and
model, and with no saved thinking change the parent's level, while an explicit
branch value including "off" always wins. Forking is a data-only copy that
executes no model and loads no project resources, so it stays allowed while the
parent is provider-unavailable or project-untrusted without granting prompt
readiness.

## Amendment: configured sessionDir discovery (2026-10-18)

Pi writes a session into `sessionDir` when that setting appears in global
`~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`, and Desktop history must
discover those files with the same resolution the CLI uses, in addition to the
recursive default root `<agentDir>/sessions`.

- An absolute or `~` global `sessionDir` is scanned without a known project,
  while a relative value resolves from each known local project working
  directory rather than the Desktop process cwd; remote project ids are ignored.
- Custom directories are scanned non-recursively as Pi's flat `*.jsonl` layout,
  and a file is admitted only when its real path stays inside the default root or
  a resolved `sessionDir`, so symlink escapes are dropped.
- Detail, prompt, and fork authorize a file against the default root, the session
  directories of the current project list, and any directory that already
  admitted it; a fork publishes the child beside its parent, and trust and
  provider gates still follow the session header cwd.
