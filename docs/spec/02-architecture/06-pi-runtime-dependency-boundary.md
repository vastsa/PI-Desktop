# 06. Pi Runtime Dependency Boundary

## 1. Purpose

PI-Desktop uses the pi agent loop without adopting the CLI's session runtime
or giving a JavaScript package ownership of desktop persistence. Package
boundaries must keep that split clear as upstream packages evolve.

## 2. Current ownership

The sidecar pins `@earendil-works/pi-agent-core`, `pi-ai`, and
`pi-coding-agent` together at exactly `1.1.0`; Desktop's `pi-ai` and `pi-mcp`
development dependencies use the same release. Target-release package patches
remain narrow compatibility deltas and are listed with their audited behavior
in `docs/project/pi-110-adoption.md`.

- `@earendil-works/pi-agent-core` supplies the agent loop and its stable agent,
  event, and tool types. Agent Runtime owns desktop-specific compaction,
  prompt-template expansion, and session-context projection.
- `@earendil-works/pi-ai` supplies provider transports, auth, message types,
  request retries, and token estimation. Hosted-search request and estimation
  behavior remains covered by PI-Desktop's pi-ai patch and contract tests.
- Rust `host-core` remains the sole owner of SQLite and authoritative durable
  session state. The Node sidecar asks it to persist checkpoints and tool
  outcomes through the existing RPC contract.
- `@earendil-works/pi-coding-agent` is a transitional dependency. Production
  imports are confined to native Pi session continuation and its session-file
  manager; that native-session path still uses the package's AgentSession and
  native session behavior. Trusted extensions receive a small compatibility
  shim from `extensions/loader.ts`. The normal Desktop agent runtime,
  host-core checkpoint-compaction path, and durable session store do not use
  the package's AgentSession.

The extension shim is a versioned compatibility subset, not the full 1.1.0
coding-agent API. Its legacy `VERSION` marker remains sourced from
`TRUSTED_EXTENSION_KERNEL_VERSION` and intentionally identifies the modeled
0.87.1 extension surface.

Do not reintroduce imports from removed `pi-agent-core` harness, session,
compaction, or prompt-template APIs. Keep desktop behavior in the agent-runtime
boundary and use public `pi-ai` APIs for provider-facing operations.

## 3. `pi-durable` assessment

`@earendil-works/pi-durable` is a candidate for a later runtime migration, not
a drop-in replacement for the removed `pi-agent-core` helpers. The
[upstream README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
currently marks the API experimental and subject to change. It provides a
complete `Harness` over `Session` storage, immutable conversation entries,
atomic commits, task checkpoints, compaction, and recovery. Its Node adapters
include SQLite and JSONL storage; the README states that one process owns a
storage at a time and that cross-process locking is not provided.

Those semantics differ from PI-Desktop's current boundary: Rust host-core owns
the SQLite database and session records, while Node owns the in-memory agent
loop. Do not open a second SQLite writer against host-core's database. Before
adopting the durable harness, a separate ADR must compare these options:

1. Implement `pi-durable`'s `Storage` contract over host-core RPC, including
   the atomic transaction guarantees and storage conformance tests it expects.
2. Keep host-core as the source of truth and use an in-memory durable harness,
   with explicit reconstruction and recovery semantics from the host transcript.
3. Retain the current desktop-owned runtime if neither option preserves session
   compatibility and the existing host permission boundary.

The decision must account for existing SQLite data, JSONL/native Pi sessions,
checkpoint ordering, duplicate submissions, cancellation, process restart,
tool replay safety, and the single-writer rule. Any change to the frozen Rust
storage ownership or RPC contract requires a new ADR and a data migration plan.

## 4. Removing `pi-coding-agent`

The dependency is not a foundation for new agent-runtime code. Remove it after
these replacement seams are complete:

1. Replace `native-pi-session.ts`'s `AgentSession`, `SessionManager`,
   `ModelRuntime`, resource loader, trust-manager, and native compaction calls
   with a desktop-owned reader/writer over the existing native Pi JSONL format
   and the stable pi agent loop.
2. Keep the extension SDK contract backward compatible while making the
   runtime shim and any exported extension types desktop-owned. Preserve the
   current virtual-module behavior and discovery rules.
3. Remove the direct dependency, update package pins and patches together, and
   run native session, trusted-extension, compaction, build, and package-bundle
   checks against the new dependency graph.

Until then, new imports from `pi-coding-agent` require a concrete compatibility
need and must stay behind the native-session or extension-compatibility seams.
Do not move removed `pi-agent-core` APIs there as a shortcut.

## 5. Compatibility invariants

- Renderer, Electron Main, host-core, and sidecar ownership remain unchanged.
- Existing session data and public RPC / Plugin SDK contracts remain readable.
- The full transcript stays visible; compaction only changes model context and
  persists through host-core.
- Cancellation, provider retry, hosted-search validation, tool ordering, and
  extension discovery retain their current behavior.
- Any future switch to `pi-durable` is independently reviewed because it
  changes the runtime/session lifecycle and cannot be inferred from a package
  version update.
