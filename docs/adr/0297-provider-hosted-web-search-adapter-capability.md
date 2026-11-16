# ADR 0297: Provider-hosted web search as an adapter capability

- Status: Accepted
- Date: 2026-09-19

## Context

Some providers run web search server-side — Anthropic Messages ships a
`web_search_20250305` server tool and OpenAI Responses ships `web_search` — and
that search runs inside the provider request, is billed per search, and returns
structured blocks the client must keep for multi-turn grounding. PR #570 added it
as a composer toggle with runtime SSE re-parsing and was reverted in #608,
because a plugin-shaped version would need four new SDK extension points and
pi-ai 0.86.1 drops vendor search blocks in both adapters.

## Decision

### 1. The capability is declared data gated by the resolved wire API

The per-model opt-in is `ModelBinding.nativeWebSearch`, offered only when the
resolved route is `responses`, `openai_codex_responses`, or
`anthropic_messages`; absent means off, because models.dev publishes no
hosted-tool capability. Runtime `resolveNativeWebSearch` keys on the final adapter
API, never on vendor names or model-id substrings.

### 2. Attachment and extraction live in the pi-ai adapters

A `patches/@earendil-works__pi-ai` patch appends the vendor tool, captures search
blocks and citations, and replays each request and result pair on later turns in
the Anthropic, OpenAI Responses (including Azure), and Codex Responses adapters,
each pushing `hosted_search_update` transitions that the `pi-agent-core` patch
forwards as `message_update`. The patches are a stopgap to propose upstream and
remove once released.

### 3. The flag travels the existing model-config channel

`ModelConfigWithBinding` copies `nativeWebSearch` into `ModelConfig.webSearch` and
`buildProviderModel` spreads it into the pi-ai `Model`, so no new IPC, sidecar
parameter, or runtime rebuild hook is needed.

### 4. Display data and replay data are separated, and both persist

The runtime normalizes `hostedSearch` into `UiMessage.hostedSearch` with
`status/rounds[]` for activity rows and `replay[]` for the adapter's raw content
parts, persisted as an additive `hostedSearch` transcript block with no SQL
migration; `historyToEntries` restores `replay` after thinking and before text so
later turns stay grounded. Transcripts written without `replay` still render, they
just cannot ground.

### 5. The UI is a transcript activity row per round, not a composer control

Each round renders as a `HostedSearchRow` on the tool-row idiom with a searching
state and an expandable list of plain text source links, so reading a transcript
never fetches favicons or leaks source hostnames (the #579 rule). Citation badges
in message text are out of scope for v1.

Amended 2026-09-24: an opted-in request may be resolved through a shared
published-route table before the final wire gate, so DeepSeek Completions uses its
same-origin Anthropic interface and xAI and legacy OpenAI Completions use
same-origin Responses while search is enabled. Only exact official HTTPS origins
and paths match, saved provider settings are never rewritten, and the model,
registry, history restoration, and delegation all use the same effective API.

## Consequences

- Enabling the tool is per model, always-on once enabled, and effective on the
  next turn; a session toggle can layer on later without touching the adapters.
- A gateway that mangles replay blocks surfaces as a provider error whose remedy
  is unchecking the opt-in; nothing silently strips the tool.
- Search runs on the provider with no local fetch and no allow prompt, so the
  model-level opt-in is the consent surface, and compaction replays search
  projections through the 2026-09-22 contract repair.
