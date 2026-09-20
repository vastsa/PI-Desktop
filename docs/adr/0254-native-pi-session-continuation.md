# ADR 0254: Continue native Pi sessions in their canonical JSONL

- Status: Accepted
- Date: 2026-09-14
- Decision: D421
- Supersedes: baseline D007 only for session discovery; one-shot import remains available

## Context

PI-Desktop historically imports Pi sessions by flattening them into Desktop-owned transcripts. That copy cannot preserve the native tree, compaction, custom entries, or receive turns subsequently sent from either application. The coding-agent SDK already owns the v3 session format and native model/auth/resource lifecycle.

## Decision

1. The Node agent sidecar exposes a source-discriminated `pi-native` adapter. It discovers files below Pi's agent session directory, projects immutable byte snapshots through `SessionManager.inMemory`, and opens a persistent `SessionManager` only when a prompt is accepted.
2. Native identity is an opaque composite derived from canonical file path plus native header id. Paths never cross the preload boundary. Electron merges native summaries with Rust-owned Desktop summaries; Rust remains the exclusive SQLite and Desktop-transcript owner.
3. Native continuation uses `createAgentSession` with Pi `ModelRuntime`, `SettingsManager`, `DefaultResourceLoader`, saved provider/model/thinking, and the original `SessionManager`. There is no Desktop provider fallback and no `UiMessage` reconstruction for model context.
4. The first slice supports list, detail, refresh, text-only Agent prompt with no tools (`noTools: "all"`), stop, and renderer-local pin/archive. Built-in and extension model tools stay disabled until an explicit Desktop permission bridge is designed; this is not full Pi tool parity. Rename, delete, move, revision, Plan/Goal, queue, collaboration, attachment, and transcript rewrite operations are rejected; fork and side chat are added by the amendment below.
5. A cooperative sidecar lease serializes PI-Desktop writers. Before each SDK append, the adapter verifies canonical file identity and full-byte fingerprint; after append it verifies exactly one line with the expected entry and parent was added. Divergence fails closed. A stale lease is reclaimed only for a dead local PID when the target is unchanged or a complete append-only extension with the same file identity, original byte prefix, and continuous parent chain. Capability refresh exposes reclaimable dead-owner leases without deleting them; only acquisition reclaims. Live, remote, malformed, or uncertain ownership is never stolen. An owned idle runtime remains promptable, while an active runtime is stoppable and rejects overlap until settlement. This cannot make an uncooperative Pi Web/CLI process honor the lease, so optimistic validation remains mandatory.
6. Version other than exactly v3, a missing trailing newline, missing cwd, unavailable saved provider/auth, untrusted project resources, corrupt identity, or another live lease keeps the session browseable and read-only with an explicit reason. Projection never repairs or migrates the source file.

## Consequences

- Desktop sessions and their host-owned persistence are unchanged.
- Native branches, compaction data (including unknown fields such as `retainedTail`), custom/context messages, and future unknown entries remain untouched because reads are in-memory and writes are SDK append-only.
- An uncooperative writer can still race within the OS append operation. The adapter detects prefix/suffix divergence after the append, preserves bytes, disposes the runtime, and requires reload; full mutual exclusion requires Pi clients to adopt a shared lease protocol.
- `@earendil-works/pi-coding-agent` is a runtime dependency of the bundled sidecar and its session format behavior is version-pinned.
- `bindExtensions` runs native startup/resource discovery with the SDK headless UI (`mode: "print"`, `hasUI: false`), error ownership, and explicit unsupported session controls. Guards and listeners precede startup; failure disposes the session and lease. Native extensions are trusted local code, not Desktop plugins or sandboxed tools.
- ModelRuntime initializes the local catalog/auth snapshot without model network refresh; the exact saved provider/model/auth is required. Native Composer readiness uses `canPrompt`, independently of Desktop provider secrets.
- Desktop terminal completion follows SDK prompt settlement (after `agent_settled` hooks and final persistence), not intermediate `agent_end`. Durable user acknowledgements reconcile caller optimistic IDs to SDK IDs without changing native entry IDs or deduplicating text. Abort refreshes native detail and never rewrites/restores a durable user row.
- Native compact and session-addressed queue push/list fail with `NATIVE_PI_UNSUPPORTED` before host access. Queue remove/prioritize retain the existing opaque **host turnId** contract, not a session/source contract. Native paths never create host queue entries; future native queue support requires an explicit source/session protocol extension.
- Listing still synchronously parses complete changed and unchanged files. Projection caching and bounded async scanning are deferred; no responsiveness bound is claimed for large catalogs in this slice.

## Amendment: native side-chat forks (2026-09-14)

The `sidechat:` panel and tab described in this amendment were removed by ADR
0268; the `session.fork` capability they routed to remains in place and is used
by the Fork action.

`session/fork` is now source-discriminated. Desktop sources keep the existing
Rust `session.fork` contract; `native-pi:` sources route to a sidecar
`native.session.fork`, which returns the child as an ordinary `SessionDetail`.
The renderer never supplies or receives a file path.

A native fork branches the parent snapshot through the SDK
(`SessionManager.inMemory` + `createBranchedSession`), so ancestry, label
re-chaining, compaction re-parenting, and unknown entries follow the SDK's own
rules. The parent file and its live manager are never mutated; the child is a
new v3 JSONL in the parent's session directory with a header `parentSession`
pointing at the canonical source path. Child metadata (title, and a fallback
model/thinking) is appended in memory. Publication writes a complete temporary
file (device/inode plus content hash captured from the exact payload), then
hardlinks it to the final name after verifying that the staged file is still
that inode with those exact bytes; the published child is verified against the
same identity/hash before any projection or registration. A failed fork never
exposes a partial child, never clobbers or renames an existing file, and
removes only files whose device/inode and content still match what this
operation itself wrote. An altered staging or published file fails closed with
`NATIVE_PI_SESSION_CHANGED` and its uncertain bytes are preserved rather than
deleted. The source bytes and our own running/opening state are re-checked
immediately before publication; drift fails closed. As with the rest of the
window, an uncooperative external writer that acts between verification and
link is outside the cooperative-lease contract; the snapshot checks catch what
they can and never touch the parent.

When the selected branch saved no model, the child records the **parent
session's saved** provider/model; when the branch saved no thinking-level change
at all, it records the parent's saved level. An explicit branch value, including
"off", always wins. There is no Desktop provider/auth fallback. Forking is a
data-only copy: it executes no model and loads no project resources, so it
remains allowed while the parent is provider-unavailable or project-untrusted.
That does not grant prompt readiness - the child reports the same read-only
reason and keeps the existing auth/trust gate until it is satisfied.

The side-chat panel streams native replies: `NativePiRuntime` projects
`message_start`/`message_update` under a provisional row id and the terminal
`message_end` names that exact id in the additive `replacesMessageId` field, so
the renderer re-keys only that row through `projectMessageEnd` (active,
cached/retained, and side-chat projections share the same seam); a generic
Desktop completion carries no field and never touches another row. Durable user acknowledgements also
reconcile the side-chat projection. Closing the panel removes only the renderer
registration and tab; the child remains a native session in the sidebar and in
title/project search, and reopens as an ordinary conversation. A send while a
native turn is running fails before the Desktop queue with a visible message and
a preserved draft; native sessions still cannot enqueue.
