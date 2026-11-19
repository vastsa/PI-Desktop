# Pi 1.5.2 adoption

## Scope

Upgrade Agent Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, plus
Desktop's `pi-ai` and `pi-mcp`, from 1.5.0 to exactly 1.5.2, keeping the whole
Pi release group (including `pi-codemode`, `pi-schema`, `pi-telemetry`, and
`pi-tui`) aligned through the lockfile and exact release-age exclusions. No
Host protocol, database schema, persisted provider endpoint, permission
policy, extension `VERSION` marker, or storage ownership changes.

Official release notes: [Pi 1.5.1](https://github.com/earendil-works/pi/releases/tag/v1.5.1),
[Pi 1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2).

## Compatibility work

- Rebase the three pnpm patches onto the published 1.5.2 layouts.
  `pi-agent-core` applied unchanged. Manual ports:
  - `pi-ai` Anthropic adapter: 1.5.1 reads `compat` once at the top of
    `stream()` and adds message threads. The patch keeps transcript
    normalization inside the guarded `try` (so preparation errors still map to
    local request errors), marks preparation finished after the payload is
    serialized and before the threaded or plain send, and re-inserts the local
    request-error mapping in the catch path, now around upstream's
    `withCauseDetail` message.
  - The Claude Code version bump hunk is dropped: 1.5.2 ships the same
    `2.1.322` itself ("Anthropic OAuth requests reporting an outdated Claude
    Code version").
  - `pi-ai` `clampMaxTokensToContext`: 1.5.1 replaced the fixed margin with a
    15% input-proportional margin (#10497). The patch keeps upstream's new
    margin and only re-applies the model-aware `estimateContextTokens(context,
    model)` call.
  - `pi-coding-agent` compaction utils: re-add the `hostedSearchReplayProjection`
    import next to upstream's new `sliceHead` import.
- `pi-coding-agent` swaps its TUI Mermaid renderer (`grok-mermaid` to
  `lovely-mermaid`); Desktop does not use the TUI. Its `undici` stays 8.12.3,
  so the single-instance sidecar topology from 1.5.0 is unchanged.
- pi-ai 1.5.1 sends the documented `session-id` header instead of `session_id`
  on OpenAI Responses (#11639). Desktop adds `x-session-affinity` on top and
  never read the underscore form; the affinity test now asserts the new name.

## Adopted 1.5.1 / 1.5.2 features

- **Anthropic message threads.** pi-ai 1.5.1 sends only new messages and lets
  the server continue the conversation, keyed by the request's `sessionId`
  (default on for the `anthropic` provider at `api.anthropic.com`, opt-in via
  `compat.supportsMessageThreads`). Desktop's main turns already send the
  session id, so they get threads unchanged. Delegates and compaction
  summaries share that session id for gateway affinity, so they now pass
  `disableContinuation: true`: they neither continue nor overwrite the
  conversation's single continuation slot, which would otherwise force the
  next main turn back to a full request.
- **Session resource cleanup.** `DesktopAgentRuntime.dispose()` calls pi-ai's
  `cleanupSessionResources(sessionId)` after extensions close, releasing the
  per-session thread state and the strict-tool downgrade memory added in 1.5.1
  (#11626), as the upstream coding agent does on session teardown.
- **Qwen Token Plan Individual (China).** The new
  `qwen-token-plan-individual-cn` provider uses the same endpoint as the
  existing `alibaba-token-plan-cn` preset, so it becomes an alias of that row.
- **Inherited without Desktop code changes:** OpenAI-compatible requests omit
  an empty `tools` array (vLLM 0.20+), the `requiresToolsWithToolHistory`,
  `requiresNonNullAssistantContent`, and `promptCacheKeyMode` compat fields
  through catalog `compat`, Anthropic non-strict schemas keep root `$defs`,
  the OpenRouter output-limit margin, retries for streams cut short after the
  reply began, abort-during-lazy-load reported as abort, Azure GPT-6 context
  windows and long-context pricing, Claude Sonnet 5 temperature, OpenCode Go
  Claude 5.5 thinking-block binding, new default models, and Claude Fable 5.2
  in pi-ai's built-in catalog. Desktop's bundled models.dev catalog and
  overlays remain the source of what the UI offers.
- **Not applicable to Desktop:** idle prompt-cache warming (`cacheWarming`
  lives in the coding-agent session, which is not Desktop's agent loop),
  `pi auth login`, `pi update` summaries, TUI Mermaid rendering, terminal
  overlays and keybindings, grep/find/read/edit tool changes in the coding
  agent's own tools, RPC-mode shutdown, and the session fork prompt for a
  missing working directory (1.5.2).

## Desktop patch additions

- **GPT-6.2 Sol and Astra.** pi-ai 1.5.2 does not list `gpt-6.2-sol` or
  `gpt-6.2-astra` (released 2026-11-17). The pi-ai patch adds both to the
  `openai`, `openai-codex`, `github-copilot` and `opencode` provider data,
  cloned from `gpt-6.1-sol` / `gpt-6-astra` (same API, base URL, compat and
  thinking map) with the published prices. Gateway data (`openrouter`,
  `vercel-ai-gateway`) is not patched: those files are single-line JSON of
  several hundred KB and carry no transcript capability Desktop reads beyond
  `supportsMidConvoSystemMessages`. The bundled models.dev snapshot gains only
  the published records for these two ids (OpenAI, OpenCode, OpenRouter,
  Vercel and other gateways), not a full refresh. Drop the patch hunks once
  pi-ai ships the entries.

## Explicitly unchanged

- Existing user data needs no migration. No persisted format, RPC, Plugin
  SDK, or permission contract changes.
- `pi-coding-agent` remains transitional; it is not the normal Desktop agent
  loop, compaction engine, or durable session store.

## Validation

Task candidate: `chore/pi-1-5-2-upgrade` on `047c4eab1` (`origin/main`,
2026-11-18), run from the dedicated request worktree. No real provider or live
service was used.

- `pnpm build:js`, Desktop and Agent Runtime typecheck, `pnpm lint`,
  `pnpm check:agent-policy`, `pnpm check:pi-patches`,
  `pnpm check:pi-dependencies`, and `scripts/pi-patch-hash.test.mjs` passed.
- Agent Runtime: 136 test files, 2,041 tests passed, including the new
  `pi-anthropic-message-threads.test.ts`. Removing either
  `disableContinuation` or the dispose cleanup makes it fail.
- Shared 1,442, plugin-sdk 386, i18n 31, voice-runtime 52, plugin-devkit 53,
  computer-use 31, agent-host 66, racp 28, host-runtime 190, pi-host 68
  (1 skipped), and docs 14 tests passed.
- Desktop: 5,221 tests, 5,215 passed, 4 skipped, 2 failed, using the primary
  checkout's Electron 43.6.0 binary by link. `market-browse-user-path` timed
  out only under the full parallel run and passes alone.
  `image-model-disclosure-user-path` ("Saved marking must exclude chat") fails
  identically on the unmodified base commit; it exercises renderer model
  selection only and is outside this change.
- Rust host-core is untouched and was not run.
