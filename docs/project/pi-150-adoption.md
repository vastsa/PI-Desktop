# Pi 1.5.0 adoption

## Scope

Upgrade Agent Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, plus
Desktop's `pi-ai` and `pi-mcp`, to exactly 1.5.0. Keep the Pi release group
aligned through the lockfile and exact release-age exclusions, which now include
the new `pi-schema` package. No Host protocol, database schema, persisted
provider endpoint, permission policy, extension `VERSION` marker, or storage
ownership changes.

Official release notes: [Pi 1.5.0](https://github.com/earendil-works/pi/releases/tag/v1.5.0).

## Compatibility work

- Rebase the three pnpm patches onto the published 1.5.0 package layouts.
  `pi-agent-core` applied unchanged. `pi-ai` needed manual ports where 1.5.0
  replaced re-parsing with incremental tool-call parsing and moved compat
  schemas to `pi-schema`:
  - Anthropic hosted-search capture now registers `server_tool_use` and
    `web_search_tool_result` blocks in the adapter's `openBlocks` map and
    streams the query through `ToolCallArgumentsStream`, instead of an
    `index` / `inputJson` scratch on the block.
  - `requiresNonEmptyReasoningReplay` is declared with the pi-schema builders.
  - Local request-error mapping is re-inserted where 1.5.0 removed the
    per-block scratch cleanup from the Anthropic and OpenAI Responses catch
    paths.
  - `pi-coding-agent` only needed its `Api` type import re-applied.
- `pi-ai` no longer re-exports TypeBox. Agent Runtime imports `Type` from its
  existing direct `typebox` dependency. Tool schemas stay plain JSON Schema, so
  validation on pi-schema accepts them unchanged.
- Bump Agent Runtime's direct `undici` from 8.10.2 to 8.12.3 to match
  `pi-coding-agent` 1.5.0. Two 8.x copies split `pi-ai` into two peer instances
  and pulled undici into the sidecar entry (891 KiB, over the 500 KiB gate);
  one copy restores 315 KiB and the 1.4 instance topology.

## Inherited without Desktop code changes

- Incremental tool-call argument parsing in providers and agent proxy streams
  (lower CPU and memory for large streamed tool calls).
- pi-schema coercion for plain JSON Schema tools, including MCP tools (numeric
  strings, single value to array). Validation messages shown to the model
  change wording.
- JPEG-first image resizing in the bundled coding-agent resize worker.
- Provider fixes: Gemini `const` to `enum`, Bedrock strict-tool retry,
  OpenRouter reported costs, LiteLLM overflow detection, Claude
  system-after-empty-assistant ordering and capped effort, Kimi K3.1 settings,
  GPT-5.4/5.5 tool namespace after model switch, OpenCode endpoints.
- GPT-6.1 Terra and the models.dev v2 catalog in pi-ai's built-in models.
  Desktop's bundled models.dev catalog and overlays remain the source of what
  the UI offers.

## Adopted 1.5 features

- **Billed vs. estimated cost.** `usageFromPi` records a total marked
  `usage.cost.totalFromProvider` as `costStatus: "reported"`, even when the
  model has no catalog rates, and keeps unmarked totals `estimated`. Replay back
  into Pi restores the marker. Persisted cost keeps its five numeric fields.
- **Served model.** Agent Runtime stores Pi's `responseModel` as the additive
  `responseModelId` message field when it differs from the requested model and
  is not a dated snapshot of it (`response-model.ts`). Host-core round-trips it
  through record meta with no SQL migration; older builds ignore it. The model
  chip shows the served model and labels the requested one (`chat.servedByModel`
  in all shipped locales), and error details show both.
- **Extension `pi.exec()`.** `extensions/managed-exec.ts` now decodes output
  across chunk boundaries, caps stdout and stderr combined in bytes (default
  10 MiB), terminates on overflow with `truncated: true` and a nonzero code, and
  resolves a spawn failure with code 1 and the spawn error in stderr.
  `ExtensionExecResult` gains `truncated`.
- **Zhipu/Z.ai `1308`.** Desktop's classifier treats the JSON error code `1308`
  (plan usage limit, sent as 429) as terminal `PROVIDER_ERROR`, so neither retry
  budget replays it.
- **GPT-6.1 Terra.** The bundled models.dev catalog is refreshed to the current
  snapshot, which lists `gpt-6.1-terra` for OpenAI and Azure (1.05M context,
  reasoning). The refresh also drops `openai/gpt-image-1` from chat records;
  image settings metadata lives in `settings-operation-metadata.json` and is
  unaffected. ChatGPT (Codex) accounts list models from the live
  `/codex/models` endpoint; `CODEX_MODELS_CLIENT_VERSION` is unchanged because
  verifying a newer client version needs a real account.
- Not applicable to Desktop: TUI rendering, `pi update` / self-update command,
  extension package changelogs, terminal keybinding hints.

## Explicitly unchanged

- Existing user data needs no migration. No persisted format, RPC, Plugin SDK,
  or permission contract changes.
- `pi-coding-agent` remains transitional; it is not the normal Desktop agent
  loop, compaction engine, or durable session store.

## Validation

Task candidate: `chore/pi-1-5-upgrade` rebased onto
`28d5d07de18f` (`origin/main`, 2026-11-06), run from the dedicated request
worktree with the primary checkout's Electron and a worktree-built debug Host.

- `pnpm check:pr-base`, `pnpm build:js`, Desktop typecheck, lint, and
  `pnpm docs:check` passed. Pi dependency and patch gates and patch-hash fixture
  tests passed.
- Agent Runtime: 122 test files, 1,769 tests passed. Shared: 1,402 passed.
  i18n: 31 passed.
- Desktop: 4,864 tests, 4,861 passed, 3 skipped, 0 failed. On the earlier base
  three timing-sensitive tests (`macos-signing-watchdog`, `npm-executable`,
  `remote-host-ssh-transport`) timed out once under the full parallel run and
  passed 41/41 alone.
- Host-core: `cargo fmt --check` passed; 1,210 of 1,211 tests passed. The one
  failure, `review_rpc_records_workspace_scratch_and_approved_external_write_edit`,
  fails identically on the unmodified base commit. Clippy reports two existing
  warnings in `review.rs` and `transcripts.rs`.
- Trusted-extension E2E passed 57/57.
- Hosted-search E2E passed 10/10 only with a local, uncommitted fake-host
  addition for `tools.fileBatchCapabilities`. Without it every scenario stops
  with `Unsupported fake-host RPC`: `bdc35fa12` added that runtime RPC but not
  the handler in `scripts/e2e/hosted-search-sidecar.mjs`, which this change
  does not touch. That fixture gap is a separate fix.
- No real provider or live service was used.
