# ADR 0254: Continue native Pi sessions in their canonical JSONL

- Status: Accepted
- Date: 2026-09-14
- Decision: D421
- Supersedes: baseline D007 only for session discovery; one-shot import remains available

## Context

PI-Desktop historically imports Pi sessions by flattening them into
Desktop-owned transcripts. That copy cannot preserve the native tree,
compaction, custom entries, or receive turns subsequently sent from either
application.

## Decision

1. The Node agent sidecar exposes a source-discriminated `pi-native` adapter.
2. Native identity is an opaque composite derived from canonical file path plus
   native header id.
3. Native continuation uses `createAgentSession` with Pi `ModelRuntime`,
   `SettingsManager`, `DefaultResourceLoader`, saved provider/model/thinking,
   and the original `SessionManager`.
4. The first slice supports list, detail, refresh, text-only Agent prompt with
   no tools (`noTools: "all"`), stop, and renderer-local pin/archive.
5. A cooperative sidecar lease serializes PI-Desktop writers.
6. Version other than exactly v3, a missing trailing newline, missing cwd,
   unavailable saved provider/auth, untrusted project resources, corrupt
   identity, or another live lease keeps the session browseable and read-only
   with an explicit reason.

## Consequences

- Desktop sessions and their host-owned persistence are unchanged.
- Native branches, compaction data (including unknown fields such as
  `retainedTail`), custom/context messages, and future unknown entries remain
  untouched because reads are in-memory and writes are SDK append-only.
- With the 0.87.1 coding-agent pin, `context_edit` entries are append-only and
  affect only the SDK's future model-context projection.
- An uncooperative writer can still race within the OS append operation.
- `@earendil-works/pi-coding-agent` is a runtime dependency of the bundled
  sidecar and its session format behavior is version-pinned.

## Amendment: native side-chat forks (2026-09-14)

The `sidechat:` panel and tab described in this amendment were removed by ADR
0268; the `session.fork` capability they routed to remains in place and is used
by the Fork action.

`session/fork` is now source-discriminated. Desktop sources keep the existing
Rust `session.fork` contract; `native-pi:` sources route to a sidecar
`native.session.fork`, which returns the child as an ordinary `SessionDetail`.

## Amendment: configured sessionDir discovery (2026-10-18)

Pi writes a session into `sessionDir` when that setting is present in global
`~/.pi/agent/settings.json` or in `<cwd>/.pi/settings.json`. Desktop history
must discover and open those files with the same resolution the CLI uses, in
addition to the default agent session root (`<agentDir>/sessions`).

- The default root stays a recursive scan, so sessions written before a custom
  directory remain visible.
- An absolute or `~` global `sessionDir` is scanned even when no project is
  known.
- Custom directories are scanned non-recursively, matching Pi's flat `*.jsonl`
  layout.
- Detail, prompt, and fork authorize the file against the default root, the
  session directories for the current project list, and any session directory
  that already admitted a file.
