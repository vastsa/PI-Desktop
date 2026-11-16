# ADR 0297: Provider-hosted web search as an adapter capability

- Status: Accepted
- Date: 2026-09-19

## Context

Some providers execute web search server-side: Anthropic Messages ships a
`web_search_20250305` server tool, and OpenAI Responses (plus compatible
gateways) ships a `web_search` tool. Unlike an MCP search server, the search
runs inside the provider request, is billed by the provider per search, and
returns structured blocks (`server_tool_use` + `web_search_tool_result`,
`web_search_call`, `url_citation` annotations) that the client must keep in the
conversation for multi-turn grounding.

- pi-ai 0.86.1 drops vendor search blocks in both adapters: the Anthropic stream
  loop has no `server_tool_use` / `web_search_tool_result` / `citations_delta`
  branches, and the Responses item loop has no `web_search_call` slot or
  annotation handling.
- Anthropic requires `server_tool_use` + `web_search_tool_result` blocks
  (including `encrypted_content`) to be replayed verbatim on later turns.

## Decision

1. **Capability is declared data and gated by the resolved wire API.** The
   per-model opt-in is `ModelBinding.nativeWebSearch` (settings UI: a checkbox
   in the model's advanced sheet, disabled unless its resolved search route is
   `responses`, `openai_codex_responses`, or `anthropic_messages`). models.dev
   publishes no hosted-tool capability, so there is no catalog default; absent
   means off.

2. **Attachment and extraction live in pi-ai adapters**, delivered by extending
   `patches/@earendil-works__pi-ai@0.87.1.patch`:
   - `anthropic-messages.js` appends `web_search_20250305` when opted in,
     captures search blocks as `hostedSearch`, collects citations, and replays
     both halves of each pair on later turns.
   - `openai-responses(-shared).js` and Azure's `buildParams` append
     `web_search`, request `web_search_call.action.sources`, capture search
     items/citations, and replay the item for the same model.
   - `openai-codex-responses.js` uses a separate Codex request builder and
     ChatGPT subscription endpoint.
All three adapter paths push `hosted_search_update` transitions. The
`pi-agent-core` patch forwards them as `message_update`, so activity renders
while a search is in flight instead of only at turn completion.

3. **The flag travels the existing model-config channel.**
   `ModelConfigWithBinding` copies `nativeWebSearch` into
   `ModelConfig.webSearch`; `buildProviderModel` spreads catalog fields into the
   pi-ai `Model`, so no new IPC, sidecar parameter, or runtime rebuild hook is
   needed.

4. **Display data and replay data are separated, and both persist.** The runtime
   normalizes `hostedSearch` blocks into `UiMessage.hostedSearch`
   (`status/rounds[]` for activity rows; `replay[]` for the adapter's raw
   content parts, stripped of streaming scratch).

5. **UI is a transcript activity row per round, not a composer control.** Each
   round of a `hostedSearch` activity renders as a `HostedSearchRow` on the
   tool-row idiom (icon + name + query summary, chevron disclosure): searching
   state while the round is in flight, sources when expanded.

## Consequences

- Enabling the tool is per model, always-on while enabled, and takes effect on
  the next turn (runtime rebuild follows from modelConfig change).
- Gateways that mangle replay blocks surface as provider errors on the next
  turn; the user-visible remedy is unchecking the model's opt-in.
- `pause_turn` keeps pi-ai's existing mapping to `stop`; a long searching turn
  may end early on the official Anthropic wire.
- The original implementation omitted search from compaction serialization.
- Search executes on the provider.

## 2026-09-24 amendment: one service entry for official search

DeepSeek's saved Completions configuration cannot carry the hosted search tool
available on its published Anthropic interface. Keep the existing per-model
search opt-in and resolve the request through a shared published-route table
instead.

Only exact official HTTPS origins and paths match; vendor/model labels do not.
Unknown relays and explicit non-Completions protocols stay unchanged.
