# ADR: Preserve chronological model system state

- Status: Accepted
- Date: 2026-10-01
- Issue: #1285
- References: [Pi PR #9548](https://github.com/earendil-works/pi/pull/9548),
  [Pi model authority](pi-ai-core-0991-authority.md)
- Updates: ADR 0039 catalog refresh, ADR 0225 deferred-tool restoration

## Context

Moving new tool declarations to the beginning of a conversation changes its
cached prefix, and rebuilding from visible chat loses the chronology of
instruction and tool changes. Pi 0.99.1 already owns tool-state diffing and
request projections, while Desktop owns session persistence and permissions.

## Decision

Keep Pi's provider-neutral system messages in chronological order, written through
the existing Host-owned transcript writer with optional versioned `modelSystem`
metadata on hidden system rows and acknowledged before dispatch, so anchors
preserve model order when the user row was pre-persisted. Save the effective state
once at explicit compaction and restore it before the summary and retained tail,
while current mode, catalog, and Host permissions stay authoritative for
execution.

Desktop's runtime instructions, skill catalog, and contextual guidance become
separate replaceable sections: the skill-loading header uses `skills` and each
catalog entry uses `skill:<exact-id>`, so a change appends only that entry's
replacement or null tombstone. A legacy aggregate `skills` section is replaced
once at continuation, catalog-only skill changes refresh an idle runtime, body
loading and permission checks stay at the existing Host bridge, and a tool schema
change never reuses an idle runtime on identical names.

The published model, API, and endpoint identity is retained before account
overrides, and transcript capability opt-ins are accepted only when that identity
matches the actual request route, letting Pi adapt partial support instead of
persisting a folded projection. models.dev stays authoritative for published
limits, prices, and modalities, while only the five transcript transport flags and
their original binding are copied from Pi's exact published model. Under that
model, the Pi 1.0.0 dependency patch adds the missing mid-conversation system
capability to the `deepseek-flash` catalog entry, verified on the official endpoint
for cache reuse and effective instructions, and stays in the single Pi catalog
rather than a parallel Desktop allowlist.

For that exact official binding, declare the complete current tool catalog in
deterministic name order from the first request, with ToolSearch changing only
execution activation and other bindings keeping on-demand schema publication.
DeepSeek caps a request at 128 functions, so a catalog that exceeds it, or whose
prompt and schema cost leaves too little retained tail below the compaction
threshold, falls back to the on-demand path with a logged reason; a catalog is
never truncated.

Activation stays separate in a versioned `tool_activation` system section that
records the active deferred names and a SHA-256 identity of the account, model,
API, endpoint, declarations, and deferred-name set. It never turns a declaration
snapshot into execution permission: invalid or mismatched state grants no
activation, temporary prompt replacement preserves the metadata, and any
catalog, schema, mode, account, or route change starts a new declaration epoch.

## Consequences

- Ordinary continuation preserves history and cache prefixes without a new
  persistence store or migration, and unknown old histories establish their first
  baseline at continuation.
- Added records consume transcript storage, and a failed write stops dispatch as a
  local preparation failure that retries with the same row ID.
- The first request is larger, so short conversations may cost more overall; no
  universal savings are promised, and providers may still fold unsupported
  updates and lose cache reuse.

## Alternatives

- Prepend a reconstructed snapshot: rejected; it changes history on ordinary
  continuation.
- Adopt Pi AgentSession or a new persistence store: rejected; it creates another
  session owner.
