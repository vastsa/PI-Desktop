# ADR 0297: Provider-hosted web search as an adapter capability

- Status: Accepted
- Date: 2026-09-19

## Context

Some providers execute web search server-side: Anthropic Messages ships a
`web_search_20250305` server tool, and OpenAI Responses (plus compatible
gateways) ships a `web_search` tool. Unlike an MCP search server, the search
runs inside the provider request, is billed by the provider per search, and
returns structured blocks (`server_tool_use` + `web_search_tool_result`,
`web_search_call`, `url_citation` annotations) that the client must keep in
the conversation for multi-turn grounding.

PR #570 previously added this as a composer toggle with runtime-level SSE
re-parsing; it was reverted (#608) with the owner asking for a plugin-shaped
follow-up. A capability review found the plugin SDK cannot reach the request
payload, the response stream, the composer, the transcript, or message
persistence, so "web search as a plugin" would require four new SDK extension
points — larger than the feature itself. This ADR records the host-built
shape that landed instead.

Two upstream facts forced the design:

- pi-ai 0.86.1 drops vendor search blocks in both adapters: the Anthropic
  stream loop has no `server_tool_use` / `web_search_tool_result` /
  `citations_delta` branches, and the Responses item loop has no
  `web_search_call` slot or annotation handling. Extraction must therefore
  live inside the adapters, not beside them.
- Anthropic requires `server_tool_use` + `web_search_tool_result` blocks
  (including `encrypted_content`) to be replayed verbatim on later turns.
  A display-only normalization cannot satisfy that; replay needs the raw
  wire blocks.

## Decision

1. **Capability is declared data, evaluated in one place.** The per-model
   opt-in is `ModelBinding.nativeWebSearch` (settings UI: a checkbox in the
   model's advanced sheet, disabled unless the provider's API style is
   `responses` or `anthropic_messages`). models.dev publishes no hosted-tool
   capability, so there is no catalog default; absent means off. The single
   evaluation point is `resolveNativeWebSearch` in
   `packages/shared/src/native-web-search.ts`, keyed on the resolved wire
   API — never vendor names, base URL hostnames, or model-id substrings.

2. **Attachment and extraction live in the pi-ai adapters**, delivered by
   extending `patches/@earendil-works__pi-ai@0.87.1.patch`:
   - `anthropic-messages.js` appends the `web_search_20250305` tool when
     `model.webSearch === true`, captures search blocks as `hostedSearch`
     content parts (raw wire block kept whole, streamed `input_json_delta`
     accumulated so the query is available live), collects `citations_delta`,
     and replays both halves of each pair in order on later turns.
   - `openai-responses(-shared).js` (and the Azure variant's own
     `buildParams`) appends the `web_search` tool, asks for
     `web_search_call.action.sources` via the opt-in `include` channel,
     creates a `hostedSearch` slot for `web_search_call` items, collects
     `url_citation` annotations, and replays the item for the same model.
   Both adapters push a `hosted_search_update` stream event per block
     transition; `patches/@earendil-works__pi-agent-core@0.87.1.patch` teaches
   the agent loop to forward it as `message_update` — without that second
   patch the events die in the loop's switch and search activity renders only
   when the whole turn finishes. The patches are a stopgap; the same changes
   should be proposed upstream and dropped once released.

3. **The flag travels the existing model-config channel.**
   `ModelConfigWithBinding` copies `nativeWebSearch` into
   `ModelConfig.webSearch`; `buildProviderModel` spreads catalog fields into
   the pi-ai `Model`, so no new IPC, sidecar parameter, or runtime rebuild
   hook is needed.

4. **Display data and replay data are separated, and both persist.** The
   runtime normalizes `hostedSearch` blocks into `UiMessage.hostedSearch`
   (`status/rounds[]` for activity rows; `replay[]` for the adapter's raw
   content parts, stripped of streaming scratch). Persistence is an additive
   `hostedSearch` transcript block (`ui_to_record` / `record_to_ui`) — no SQL
   migration. `historyToEntries` restores `replay` after thinking and before
   text so convertMessages can ground later turns after a restart. Transcripts
   written without `replay` still render; they just cannot ground. The
   wire-slimming functions (`streamingMessageIdentity`, `applyMessageUpdate`)
   carry the field so delta frames cannot drop it.

5. **UI is a transcript activity row per round, not a composer control.**
   Each round of a `hostedSearch` activity renders as a `HostedSearchRow` on
   the tool-row idiom (icon + name + query summary, chevron disclosure):
   searching state while the round is in flight, sources when expanded.
   Sources are plain text links — no favicon fetches — so reading a
   transcript never leaks source hostnames anywhere (the #579 rule).
   Citation badges in message text are out of scope for v1; links stay
   ordinary markdown links.

## Consequences

- Enabling the tool is per model, always-on while enabled, and takes effect
  on the next turn (runtime rebuild follows from modelConfig change). A
  session-level toggle and composer affordance can layer on later without
  touching the adapter contract.
- Gateways that mangle replay blocks surface as provider errors on the next
  turn; the user-visible remedy is unchecking the model's opt-in. No silent
  fallback strips the tool — a search that quietly did not happen is worse
  than an error.
- `pause_turn` keeps pi-ai's existing mapping to `stop`; a long searching
  turn may end early on the official Anthropic wire. This is a known
  limitation to revisit with the upstream patch.
- The original implementation omitted search from compaction serialization.
  The 2026-09-22 contract repair supplies actual search replay projections to
  the summary request instead. Prefix/tail retention is unchanged: compacted
  content becomes a model-generated text summary (not lossless raw replay),
  and retained-tail search follows the existing adapter replay policy. The
  model can search again when the summary lacks sufficient grounding.
- Search executes on the provider. There is no local fetch, no ask/allow
  prompt, and billing is the provider's. The model-level opt-in (default
  off) is the user consent surface.
