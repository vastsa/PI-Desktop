# ADR: Preserve chronological model system state

- Status: Accepted
- Date: 2026-10-01
- Issue: #1285
- References: [Pi PR #9548](https://github.com/earendil-works/pi/pull/9548),
  [Pi model authority](pi-ai-core-0991-authority.md)
- Updates: ADR 0039 catalog refresh, ADR 0225 deferred-tool restoration

## Context

Moving new tool declarations to the beginning of a conversation changes its
cached prefix. Rebuilding from visible chat alone also loses the chronology of
instruction and tool changes. Pi 0.99.1 already owns tool-state diffing and
provider request projections; Desktop owns session persistence and permissions.

## Decision

Keep Pi's provider-neutral system messages in chronological order. Use the
existing Host-owned transcript writer and optional versioned `modelSystem`
metadata on hidden system rows, acknowledging writes before dispatch. Anchors
preserve model order when the user row was pre-persisted. Save the effective
state once at explicit compaction; restore it before the summary and retained
tail. Keep current mode/catalog/Host permissions authoritative for execution.

Separate Desktop's runtime instructions, skill catalog and contextual guidance
into replaceable sections. The skill-loading header uses `skills`, and each
catalog entry uses `skill:<exact-id>`; a change or removal appends only that
entry's replacement or null tombstone. The fixed prefix prevents collisions with
other Desktop section names. Restoring a legacy aggregate `skills` section
replaces it with the header and individual entries once at continuation.
Catalog-only skill changes refresh an idle runtime;
body loading and permission checks stay at the existing Host bridge. Tool schema
changes cannot reuse an idle runtime merely because tool names are identical.

Retain the published model/API/endpoint identity before account overrides.
Accept transcript capability opt-ins only when that identity matches the actual
request route. Let Pi adapt the request for partial or absent support; never
persist an adapter's folded projection.

The current models.dev catalog remains authoritative for published limits,
prices and modalities. Independently copy only the five transcript transport
flags and their original binding from Pi's exact published model. Do not derive
transport support from a models.dev metadata match or an account endpoint
override. Both Pi and models.dev metadata projections can carry that binding;
unverified routes and generic records retain the conservative fallback.

The Pi 1.0.0 dependency patch adds the missing mid-conversation system
capability to its `deepseek-flash` catalog entry. Authorized official-endpoint
experiments confirmed both preserved cache reuse and effective updated
instructions. Keep this correction in the single Pi catalog, not a parallel
Desktop allowlist; remove the hunk when an upgraded Pi catalog carries it.
The model/API/endpoint binding check still excludes aliases and relays. Native
tool-addition and tool-change flags are not enabled by this correction.

## Stable declarations across provider transports

Choose the declaration strategy by the bound Pi transport capabilities, not a
model-name allowlist. Responses (OpenAI/Codex) with verified system support
and `additional_tools` or client tool search, Chat Completions with verified
system/tool additions, and Pi's transcript transport retain native chronological
additions. Other transports declare the complete current catalog in deterministic
name order from the first request. In particular Anthropic's native transition
blocks still grow its request-level schemas, so they use fixed declarations.
This policy also covers compatible relays without enabling unsupported native
message roles or switching their configured API.

Desktop currently exposes Chat Completions, Responses, Codex Responses,
Anthropic Messages, Gemini and Pi Messages bindings. This change does not add
new selectable Azure, Vertex, Bedrock or Mistral native bindings; models offered
through existing compatible endpoints follow that endpoint's adapter.

Keep activation separate from declarations in a versioned `tool_activation`
system section. The section records active deferred names and a SHA-256 identity
of the account, model, API, endpoint, declarations and deferred-name set. Updates
append after tool results and persist through the existing Host journal and
compaction checkpoint. Before provider conversion, omit this Desktop-only
activation section and any resulting empty metadata-only message. Preserve all
other instruction sections, content and tool deltas. Providers that fold system
messages must not rewrite their leading instructions just because execution
activation changed. ToolSearch results tell the model which tools were activated;
uncertain models may search again. Canonical persisted history is not mutated.
Restoration never interprets the complete declaration
snapshot as permission to execute every tool. Successful ToolSearch results
newer than the saved activation section recover an interrupted activation.
Invalid, unknown-version or mismatched state grants no activation. Legacy
histories without this section retain their existing activation evidence rules.

Check activation before extension hooks or Host execution, then retain all
existing mode, approval and Host restrictions. A catalog/schema/mode/account or
route change starts a new declaration epoch and invalidates prior activation;
removed tools cannot be invoked. Temporary prompt replacement must preserve the
activation metadata. Current runtime activation remains authoritative between
prompts; declarations do not re-grant revoked activation.

Use 128 functions as a conservative shared fixed-catalog ceiling, including
DeepSeek Chat Completions' limit. If the full catalog exceeds that ceiling, or its estimated prompt/schema cost leaves less than the ordinary
retained-tail budget below the automatic compaction threshold, use the existing
on-demand path and log the fallback reason. Never truncate a catalog. Context
estimation charges the full declared catalog while fixed declarations are active.

The first request is larger. Short conversations may cost more overall even
when later cache-hit ratios improve. Acceptance compares cold and subsequent
uncached tokens and cumulative input cost across both short and longer synthetic
conversations; no universal savings or hit-rate guarantee is made.

## Alternatives and consequences

Prepending a reconstructed snapshot was rejected because it changes history on
ordinary continuation. A new persistence store or adopting Pi AgentSession
would create another session owner; optional canonical metadata preserves the
current process and data boundaries without a database migration. Unknown old
histories establish their first baseline at continuation rather than inventing
past state. Downgrades remain readable but do not retain these cache guarantees.

The added records consume transcript storage. A failed write stops dispatch as
a local preparation failure; retry uses the same row ID. Providers may still
fold unsupported updates and lose cache reuse. Even native mid-conversation
system support does not guarantee provider cache reuse. Entry-level updates
reduce new input tokens without changing instruction roles or priority. Offline tests prove ordering,
restoration and payload compatibility, not real-provider cache-hit ratios.
