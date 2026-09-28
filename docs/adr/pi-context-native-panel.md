# ADR: Native context panel over the trusted extension bridge

- Status: Accepted for implementation
- Date: 2026-09-25
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md`

## Context

Pi-Context exposes category snapshots and context-pack commands. The terminal-only
`ui.custom` and `ui.setWidget` methods are deliberately inert in PI-Desktop.
The desktop already owns the work panel and a session-scoped trusted-extension
status transport. The old standalone `~/.pi/agent/extensions` discovery is not
part of the launch path; ADR 0215 makes active plugin contributions authoritative.

## Decision

1. An **enabled plugin contribution** may load Pi-Context into the Agent
   sidecar. A junction in the CLI extensions directory alone never enables it.
2. The sidecar projects only the current model-context messages as a read-only
   `sessionManager.getBranch()` view. Its lightweight coding-agent import shim
   provides `getAgentDir`, `buildSessionContext` over those active messages,
   pi-ai-backed `estimateTokens`, a lightweight skill formatter for category
   estimates, and the pinned Pi SDK's read-only skill scanners and frontmatter
   helpers. Those SDK helpers are loaded lazily in the sidecar, not eagerly in
   Electron Main. The terminal UI is not loaded into the renderer and SQLite
   stays in host-core. Persisted session semantics are unchanged.
3. Only `pi.events.emit("context:snapshot", snapshot)` crosses the existing
   trusted-extension status transport, with a 256,000-character JSON limit.
   The always-mounted renderer status listener validates and retains the latest
   snapshot per session in a bounded in-memory cache; older events cannot
   replace newer snapshots. The work panel reads that cache even when opened
   after the turn. The cache is not persisted across renderer reloads and raw
   event JSON is never rendered in the human-readable status line.
4. The native Context work-panel tab shows one capacity summary (model-reported
   used and remaining) and a non-overlapping estimated breakdown. Messages,
   System prompt, and Memory files share the estimated category total;
   Skills, tools, MCP, commands, bundles, and custom agents are nested within
   System prompt and share that estimate instead. A mismatch between category
   estimates and model usage is labelled, not hidden. Zero and deferred
   categories remain available without dominating the list.
   Without a snapshot it labels last-request usage as an estimate, not a
   fabricated Messages/Free breakdown. Export/import/handoff still invoke the
   existing sidecar commands. Plugin permissions and project activation remain
   unchanged.

## Consequences

This adds a bounded sidecar-to-renderer data use of the existing status channel;
no new Electron IPC channel or Rust persistence is introduced. The extension
must be imported/enabled through the existing plugin workflow before its
categories or pack commands become available. A future generic extension event
bus needs a separate contract and decision.
