# Decisions Log

> Baseline delta: `0.3.0` → `0.4.16`
> Date: `2026-08-14`
> Status: Accepted for implementation

This log freezes previously open questions into concrete decisions.

## A. High-priority architecture decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D001 | Electron ↔ Rust transport | **Rust sidecar + stdio JSON-RPC (NDJSON)** | Simple isolation, debuggable, replaceable later |
| D002 | SQLite ownership | **Rust host-core owns SQLite exclusively** | Single writer, clearer privilege boundary |
| D003 | Default mode | **Agent** | Product is an agent desktop, not pure chat |
| D004 | Former restricted profile | *(superseded by D189)* **The former Chat read-only profile is removed; persisted Chat values migrate to Plan.** | The product now has one Agent with a planning state and a separate approval boundary |
| D005 | Permission timeout | **120s → deny** | Fail closed, do not hang forever |
| D006 | `allow-session` scope | **By `toolName`** | Simple UX; workspace sandbox still enforces path safety |
| D007 | `~/.pi` compatibility | **No auto-import in MVP** | Keep config ownership clean in `~/.pi-desktop` |
| D008 | Node runtime packaging | **Dev uses system Node; release runs the bundled sidecar on the Electron binary via `ELECTRON_RUN_AS_NODE=1` (no separate Node shipped)** | Unblock M1–M4; resolved at M5, see 03-runtime/07-process-model §6 |
| D009 | Plugin runtime isolation | **Target = separate process; M4 may use host-managed sandboxed runtime** | Ship plugin foundation pragmatically without weakening API gateway |
| D010 | First release platform | **macOS arm64 only** | Focus acceptance and packaging |
| D373 | Remote Agent Control host boundary | *(amended by D374 and D375)* **Remote control (post-MVP) runs through a logical Agent Host that owns Sessions, Turns, event cursors, approvals, attachments, workspace policy, and crash recovery; a production Gateway owns identity, routing, rate limits, revocation, and audit, and the Agent Host connects outbound. The existing Electron IPC, `host.proxy`, and host-core stdio boundaries are never exposed.** | A remote surface needs its own boundary rather than a tunnel into local IPC or the host-core stdio contract (ADR 0205, E2E-221 through E2E-230) |
| D374 | Remote Agent Control v1 target amendments | **Amend D373 / ADR 0205: `RACP-WS` is the only normative v1 binding (`RACP-HTTP` is the browser profile, `RACP-GRPC` is reserved); typebox in `packages/shared` is the single contract source; the headless `packages/agent-host` module is the first deliverable and is shared by desktop IPC, local MCP, and RACP; cursors are `{ epoch, sequence }` with ephemeral deltas; the turn queue moves into the Host; host-core exposes `permissions.pending`; remote approvals carry the full local decision vocabulary under a default `ask` ceiling; browser clients use a cookie profile; the first deployment is single-tenant.** | Reviewing the D373 draft against the shipped desktop found the remote approval vocabulary narrower than the local contracts, pending requests held as connection state, per-token deltas exhausting the replay window, and more bindings than v1 can carry (ADR 0205) |
| D447 | Headless runtime boundary | **Amend ADR 0205 rollout R2 prerequisites (ADR 0284): the Electron-independent runtime layer under the Agent Host module lives in `packages/host-runtime` — the host-core and sidecar stdio transports, the restart supervisor (process-model §4 policy), the durable turn lifecycle (`RuntimeService` as the module's `RuntimePort`: `session.beginTurn` → user row → prompt → `session.endTurn`, abort lock, stale-terminal guard, single-flight finalization), transcript persistence with the D299 checkpoint, a headless launch resolver over host-core's own registries, approved Plan/Goal dispatch (D189), and the host-core adapters for `SessionPort` / `QueueStore` / `permissions.pending`. Electron main keeps thin adapters (binary and bundle locations, `ELECTRON_RUN_AS_NODE`, redacted stderr, schema/glibc diagnoses, renderer status pushes) and its own local prompt path. `TurnStartRequest` gains an optional `userMessageId`. No IPC, sidecar, host-core, Plugin SDK, default, or persisted-data change.** | `pi-host` must run the same lifecycle invariants as the desktop without Electron; a second implementation of abort locks, stale terminal events, and queue release after durable settlement would drift from the one the desktop already fixed |
| D448 | RACP-WS transport and device pairing | **Amend ADR 0205 rollout R2 (ADR 0285): `packages/racp` holds both ends of the normative `RACP-WS` binding. `RacpServer` dispatches every catalog operation through its role rule onto the Agent Host module and a `RacpHostOperations` interface the Host implements; `RacpClient` correlates requests, answers server-initiated requests, tracks the last durable cursor per session, reconnects with bounded backoff, and fails the dropped connection's in-flight calls with `HOST_DISCONNECTED` instead of re-sending them. Authentication is the header profile with Host-issued `pdt1.` device tokens and single-use, expiring `ppt1.` pairing tokens (hashed, constant-time compared; never in a URL); `connection/pair` mints an `owner` device. `connection/pair`, `project/register`, `project/browse`, `server.hostId`, the `events/closed` notification, and the codes `PAIRING_FAILED`, `PAIRING_TOKEN_EXPIRED`, `CAPABILITY_UNAVAILABLE`, `REMOTE_PATH_NOT_FOUND`, `REMOTE_PATH_FORBIDDEN`, `HOST_DISCONNECTED`, `HOST_BOOTSTRAP_FAILED`, `HOST_VERSION_MISMATCH`, `REMOTE_AUTH_FAILED`, `REMOTE_CONNECTION_FAILED`, `REMOTE_FORWARD_FAILED` join the contract (spec §14a). The bind refuses non-loopback addresses; attachments and the tool relay are advertised unavailable.** | The SSH-tunnel topology needs a server `pi-host` can bind and a client the desktop can run, with the pairing the security spec describes; the conformance behaviors that need no machine boundary become package tests |
| D451 | Review opens only on explicit user action | **A tool result never opens, activates, or resizes the work panel. The `tool_end` artifact gate and `shouldOpenReviewArtifact` are removed; Review is reached only from the `+` New launcher row or from the retained session context the viewport-fixed toggle / `Cmd/Ctrl + J` reveals. A successful workspace Write/Edit still records its message-owned inline review card in the transcript.** | An agent edit silently revealing a side panel competes with the user's own reading and layout, and the transcript card already carries the change evidence. See ADR 0043, `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md` §5, `04-ux/09-interaction-patterns.md`, E2E-057. |
| D452 | Plan and goal artifacts open in the bundled file view | **The contract approval card's artifact opener hands the immutable `.pi/plan/*.md` or `.pi/goal/*.md` path to the bundled `pi.file-manager` view whenever that view is launchable, and to the host file tab otherwise — the same preference and fallback a chat file reference already uses (ADR 0241). The artifact still creates or activates a tab in its originating session, so the approval reveal itself is unchanged; only the surface changes. Renderer-only; no protocol, host, storage, artifact-content, or permission change. See D189, ADR 0043, `04-ux/08-component-spec.md` §5.4 and §10A.2, `04-ux/09-interaction-patterns.md` §5A, E2E-106.** | The approval opener used a host file tab while every other project file the conversation names already opens in the user's own file view, so a plan or goal landed in the one surface the user does not browse project files in. |
| D459 | Restore resizable sidebar width with collapse-below-threshold | **Amend D408 / ADR 0238 and restore ADR 0141 (ADR 0290): the expanded sidebar is again a renderer-owned `240px..520px` column (default `275px`) with a right-edge handle that previews on pointer-down, persists on release, and supports ArrowLeft/ArrowRight (16px), Home, and End. A pointer width below `160px` collapses as a user action without overwriting the preferred expanded width; keyboard resize never collapses. Live maximum is the three-column remainder after MainChat's 450px floor. Renderer only; existing `pi.desktop.sidebarWidth` preference. See E2E-168.** | Long labels need reclaimable width; ADR 0238's fixed 275px pin blocked that while the live three-column budget could already cap a user-chosen width. This decision was mistakenly recorded as D451 (already used by Review-opens-only-on-explicit-user-action); renumbered per issue #620. |
| D457 | Signed macOS DMG is a two-icon install | **Amend D406 / ADR 0232 / ADR 0204: official and local DMGs contain only PI-Desktop.app and the Applications link on a branded 720×440 plate. They no longer include `If app won't open, read this.txt` or the command helper. macOS ZIP packages still ship both the opening note and `PI-Desktop-macOS-open.command` for trusted unsigned artifacts. See ADR 0296 and E2E-196b.** | Tagged DMGs are signed and notarized (D450); the unsigned-opening note on the installer read as an error. |
| D450 | Signed macOS GitHub Releases | **Amend D078 / ADR 0022: GitHub tag releases Developer ID-sign, notarize (`notarytool` via electron-builder 26), staple, and Gatekeeper-verify macOS DMG/ZIP before upload, using identity `Developer ID Application: XingYu Liu (DUV63RKYTW)` / team `DUV63RKYTW` from Actions secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Missing secrets fail the job. Local unsigned packaging without a certificate remains. `workflow_dispatch` may set `sign_macos: false` only for unsigned debug artifacts. Packaged macOS uses in-app `electron-updater` (ZIP + merged `latest-mac.yml`); Linux deb/rpm and Windows portable ZIP stay notify-and-link. No afterPack/afterSign adhoc codesign (ADR 0278).** | Production DMGs must open without a Gatekeeper warning, and signed macOS installs can download and restart into a new tag. See ADR 0289, E2E-196c, E2E-067A. |

## B. Secondary implementation defaults

| ID | Topic | Decision |
|---|---|---|
| D011 | TS schema validation | **typebox** |
| D012 | i18n library | **i18next + react-i18next** |
| D013 | Bash execution style in M3 | **Non-interactive only** (no PTY yet) |
| D014 | Command palette shortcut | **Cmd/Ctrl + Shift + P** |
| D015 | Plugin tool exposed name | **Forced prefix** `plugin_<pluginIdSafe>_<toolName>` |
| D016 | Uninstall plugin data | **Delete by default**, optional keep-data later |
| D017 | enable → load failure | **Auto fallback to disabled** |
| D018 | Plugin secrets in settings | **Not allowed in MVP** |
| D019 | Plugin session summary access | **Denied by default** *(amended by D336: granted only through `session.read`, and only for the in-flight tool session)* |
| D020 | Auto-update | **Post-MVP** |
| D021 | First-run onboarding | **Inline checklist (not modal wizard)** |
| D022 | Local telemetry | **Local logs only in MVP (no remote telemetry)** |


## C. Provider & model coverage decisions (0.3.4)

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D023 | Provider coverage goal | **Universal market coverage** (not a tiny fixed vendor list) | Globalization + real coding workflows |
| D024 | Coverage strategy | **pi-ai native providers + first-class OpenAI-compatible + custom providers** | Maximum reach without rewriting every SDK |
| D308 | Zhipu / Z.AI named endpoint presets | **Amend D024 / ADR 0116: the add-provider Service select offers four OpenAI-compatible Zhipu endpoints — China and international standard API plus GLM Coding Plan — with locked published URLs and models.dev `vendorKey`s (`zhipuai`, `zhipuai-coding-plan`, `zai`, `zai-coding-plan`). No new apiStyle or wire adapter. Completions requests on those URLs use `thinkingFormat: "zai"` and `zaiToolStream: true`. Custom endpoint remains available.** | Users had to know which BigModel / Z.AI URL to paste, and `vendorKey: "custom"` could catalog-match the wrong API vs Coding Plan record. Named presets keep coverage on the existing OpenAI-compatible path. See ADR 0155 and E2E-005D. |
| D389 | DeepSeek reasoning_content replay on aggregators | **Amend D024: Completions requests for DeepSeek-family models set `requiresReasoningContentOnAssistantMessages: true` when the row `vendorKey`, base URL, model id, or catalog `family` identifies DeepSeek. Do not change `thinkingFormat` for that match. pi-ai still auto-detects official `deepseek.com` URLs.** | DeepSeek thinking mode 400s if any replayed assistant message omits `reasoning_content`. PI-Desktop stores a UUID as `model.provider`, so SiliconFlow, Volcengine, and custom gateways never match pi-ai's `provider === "deepseek"` check. See E2E-005E. |
| D424 | DeepSeek reasoning across compaction | **Amend D389 / ADR 0136: restore thinkingSignature on history rebuild; store recent thinking in checkpoint `details.retainedReasoning` and replay after the summary; non-official DeepSeek Completions rows set `requiresNonEmptyReasoningReplay` so the pi-ai patch uses a documented placeholder instead of `""`. Official deepseek.com keeps empty-string fill.** | OpenCode / third-party DeepSeek V4.1 Flash 400s after compaction when empty reasoning is echoed (#296). |
| D309 | Add-provider common path is Service + key | **Amend D308 / ADR 0116 / ADR 0155: a new add-provider dialog starts with only Service. Named endpoints (Zhipu / Z.AI, OpenCode Go) then show Service + API key and a host summary. Custom endpoint then shows Name, Base URL, and API key. Name (named) and API format (custom) stay in Advanced. OpenCode Go is a Service option. No stepper or vendor-card grid.** | Stacking Name, Base URL, and API format next to Service made a known service look like a generic gateway. The common path should be pick a service and paste a key. See ADR 0156 and E2E-005 / E2E-005B / E2E-005D. |
| D310 | Custom API format stays beside the key; Service lists top models.dev vendors | **Amend D309 / ADR 0155 / ADR 0156: Custom endpoint shows Name + Base URL, then API key beside API format on the common path. Named Service options expand to models.dev-backed international and China first-party endpoints (OpenAI, Anthropic, Google, OpenRouter, Groq, xAI, Mistral, Together, Fireworks, OpenCode Go, Z.AI, DeepSeek, Qwen, Moonshot, Zhipu, SiliconFlow, Volcengine, MiniMax Anthropic Messages, MiniMax OpenAI-compatible, Kimi For Coding), each with a published URL and wire style. Named display names stay in Advanced.** | Custom gateways need the format next to the key, while named vendors should cover the usual domestic and international APIs without a closed allowlist. See E2E-005 / E2E-005B / E2E-005D. |
| D311 | Service picker is searchable; discovery waits for a stable choice | **Amend D310: the add-provider Service control is a searchable anchored menu (same pattern as the default-model picker), not a native select. Filtering is client-side over localized name, vendor key, aliases, and host. Named add-path discovery does not start until an API key is present (editing still reuses the stored secret). Custom endpoints still probe a valid URL without a key. The discovery hook does not mark loading until the debounce fires, and an endpoint change clears the previous list immediately.** | Native selects with optgroups are sluggish in the overlay, and changing Service or typing a key used to refetch/re-render on every change. Search matches how models are filtered. See E2E-005 / E2E-005D. |
| D312 | Service list is a flat vendor catalog; add Xiaomi | **Amend D310 / D311: named Service options are one vendor list, not International / China groups. Add Xiaomi (`vendorKey: "xiaomi"`, `https://api.xiaomimimo.com/v1`, Chat Completions). Custom stays first. Search still matches localized name, vendor key, alias, and host.** | Region headings split the same vendors users already search by name. Xiaomi's first-party MiMo API is a models.dev vendor. See E2E-005. |
| D025 | Model allowlist | **No closed product allowlist** | Models churn; power users need free-form IDs |
| D026 | Catalog sources | **bundled snapshot + discovery/refresh + user-defined** | Works offline and stays current |
| D027 | Default identity | **Model selection is `(providerId, modelId)`** | Same model id can exist on many gateways |
| D028 | Secrets | **OS safeStorage (or controlled fallback) via secretRef; never in provider JSON** | Security boundary with Rust host ownership |
| D029 | Local models | **Supported through OpenAI-compatible local gateways** | Ollama/LM Studio/vLLM without special-case architecture |
| D030 | Connection test | **First-class host method before trusting provider for runs** | Fail early, actionable setup UX |
| D031 | Secrets backend | **OS safeStorage primary + encrypted file fallback** | Robust on macOS first release |
| D032 | Workspace ignore | **security denylist + defaults + `.pi-desktopignore`** | Safe/predictable tool FS behavior |
| D033 | Tool result limits | **256KB/4000 lines defaults with explicit truncation markers** *(amended by D194, D306)* | Protect context & UI |
| D306 | Search/read truncation is a cut, not a window | **Amend D033 / D194: Read/Glob/Grep `truncated` is true only when the host cut content the caller asked for (byte budget, per-line clip, Grep/Glob match cap). A Read that returned the requested or default window of a longer file is complete for that window; `totalLines`/`offset`/`lineCount` and a next-offset `notice` describe the remainder. Default Read window is 2000 lines (max 4000). `BUDGET_SEARCH` is 128KB / 4000 lines. Per-line clip is 16,384 characters. The UI truncated chip follows this flag.** | The 48KB / 500-line window marked almost every source and spec file truncated, including successful paged reads, which hid real cuts and forced the agent to re-search what it already had. |
| D307 | Revision payloads follow the live branch | **Amend D109: a regenerate branch keeps growing after its archive (later prompts, error-ended turns that never reach `agent_end`), so every operation that discards the live branch first writes it back over the variant it belongs to. `session.activateRevision` re-archives the live branch of the family from the durable transcript before switching and takes the prefix from there; the regenerate path refreshes the stamped variant via `session.saveRevision { revisionIndex }`; `session.saveActiveRevision` refreshes an already-archived index instead of skipping it. The variant refreshed is the one the live root's `activeRevision` stamp names; a stamped variant with no index row yet is stored as its own variant, never over a previous one. Switching also carries each surviving message's owning `turn_id` and keeps checkpoints whose anchors survive.** | The archive was written once and reused forever: paging away from a branch that had grown since its agent_end archive, then back, restored the stale copy and silently deleted every later turn from the transcript and its JSONL. |
| D390 | Host-owned regenerate truncate | **Amend D199 / D258 / D307: `agent/prompt` truncates through `session.truncateFrom` under the host lock (identity-first cut, abort leftover running turn, archive discarded tail, rewrite prefix). The kept transcript does not cross JSON-RPC. An NDJSON request line over 64 MiB is `LIMIT_EXCEEDED` and does not end the stdin reader. Protocol version stays at 11. See ADR 0216 and E2E-246.** | Retrying a multi-thousand-message session timed out at 130 s on `session.replaceMessages` and could kill host stdin at 64 MiB (issue #211). |
| D391 | Host stdout sender must not outlive serve | **Amend D390 / ADR 0216: the Windows Alt+Space hook retains only a weak clone of the stdout sender. After stdin EOF, dropping serve's sender closes the writer channel and host-core exits. Electron rejects an NDJSON request over 64 MiB before writing, with `LIMIT_EXCEEDED`. A host-side oversize reply peeks the JSON-RPC id from the truncated prefix so the client does not wait 130 s. Serve waits at most 5 s for the stdout writer after stdin ends. Protocol version stays at 11. See ADR 0217 and E2E-247.** | On Windows v0.14.6 a 64 MiB stdin cap ended the reader, but a strong keyboard sender kept the writer thread alive, so host-core became a zombie and Electron reported `host RPC timeout: session.replaceMessages` (issue #211). |
| D392 | Effective image-input overrides across Composer and transport | **Amend D243 / ADR 0101: image capability starts with the published model record, then an exact binding's `supportsImages` value wins when it is `true` or `false`; absent or `null` follows the published value. Composer badges, attachment status, and main-process image transport use the same effective result. Unknown/custom models remain conservative without an explicit override. See ADR 0218 and E2E-163.** | A configured endpoint could already transport an image through its binding override while the Composer row still hid the vision badge, or could show a published badge after image input was disabled for that endpoint. |
| D393 | User-invoked Skills in the composer | **Amend D123 / D174 / ADR 0024 / ADR 0039: active built-in, plugin, and user Skills appear in a separate `Skills` group at the end of the composer slash menu. Selecting one inserts its exact id; Electron main revalidates the active project scope at send time and asks the model to call the local `Skill` tool, preserving on-demand body loading and existing permissions. Existing command names win collisions; inactive Skills remain literal slash text. See ADR 0219 and E2E-088b.** | D174's model-invoked catalog remains the body-loading and security contract, while a final explicit entry makes known workflows discoverable without moving Skill bodies into the renderer, prompt, or host protocol. |
| D394 | Windows work-panel chrome keeps one resource action cluster | **Amend D154 / D357 / ADR 0195: the open work-panel header keeps one compact resource switcher; resource close is owned by the existing keyboard-operable context-menu rows, the viewport-fixed toggle remains the only panel collapse control, and subagent detail returns with a back chevron. Windows/Linux native controls remain fixed at the window edge. Renderer-only; no panel state, window geometry, IPC, protocol, or storage change. See ADR 0220 and E2E-067.** | The header resource `X`, viewport-fixed toggle, and Windows native close cluster read as duplicate close actions and became cramped at narrow panel widths. |
| D396 | Renderer and plugin-panel scrollbars share one compact contract | **Amend D300: every renderer scroll container uses one 6px, trackless, transparent-at-rest scrollbar with the same hover, focus-within, scroll-reveal, and dragged-thumb states. Remove the sidebar-specific width and opacity override. The plugin-panel preload applies the same contract and 300ms reveal mark to docked and detached plugin documents, including the bundled Files view. External pages loaded inside the Browser guest remain page-owned. Presentation-only; no protocol, storage, host runtime, or external-page behavior change. See E2E-157.** | Windows' classic scrollbar made the right-side work-panel Files view visibly heavier than the conversation, while the sidebar retained a second scrollbar treatment. |
| D-LOCAL-message-quotes | Message quotes and renderer-owned side chats | *(retired by ADR 0268 on 2026-09-16)* **Amend D209 / D301: every user message and assistant turn gains a Quote action that inserts a `> `-prefixed Markdown blockquote plus a `chat.quoteSource` attribution into the active session's composer draft and focuses it, using the live selection inside that message row when one exists and the message's own text otherwise; it never sends and adds no chip kind, with a 2000-character cap. Open side chat forks the anchored message through `session.fork` without activating the child, registers the child as a renderer-owned side chat of the parent, and opens one `sidechat:<childSessionId>` tab in the existing docked panel that streams from the same event stream through the background-transcript reducer, with Add to main chat, Open as a conversation, a compact Send/Stop input, and the existing permission card. Closing the tab or activating the child removes the registration; the durable child stays an ordinary session. No protocol, schema, IPC, or permission change. See ADR message-quotes-and-side-chats and E2E-CHAT-quote-prefill through E2E-CHAT-side-chat-close.** | Users needed to reuse an exact earlier message or answer and to ask a side question without replacing the visible main conversation, and the existing fork path always activated its child. *(Amended by D-LOCAL-selection-overlay: the excerpt is recovered from the rendered DOM as Markdown, and a selection inside a transcript row offers Add to chat, Ask in side chat, and Copy from a selection-following overlay.)* |
| D-LOCAL-response-annotations | Response annotations as prompt attachments | *(retired by ADR 0268 on 2026-09-16)* **Amend D-LOCAL-message-quotes (decision 3) for assistant turns: selecting text in a response and choosing Add to chat attaches a numbered annotation to that turn instead of editing the composer draft — the answer body is not decorated (only a citation the model writes renders, as a numbered reference), the composer shows one annotation attachment chip whose tooltip lists the excerpts plus one control that drops them, and the next prompt carries them as `# Response annotations:` + an instruction + `<response-annotations>` JSON (`[{text, annotation, source:{messageId}}]`) + `## My request:` before the user's own text, consuming them. The visible draft, optimistic row, title, and edit seed stay annotation free, and a stored prompt carrying the block is displayed as its request. *(Amended 2026-09-12: Add to chat opens a compact comment editor whose Save writes the user's optional comment into the annotation; re-annotating an attached excerpt reopens that editor instead of a silent no-op, and the composer attachment lists each item with edit and remove controls beside clear-all.)* Quoting a user message, and the side chat's Add to main chat, keep D-LOCAL-message-quotes's draft quote; no protocol, storage-schema, IPC, or permission change. See ADR response-annotations and E2E-CHAT-annotation-attachments, E2E-CHAT-annotation-session-state.** | The draft quote copied the model's words into the user's own prompt text, and several referenced passes had no numbering the model could address; the reference implementation attaches them as numbered prompt data instead. |
| D398 | Context usage display preference | **Amend D347 / ADR 0184: the context usage inspector's leading figure — the trigger ring arc, percentage, token label, popover heading, tooltip, and `aria-label` — is configurable via `AppSettings.contextUsageDisplay` (`"remaining"` or `"used"`). Default and fallback for absent/unrecognised values is `"remaining"`. When `"used"`, the ring fills by `usedRatio`, and text shows the used-capacity pair. Warning and critical color thresholds (remaining ≤ 25 % / ≤ 10 %) stay based on remaining capacity regardless of display mode. Settings → AI → Defaults adds a segmented control (Remaining / Used) after Link open destination and before Enter-to-send. Renderer only; no protocol, storage, host, or migration change. See ADR 0222 and E2E-250.** | The remaining-only display gave weak signal at low occupancy and did not match users who reason in terms of "how much have I spent". Color must stay on remaining to avoid a misleading green ring at 90 % used. |
| D399 | Project group manual ordering | *(amended by D402)* **Amend D093: retained project groups expose a visible-on-hover/focus grip. Native drag/drop and ArrowUp/ArrowDown on that grip write contiguous normalized-path `order` values and set `projectSort` to `manual` in renderer-local sidebar preferences. Archived and pinned priority remains ahead of manual order; project activation, host workspace identity, session ordering, and on-disk directories are unchanged.** | Users with several active repositories need a stable working order independent of recent activity or alphabetical names, while the existing path-keyed and host-owned project model remains untouched. |
| D400 | Restore deferred tools from effective session context | **Amend D185 / ADR 0048: before each new prompt and after a mode switch, clear the in-memory deferred activation set, then restore names from successful `ToolSearch` results (`addedToolNames`) and successful deferred-tool results in the effective `buildSessionContext` projection. Keep only names still in the current deferred catalog and mode; ignore errors, interrupted or missing-result placeholders, and assistant/user prose. No host permission or workspace boundary changes.** | Clearing activations while retaining their successful transcript markers left the model able to see a capability that was absent from the next provider schema. Reconstructing only from effective successful evidence keeps the provider request coherent without parsing prose or reviving stale or disallowed tools. See ADR 0225 and E2E-008a. |
| D402 | Long-press project title to reorder | *(amended by D403)* **Amend D399 / D093 / ADR 0227: retained project groups have no visible reorder grip. A 400ms still press on the project title arms a pointer reorder; movement beyond 8px before that delay cancels it so a click still selects and toggles collapse. ArrowUp/ArrowDown on the focused title is the keyboard path; Escape cancels. Persistence, pin/archive buckets, host workspace identity, session ordering, and on-disk directories are unchanged. See ADR 0228 and E2E-253.** | The dedicated grip consumed a leading column and made reorder a second control beside the title that already selects and collapses the group. |
| D403 | Press-and-move project title reorder | **Amend D402 / D093 / ADR 0228: mouse and pen reorder by pressing the project title and moving 8px; a click with no qualifying movement still selects and toggles collapse. Touch does not start a reorder. An accent insertion line shows before/after placement. ArrowUp/ArrowDown and Escape are unchanged. See ADR 0229 and E2E-253.** | A 400ms still press is a mobile long-press pattern and is slower than ChatGPT-style desktop sidebar lists. |
| D404 | Skill ships with the Agent core tool set | **Amend D174 / D185 / ADR 0048 / ADR 0219: `Skill` joins the Agent-mode core tool set, so its schema is present on the first provider request whenever the skill catalog is non-empty. It is removed from the deferred catalog and never appears under `# On-demand tools`; the other on-demand capabilities and `ToolSearch` are unchanged, and Plan and Goal still omit the tool entirely. No protocol, storage, permission, or skill-body change. See ADR 0230 and E2E-254.** | A user-typed `/skill-id` and the `# Skills` section both ask the model to call `Skill`, and a tool that is absent from the schema cannot be called at all: the deferred entry added a discovery round trip before any skill body could load (issue #204). |
| D405 | Ideographic comma opens the slash menu | **Amend D123 / D139 / ADR 0024: a `、` (U+3001) committed as the first character of an empty composer draft is rewritten to `/` before trigger detection, so a Chinese IME reaches the ordinary slash menu without switching input methods. Only that position is rewritten; a `、` anywhere else stays ordinary punctuation, and the `@` file menu is unaffected. Shared grammar and renderer only; no IPC, storage, or autocomplete-source change. See ADR 0231 and E2E-255.** | Reaching `/new`, `/compact`, a mode alias, or a Skill forced a Chinese IME user to switch to ASCII input mid-sentence and then switch back (issue #65). |
| D406 | Keep macOS DMG opening guidance text-only | *(amended by D457)* **Amend D371 / ADR 0204: macOS DMGs expose the opening-help note as `If app won't open, read this.txt` and no longer include the executable `PI-Desktop-macOS-open.command`. macOS ZIP packages retain both the note and the helper. The note provides the narrow Terminal fallback for trusted unsigned builds; signed and notarized builds do not need it. See ADR 0232 and E2E-196b.** | The DMG should keep the normal app-to-Applications flow focused while still giving users a visible, actionable answer when an unsigned app does not open. |
| D407 | Restore archived projects after session import | **Additive renderer behavior for issue #250: when a core or plugin import adds a new project-bound session, the import-triggered session refresh normalizes its project path and clears the renderer's archived presentation state for that project. Pathless sessions, skipped imports, historical plugin paths without an active binding, and ordinary refreshes leave archive state unchanged. Host project rows, IPC channels, plugin methods, storage schema, and data formats do not change. See ADR 0236 and E2E-257.** | The host can successfully materialize an imported session under a project while the renderer still hides that project's sidebar row as archived. Restoring only the newly imported binding makes the result discoverable without weakening deliberate archive choices during ordinary refreshes (issue #250). |
| D408 | Prioritize MainChat in the three-column shell | **Amend ADR 0226 / ADR 0151 / ADR 0033 for issue #267: MainChat keeps a hard 450px minimum, the work panel is capped by the live budget (`client width - 450px - expanded sidebar`, with no fixed maximum), and the expanded sidebar yields at that threshold — including while `sidebar-out` still occupies flex space. A manual sidebar reopen spends panel width first and otherwise targets 460px; closing the panel restores only a sidebar the layout collapsed. The native window never changes: the reservation seam stays at zero and no geometry is applied. Preview mode temporarily unmounts MainChat and uses a window-level chrome row; collapsed-sidebar macOS preview reserves 88px, or 8px in fullscreen, for traffic lights (D433). See ADR 0238 and E2E-LAYOUT-three-column-width-priority.** | The fixed client area had no explicit width priority, so the side docks could pin MainChat to its floor and leave the composer unusable. Making the yield order explicit keeps the chat readable inside the fixed window without reintroducing native window growth (issue #267). |
| D409 | Host-owned session collaboration messages | *(amended by D446)* **Amend ADR 0237 / ADR 0165 / ADR 0213: Rust host-core owns a durable session-collaboration ledger keyed by message id and real source/target Session IDs. Plugin-mediated `spawn`, `send`, `status`, `result`, and `cancel` operations use the reviewed desktop-control gateway; the sender is bound to the active plugin Agent tool invocation, target turns retain their existing configuration, and each delivery is claimed by its actual durable turn. Completion callbacks are durable, at-most-once, and reference the settled turn. Provenance is persisted with transcript rows and cannot be forged, stripped, or edited through regeneration. The additive schema v16 migration retains queued work across restart without unattended replay, applies permission ceilings and bounded autonomous hops, and keeps the existing Task family unchanged. See ADR 0239 and E2E-PLUGIN-session-orchestrator-real-workers.** | The plugin's prior create/prompt polling path could infer neither a durable turn outcome nor a safe bidirectional sender identity. A host-owned ledger makes delivery, provenance, callback, cancellation, and restart behavior auditable without restoring the withdrawn A2A protocol. |
| D410 | Independent session discovery and navigable collaboration projections | **Amend ADR 0239: add the reviewed read operation `session/collaboration/list`, bounded to 100 non-deleted Agent sessions and redacted to Session IDs, titles, status, updated time, readable provider/model labels, and bounded creation links. Extend the sidebar projection with readable model labels and at most eight created-session references. Render creator/created-session references as keyboard-focusable navigation buttons; independent sessions do not receive fabricated creator links. No renderer storage ownership or collaboration mutation boundary changes. See ADR 0240, E2E-SESSION-independent-top-level-communication, and E2E-SESSION-hover-card-model-and-links.** | Existing Session IDs were valid send targets but could be undiscoverable when they were not created by the plugin, while the hover card exposed only IDs and non-interactive provenance. A bounded host directory and navigable projection make durable sessions communicable and explainable without exposing transcripts or credentials. |
| D446 | Silent completion notices | **Amend D409 / ADR 0239 and the D193 silent-turn contract for issue #504: the first settled assistant reply to a current Host-resolved completion notice may end with no visible text and no tool call without silent-turn recovery or `EMPTY_MODEL_RESPONSE`. The exception is spent by that reply (silent, textual, or a tool batch), survives a provider retry of the same attempt, and is revoked once accepted user steering enters the model context. Only provenance Main resolved from the Host ledger enables it (`kind: completion`, the current target session, nonempty message and reply-to IDs); prompt text, plugin content, task/message deliveries, and restored history cannot. An accepted silent reply is persisted as an empty completed row but is excluded from runtime entries and model context, as a restored transcript already is. See the ADR 0239 amendment and E2E-SESSION-completion-notice-allows-silence.** | The completion prompt already says no acknowledgement is needed, yet the runtime retried the silence and reported a failure after a task that had succeeded (issue #504). Bounding the exception to one ledger-verified reply keeps ordinary prompts, deliveries, tool work, and user steering under D193, and keeping the empty reply out of context avoids a provider rejecting the next request. |
| D447 | Stage Manager bounds watchdog is macOS-only | **The permanent 1.5s `boundsWatchdog` in `bootstrap/window.ts` runs on macOS alone; every other platform clears the interval on its first tick. Its two inputs are macOS-only (the `/tmp/pi-window-bounds` CG helper, and a "window smaller than 500x400" test the 1040x700 minimum window size makes unreachable), so elsewhere it could never recover anything and only called `window.setAlwaysOnTop(false)` forever. On Linux/X11 that repeats a `_NET_WM_STATE` removal, and Mutter answers it by raising the window (`meta_window_unmake_above` calls `meta_window_raise` unconditionally), so the app yanked itself back to the top of the stack about 1.5s after the user focused another window even though `_NET_WM_STATE` never carried `_NET_WM_STATE_ABOVE`. macOS Stage Manager recovery is unchanged. See D039, D053, D083 and US-UI-19.** | A window that re-raises itself over whatever the user just focused is not usable, and the interval had no purpose off macOS; the fix removes the message instead of teaching each platform to tolerate it. |
| D413 | Skill market public-HTTPS catalog fetch | **Additive: Settings → Skills Market discovers SKILL.md catalogs in Electron main under a shared public-HTTPS policy (syntactic public host + DNS classification + per-hop redirect re-validation). The renderer does not fetch. Install remains `skills.create`. Catalog ids match host `valid_capability_id`. Expanded documents over 128 KiB are refused. Builtin titles are English. See ADR 0243, E2E-SKILL-MARKET-*, issue #287.** | Community skill discovery needs main-process egress without a plugin-marketplace host allowlist, and copied classifiers would collide with the MCP market. |
| D421 | Native Pi session continuation | **Amend baseline D007: discover Pi v3 sessions as source-discriminated projections and continue them through coding-agent `AgentSession`/`SessionManager` against their canonical JSONL. Rust remains authoritative for Desktop SQLite/transcripts. Native continuation requires exact saved provider/auth, project trust, canonical path/header identity, and a cooperative lease plus byte/leaf validation; failures remain browseable/read-only. First slice excludes native rename/delete/move/revisions/Plan/Goal/queue/collaboration; the 2026-09-14 ADR 0254 amendment adds native fork with exact stream re-keying and inode-tracked publication; the side-chat panel it added is retired by ADR 0268. See ADR 0254 and E2E-SESSION-native-pi-*.** | Importing a flattened copy cannot preserve Pi's tree or make later Desktop turns visible to Pi Web. |
| D412 | Delta-only coalesced streaming updates | **Amend the local `message_update` contract: append-only streaming frames carry `stream: delta` plus `deltaText`/`deltaThinking` (and reset flags) without growing `content`/`thinking`. Runtime coalesces those frames every 16ms and flushes before semantic boundaries. AgentHost, inflight checkpoints, and the renderer apply deltas; `message_start`/`message_end` remain full snapshots. Transcript activity parts keep object identity when only the tail token changes. Protocol version stays 11. See ADR 0242, E2E-STREAM-long-turn-keeps-realtime, and issue #299.** | Each token re-serialized the full assistant snapshot across sidecar, AgentHost, and IPC, so a long turn cost O(n²) bytes and backlogged later short chunks. |
| D416 | Git clone accepts only syntactically public hosts | **Amend home git clone: `parseGitCloneUrl` reuses `isPublicHostname` so loopback, private, CGNAT, link-local, ULA, and `.local`/`.localhost` remotes are rejected before `git clone` runs. HTTPS/HTTP/SSH/`git@host:path` to public hosts remain valid. `file:` and URL passwords stay rejected. Git still performs its own DNS; this is not a market-style pin. See ADR 0247 and E2E-CLONE-public-hostname-rejects-private.** | Clone accepted `http://127.0.0.1/...` and RFC1918 literals, which is a LAN/SSRF hole the market fetchers already close for HTTPS catalogs. |
| D417 | Plugin runtime theme APIs + sidebar image token | **Add `pi.app.setTheme` and `pi.themes.upsert`/`remove`/`list` under `ui.theme` (ADR 0260 / issue #352). Remove `MAX_THEMES_PER_PLUGIN`. Runtime upsert sanitizes CSS like load-time registration and emits `pluginChanged` (`reason: "themes"`); `setTheme` persists `AppSettings.theme` and emits `settingsChanged`. Split sidebar paint: `--ds-bg-sidebar` stays a color; optional `--ds-bg-sidebar-image` holds gradients/images, with macOS vibrancy stacking sheen over the image layer.** | Theme editor plugins cannot apply a theme from their panel, cannot ship an unlimited library, and cannot live-edit production CSS without reload; sidebar gradients broke `color-mix` / vibrancy consumers when stuffed into the color token. |
| D420 | Structured, bounded, and redacted process logs | **Amend ADR 0046 / ADR 0212: every app/host/agent NDJSON record has a stable event and top-level correlation fields. A normal tool call emits one completion/failure record, while an unexpected sidecar exit emits interruption records for active tools; the tool protocol and transcript remain unchanged. Central logging redacts credentials and local paths, bounds structured data to 8 KiB, summarizes tool results instead of copying output, and mirrors the same sanitized record to development console output.** | The old `tool start` / `tool end` rows were redundant and unclear, while free-form child/error details could leak secrets or consume unbounded storage. |
| D422 | Host turn-end event for plugins | **`session:turnEnded` is a host event with payload `{ sessionId, turnId, reason }` (`completed` / `aborted` / `error`), broadcast once per turn actually started by `session.beginTurn` at the end of turn teardown, after the durable `session.endTurn` attempt. The emitted `turnId` is the identity the terminal runtime event carried rather than whichever turn is active, and the plugin tool context's `turnId` is populated with the same value. There is no ack and no replay: a live subscribed plugin receives it once, delivery that races a crash, reload, or host quit is not guaranteed, and receiving it does not mean every in-flight tool of that turn has exited, so cleanup must be serialised or scoped by `turnId`. No new permission is required, and no published host emits it yet (0.14.8 does not include it). See ADR 0252.** | Plugins driving a GUI had to guess turn completion with idle timers, which fire mid-turn and again after the turn ends. A host-owned once-per-turn terminal event with an explicit turn identity lets a plugin settle exactly once, and the same identity in the tool context lets it correlate late tool results. |
| D423 | Remove the subagent turn limit | **Amend D328 / ADR 0062 / ADR 0063 / ADR 0119 / ADR 0126 / ADR 0166 / ADR 0210: `maxTurns` and `MAX_SUBAGENT_MAX_TURNS` leave the definition type, the frontmatter parser and its clamp/invalid warnings, `UserSubagentRecord` / `UserSubagentInput`, the host-core registry (record, input, frontmatter parse, document render, `MAX_TURNS_CEILING`), the five built-in documents, `SUBAGENT_PRESETS`, and the Subagent editor. A delegate ends only when it finishes, when the parent calls `TaskStop`, when the user Stops, or when a terminal parent error aborts it (ADR 0189). `maxTurns` / `max-turns` / `max_turns` in an existing document is now an unrecognized frontmatter key and is ignored like any other unknown key: no error, no warning, no definition-load failure, and no rewrite of the user's file. The `truncated` value leaves `SubagentRunStatus`, the renderer's `SubagentOutcome` union, the `chat.subagentStatus` catalog entry in every locale, and the delegation topology's warnings count; `timed_out` stays. No protocol version, schema version, or storage change. See ADR 0253, E2E-155, and E2E-SUBAGENT-legacy-turn-limit-frontmatter-is-ignored.** | The parent cannot see a delegate's live work, so it cannot size a turn cap, and the shipped 60 / 50 / 40 / 80 backstops had no derivation. The cap's only effect was to kill a delegate mid-task and surface it as `truncated` with a partial report — a state neither the user nor the parent model can resume. |


| D244 | Compact context usage summary | **Amend D103 / D184 / ADR 0047: keep the context inspector's remaining-capacity trigger, used/window counts, turn total, completed-turn speed, exact provider values, aggregate tool types/calls/tokens, and checkpoint summary, but render them as a short summary. Remove the per-tool rows, share bars, source badges, explanatory estimate paragraph, and used-capacity meter from the default panel. No protocol, storage, runtime accounting, or model metadata changes.** *(Amended by D347: the trigger moves to the composer toolbar.)* | The prior diagnostic layout made a routine capacity check tall and visually dense. Keeping the aggregate signal while removing drill-down chrome makes the default status surface scannable without changing the underlying usage data. See ADR 0103 and E2E-060d / US-UI-61. |
| D347 | Composer-docked context usage inspector | **Amend D103 / D184 / D244 / ADR 0047 / ADR 0103: the compact context inspector lives in the composer right toolbar, immediately left of the model × reasoning chip, and always mirrors the newest assistant turn that reported usage. The trigger keeps the remaining-capacity ring and percentage and drops the redundant Context label. The popover heading is remaining tokens plus percentage; rows below share one label/value rhythm separated by spacing, with no inner section rules (D297). Assistant meta keeps the model badge. Renderer only.** | The inspector under the newest answer scrolled out of reach. One composer entry is the single authority for the latest snapshot, and the doubled heading rule is fixed by dropping the extra caption rather than adding hairlines. See ADR 0184 and E2E-060d / US-UI-61. |
| D355 | Last-request occupancy in the context inspector | **Amend D103 / D184 / D244 / D347 / ADR 0047 / ADR 0103 / ADR 0184: remaining capacity, used/window counts, turn total, and provider input/output/cache/reasoning/hit-rate are the newest usage-bearing assistant message (the last model request). Occupancy is `input + output + reasoning + cacheRead + cacheWrite` on that message. They are not the sum of every model call in the visual tool-loop. Completed-turn speed and the aggregate tool row still describe that visual turn. Renderer only; host turn rollups and Token Insights stay additive billing.** | Summing cache reads across a tool loop put 367k cache read next to a 55k window. OpenCode's context widget uses only the last assistant message. See ADR 0193 and E2E-060d. |
| D356 | Optional subagent thinking override | **Amend ADR 0062 / ADR 0144: subagent frontmatter accepts `thinkingLevel: omit` in addition to inherit and the seven canonical levels. `omit` keeps the agent bookkeeping state at `off` but uses the low-level provider stream so no thinking override is synthesized. Explicit `off` still disables thinking. Model-configuration thinking chips use an accent/inverted-text selected state in both themes. No storage schema or protocol version change. See ADR 0194 and E2E-203.** | Users need inherit, explicit off, and leave-the-provider-default as three distinct choices, and selected thinking chips were unreadable in dark mode. |
| D348 | macOS sidebar source-list vibrancy | **Amend D304: the main window uses Electron `vibrancy: "sidebar"` instead of `under-window`. `nativeTheme.themeSource` follows the app theme (`system` / `light` / `dark` / plugin base) process-wide. Vibrancy re-applies only when `themeSource` changes; a missing plugin theme falls back to `system`.** | macOS 26 Liquid Glass made `under-window` a light plate that the 40% tint could not keep dark, including when app and OS appearances were both dark. See `04-ux/08-component-spec.md` §1.7 and US-UI-74 / E2E-076. |
| D243 | Model-aware image attachment transport | **Amend D197 / ADR 0059: Composer file references retain structured kind/name/MIME metadata. Electron main resolves vision from the exact models.dev model record when matched, or the exact pi-ai fallback record (`modalities.input` / `input` includes `image`), then applies an exact binding's explicit `supportsImages` override. It stores image bytes as `attachments/<sha256>`, sends eligible images as transient image blocks, and falls back to a safe `@path` for unknown/non-vision or oversized images. Durable messages store refs and metadata, never base64; the renderer shows an accessible capability status.** | The previous path-only contract made a vision-capable GPT model receive a scratch path instead of image content. Keeping the published capability authoritative by default while allowing an explicit endpoint-local override keeps Composer and transport aligned without mutating shared model metadata (ADR 0101, amended by D266 and D392 / ADR 0218). |
| D245 | OpenCode-style bounded provider 429 retry | **Amend D186 / D233 / ADR 0091: `PROVIDER_RATE_LIMITED` gets five silent, abortable retries after the initial attempt, with one counter shared across request setup and mid-stream recovery. Disable nested pi-ai retries; capture failed response status/headers; honor `retry-after-ms`, `retry-after` seconds, HTTP-date, then 2-second exponential backoff with 25% positive jitter and a 30-second cap. Reuse the assistant bubble and suppress intermediate lifecycle/error events in main sessions and builtin subagents. Authentication, model-selection, malformed-request, and context errors remain terminal; exhaustion records `retryAttempt: 5` and `providerStatus: 429`.** | The prior split one-retry policy exposed transient 429s too early and allowed setup and stream layers to drift. OpenCode's bounded, header-aware policy preserves user control without hiding persistent provider failure or multiplying nested retries. |
| D237 | Vendor-account (OAuth) login for providers | **A provider row may be authenticated by a vendor subscription instead of an API key. pi-ai's seven OAuth flows are registered statically at startup (`registerBunOAuthFlows()`); Electron main owns login/logout orchestration and implements pi-ai's `CredentialStore` over host-core's encrypted secret store under the new ref `secret:provider:<id>:oauth`, serializing `modify` per provider for locked refresh. `auth_kind` gains `oauth`, `has_secret` widens to "api key **or** oauth", and a new `has_oauth` plus a non-secret `oauthAccountLabel` drive badges and hide the key input; host protocol and storage schema are unchanged. The vendor card list is derived from `models.getProviders().filter(p => p.auth.oauth)`, and login upserts one row per `vendorKey`. The sidecar's launch payload for an OAuth row carries `apiKey: ""`; the runtime injects a `resolveAuth` callback that calls the new host-proxy method `provider.resolveAuth`, which Electron main answers itself — never forwarding to host-core — after checking the `(sessionId, providerId)` pair against the per-launch binding table. The reply is a short-lived `ModelAuth` (`apiKey`/`headers`/`baseUrl`), so a refresh token never leaves main and `matches()` keeps a vendor runtime warm across turns. `providers.listModels` and the connection test go through the authenticated account instead of probing `/models`; apiStyle follows the selected model and gains `openai_codex_responses` and `pi_messages`. Five invoke channels plus one event channel under `pi-desktop/providers/oauth/*` carry the interaction.** | Subscribers of Claude Pro/Max, ChatGPT Plus/Pro and Copilot had to buy separate API credit to use the app. pi-ai ships the flows but declares login orchestration app-owned. Vendor tokens expire in about an hour, so resolving once at launch would break long sessions and churn `matches()` every turn; per-request resolution keeps the runtime stable while giving the model-directed process only a revocable token for the provider its session is bound to — strictly less than the long-lived API key it receives today (ADR 0095). |

| D238 | Flat Settings directory and marketplace context ownership | **Settings renders one flat searchable directory in the exact order Basics / AI / Shortcuts / Instructions / Model configuration / Import / Project archive / Info. Personal, Integrations, Coding, and other group headings are removed. The Settings Extensions destination is removed; its official/mirror/custom marketplace source selector moves into Extensions → Marketplace beside the catalog and retains the same persisted settings and refresh behavior. No IPC, host protocol, storage, provider, permission, or project ownership contract changes.** | The nine-entry Settings rail repeated its own navigation hierarchy and used the same Extensions label as the app-shell plugin destination. Putting marketplace source selection beside marketplace browsing removes the duplicate entry while preserving the mirror/custom-source workflow (ADR 0096). |

| D239 | Place global defaults under AI | **The eight-destination Settings directory remains unchanged. Basics owns Appearance and platform-supported close behavior. 全局 AI / AI owns Permissions and the Defaults card containing default operating mode (Agent / Plan / Goal), command shell selection/fallback status, and Enter-to-send. Model configuration retains the default provider/model selector. Only renderer content and Settings search ownership move; persisted settings, host APIs, runtime semantics, and deep-link contracts remain unchanged (ADR 0097).** | Default mode, command shell, and Enter-to-send change global agent behavior, so placing them beside appearance mixed unrelated concerns and made the AI destination incomplete. |
| D240 | Independent vendor OAuth accounts and settings ownership | **Amend D237 / ADR 0095: every OAuth login creates a fresh provider row and row-scoped `CredentialStore`, even when `vendorKey` matches an existing account. The Vendor accounts card owns the full OAuth row lifecycle and deletes through `providers.delete`; the AI services list excludes OAuth rows but the default selector may still choose them. Vendor auth bindings and resolution use the exact `providerId`; ambiguous vendor/name aliases for subagents fail closed.** | One vendor-global row made a second account overwrite or reuse the first credential, while sign-out left a stale AI-service row. The row id is the only unambiguous account identity and lets deletion remove exactly one credential and configuration. See ADR 0098. |
| D339 | Per-provider User-Agent override | **Superseded by D341.** Each AI-service and OAuth provider row may store optional `config_json.userAgent`. Empty keeps adapter defaults (pi-ai / `claude-cli` / OpenCode). A non-empty value is last-writer `User-Agent` on that row's outbound HTTP (turns, subagents, one-shots, discovery, connection test, OAuth refresh) via a fetch wrapper plus stream-option headers. Update `""` clears. Max 256 bytes; no CR/LF. Advanced UI only; first OAuth login does not collect it. `matches()` includes `userAgent`. The unused `headers` map stays unimplemented. No schema/protocol bump. | Gateways and vendor subscriptions inspect User-Agent; Codex overwrites it after extra headers. See ADR 0176 and E2E-005G. |
| D341 | Per-provider custom HTTP headers | **Amend D339 / ADR 0176: each AI-service and OAuth row stores optional `config_json.headers`. Empty / `{}` keeps adapter defaults. A non-empty map is last-writer on that row's outbound HTTP (turns, subagents, one-shots, discovery, connection test, OAuth refresh) via a fetch wrapper plus stream-option headers. Leftover `userAgent` migrates to `headers["User-Agent"]`. Max 32 headers; key ≤ 256 bytes; value ≤ 4096 bytes; no CR/LF; reserved auth/hop-by-hop/routing keys rejected. Compact KeyValueRows Advanced UI; first OAuth login does not collect headers. `matches()` includes the map. No schema/protocol bump.** | Users needed arbitrary non-secret headers, not only User-Agent. See ADR 0178 and E2E-005G. |
| D242 | Builtin subagents inherit the parent permission mode | **Builtin subagents use the default `permission: inherit` behavior. The builtin `fixer` no longer overrides the parent session, so `auto` covers its in-root and explicit external-path calls without a second authorization card; explicit non-`inherit` scopes on eligible builtin or user definitions remain intentional overrides.** | The observed popup came from the builtin `fixer` replacing an `auto` parent with `accept-edits`; inheriting the parent fixes the UX without weakening host-core containment or external-path permission rules (ADR 0100). |
| D241 | Titled Settings navigation clusters | **Keep the eight-destination Settings directory flat and searchable, but render four non-interactive localized group headings — Personal / 个人 (Basics, AI, Shortcuts), Agent / 智能体 (Instructions, Model configuration), Workspace / 工作区 (Import, Project archive), and About / 关于 (Info). Headings use whitespace for separation and no divider lines. Empty groups disappear with filtered search. This supersedes only D238's prohibition on group headings; destination order, IDs, search ownership, and marketplace placement remain unchanged.** | The flat rows became visually dense without scan landmarks. Muted headings restore grouping while preserving one-level navigation and the existing destination ownership. |
| D442 | Marketplace download requests carry a device identifier | **Amend D238: the official plugin channel resolves every install and update through `POST /api/v1/download/resolve` and sends a stable `deviceId` — the SHA-256 digest of a platform machine identifier, or a locally persisted random id when none is readable. The client tries the returned mirrors in order, verifies `sha256` and `sizeBytes` before extracting, never caches the answer, and falls back to the catalog's own package URL only when the platform could not be reached. The GitHub and CNB backup channels and `custom` keep the existing static relative-URL resolution. See ADR 0276 and E2E-PLUGIN-official-channel-resolves-through-the-platform.** | The platform needs one stable installation identity to count a download once and to rate-limit per device instead of per source address; the value is a digest, so no machine code leaves the machine, and no new UI surface is introduced. |

## D. Codex visual parity decisions (0.3.5+)

Gold source: local Codex electron captures; latest row wins where rows conflict.

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D034 | Desktop visual baseline | **Codex electron-dark 1:1 shell (charcoal gray, floating composer, ~275px sidebar)** | Match local Codex usability and density; keep PI-Desktop product branding |
| D035 | Shell display name | *(superseded by D094)* **UI chrome uses shellName "Codex"; product/about remains PI-Desktop** | Satisfy visual 1:1 replica goal while preserving product identity in about/settings |
| D036 | Theme chrome tokens | **All shell chrome (nav, threads, chips, title buttons) uses semantic `--ds-*` text/surface tokens; no raw gray-0 text in light mode** | Light macOS default was unusable when nav used white ink on `#f3f3f3` |
| D037 | Dark sidebar surface | **Dark sidebar uses `#000000` (Codex `surface-under`); main pane stays `#181818` (`gray-900`)** | Match electron-dark sideBar vs main surface separation |
| D038 | Dark composer plate | *(superseded by D047, then D061)* Dark floating composer uses solid `#212121` with stronger elevation shadow than light | Codex elevated-primary must read as a box against `#181818`; transparent mix alone looks flat |
| D039 | Stage Manager bounds | **Permanent host watchdog restores footprint while width/height remain collapsed** | 20s burst was insufficient under Stage Manager thrash |
| D040 | Composer intelligence control | *(superseded by D091)* Custom effort chip opens a popover (effort radio + model heading + settings) instead of cycling on click | Replaced because the control changed labels without configuring pi |
| D041 | Profile footer | *(superseded by D113)* **Custom footer opens profile menu (Settings / Logs / Theme); cloud badge remains update stand-in** | D113 replaces the cloud/update stand-in and generic gear row with a truthful local-profile footer |
| D042 | Projects page | *(superseded by D066 index table)* Projects is a card grid of recent/active local workspaces with pin + glyph color (localStorage recents) | Match Codex Projects destination density without cloud project backend |
| D043 | Settings shell | *(superseded by D062/D063 full-page shell)* Settings uses left nav rail on sidebar surface + content pane (General/Providers/Plugins/About) | Closer to Codex settings IA than a top-only tab strip |
| D044 | Destination list chrome | **PRs/Scheduled/Plugins use shared dest-row list + filter chips; light cards white elevated** | Match Codex destination density without full cloud backends |
| D045 | Home empty stack | **Empty chat keeps composer in home flow (not absolute bottom-only dock); refined by D047 split grow** | Initial fix for large empty gap; D047 corrects dual-grow vertical model |
| D046 | Composer placeholder | *(superseded by D094)* **Empty draft uses Codex placeholder (EN/zh-CN) instead of blank** | Empty white plate read as broken without ink; match the earlier visual gold copy |
| D047 | Home split grow | *(geometry superseded by D111)* **Empty home used upper/lower grow regions (hero items-end + composer justify-end); dark box uses Codex elevation-prominent** | Match electron dual grow; D111 replaces dual-grow portal with a scrollable flow stack to stop composer/card collisions |
| D048 | Sidebar recents label | *(superseded by D088)* **Recents section uses live Codex gold label EN `Recents` / zh-CN `最近` (not asar-only `Tasks`/`任务`)** | Visual gold + live coding shell section heading between plugins and thread list |
| D049 | Home suggestion cards | *(superseded by D131)* **Empty home shows 4 ambient cards under hero (auto-fit row) and prefills starter prompts on click** | D131 removes the card row and prompt-prefill entry points from the empty home |
| D050 | Empty composer plate height | *(superseded by D055, then D061)* Home empty composer min-height ~112px (compact); model chip shows model id (effort stays in menu) | Match Codex empty plate density; model chip chrome closer to electron model picker trigger |
| D051 | Sidebar nav density | *(session-list IA superseded by D088; row density retained)* **Nav rows ~32px pitch, recents rows ~28–31px, section label `最近`/`Recents`** | Close light-home sidebar residual vs cx-home-clean |
| D052 | Home vertical + night box polish | *(workspace-chip surface superseded by D095; remaining guidance retained)* **Upper pb ~62px (hero first-ink ~y305); light chips `#f3f3f3`; light composer elevation stronger; dark home composer solid `#212121`; toolbar controls 28px** | Close residual heat at hero y≈300 and composer band; night plate must not flatten into `#181818` |
| D053 | Stage Manager CG detection | **CG bounds helper matches any window layer by pid; missing-CG needs streak≥3 before shelf recovery; avoid permanent alwaysOnTop** | alwaysOnTop floating layer broke layer-0 helpers and caused restore thrash |
| D054 | Empty draft row + infinity cue | *(∞ cue superseded by D094; leading brand cue superseded by D160)* **Composer auto-resize must never collapse empty textarea height (<28px); keep a visible brand cue left of draft; solid disabled send (`#bdbdbd` light); denser placeholder ink; night plate solid `#212121`** | Empty `height:0` auto-resize hid placeholder and read as broken night/light box; gold draft row needs visible mark + ink density |
| D055 | Empty plate draft Y | *(plate-height guidance superseded by D061; workspace-chip density superseded by D095)* Home empty shell min-height ~148px (bottom-aligned) so draft densest ink ≈y556 vs gold; chips compact 28px | 112px plate left draft ~30px low; grow plate upward without moving toolbar footing |
| D056 | Empty-home workspace chips | *(superseded by D095)* **Hide project/Local/branch capsule on empty home always; show only in thread-docked composer** | cx-home-clean empty gold has no capsule band above the plate even with project title |
| D057 | Home mark + hero title optical | *(home mark superseded by D094; title guidance retained)* **Empty-home Codex mark uses denser stroke; short workspace basenames display as `PI-Desktop` for gold title span** | Hero residual was thin mark + short project label under-inking title vs Codex gold |
| D058 | Home content width + dark ink tokens | **Home dual-grow max width uses `768px` (not `48rem` under 14px root); home horizontal pad 12px; hero title/night controls use theme tokens; night home plate scoped to dark only** | `48rem` at 14px root shrank plate ~120px vs Codex gold; hardcoded light hero ink made night title unreadable |
| D059 | Light disabled send ink | **Disabled send chip `#8e8e90` + white arrow (not `#bdbdbd`)** | Pixel-match cx-home-clean empty send control |
| D060 | Light New task ghost row | **Light empty-home New task is transparent (no solid chip); only hover wash** | Gold has icon+label without filled pill; filled `#e8` chip was main nav residual |
| D061 | Empty plate Y + night elevated-primary | **Home empty plate min-height 140px + wrap bottom pad 16px (top ~y536–538 / draft ~y552 / foot shadow ~y674); light+dark home plates use elevated-primary fill and downward elevation (no upward omni glow); dark fill `#212121f5`** | Plate was high with pre-plate halo; solid night plate + heavy omni shadow diverged from Codex elevated-primary and gold foot band |
| D062 | Settings Codex shell | **Settings uses Codex grouped rail (Personal/Integrations) + search + Back to app; content is elevated row panels; Providers/Plugins retained for local-first; MCP empty state under Integrations** | Destination parity gap; prior 4-item flat rail diverged from Codex settings IA |
| D063 | Settings full-page takeover | **Settings replaces app sidebar with Codex full-page shell: back+search+icon groups (Personal/Integrations/Coding), elevated permission/general cards, local Providers/Plugins retained** | Nested settings-inside-main-pane diverged from live Codex settings gold |
| D064 | Settings general content parity | **Basics card rows match Codex: default open target, language, menu bar, bottom panel; nav adds Pets/Appshots; sun/pet/snapshot icons; pill selects** | Closer 1:1 to live Codex settings gold content band |
| D065 | Settings general gold polish | **Permission rows include blue Learn more links + full-access risk copy; open-target pill shows VS Code glyph; Agent uses circular-arrow icon; Integrations order Appshots→Plugins→Browser→Computer→MCP; Enter-to-send moves to Agent** | Residual gaps vs cx-settings-try after full-page shell |
| D066 | Home-with-project chrome + projects index | *(composer intelligence label superseded by D091; workspace-chip portion superseded by D095)* Home shows workspace chips when project open (no ∞); home placeholder 随心输入/Ask anything; footer gear+help; Projects page is Codex index (search/columns/expand/actions) using setProject | Gold cx-home-clean with project + projects-index-page parity |
| D067 | Home suggestion glyphs + chip gap | *(suggestion-glyph portion superseded by D131; composer chip-gap portion superseded by D095)* **Suggestion icons match Codex (code/hammer/refresh/bug) with blue/purple/green/orange tones; composer chip gap 8px and denser capsule** | D131 removes the cards; D095 remains authoritative for composer spacing |
| D068 | Recents row actions + fixture titles | *(sidebar actions superseded by D088, then reorganized by D093; fixture-title guidance retained)* **Active/hover recent rows show pin + panel trailing actions; capture/fixtures prefer Chinese titled empty sessions (同步代码) over bare New task** | Gold sidebar selected row chrome; reduce selection residual |
| D069 | Destination title scale + dark New task ghost | **Destination page titles use Codex 28px/560 weight; New task is transparent ghost in dark too; capture drops English noise fixtures and pins 同步代码** | PR/Projects title mismatch; dark New task read as selected chip |
| D070 | Settings gold metric polish | **Settings rail 275px/#f4f4f4; denser nav; content title offset; 32×20 accent toggles; Account arrow-up-right; 14px cards; 720px content band** | Residual vs cx-settings-try (rail width, toggle size, title Y, external mark) |
| D071 | Transcript interaction parity | **Tool calls render as Codex-style lightweight disclosure rows (caret + name + mono arg hint + spinner/status, clamped inset body) replacing boxed cards; auto-scroll only while pinned to bottom with floating jump-to-latest pill (send / retry / regenerate re-pin per D151); readable Working… line with elapsed time and a compact running marker (amended by D290); hover copy on messages and code blocks** | Boxed tool cards and forced scrollIntoView diverged from Codex transcript feel; spec 7.4 scroll pause was unimplemented |
| D072 | Typography/radius token enforcement | **All font-size/weight/line-height/letter-spacing/border-radius values must use `@theme` token vars (`--text-*` ramp with `-plus` half-steps, `--font-weight-*` incl. 520/560, `--leading-*`, `--tracking-*`, 12-step `--radius-*`); raw literals in CSS and TSX arbitrary utilities are blocked by `scripts/check-style-tokens.mjs` wired into `pnpm lint`; pixel values preserved exactly (no visual change)** | ~130 scattered literals drifted from any scale; design-system doc §5.2/§6.2 tables were stale vs implementation |
| D073 | Full renderer i18n coverage | **Every user-visible renderer string flows through i18next (`en` source of truth, `zh-CN` via `satisfies EnglishCatalog`): ContextPanel/CommandPalette/PermissionDialog wired; toast/aria/title/placeholder literals keyed; session default titles come from `i18n.t` with a shared case-insensitive `isDefaultSessionTitle` matcher covering legacy titles across locales; proper nouns (VS Code, Finder) and native language names stay untranslated** | Six components bypassed i18n entirely; default-title matching was duplicated in store and Sidebar and missed zh "新对话" |
| D131 | Empty home without suggestion cards | *(starter-grid clause amended by D205, then superseded by D206)* **The empty chat home temporarily rendered only the hero, optional first-run checklist, and composer; the original four Explore / Build / Review / Fix cards, their colored glyphs, and their prompt-prefill actions were removed. This superseded D049/D067 and the original card-specific clauses of D111 while retaining its single scrollable flow layout.** | The direct composer remained the primary task entry; removing the original decorative starter row addressed noisy card treatment. D205 briefly reintroduced a quieter, non-submitting developer grid before D206 returned the empty state to direct entry. |
| D133 | Project index moves to Settings archive | *(five-destination count/order superseded by D166; flat-list presentation superseded by D168)* **The home sidebar no longer has a standalone Projects destination. Settings adds Project archive (zh-CN: 项目归档) after Import and before Info, bringing the compact directory to Basics / Model configuration / Import / Project archive / Info. The archive reuses the durable Projects index and always includes archived records, with search, add, activate, task expansion, pin, archive/restore, and close actions. Project and session groups remain in the home sidebar for active work. Global search exposes the archive as a Settings result, not a standalone page. This supersedes the standalone-destination clauses of D042/D066 and D090's four-destination limit without changing project storage or activation semantics.** | Active project work already lives in retained sidebar groups; moving historical project management into Settings reduces primary navigation while keeping recovery and archive controls discoverable. |
| D168 | Project archive presentation redesign | *(band layout and per-section panels superseded by D267)* **Project archive renders three stacked bands: an overview banner (intent sentence, primary Add project, and four derived counters for projects, open, archived, sessions), a toolbar (search with clear affordance and live match count, plus a Recent/Name sort segmented control), and a grouped index whose always-visible sections run Pinned / All projects / Archived with per-section counts, one settings panel per section, and hairline row separators. Rows carry a disclosure control, glyph, name with Active/Open/pinned/Archived tags, one meta line (shortened monospace path, branch, session count), relative last-active time, and hover/focus-revealed New task plus row menu; the menu groups create/edit above pin, archive/restore, and destructive Close, and dismisses on Escape or outside press. Archived rows are grouped and softened, never hidden or filtered, so D133's no-visibility-toggle rule still holds. This supersedes D133's flat-list presentation without changing project storage, search matching, session batching, or activation semantics.** | The flat single-list archive gave equal weight to pinned, working, and archived records and hid its disclosure and row actions behind hover, so scanning a long durable index meant reading every row. Grouping with derived counters and an explicit sort makes state legible at a glance while keeping archived history permanently reachable. |
| D267 | Project archive is one workbench, not three bands | *(row anatomy and inline expansion superseded by D455)* **Revise D168's band layout: Settings → Project archive renders the D257 one-workbench composition — a quiet intro line carrying only the page description, one toolbar (Recent/Name sort on the shared `settings-segment` primitive, search with clear affordance and live match count, primary Add project), and one settings panel whose always-visible Pinned / All projects / Archived groups are non-interactive in-panel header strips with per-section counts instead of one panel per section. The decorative gradient hero band is removed together with the four page-level overview counters it carried, retiring the `project.statProjects`, `project.statOpen`, `project.statArchived`, and `project.statSessions` keys; the per-group counts on the panel's header strips are now the only totals. The external uppercase section labels are removed as well; row geometry matches the capability rows (32px controls, 14px list gap, 28px row glyph). Beyond dropping the four retired counter keys this is presentation only: D168's row anatomy, row menu grouping, search matching, session batching, activation semantics, and accessibility semantics are unchanged, and no ADR is required.** | D168's overview banner used a decorative gradient and `--text-xl` counter tiles, which the design system forbids, and its per-section panels repeated the same elevated frame three times. Demoting the counters to an inline run kept the clutter without earning it: every total they showed is already legible from the per-group strip counts, so restating them above the toolbar duplicated numbers and gave the destination a header no sibling page has. Dropping them leaves the durable index looking and behaving like the agent capability pages. |
| D455 | Project archive is a list + inspector | *(row anatomy superseded by the same-day "Project archive reads as an inset grouped card list" entry)* **Revise D267's expanding rows: Settings → Project archive keeps the quiet intro and toolbar, then a one-column workbench. The index remains Pinned / All projects / Archived with per-section counts and no visibility toggle (D133). Compact rows show glyph, name, one status tag, session count, and relative time. A click selects and stays in Settings; double-click, Enter, or the inspector Open action activates and returns to chat. Folders, chats (batches of eight), and the row menu open under the selected row at full width. Search still matches session titles and selects the owning project. Presentation only: no IPC, storage, or host change. See ADR 0294 and E2E-038.** | Inline expansion and per-row menus made a long durable index hard to scan, and clicking a name left Settings instead of managing the project. |
| D456 | Session thinking-parameter omission | **Amend ADR 0194 / ADR 0144 / ADR 0221: session `thinkingLevel` accepts `omit` in addition to the seven canonical levels. Composer prepends `omit` on a reasoning model. Settings `defaultThinkingLevel` also accepts `omit` when the binding enables any reasoning level. Runtime bookkeeping stays `off` and uses the low-level provider stream so no thinking override is synthesized. Binding/catalog capability lists stay canonical. Schema v19 widens the session CHECK to include `omit`. Handshake protocol version is unchanged. See ADR 0295 and E2E-203a.** | Explicit `off` still serializes a disable; users need a session-level do-not-send matching subagents. |
| D458 | Composer reasoning slider on the menu root | **Amend the combined model × reasoning menu: when more than one level is listed, a native range slider with one labeled stop per level sits under the Reasoning level entry. Slider and tick commits persist the last pending level through `configureActiveSession` without leaving the root; the entry still opens the classic radio list. Tick labels are not tab stops. The slider shows a rail with one track dot per stop and a visible label under each stop; the dots row and labels row are full-width n-column grids and the range input overlays the rail inset by half a column minus the thumb radius, so the dot, thumb and label share one column center for every stop count. The selected stop uses the accent token, the rest muted. Renderer only. See issue #417, `04-ux/08-component-spec.md`, and E2E-050.** | Switching a level required a submenu trip; a Codex-style slider keeps the radio list while making quick adjustments one drag. |

## E. M5 hardening decisions (0.4.0)

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D078 | macOS signing lanes | *(amended by D450 / ADR 0289)* **Static configuration does not embed a certificate identity, so local builds without a configured certificate remain unsigned. Official GitHub tag releases require Developer ID signing and Apple notarization; CI receives certificate material through Actions secrets and rejects unstapled artifacts.** | Contributors can package without credentials while published macOS artifacts satisfy Gatekeeper. See 06-delivery/06-release-runbook. |
| D079 | App icon / brand mark v1 | *(renderer asset path refined by D221)* **`build/icon_1024.png` is the canonical PI-Desktop logo; `scripts/make-icon.py` derives `build/icon.icns` without overwriting the PNG; packaged macOS builds, `pnpm dev`, and renderer chrome reuse those assets** | Keep one visual identity across development, renderer, and packaged lanes while preventing the derivation script from restoring the obsolete generated mark |
| D080 | Backend supervision | **Child exit rejects in-flight RPCs immediately; backoff restarts (0.5s→4s, max 3 per 2min); `hostStatus` events drive renderer degradation UI** | Crash recovery without hangs; fail visible, not silent |
| D081 | Renderer sandbox | **`sandbox: true` with fully bundled CJS preload; production CSP drops `unsafe-eval` and localhost connect-src** | Electron security baseline; verified by `test:e2e:boot` |
| D082 | Log channels | *(superseded in part by D182)* **app/host/agent NDJSON files with 5MB rotation (keep 2 rotated) via main-process Logger; audit channel stays in host-core SQLite** | Diagnosable failures without unbounded growth; audit needs queryability |
| D083 | Window state | **Persist last good bounds to `window-state.json` (min 960×640 to restore); Stage Manager shelf recovery keeps the Codex footprint; capture runs force deterministic bounds** | Users keep their window; shelf recovery and pixel captures stay deterministic |
| D084 | Cross-platform shell strategy | *(superseded by D190)* **The Bash tool runs bash on every platform, resolved once per process: `PI_DESKTOP_BASH` override → Unix well-known paths + PATH → Windows `bash.exe` derived from Git for Windows (git on PATH, standard install dirs, then PATH minus the WSL `System32` launcher); Unix uses `bash -lc`, Windows `bash -c` + `CREATE_NO_WINDOW`; no bash bundled in installers; missing shell surfaces stable `SHELL_NOT_FOUND` with install guidance** | Superseded by the selectable shell catalog and stable execution identity in D190 |
| D085 | Toast system v2 | **Single global toast stack (`ToastHost` + store queue) replaces the string `setToast`: `showToast(message, {variant, duration})` with info/success/warning/error variants (Lucide icon tinted by semantic token on a neutral elevated plate), auto-dismiss 4s / error 8s / 0 sticky owned by the system (no caller timers), hover pause, max 4 with dedupe, enter/exit motion + reduced-motion-safe removal, `aria-live` + role status/alert; usage rules in 08-component-spec §17** | Old toast was a bare fixed div: no variants or stacking, and most call sites never cleared it so messages persisted forever; callers hand-rolled timeouts |
| D086 | Storage schema v2 | **Single `pi.sqlite` (host-core exclusive) rebuilt per 03-runtime/04: `kv` namespaces replace `meta`/`settings` and host plugin settings; `projects` replaces the workspace singleton; transcripts become canonical block arrays (`messages.content_json` + extracted `text`, ms-integer times, O(1) per-session `seq`, stable `mid` rowid) with `turns` carrying state-machine status + usage rollups and FTS5 trigram search; new `models` catalog, `artifacts`, `scheduled_tasks`+`task_runs` (moved out of Electron's JSON, fixing a D002 violation); indexed prunable `audit_log`; `PRAGMA user_version` migrations with pre-migration `.bak`; dead `plugins`/`provider_models` tables dropped (registry.json stays authoritative)** | v1 schema was a lossy UI projection (no turns/usage/blocks/attachments), ordered by `MAX+1` scans, had zero secondary indexes, two dead tables, RFC3339 text times, and scheduled tasks bypassing host ownership; spec'd features (artifacts view, cost chips, run history, project grouping, global search, catalog refresh) had no storage to land on |
| D087 | Immersive composer context rail | *(superseded by D095)* **Project / Local / branch remain one rail, but the rail now attaches directly to the composer shell, shares its theme surface and sole elevation, and drops the visible 8px gap plus independent capsule shadow; supersedes the gap portion of D067** | The detached capsule and differently colored plate made context and prompt input read as unrelated controls instead of one Codex-style immersive composer |
| D089 | Composer draft height | **The prompt textarea shows one visible line by default, auto-grows from wrapped content through seven visible lines, scrolls internally beyond line seven, and contracts as content is removed; the home shell is content-driven instead of keeping D061's fixed 140px minimum** | Preserve transcript space and Codex-like density while keeping multiline editing usable |
| D088 | Scoped home sidebar sessions | *(superseded by D093 only for the one-current-project and no-row-actions limitations)* **Replace the Recents aggregate with one current-project session group plus persistent path-less Temporary sessions; keep other projects in the Projects index; remove Recents pin/panel row actions; scope empty-draft reuse and explicit `+` creation by project context** | D093 retains exact-path grouping, scoped draft reuse, and the Temporary boundary while allowing several retained project groups and scoped organization actions |

## F. Baseline 0.4.2 product decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D090 | Compact settings directory | *(four-destination count and order superseded by D133)* **Settings retains the D063 full-page shell and D070 visual metrics, but its rail contains exactly Basics, Agent, Import, and Info in that order. Appearance moves into Basics; Providers moves into Agent. Plugin management remains in the app shell's existing Plugins destination, with load/enable/disable/uninstall available there, and is not duplicated in Settings. This supersedes the broader grouped navigation and standalone Appearance/Providers/Plugins placements in D062–D065, plus D070's Account-specific rail metric.** | Remove empty, low-value, and duplicate destinations while keeping every shipped workflow reachable and making the local-first settings surface easier to scan |
| D091 | Composer runtime configuration | **Mode and provider/model controls update the active session and are read from that session by the pi prompt path; controls without an end-to-end runtime implementation are not rendered.** | Prevent decorative effort/attachment controls and keep every visible composer action operational |
| D092 | Responsive settings content | **The settings content fills the width available after the fixed 275px rail and pane gutters, resizing through CSS flex layout with the native window. This supersedes only D070's fixed 720px content band and the corresponding visual-metric retention in D090.** | Use wide desktop windows efficiently without adding renderer resize state or changing the compact settings directory |
| D104 | Settings rail menu rename | *(Agent label superseded by D110; directory order superseded by D133)* **Settings rail destination labels are Basics / Agent / Import / Info (zh-CN: 基础 / 智能体 / 导入 / 信息). Destination IDs remain general / agent / import / about; only user-facing labels change. This renames the D090 compact directory labels without changing order, contents, or deep-link targets.** | Shorter, action-oriented labels scan faster while preserving the compact directory |

## G. Baseline 0.4.3 sidebar and project decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D093 | Sidebar organization, retained project tabs, and session workspace isolation | **The renderer retains normalized open-project paths and local project/session presentation metadata for pin, archive, collapse, sort, and manual order. The sidebar renders one independently collapsible group per retained path plus Temporary sessions. User-facing sort modes are recent, created, oldest, and name; project groups can opt into `manual` by dragging the project title after a small pointer movement or with ArrowUp/ArrowDown on that title, while session `manual` remains a compatibility value. Activating a group reuses `project.set`, so the shell still has one selected host workspace. Tool execution resolves its root from the durable session project, and per-session turns/grants remain independent when another tab becomes active. Archive, close, and reorder are renderer-local and non-destructive.** | Preserve a multi-repository working set and make long conversation lists manageable without creating multiple host workspace singletons or allowing an active-tab switch to redirect a background session's tools |
| D094 | Renderer product branding | *(docked composer logo superseded by D160)* **All user-visible shell identity uses `PI-Desktop`: the sidebar shell name, composer placeholder, and settings copy. `BrandLogo` imports the marks derived from `build/icon_1024.png` through Vite (see D221) for the home hero, expanded/collapsed sidebar, and docked composer; new-session controls use a dedicated message-plus icon. `Codex` remains only where it identifies an external import source or a design reference.** | Remove accidental third-party branding and vector approximations from the product surface while preserving import compatibility and the Codex-derived layout system |
| D135 | Distinct sidebar task status indicators | **Conversation rows reserve one compact leading status slot with semantic, shape-distinct states: neutral-accent outlined ring for selected, warning-orange breathing dot for in progress, success-green check for completed, and error-red circled alert for failed. Precedence is in progress, selected, then latest terminal outcome. Starting a new turn clears the prior outcome; abort produces no failure. Every state has localized accessible text and reduced motion makes the in-progress dot static.** | The prior running dot reused the accent token and disappeared when idle, making selected, active work, completion, and failure difficult to scan or distinguish by more than row background |

## H. Baseline 0.4.4 composer decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D095 | Remove composer workspace context rail | **The home and thread-docked composer variants never render the passive project / Local / branch rail or reserve layout/elevation for it. Project selection, session binding, branch metadata, and workspace-scoped tools remain available through non-composer surfaces. This supersedes the context-rail portions of D052, D055, D056, D066, D067, and D087.** | The rail duplicated navigation, showed two passive values, and could display misleading fallback branch metadata while consuming prompt space |

## I. Baseline 0.4.5 thinking-mode decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D096 | End-to-end thinking mode | **Thinking level is session-scoped with canonical values `off|minimal|low|medium|high|xhigh|max`; capability resolution and nearest-level clamping drive the Composer and pi request; thinking streams and persists separately from final answer text; schema v3 and protocol v2 carry the new fields.** | Restore reasoning controls only after model capability, persistence, IPC, sidecar, pi runtime, event, storage, and transcript paths are all operational |
| D102 | Custom provider thinking presets | **Settings expose Off / On-off only / Graded (plus advanced custom lists). On-off only persists `supportedThinkingLevels: ["off","high"]`; Graded clears the sparse override and uses the conservative default set; Composer renders only the resolved set and never invents graded options for boolean-like models such as mimo.** | Custom OpenAI-compatible endpoints often expose boolean thinking rather than a full effort ladder |

## K. Work panel decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D097 | Docked work panel replaces context panel | **The right side hosts a docked, drag-resizable (320–min(720px, 60vw)) work panel with Review / Terminal / Browser / Files tabs, toggled by the titlebar button or Cmd/Ctrl+J; `{open, tab, width}` persist in localStorage. The former ContextPanel overlay and its `context.*` copy are removed; workspace/model/status live in composer chips and Settings.** | Codex-parity working surface for inspecting agent output; the info-only overlay duplicated data available elsewhere |
| D098 | Review tab reads the git working tree *(superseded by D180)* | **Historical decision: Review rendered the workspace's uncommitted state through the git CLI.** | Superseded because commits erased message-level evidence and could not support safe per-message rollback |
| D099 | Terminal tab is a real PTY *(superseded by D251)* | **Historical decision: the former work panel exposed an interactive shell as a session-scoped terminal tab.** | The current product removes that separate shell surface; Agent Bash remains non-interactive and transcript-owned |
| D100 | Browser tab embeds a WebContentsView | **The preview browser is a main-process WebContentsView with renderer-driven bounds sync, hardened (deny popups→external, deny permission requests, http(s)-only navigation, isolated persist partition); it hides while blocking overlays (palette, permission dialog, settings) are open. The user drives it; the agent does not.** | Recommended modern embedding without webview-tag caveats; hide rules resolve its compositor z-order over renderer overlays |
| D138 | Session-scoped inline permission requests | **Tool approval is an inline PermissionCard owned by its originating `sessionId`, never a global dialog. Different sessions retain independent pending requests and absolute timeout deadlines; background message/tool/permission events update only scoped state and never activate, cover, or focus another conversation. Resolution and cleanup match both session and request identity. This supersedes only D100's permission-dialog overlay/hide clause; palette, search, settings, and other blocking surfaces retain their existing browser hide behavior.** | Concurrent agents must not steal the active workflow or overwrite each other's approval requests; the existing protocol already carries the required session/request identity. |
| D139 | Navigation intent and shortcut event guards | **Every explicit session, project, page, fork, or history navigation begins or reuses one renderer navigation intent; asynchronous work commits visible state only while that intent remains current. Global shortcuts ignore modifier-only and IME composition events, while history navigation also ignores key-repeat events.** | Late session/project loads and incomplete keyboard events must not cause unexplained page or history jumps. |
| D128 | Artifact-driven work panel tabs (shortcut clause superseded by D207) | **The work panel has no empty manual entry point, welcome chooser, titlebar/menu command, or Cmd/Ctrl+J shortcut. A file/URL/BrowserPreview/successful-command artifact creates and activates a closeable top tab; successful active-session workspace Write/Edit artifacts create and activate the singleton Review tab. File tabs are keyed by lexically normalized path, singleton tool tabs deduplicate, closing the active tab selects its right neighbor then left, closing the last tab hides the panel, and the sole panel-level control collapses it without deleting retained runtime tabs. Changing the visible session or workspace closes and clears tabs so relative resources never cross context boundaries. Startup is closed with no tabs; only panel width persists, while temporary OS-window expansion is excluded from launch bounds. Background-session, failed, and scratch writes do not steal focus. This supersedes D097's fixed tab entry points and `{open, tab}` persistence, refines D098's automatic refresh, and supersedes only D112's welcome-chooser clause.** | Match Codex's output-driven work surface, avoid an empty tool launcher, and make each visible tab correspond to work the session actually produced or explicitly previewed. D128 corrects the initially duplicated D119 identifier; D119 remains the transcript file-store decision. |
| D140 | Session-owned dirty-workspace transcript review entry *(superseded by D179)* | **After a session produces a successful workspace Write/Edit, its transcript ends with one explicit Review changes command outside collapsed activity groups while that Git working tree remains dirty; other sessions in the same project do not inherit the command. It reports the capped file count and addition/deletion totals and creates, reopens, or activates D128's singleton Review tab. The entry and Review share one workspace-keyed diff refreshed on workspace activation, successful Write/Edit/Bash completion (500ms debounce), explicit Review refresh, and window focus; sequenced requests discard prior-workspace responses. Clean and non-Git results clear review ownership for that workspace; clean, non-Git, missing-workspace, and failed-refresh states hide the entry. Review ownership is renderer-memory state discarded on relaunch with D142's work-panel contexts. This is a contextual artifact/status entry, not the empty manual launcher forbidden by D128.** | Automatic panel opening alone leaves no discoverable return path after collapse or tab close, while session ownership prevents unrelated conversations from claiming project-wide edits. Sharing the real diff makes the conversation entry accurate and keeps Review deduplicated. |
| D179 | Message-scoped inline review cards *(superseded by D180)* | **Historical decision: each successful workspace Write/Edit row rendered a card by matching the current workspace diff.** | Superseded because current Git state disappears after commit and cannot provide message-owned rollback |
| D180 | Message-owned review snapshots and guarded rollback | **Successful workspace Write/Edit results carry bounded `details.review` evidence: snapshot id, message/tool id, path, operation, added/modified/deleted status, +/− counts, hunks, and rollback state. The host stores pre-tool bytes and before/after hashes outside the workspace under the session, and the renderer derives the adjacent card and chronological Review history from transcript messages only. `review.rollback` verifies the current post-tool hash before restoring prior bytes or removing a newly-created file; conflicts never overwrite later edits. Session deletion and startup cleanup remove snapshots; forked evidence is visible but non-reversible.** | A message-owned snapshot survives Git commits, separates same-path edits, and makes rollback explicit without trusting mutable repository state |
| D142 | Session-scoped work-panel runtime contexts (no-launcher clause amended by D207) | **Each conversation owns an in-memory work-panel context containing open state, ordered tabs, active tab, and Browser resource. Session selection atomically projects that context, switching away never deletes it, and switching back restores it. File/URL/BrowserPreview/command/Review artifacts are recorded against their originating `sessionId`; BrowserPreview renderer events therefore carry `sessionId`. Background artifacts may update their retained context but never open, activate, resize, navigate, or focus the visible panel. A workspace selection without an active conversation hides the panel, and relative resources remain bound to their session/workspace. Relaunch discards every context and Browser resource; only panel width persists. This supersedes only D128's requirement to close and clear tabs when the visible session or workspace changes; D128's artifact triggers, deduplication, and close/collapse behavior remain unchanged, while D207 adds an active-session shortcut that only reveals the retained context. No process ownership boundary changes.** | Permission-gated tools can finish while another conversation is loading or visible. A global destructive tab set either flashes open before being cleared or loses the originating conversation's tools; session-keyed renderer state preserves continuity without allowing background work to steal focus or making transient resources durable. |
| D154 | Work-panel activity rail and resource switcher | **Once an artifact has opened the work panel, a 44px activity rail exposes Review, Terminal, and Browser as one-click 32px tool buttons; opening a missing tool still uses D128's `openWorkPanelTab` path. The 46px content header shows and closes the active resource and exposes a bounded keyboard-operable switcher for every open tool/file resource. The panel minimum becomes 364px so the rail preserves the previous 320px content floor *(width clamp superseded by D167)*. This replaces the horizontally scrolling top tabs and hidden empty-header context menu while preserving D128's artifact-driven panel entry, resource deduplication/order, close-neighbor behavior, and session-scoped runtime ownership.** | High-frequency tools should be visible and spatially stable, while long or numerous file names need a labeled overflow surface rather than compressing every action into one titlebar row. |
| D157 | One visual assistant turn per user turn | **Provider-level assistant messages separated by thinking/tool activity remain distinct canonical transcript records, but ChatTranscript composes all records after one user message and before the next into one `role=article` assistant turn. Ordered markdown fragments and activity disclosures remain visible; only the composed turn owns the trailing aggregate model/usage row and Copy/Fork/Retry toolbar. Copy joins all contentful fragments with paragraph breaks; Fork and Retry use the last contentful assistant record as their durable boundary.** | Tool-capable providers close and reopen assistant messages around every tool call. Rendering those transport boundaries as separate responses duplicated action toolbars and made one agent run look like many AI replies. |
| D162 | Latest-wins cached session switching | **The renderer marks the newest selected row immediately, coalesces session-detail prefetch/load work, retains an LRU-style five-transcript memory cache, and starts the newest transcript read without waiting for superseded reads. Workspace alignment may overlap transcript IO; navigation generations gate the atomic visible commit. ChatSurface keeps the previous complete view non-interactive while React defers a changed session tree, then paints the destination at its final record. Cached snapshots are always revalidated.** | The former global selection promise queue made every click wait behind obsolete full-transcript JSONL reads, while one synchronous long Markdown commit delayed visible feedback. Latest-wins IO plus a stable deferred frame matches Codex-style navigation without weakening session/workspace isolation. |
| D156 | Independent native-window and work-panel resize ownership | *(responsive-clamp and no-native-reservation clauses superseded by D163)* **Electron Main exclusively owns BrowserWindow bounds at a 1040x700 minimum, while the renderer owns a persisted preferred work-panel width. The divider uses anchored, frame-coalesced preview and commit-on-release; Escape, pointer cancellation, and lost capture roll back. Native window-edge resize never rewrites the panel preference. This supersedes D083's restore minimum and removes the `window/resizeBy` delta channel and resize-attribution heuristic.** | Circular ownership made divider release resize the OS window a second time, introduced async races and platform differences, moved windows near display edges, and rewrote a panel preference during unrelated native resize. |
| D163 | Native width reservation for the fixed work panel | *(width range superseded by D167)* **An open docked panel keeps one committed fixed width in `364..720`; native window/sidebar changes never clamp it. Renderer sets the visible target through idempotent `window/setWorkPanelReservation({width: 0 | 364..720}) -> {requested, reserved}`: open requests the committed width, collapse/final close requests zero, and divider commit updates it. In normal state Main adds available native work-area width and reverses it symmetrically, so chat stays stable when the full target fits; otherwise the panel remains fixed and chat absorbs `requested - reserved`. Native edges resize chat only. Maximized/fullscreen requests defer until normal; display/work-area changes reconcile the target against current available width without reapplying it during ordinary same-display movement. Persisted base bounds exclude reservation width and its x shift, and background artifacts cannot alter the visible reservation. This supersedes ADR 0029/D156 clauses that clamp the panel inside current client width or prohibit panel-driven target geometry, while preserving Main bounds ownership and divider gesture rules (ADR 0032).** | A docked tool should not take width from chat when the display can extend the normal window, and resizing chat should never squeeze the tool. A bounded target-state reservation provides Codex-like behavior without restoring non-idempotent deltas or circular preference updates. |
| D167 | Slimmer default work-panel width | **The docked work panel opens at a 280px committed default (one third narrower than D163's 420px) and clamps to `244..720px`; the renderer constant, the Electron reservation validator, and the `.work-panel` CSS floor share those bounds. Double-click on the divider restores 280px. The 44px-rail-plus-320px-content rationale behind D154's 364px floor no longer applies now that tools live in the header switcher, so the floor scales with the default. Persisted wider widths stay valid and are unchanged on upgrade; the 720px maximum, divider gesture rules, and native reservation lifecycle are unchanged (D255, ADR 0122).** | The panel opened wider than most review/terminal/file content needs, taking readable width from chat inside the fixed client area, and the old 364px floor made a narrower default unreachable. |
| D255 | Restore native reservation while the work panel is visible | **Keep the work panel as an in-flow fixed-width renderer column, but request its committed width through `window/setWorkPanelReservation` before presenting it. Keep the panel mounted during exit, then request zero and unmount only after the reservation succeeds. The native window therefore grows to preserve MainChat width while the panel is visible when the display work area allows it, and collapses symmetrically back to the base bounds when the panel is folded or closed. Constrained work areas retain the existing capped reservation and chat shortfall; persisted bounds exclude temporary reservation geometry. This supersedes ADR 0033's no-native-expansion decision without changing the IPC shape, Browser measured-bounds path, Main-owned edge resize, or session-scoped panel state.** | The fixed-window dock left the application window wider after the user collapsed the panel, causing MainChat to occupy the released right-column width instead of returning to the chat-only window bounds. |
| D256 | Native taskbar minimize for Windows/Linux window controls | **Amend D216 / D252 and ADR 0078 / ADR 0117: Windows/Linux renderer and native-menu `minimize` actions call Electron's native minimize transition, and their `minimize` event is not converted to `hide()`, so the taskbar entry remains available. macOS native minimize remains tray-resident. Windows/Linux close behavior remains D230 / ADR 0090: the close button hides to the tray only for `tray` and exits for `quit`. No IPC action, storage, host protocol, or background-process contract changes.** | The custom top-right minimize button was using the same tray-hide effect as close-to-tray, so users lost the normal taskbar restore path even though close behavior was already configurable. |
| D258 | Transcript layout index, one window coordinate space, and identity truncation | **Refine ADR 0120: host-core keeps a per-session transcript layout (byte offset of every message and compaction line plus the `file_len` those offsets were recorded against) and serves a bounded window by seeking to its first selected line, so opening a session costs the window instead of the whole history. The layout is an in-memory cache of derived data: growth scans only the tail, shrink or replacement rescans, and every rewrite/delete path drops the entry; a torn trailing line stays outside both the offsets and `file_len`. Lines are classified by one depth-aware scan for the top-level `type` key rather than parsed, so a nested `type` inside an open-ended tool result or checkpoint detail cannot decide a line kind; `type` is now written first so the scan usually stops at the first key, and legacy lines that carry it after their payload are read by the same scan. Read windows are physical message-line positions clamped against the layout and never against `last_seq`, whose deduplicated count sits permanently below the file whenever an append's index commit was lost - which had been cutting the newest messages out of the tail. The compaction chain is still returned whole with any window. `agent/prompt` gains `truncateFromMessageId`, resolved by the host against its own transcript and rejected with `NOT_FOUND` when unknown, replacing a `messageStart + userIndex` sum that mixed file offsets with renderer array indices. Recording a forked child (list row, cached transcript, checkpoint marks) becomes unconditional while only the visible switch stays gated on the D139 navigation intent.** | ADR 0120 bounded the payload but left a full sequential scan to locate each page, so long sessions still opened slowly and degraded as they grew; and two coordinate-space confusions were silently losing the newest messages and truncating the wrong turn on a paged transcript (ADR 0127) |
| D259 | Bounded shared budget for transient provider failures | **Amend D186 / D245 and ADR 0050 / ADR 0091: non-429 transient provider failures share one bounded logical-turn budget of four retries after the initial attempt, for five provider attempts total, shared across request setup and stream delivery. The budget admits exactly `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and retryable `PROVIDER_ERROR`; `PROVIDER_ERROR` is now retried in the stream phase as well as during setup, so an upstream gateway 502/503/504 recovers wherever it lands. Non-429 delay honors `retry-after-ms`, `retry-after` seconds, then HTTP-date before a deterministic 1s/2s/4s/8s schedule, capped at 8 seconds, and captured headers are retained for every status that can state a delay (429, 408, 409, 5xx). Only the failed request is replayed; the session, transcript, and completed tool calls are untouched. The main session, builtin subagents, and one-shot composer enhancement share the same codes, budget size, and precedence. The 429 five-retry budget stays separate and the two do not draw from each other. Exhaustion records `retryAttempt: 4`. No IPC, storage, host protocol, or provider-config change.** | A relay answering `OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}` reports a momentary upstream outage, but the split one-retry-per-phase policy turned a second 502 into a terminal error card and never replayed a mid-stream 502 at all, while subagents refused any non-request-phase transient retry. One shared bounded budget recovers ordinary gateway flapping without hiding a persistent outage. |
| D164 | Dual-locale in-app product changelog | **Product "what's new" text for app updates is maintained as a dual EN/zh-CN catalog in `packages/shared` (`CHANGELOG`). Electron Main formats notes for the discovered `availableVersion` using the product UI locale and attaches them as optional `UpdateState.releaseNotes` plain text on the existing updates IPC/event path. The ambient banner and Settings → Info Updates row show a compact What's new section when notes exist. English is the source of truth; zh-CN mirrors versions and highlight counts. GitHub auto-generated release bodies remain web-only and are not the in-app source. No new feed URL, notes channel, or renderer-owned remote fetch is introduced (extends D120 / ADR 0022).** | Users need bilingual release highlights at update time without a second network surface or weakening Main's sole ownership of update delivery. |
| D357 | Viewport-fixed work panel toggle | **Amend D128 / D207 / D221 and ADR 0068 / ADR 0085: AppShell owns one viewport-fixed toggle at the top-right of every non-Settings route. It is the pointer equivalent of `Cmd/Ctrl + J` — reveal the active session's retained context without creating a tab, collapse a visible panel without deleting tabs, disabled with no session. It is the sole panel-level collapse control. Windows/Linux window controls stay viewport-fixed; while the panel is open the header reserves that band plus the toggle. No host protocol, IPC channel, or native application-menu command. Artifact-driven tabs and session-scoped contexts are unchanged.** | The shortcut-only entry left the panel undiscoverable for pointer users. A Cmd/Ctrl+J equivalent is not D097's empty fixed-tab launcher. See ADR 0195 and E2E-056. |

## L. Transcript presentation decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D101 | WorkBuddy-inspired transcript density | **User turns render as compact right-aligned soft plates (`min(78%, 560px)`, subtle border + hairline shadow). Assistant turns stay transparent full-width prose (max 720px). Message row vertical padding tightens to 10px. Hover/focus-within reveals quiet copy chips under each turn (right-aligned for user, left-aligned for assistant). Streaming assistant answers use a thin accent left rule. No mascot, reactions, or cost-chip UI yet.** *(amended by D323)* | Current right-aligned user bubbles were underspec'd and visually sparse versus WorkBuddy's task chat; denser plates improve scanability without abandoning the Codex/developer restraint |
| D103 | Per-message model + token meta and retry | **Completed assistant turns surface modelId + token usage chips under the answer (tokens-only; hover breakdown for input/output/cache/reasoning). Usage is attached on runtime message_end from pi-ai Usage, persisted in message meta_json, and reloaded with the transcript. Action row adds Retry, which re-sends the nearest preceding user prompt. No currency pricing and no like/dislike.** | WorkBuddy per-message meta improves trust/scanability; token totals already flow from the provider while priced cost still needs a catalog |
| D105 | In-place regenerate for assistant turns | **Regenerate truncates the session transcript to the nearest preceding user prompt (exclusive of that prompt and everything after), disposes the live pi-agent for the session, and re-sends the prompt so the new assistant/tool tail replaces the discarded branch instead of stacking a duplicate turn.** | Users expect regenerate to rewrite the current turn; append-only retry polluted long sessions and left stale answers above the redo |
| D106 | Preserve user hard newlines in transcript | **User bubbles render plaintext with hard newlines intact. Composer only trims leading/trailing whitespace; transcript uses `message-user-text` with `white-space: pre-wrap` (no forced mid-glyph word-break) so multi-line prompts never collapse into one paragraph. Copy and session reload keep the original line breaks.** | Multi-line prompts (code snippets, lists, pasted blocks) are common in coding agents; collapsing newlines makes the transcript hard to re-read and re-edit |
| D107 | Configuration provider studio | **Settings → Agent uses a compact provider studio: a Defaults card, separate vendor-account rows with edit/test/remove actions, modal add/edit dialogs, and card-based AI-service management with secret badges, test connection, and make-default/delete actions. This refines the Providers presentation inside the compact settings directory without adding rail destinations.** | Dense stacked forms, a redundant summary hero, and cramped list rows made multi-provider setup hard to scan and over-emphasized secondary fields |
| D110 | Model configuration label + add-provider dialog | **Settings rail label for the agent destination is Model configuration (zh-CN: 模型配置). Adding a provider opens a modal dialog instead of an inline collapsible composer; the destination id remains `agent`.** | Clarify the model-setup purpose of the tab and reduce page churn while editing provider credentials |
| D108 | Conversation minimap only when overflowing | **The left-edge conversation minimap rail renders only when at least two visible user/assistant messages exist and the transcript overflows one viewport (`scrollHeight > clientHeight`). Short one-page threads hide the rail; streaming growth, content resize, and window resize re-evaluate visibility.** | A navigation rail is noise when every message already fits on screen; overflow is the signal that jump/preview navigation is useful |
| D109 | ChatGPT-style regenerate revision history | **Regenerate archives the discarded assistant/tool tail under a stable `revisionRootId` family in `message_revisions` (schema v4). The live root user turn carries `revisionCount` / `activeRevision` and a quiet `current / total` pager switches linear variants in place. First regenerate stores the original branch as revision 1; later regenerates append new branches and mark the newest active. No free-form branch tree.** *(amended by D307)* | Users expect regenerate to keep prior answers reachable like ChatGPT; D105 in-place rewrite alone deleted history that was still useful for comparison |
| D111 | Empty home scroll stack | *(card-specific clauses superseded by D131)* **Empty chat home is a single scrollable vertical stack inside `home-main-content`. Short windows top-align and scroll; content stays in document flow and the home composer remains non-docked.** | Dual-grow + absolute portal let the home composer overlap guidance on shorter windows; flow layout preserves every remaining block without collision |
| D112 | Readable chat beside the work panel | *(dynamic width clamp superseded by D163; welcome chooser superseded by D128)* **MainChat has a 360px readability target beside the panel. D163 preserves it through native width reservation whenever the display work area can supply the complete committed panel width; otherwise MainChat absorbs the unavoidable shortfall while the panel remains fixed.** | A panel-only width cap could leave roughly 109–205px for chat at supported window sizes; native reservation now preserves chat without compressing the tool surface. |
| D113 | WorkBuddy-inspired local profile footer | **The expanded sidebar ends in a transparent 58px footer. Its 44px profile trigger contains a 30px circular local-user glyph, two-line `Custom` + `Local profile` / `本地配置` identity, and a chevron; a separate 32px Help shortcut opens Settings → Info. The 280px profile menu opens 8px above the footer with a repeated identity header, divider, and Settings / Logs / Theme actions, preserving Escape, outside-click, arrow-key, and focus-restore behavior. This supersedes D041; no cloud account, notification, share, or update capability is implied.** | Adapt WorkBuddy's avatar-and-actions footer grammar to PI-Desktop's truthful local-only capabilities while improving identity hierarchy and eliminating the stale cloud stand-in |
| D137 | Glyph-only message toolbars; edit means edit-the-prompt | **Message toolbars carry icons only: the label lives in a CSS hover/focus tooltip (`data-tip`) plus `aria-label`, never as a visible chip caption (worded buttons stay only on error surfaces). Edit moves off the assistant answer onto the user turn: it opens the prompt in an inline textarea (slash turns seed the typed `command` form so the resend re-expands the template) and saving replays the D105/D109 regenerate path with the new text in the same session — the replaced prompt and its whole answer tail are archived as a revision, so the existing `current / total` pager walks back to the original. Editing the assistant's own text and its fork-into-a-child-session variant (D134) are dropped; Fork stays as the explicit divergence action.** | Four worded chips under every answer read as a sentence and crowded the transcript; and the useful correction is almost always "I asked it wrong", which users expect to re-run in place with history intact (ChatGPT semantics) rather than to hand-edit the model's words in a new session |
| D165 | Safe lazy Mermaid diagrams in assistant answers | **A completed `mermaid` fence in assistant answer prose renders as a theme-aware SVG after entering the near-viewport band. Partial stream fences and all thinking prose stay source code. The renderer dynamically loads official Mermaid, serializes its global theme renders, caps source at 20,000 characters and edges at 500, locks strict/no-HTML/no-link configuration, and applies a second SVG-profile sanitizer. Invalid or oversized diagrams fall back to visible copyable source; the diagram toolbar toggles source and copies it.** | Diagrams improve architecture and flow explanations, but parsing partial streams or every offscreen historical fence would undermine direct-stream and fast-session-switch behavior. Strict bounded local rendering adds the capability without a new protocol, network, or Electron privilege boundary. |
| D261 | The mounted transcript is a window, not the loaded history | **Refine ADR 0120 / D258 in the renderer: the mounted history is a trailing window over the loaded history — 15 rows in the first commit after a session switch, a 60-row steady state, grown 40 rows at a time. Reaching the top escalates in two stages: grow the window while it is partial, and call `loadOlder` only once the window covers all loaded history. Window growth and a fetched page take the same pre-paint scroll anchor, because both add height above the reading position. The window resets per session and is clamped to the loaded history, so a stale budget from the previous session cannot over-mount. The hydration spacer stays scoped to the first commit. The conversation minimap is built from the mounted entries rather than from every loaded message. No IPC, storage, host protocol, or pagination change.** | ADR 0120 bounded what crossed the IPC boundary and D258 bounded the cost of locating a page, but the renderer still mounted every row it had ever paged in and kept it mounted for the life of the session. `content-visibility: auto` skips layout and paint for those rows while retaining their React trees, Markdown ASTs, and Shiki token arrays — the wrong resource on a low-memory Windows machine, where the reported symptom was the chat area getting progressively less responsive in a long session. Windowing bounds retained memory and per-frame reconciliation together; feeding the minimap the full set would have drawn dashes whose click target no longer exists. |
| D317 | Live/durable transcript merge keeps chronological order | **Amend ADR 0120 / D261 / ADR 0137 in the renderer: `mergeLiveSessionMessages` stitches a bounded durable `session.get` page onto the live snapshot in chronological order. Live rows older than the page stay before it; an optimistic user row or in-flight assistant/tool tail stays after it. Completed overlapping ids still prefer the durable row. Live-only rows are never appended after the durable page. A previously appended older prefix is healed back in front when its `createdAt` precedes the page. Renderer only: no IPC, storage, host-protocol, or pagination change.** *(amended by D324)* | A session that stayed open past the newest-100 page accumulated hundreds of live rows. Revalidation used the durable page as the array prefix and appended the rest, so D261's trailing mounted window painted old history and hid the just-sent prompt while the turn kept running. Abort then idle reload showed only the durable page, which is why the messages appeared to come back after Stop plus another switch. |
| D324 | Idle session switch keeps a not-yet-flushed completed tail | **Amend D317 / ADR 0137 in the renderer: `selectSession` stitches the bounded durable page onto the live snapshot whenever the session is running or still has live provenance (`liveSessionTranscripts`). A completed assistant/tool row that the durable page does not yet contain stays. Live provenance is cleared only once that page already contains every live id, not merely because the turn ended. Renderer only: no IPC, storage, host-protocol, or pagination change.** | User prompts persist before the model runs; assistant/tool rows go through the async outbox and land after `message_end`. After `agent_end`, idle revalidation used the durable page only and dropped replies that were already on screen (issue #41). |
| D327 | Completed replies survive process restart | **Amend D299 / ADR 0153 / ADR 0041: the finished `message_end` snapshot is checkpointed before the outbox append; `completed`/`error` `session.endTurn` deletes `.inflight.json` only when that id is already indexed; boot recovery skips completed leftovers so the outbox can append first; handshake awaits that drain then `session.recoverInflightMessages` promotes any leftover as `complete`. Additive RPC, no protocol or schema version change.** | The same user-only transcript as issue #41 after a full quit (issue #42): user rows are durable before the model runs, assistant/tool rows sit in the outbox, and D324's live merge does not survive process teardown. |
| D444 | Cross-session message id collision remaps; outbox UNIQUE is not a pause | **Amend ADR 0041 / D327: `session.appendMessage` still treats an id already indexed in the same session as a no-op (or a terminal-assistant replacement of a streaming row). If that globally unique `messages.id` already belongs to another session, the host remaps to `{sessionId}:{id}` before writing JSONL or the index, and a later replay of the original id is also a no-op against the remapped row. Electron's persistence outbox treats `UNIQUE constraint failed: messages.id` as an idempotent ack and continues draining, so one colliding toolCallId cannot stall every later assistant/tool row or fill the 1024-entry cap. No protocol or schema version change.** | Provider tool rows used `toolCallId` (e.g. `call_421522`) as `messages.id`. Those ids are not globally unique. A collision failed SQLite after the JSONL write, the FIFO outbox paused on that head, later rows from every session never persisted, and a quit showed earlier history as gone (issue #523). |
| D597 | Drain poison outbox entries; accept steering into a delivery turn | **Amend ADR 0041 / ADR 0239 / ADR active-turn-steering / D444: Electron's persistence outbox treats a host append whose message carries a `PERMISSION_DENIED:` prefix as a permanent rejection, drops that row, and keeps draining. `PLUGIN_PERMISSION_DENIED` and other failures still pause. Host provenance accepts `UiMessage.steering` into a claimed collaboration delivery turn when the target session matches, without stamping the delivery origin and after stripping any client-supplied `session_message`. Cross-session steering is still `PERMISSION_DENIED`. No protocol or schema version change.** | Alt+Enter into a session-collaboration delivery turn was rejected as a delivery mismatch, the outbox retried that head forever, filled to 1024, and later assistant/tool rows were discarded so the transcript kept only user messages. |
| D328 | Parent-judged subagent lifetime | **Amend ADR 0089 / ADR 0119 / ADR 0129: idle and duration watchdogs are not armed; parent `agent_end` does not abort running delegates; the runtime keeps the durable turn open and prompts the parent with reports when they finish. `TaskWait` timeout and `TaskList` return a heartbeat (agent, status, elapsed, turns, last tool). Only `TaskStop` and user Stop abort a delegate. Explicit `maxTurns` and the concurrency cap of 10 stay. Runtime only: no IPC, storage, or host-protocol change.** *(amended by D352: a terminal parent error does abort leftover delegates and returns the session to idle)* | The parent cannot see live delegate work and treats `TaskWait` expiry as permission to finish, after which abort-on-end killed the unfinished job. Waiting is an event loop; models are not. |
| D352 | Parent fatal error aborts leftover delegates | **Amend D328 / ADR 0166: parent idle still keeps the durable turn open and does not abort running delegates. A terminal parent provider/stream error (including exhausted HTTP 429), overflow-recovery failure, mutation-budget termination, or rejected prompt aborts leftover delegates, skips the D328 resume prompt, and emits `agent_end`. `isRunning` does not count leftover delegates after that error, so Continue is not `AGENT_BUSY`. A later `agent_end` must not overwrite the failed TurnOutcomeCard. Each new parent prompt bumps a turn epoch and only auto-resumes delegates started in that turn. Runtime and renderer only: no IPC, storage, or host-protocol change.** | After a parent 429 the UI showed Continue while a Gemini (or other) subagent kept the sidecar busy, so the next prompt was `session already has an active turn`. See ADR 0189 and E2E-155. |
| D354 | Label both macOS release architectures | **Amend D353 / ADR 0145: both native macOS release lanes pass target-specific electron-builder patterns. Public assets are `PI-Desktop-<version>-arm64.dmg` / `PI-Desktop-<version>-arm64-mac.zip` and `PI-Desktop-<version>-x64.dmg` / `PI-Desktop-<version>-x64-mac.zip`. Generated per-architecture updater feeds retain these URLs and checksums. This changes release asset naming only; updater ownership, signing, and delivery mode remain unchanged.** | The arm64 asset `PI-Desktop-0.14.4.dmg` did not identify its architecture, while the x64 lane used a different `Intel` convention. Both public architectures need self-describing, standard labels. |
| D353 | Disambiguate Intel macOS release artifacts | **Amend D285 / ADR 0145: the native macOS x64 release lane passes target-specific electron-builder patterns so its public assets are `PI-Desktop-<version>-Intel.dmg` and `PI-Desktop-<version>-Intel-mac.zip`. The generated `latest-mac-x64.yml` retains those URLs and checksums. The arm64 lane keeps the generic `PI-Desktop-<version>.dmg` and `PI-Desktop-<version>-mac.zip` names. This changes release asset naming only; updater ownership, signing, and delivery mode remain unchanged.** | Users could not reliably distinguish the Intel download from the arm64 download when both used generic version names. Naming the x64 assets at build time also prevents the updater feed from retaining stale pre-rename URLs. |
| D329 | Agent-chosen Bash timeout | **Amend D190 / D273 / ADR 0054: Bash still defaults to 60 seconds. An explicit `timeout` is 1–21,600 seconds. A value above 21,600 is read as milliseconds, converted, and clamped to 21,600 seconds. In-range values including 600 and 1800 are seconds. Out-of-range values still fail before spawn. Timeout/abort still kills the process tree. Host-core `MAX_BASH_TIMEOUT_MS` matches. No protocol-version bump.** | The 300-second ceiling killed legitimate builds and rejected `timeout: 600` / `1800` (issue #44). A finite host bound remains so RPC cannot hang forever. |
| D331 | Host-owned completed-turn token history | **Amend D103: parent `message.usage` stays pi-ai Usage for that assistant message. Subagent spend accumulates on the durable turn only. Electron sums parent `message_end` usages plus `turn_end.subagentUsage` into `session.endTurn.usage`. `stats.getTokenUsageHistory` rolls up completed turns over a bounded local-calendar window with filled `day` / ISO `week` / `month` buckets. Additive IPC/RPC and `idx_turns_ended_at`; no protocol or schema version bump. No currency pricing. The user-facing dashboard is plugin `pi.token-insights` (D335).** | The turns table was already the usage rollup, but Electron never sent `usage`, and merging subagent tokens into message chips would lie to the context inspector. |
| D335 | Plugin-owned token usage dashboard | **Amend D331 / ADR 0171: Settings has no Usage destination. Global token history is marketplace plugin `pi.token-insights`. Host still persists `session.endTurn.usage` and exposes `stats.getTokenUsageHistory`. The plugin may fold host completed-turn remainders (including subagents) into its PI-Desktop fact cube without rewriting `message.usage`. No protocol or schema version bump.** | Settings duplicated a weaker heatmap the plugin already ships. See ADR 0173 and E2E-186. |
| D326 | Withdraw A2A and Peer coordination | **Remove the Agent2Agent broker, `a2a.*` RPC domain, leftover `SubagentMailbox` / `Peer` tool, and parent/delegate `A2A` tools. Concurrent delegates coordinate only through parent `Task*` reports. Handshake `PROTOCOL_VERSION` 10→11 (no `"a2a"` capability). Storage `SCHEMA_VERSION` 12→13 drops the `a2a_*` tables. ADR 0165 supersedes 0147 / 0162 / 0164.** | The sibling and parent-to-parent channels sat beside `Task*` without a product need, and the model could miss or misuse them. |
| D318 | Restore a missing sessions row from its transcript / outbox | **Amend ADR 0041 / D119 in host-core and Electron main: a live `sessions/<id>.jsonl` whose SQLite sessions row is gone is restored at host boot (`recover_orphaned_sessions`) and on `session.appendMessage`. Restore reinserts the row and rebuilds the search index from the file so append stays idempotent. If both the row and the file are gone, append inserts a stub row under the existing id so a queued outbox can drain. `session.delete` drops that session's outbox entries so a stub recreate cannot resurrect a user-deleted conversation. No protocol version, schema, or renderer change.** | A long running session could lose its `sessions` row (WAL/index loss) while turns stayed in `session-message-outbox.json`. `appendMessage` then failed `session not found`, the outbox paused at the head, the sidebar listed nothing, and the chat showed only the first flushed user row. Re-inserting the row let the outbox drain (issue #39). |
| D262 | Spill large composer text pastes into session scratch | **Text-only composer pastes at or below the persisted `largePasteThreshold` remain native textarea input; the default is 600 characters and valid values are integers from 1 through 1,000,000. Above the threshold, the renderer sends exact UTF-8 `text/plain` bytes through the existing session paste bridge, Electron stores them under `<data_dir>/scratch/<sessionId>/pasted/`, and the Composer inserts a generated `@<temporary-name> ` token at the original selection. The renderer retains a session-scoped token-to-canonical-path mapping, resolves it in place exactly once before dispatch, and excludes it from duplicate attachment/fallback serialization. Existing clipboard file/image chips and bridge bounds remain unchanged; no workspace, artifact-store, host-protocol, or schema change.** | Very large native pastes are hard to edit and visually overwhelm the composer, while the existing session scratch flow already provides bounded, isolated storage and canonical path semantics without dirtying a project (ADR 0131).** |
| D265 | One delegation reads as a card, like a fan-out | **Amends D201 / ADR 0062 in the renderer: every `Task` call in an activity group renders as a full-width delegation card — main-agent root, connector, one node per delegate — a lone delegation included, instead of falling back to a compact tool row. The aggregate header takes a count, so a single delegation is not announced in the plural: English gains `_one` forms and Chinese, which has one plural category, drops the English plural marker. Nothing else about the card changes, and no IPC, storage, host-protocol, or delegation-runtime change is implied.** *(amended by D319)* | Reserving the card for two or more delegates made the same work look like two different features, and the single case — the common one — was the one that lost the outcome, the recorded runtime and the delegate's step count (ADR 0062 §6). |
| D319 | A delegation card is only the Task fan-out | **Amends D201 / D265 / ADR 0062 in the renderer: consecutive `Task` starts form their own activity group and are the only rows inside the delegation card. Parent thinking, workspace tools, and lifecycle rows (`TaskWait`/`TaskList`/`TaskStop`) stay in ordinary processing groups before and/or after that card, never on the topology tile. The card keeps 16px inset from its tile edge. A topology group stays live (open once, ticking elapsed from its own delegation timestamps) while any of its delegates is still running, even when the parent has already moved on to a later processing group in the same turn. Renderer only: no IPC, storage, host-protocol, or delegation-runtime change.** | Consecutive thinking and tool rows used to share one activity group, so a parent that kept working after `Task` painted its own Read/Grep/thinking flush against the subagent tile and labelled them “Subagent working”. The topology already names the main agent; the parent's later work belongs in the turn stream, not inside the card. |
| D320 | Sent file references stay chips and open on click | **Amend D209 / ADR 0070 in the renderer and Electron main: a sent user turn parses serialized `@path` / `@"quoted path"` tokens and paints each as a composer-matching leaf-name chip (icon, ellipsized name, canonical path in tooltip/name). Workspace `.html`/`.htm` chips open the work-panel browser; every other allowed file opens with the OS default handler through `pi-desktop/fs/open`. That channel contains relative paths to the workspace and absolute paths to the workspace, `<data_dir>/scratch/`, or `<data_dir>/attachments/`. HTTP(S) URLs stay text links. Tool-row previews are unchanged. No host-protocol or storage schema change.** | Serialized full paths undid the compact composer node the moment the user sent, and the files tab cannot preview HTML as a page or open suffix-specific OS apps (ADR 0163). |
| D322 | Relative transcript paths preview and open | **Amend the chat/markdown file-link resolver: unprefixed relative paths stay workspace-rooted; `./` and `../` resolve against the workspace root in chat and against the viewed file's directory when previewing a markdown document. `.` / `..` normalize in place; a walk that leaves the workspace stays inert. Assistant markdown linkifies bare file tokens (known extension) in addition to inline code, links, and images. The linkify pass is a unified attacher that returns a transformer; it is never the transformer itself, so freeze does not invoke it with a missing tree. No host-protocol, IPC, or storage schema change.** | Agents write workspace-relative paths in prose and markdown files use `./` / `../` links; those were either not clickable or resolved as if they lived at the workspace root, so preview/open failed. Passing the transformer to `remarkPlugins` made unified call it at freeze with `tree === undefined`, crashing session open on `tree.type`. |
| D323 | Live parent turns stay transparent | **Amends D101 / D297 in the renderer: a streaming assistant turn does not sit on a `--ds-tile` and does not reserve a 14px inset or left rail. Thinking, workspace tools, and answer fragments stay on the page background like a completed turn. The tile remains only on the delegation card (D319) and the nested `.subagent-run`. Renderer only: no IPC, storage, host-protocol, or runtime change.** | D297 replaced the streaming rail with a whole-turn tile so the tint would not reflow. That boxed ordinary answers the same way as a subagent card. D101 already required transparent assistant prose; D319 already assigned the tile to the Task group. |
| D268 | A lifecycle row is a subagent row | **Refines D201 / D265 / ADR 0062 and ADR 0089 in the renderer: the delegation lifecycle rows (`TaskWait`/`TaskList`/`TaskStop`) stay compact tool rows and stay out of the topology counts, but are presented as subagent rows. They summarize from the roster the runtime returned — agent names read from `details.delegations[]` or `details.stopped[]`, a repeat counted rather than listed twice — never from their own `delegationIds` argument; their badge rolls that roster up using the existing `chat.subagentStatus.*` vocabulary; their label names the action taken on subagents instead of "Delegated"; and their body is the roster as a named table led by the joined reports, instead of the raw `delegations[]` JSON. No IPC, storage, host-protocol, or delegation-runtime change is implied.** | The lifecycle rows carry the settled outcome the `Task` card cannot know (ADR 0089), yet they rendered as generic tool calls whose summary was a bare UUID and whose body was a JSON dump — the least readable part of a feature whose card is otherwise the most readable. Reading the roster it already returns costs nothing and makes the whole delegation scan as one thing. |
| D263 | A cross-display drag is user intent, not an OS adjustment | **Amend D255 / ADR 0122 in Main: the work-panel reservation reconcile no longer treats every display change alike. `os-adjusted` (the window manager re-fitting bounds we asked for, or a topology change) preserves ADR 0122 verbatim; `user-moved` (the user dragging the window to another display) takes the current position as the new base bounds, normalizing only the origin into the target work area and keeping the size. Attribution keys off an unaccounted native `move` stream rather than a deadline, and reconciliation is deferred until that stream goes quiet, so no bounds are re-planned mid-drag. A cross-display drag advances the remembered display key and is persisted. No IPC, storage, or host-protocol change.** | The old logic re-planned from the origin display's base bounds and was then clamped to the target work area's edge, so the window jumped on pointer release and stale coordinates were written to `window-state.json` (issue #18, ADR 0132). |
| D269 | History continuation keeps the conversation outline reachable | **Amend D108 / D261 / ADR 0130 in the renderer: when loaded rows are withheld above the mounted window or the host reports an older page, the conversation outline remains present with one dotted earlier-history continuation even if the mounted tail has fewer than two markers or does not overflow. The continuation runs the same two-stage grow-then-fetch path and ordinary message dashes still come only from mounted rows, so every message dash has a real DOM target. The transcript's top loading boundary is observed as well as checked on scroll; while that boundary remains visible after an underfilled tail, a fetched-but-withheld page, or a window transition, history advances again without waiting for a native scroll event. Once no earlier history remains, D108's two-marker-plus-overflow visibility rule applies unchanged. No IPC, storage, host protocol, or pagination change.** | A bounded tail can contain one tool-heavy turn that collapses below one viewport, and fetching an older page can leave every new row outside the trailing mounted window. Neither transition necessarily changes `scrollTop`, so the scroll-only trigger stranded older history and left the outline absent. An explicit continuation represents unavailable navigation honestly, while boundary visibility closes the progress loop without inventing phantom message markers or eagerly loading the whole transcript. |
| D270 | One model picker for both credential kinds | **Refines D237 / D240 in the renderer: the model picker is one shared renderer component rendered by both the AI service dialog and the vendor account dialog. A vendor account therefore gets the same discovered model list, the same `ModelBinding` shape, the same per-model context-window and max-output editing, the same thinking-level controls, and the same explicit binding persistence. Only the left pane heading differs between the two dialogs. The thinking-level catalog-gating clauses are superseded by D283. Renderer only: no IPC, storage, host-protocol, or provider-config schema change is implied, and no ADR is required.** | The two surfaces were copies of one picker, and the copy silently lost the advanced controls, so a vendor-account binding could not edit the same model settings as an AI service. One component makes the guarantee structural instead of a convention two files had to remember. |
| D271 | An expanded delegate run scrolls in place | **Refines D201 / D268 / ADR 0062 in the renderer: a delegate's nested rows render in a bounded `.subagent-run-rows` scroll area of `min(420px, 48dvh)` with `overscroll-behavior-y: contain`, placed on that inner wrapper rather than on `.subagent-run` so the absolutely positioned collapse rail is not clipped. The run heading stays outside the scroll area and the area is a labelled, focusable group. `fields` tables gain the same 260px cap the other detail blocks already had, and a lifecycle row's joined reports render as a bounded `output` block instead of an unbounded note. Presentation only: no IPC, storage, host-protocol, or runtime change.** | Expanding one delegation could add dozens of rows in a single commit — a delegate that made forty tool calls grew the transcript by forty rows — so the reading position jumped and the parent's own next row was pushed out of view. `fields` was the one detail block with no height limit, and D268 had routed up to 50k characters of joined reports into a `note`, which has none either. |
| D302 | An expanded delegate run follows its latest output | **Refines D271 / D071 in the renderer: the bounded `.subagent-run-rows` scroller uses the parent transcript's pinned-follow contract independently. Expanding pins to the newest row; content growth follows the bottom while pinned; the first real upward gesture (wheel / trackpad / touch / scrollbar / keyboard) pauses follow and shows a nested jump-to-latest control; layout clamps and programmatic `scrollTo` never release follow. Native overflow anchoring is disabled on the nested scroller. The jump control overlays a relative wrapper around `.subagent-run-rows`, never on `.subagent-run`, so the collapse rail stays unclipped. Presentation only: no IPC, storage, host-protocol, or runtime change, and no ADR is required.** | D271 capped the nested run so it would not grow the transcript, but left that scroller without stick-to-bottom. A live delegate's new thinking, tool, and answer rows therefore appended below the viewport of an expanded card, and the user had to scroll by hand to see progress (issue #37). |
| D272 | Quitting stops plugins as a shutdown, not as a crash | **Refines spec 07 §3.1 in the main process: `before-quit` calls `PluginRuntime.disposeAll()` instead of `disposeWatchers()`. It marks every loaded plugin as disposing and cancels its pending restarts before anything else, disposes watchers, then stops services and runs `onUnload` in parallel — 1.5s per plugin, 3s for the whole sequence, after which the children are killed. `onPluginCrash` no longer sends its own toast, since the runtime already raised one on that path. Main process only: no IPC, storage, host-protocol, or manifest change, and no ADR is required.** | Quit left the plugin children to be killed by the process teardown, and an unmarked exit is indistinguishable from a crash: `handleChildExit`'s `disposing` guard never applied, so every quit logged `PLUGIN_CRASHED` per plugin at `exitCode: 0`, toasted "stopped unexpectedly" twice, and scheduled restarts into a closing app. 613 of 633 crash reports in one local log were this, which is what made the real crashes hard to see. |
| D273 | A model's habitual argument name is accepted, not corrected | **Refines spec 03 §4 in the agent runtime: `Read`/`Write`/`Edit`/`BrowserPreview` accept `file_path` beside `path`, and `Glob`/`Grep` accept `query` beside `pattern`. Both spellings are optional in the schema so either validates; the runtime folds the alias onto the canonical name before the write lock, the host call, and the transcript, requires exactly one of the pair, and lets the canonical name win when both arrive. `Bash.timeout` widens its schema maximum to 3600000 so a millisecond value validates, and the runtime reads a value of at least 1000 as milliseconds, clamped to the honoured 300-second ceiling, while 301 to 999 stays an out-of-range seconds value. Runtime only: no IPC, storage, or host-protocol change, and host-core's schemas are unchanged.** | Argument names are pretraining habits, not instructions a schema can correct. 852 of 1679 failed tool calls in one local month were a parameter-name miss, 724 of them `Read` sent with `file_path`, which alone was 87% of `Read`'s failures and put its error rate at 11%. Another 69 were a `timeout` in milliseconds. Each cost a turn on an error the model could not see itself making. |
| D274 | Retry an unchanged edited prompt | **Amends D137 in the renderer: confirming a valid user-prompt edit always dispatches the existing edit-resend/Regenerate path, even when the trimmed text matches the original. The inline controls are localized Retry and Cancel actions; Retry retains the existing revision archive, identity-based truncation, slash-command expansion, and attachment behavior. Renderer and i18n only: no IPC, storage, host-protocol, or runtime contract change.** | Treating an unchanged confirmation as a no-op made the “Edit and resend” action appear broken (issue #23), while the old Send label suggested a new ordinary prompt rather than replaying the selected turn. |
| D275 | Preserve the active task boundary across context compaction | **Amends D203 / ADR 0064 in the agent runtime: checkpoints record opaque `details.retainedTailMode`. An active-turn checkpoint retains only the latest user message (up to the existing 20,000-token cap) when the provider must continue after a tool result, `toolUse`, or overflow recovery. A completed-turn checkpoint has an empty retained tail at terminal boundaries, before a new prompt, and for manual compaction; its summary is authoritative for completed work. Legacy records without the mode normalize to their latest user message. No visible transcript, storage schema, host ownership, or protocol shape changes.** | Keeping several recent user prompts while compacting away completion messages made the next prompt look like a continuation of an old task (issue #22). The boundary must be explicit at restore time while active tool loops still retain the prompt needed to continue. |
| D278 | Subagent model selection | **Task.model overrides definition pin; only models with `availableForSubagents` appear in the delegation catalog; on-demand RPC resolves models not pre-resolved at launch** | The parent agent needs per-task model choice without exposing the full provider configuration. An opt-in flag keeps the delegation catalog bounded and intentional, and on-demand resolution avoids stale bindings for models added after sidecar launch. See §3/02 §5f, §3/11 §7, and E2E-166. |
| D365 | Named quiet intervals on the live activity row | **Amend D338 / ADR 0175: `AgentActivity` adds `preparing`, `compacting`, and `recovering`; `starting` shows its own label; `waiting-subagents` carries a live running snapshot (`name`, `lastPhase`, `lastToolName`) that updates on child tool/thinking changes, not on every token. The row stays one compact inline status and does not restore an activity-group capsule.** | Compaction, silent-turn recovery, the post-tool gap, and startup all looked like a stuck generic wait, and a parent wait hid what its delegates were doing (ADR 0198, E2E-008c / E2E-094) |
| D599 | A development build is its own installation | **Narrow D236 / amend ADR 0094: a development build (unpackaged, or `PI_DESKTOP_DEV=1`) takes `PI-Desktop Dev` as its Electron `userData` — and with it the single-instance lock, renderer `localStorage`, the plugin panel partitions, and browser pane cookies — and reads `~/.pi-desktop-dev`. An explicit `--user-data-dir` still wins, which is how the E2E harnesses point a build at a throwaway profile. A packaged installation keeps `PI-Desktop` and `~/.pi-desktop`, so no existing profile is relocated. `PI_DESKTOP_DATA_DIR` still overrides either profile and is made absolute before it reaches host-core as a child-process environment variable; Electron main publishes the resolved directory back to that variable so the plugin runtime reads one root. No IPC, protocol, schema, or packaged-installation path change. See `03-runtime/07-process-model.md` and E2E-150.** | A packaged app that was already running held the lock, so `pnpm dev` quit on arrival; a development host that won the race instead put a second host-core over the same single-writer `pi.sqlite`, the outbox, and the log tree. |
| D602 | Crash dumps stay in the data directory | **Electron's Crashpad reporter starts local-only (`uploadToServer: false`) before `ready`. Dumps live under `<data_dir>/crash-dumps`, not the default Electron `userData` crashDumps path, so a `PI_DESKTOP_DATA_DIR` profile does not share dumps. The next lock-holding launch writes one `diagnostics` line for dumps newer than `crash-dumps.json`, classified by Crashpad `ptype`: `error` if any new dump is the browser/main process, `warn` for recovered renderer/GPU/utility crashes. Host-core and sidecar crashes stay on the supervisor path. No upload, no IPC, no schema change.** | A crash left a minidump nobody read. Crashpad also records recovered renderer crashes, so a next-launch `error` that said the previous run died was a lie; and dumps outside the data directory escaped `PI_DESKTOP_DATA_DIR` isolation. |
| D619 | A copied formula is its TeX source | **Renderer only: a copy whose selection covers rendered math writes `text/plain` from the MathML `annotation` — `$…$` inline, `$$…$$` on its own lines, the delimiters `lib/latex-math.ts` normalizes `\(…\)` and `\[…\]` to, each run widened past any run inside the formula as a code span's fence is — instead of the two trees KaTeX paints. A cut that lands inside a formula grows to the whole formula. Only the formulas are rewritten: the reduced clone is read back through `Selection.toString()`, the serializer a copy itself runs, so prose, lists, tables and code blocks sharing the selection keep the platform's own reading — `user-select: none` chrome left behind included, which `innerText` would have written out. A selection with no formula in it, and a copy raised where the selection does not live, are left to the platform entirely. One flavour is written, `text/plain`: taking the event over drops the platform's `text/html` too and none is written back, because the reduced clone is app markup that would carry the `user-select: none` chrome the text reading drops, and because carrying the rendering instead would paste every formula twice — KaTeX's stylesheet is the only thing hiding the MathML tree and no stylesheet travels on the clipboard. One document `copy` listener owned by the shell, and the transcript's right-click Copy reads the same selection through the same module.** | A formula pasted as its glyphs, once per rendered tree, so it could not be carried into a LaTeX document or another Markdown editor (issue #414). ADR 0268 removed quoting on the grounds that the OS clipboard was the substitute; the clipboard had to actually carry the source. |


## M0. Model catalog decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D266 | Use models.dev as the primary model catalog | **Amend D136 / ADR 0027: Electron main loads `https://models.dev/api.json` as the primary provider/model metadata source, matches by provider key or normalized API URL, and maps its limits, modalities, reasoning options, tool-call, structured-output, display-name, and cost fields into the existing model surfaces. The pinned `pi-ai` catalog remains the local fallback for unavailable/missing remote records and supplies adapter-specific compatibility data where models.dev has no equivalent. Provider endpoint discovery and explicit model IDs remain available for custom/account-specific models; no provider credential is sent to models.dev, and no host schema/protocol change is introduced.** | The pinned pi-ai catalog is accurate for runtime adapters but lags the broader market catalog. A bounded, main-process models.dev fetch gives Settings and Composer current model coverage while preserving offline/local behavior and pi-ai's transport fallback. |

## M. Agent runtime decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D114 | Per-session scratch directory for agent temp files | **Each session gets `<data_dir>/scratch/<sessionId>/` as a second containment root for `Read`/`Write`/`Edit` (absolute paths only; relative paths stay workspace-bound). The path is advertised in the system prompt and as `PI_SCRATCH_DIR` in Bash. Scratch writes auto-allow without a permission card and are excluded from the artifacts table. Scratch is created lazily, deleted with the session, and swept at startup (orphans, >7 days stale). Glob/Grep/BrowserPreview remain workspace-only. Plan does not expose Write/Edit; Plan Bash can still mutate scratch under its resolved permission mode.** | Temp/intermediate files (one-off scripts, downloaded data, drafts) were dirtying the user's project and git status; a host-owned root with identical lexical + symlink defenses keeps the sandbox model intact while giving the model a legitimate place for scratch work |
| D115 | Permission modes: global default + per-session override | *(composer presentation superseded by D132; checkpoint Plan clause superseded by D189)* **A permission mode governs high-risk tool approval: `ask` (confirm everything, default), `accept-edits` (auto-allow Write/Edit, confirm Bash/plugins), `auto` (auto-allow all). Global default lives in settings `defaultPermissionMode`; each session stores `permission_mode` (schema v5, default `inherit`) which overrides it when not inherit. Resolution: session override → global default → ask, enforced solely in host-core `tools.execute`. Plan retains the selector; its Write/Edit/plugin hard deny outranks every mode, while Bash follows the selected mode.** | Confirming every Write/Edit made long agent runs high-friction, but a single global toggle is too coarse — trusted scratch sessions and risky repo sessions need different postures; keeping enforcement host-side preserves the security boundary |
| D132 | Composer permission menu shows effective modes only | **The agent-mode composer chip and menu expose only `ask`, `accept-edits`, and `auto`, with the effective mode selected directly and no global-default/inherit entry or provenance label. Choosing an item stores that explicit session override. Existing `inherit` persistence and resolution from D115 remain unchanged until the user chooses a mode. This supersedes only D115's composer-presentation clause.** | The inherited entry repeated a selectable mode and exposed storage provenance instead of the permission posture the user is choosing; presenting the three effective modes makes the control direct without changing host enforcement |
| D116 | Provider failures as assistant messages | **Every provider/model turn failure is attached to a durable `role=assistant`, `status=error` transcript message through optional `UiMessage.error`. The message shows a localized summary and stable code, keeps redacted provider detail behind an accessible disclosure, and offers context-appropriate Retry or Settings actions. Message-bound failures never use toast/global banner presentation and never re-enter later model context.** | Errors belong to the failed turn; preserving them in the transcript makes the response diagnosable after session switches/restarts without contaminating the next model request or exposing credentials |
| D127 | Context-preserving reseed + transport retry | **Reseeding a recreated pi runtime from the persisted transcript restores tool call/result pairs (from tool rows' `toolCallId`/`toolArgs`/`toolResult`) in addition to user/assistant text and thinking. Interrupted tool rows restore as errored results; orphaned tool rows get a synthesized call-only assistant carrier so pairs stay adjacent and well-formed. Failed assistant turns stay transcript-only. Separately, request setup uses one bounded pi-ai retry for transient transport/provider failures; post-response stream recovery is defined by D186.** | Text-only reseed collapsed a session's context after any runtime recreation (regenerate/edit, config change, restart): the model lost every tool result it had gathered and — seeing its own history answer without visible tool use — stopped calling tools, degrading agent sessions into bare chat. The incident trigger was a single un-retried provider timeout that forced the user into regenerate. D127 corrects the initially duplicated D120 identifier; D120 remains the earlier application-update decision frozen by baseline 0.4.6. |
| D136 | pi-ai owns known-model metadata | **For every model resolved from the pinned pi-ai catalog, Electron main passes the complete pi model snapshot to the sidecar and PI-Desktop replaces only connection identity. Provider Settings and the model menu do not override reasoning support, thinking levels, context/output limits, temperature, or compatibility. Unknown free-form ids remain usable through an explicit generic text-only, non-reasoning fallback. This supersedes D102 and the provider-override clauses of D096/D107.** | A second desktop-owned model matrix discarded pi metadata, drifted from adapter behavior, and made model semantics depend on conflicting configurations; fixes for known models now belong in pi-ai or a pi-ai upgrade. |
| D183 | Segmented tool and model latency logs *(superseded by D385 / ADR 0212; UI clause superseded by D184)* | **Every `tools.execute` call is timed in segments instead of one opaque duration: host-core emits a `tool timing` line on the `host` channel and persists `prompted`, `permissionWaitMs`, `overheadMs`, and `totalMs` next to the existing `durationMs` on `tool_execute` / `tool_denied` audit rows; the sidecar writes greppable `[timing] kind=tool …` (`hostRttMs`) and `[timing] kind=model …` (`providerWaitMs`, `streamMs`, including failed/aborted turns) lines to the `agent` channel, suppressible with `PI_DESKTOP_TIMING=0`. The original no-UI clause is superseded by D184; logging remains unchanged.** | "Executing a command is slow" was undiagnosable from the logs: approval waiting, the tool body, and the provider round trip were indistinguishable, so a 45s gap between two audit rows with 0ms durations gave no clue whether it was the user, the model, or the host. Splitting the stages makes the answer readable without reproducing the run. |
| D158 | Turn-boundary context checkpoint compaction *(soft-boundary, model-tool, and visibility clauses superseded by D200; the model tool and visibility restored in Codex's shape by D203)* | **PI-Desktop reuses pi-agent-core's context estimation, session-context, and compaction primitives but owns the orchestration and durability. After every `turn_end`, before any next provider request, the runtime evaluates model-aware soft/hard budgets. A transient deduplicated instruction can ask the model to call the internal `CompactContext` tool; the tool's normal activity row is visible/durable, while the instruction is not. Crossing the hard budget forces checkpoint generation and blocks the request on failure. A final atomic tool batch that reaches half the hard budget is fairly head/tail-truncated only in the checkpoint copy, with explicit markers and every call/result envelope retained; original transcript rows remain complete. Exact provider overflow removes the failed assistant from model context, creates one checkpoint, and retries once. Host protocol v6 appends checkpoint records beside the untouched visible JSONL transcript; restart, late truncation, and included-boundary forks preserve the newest valid checkpoint. Disabling automatic compaction removes the tool and all automatic threshold/overflow recovery, while `/compact` remains available. OpenCode DCP is an AGPL-3.0 behavioral reference only and is neither linked nor copied (ADR 0030).** | pi's end-of-run-only behavior cannot protect long tool loops, and a model reminder alone cannot guarantee provider safety. Reusing pi's tested compaction format while adding a deterministic `turn_end` gate prevents another provider request from crossing the known window, retains user-visible history, and avoids importing an incompatible plugin/runtime and license boundary. |
| D185 | Lazy per-turn tool activation *(the always-active `CompactContext` clause is void under D200, and holds again for `new_context` under D203; activation restoration amended by D400 / ADR 0225)* | **The sidecar keeps a complete local tool registry but sends only the mode core set and local `ToolSearch` on each new prompt. `BrowserPreview`, plugin tools, `Skill`, and plugin-development helpers appear as bounded compact catalog entries and are activated by exact-name or capability search; the next turn receives their schemas, native pi-ai deferred search is used when supported, and the in-memory set resets before the next user prompt, then restores only successful activation evidence still present in the effective context and allowed by the current catalog and mode. Host permissions, containment, timeouts, and audits are unchanged.** | Full tool schemas made simple first requests disproportionately large and repeated optional capability cost across turns. A pi-style active set preserves core coding ergonomics while making ancillary tools pay-as-you-go and provider-independent; restoring successful context evidence prevents the model from seeing a capability marker without receiving the corresponding schema. |
| D200 | Imperceptible background context compaction *(background pre-computation, incremental trigger, silence, and no-model-tool clauses superseded by D203)* | **Compaction becomes a host-owned background activity with no user-visible surface. `contextBudget()` keeps the D158 hard limit and request headroom, derives the retained-tail target from the model window (`clamp(hardLimit * 0.2, 8k, 64k)`, still capped at half the hard budget) instead of settings, and adds `backgroundLimit = floor(hardLimit * 0.7)` as a pre-computation trigger; the soft boundary is deleted. Checkpoint generation is split from installation: `buildCheckpoint` produces one without persisting or activating it, and installation re-estimates, appends through host-core, and emits `compaction_end`. Pre-computation runs only in provider-idle windows — while a tool executes and after a run ends — and only when the context is past the background limit **and** grew by at least the retained-tail target since the newest checkpoint's baseline, so a large tail cannot trigger a summary every turn. A pre-computed checkpoint installs at the next turn boundary or prompt only if its base is still active, its `throughMessageId` anchor still exists, and it still fits the current model's budget; any miss falls through to the unchanged blocking path, and a failed background build is discarded with no event, no persistence, and no ADR 0049 fallback. The `CompactContext` tool, the `<context_management>` nudge, and the host no-confirmation allowlist entry are removed, so triggering is entirely deterministic. `compaction_start`/`compaction_end` gain an optional `phase` (`background` \| `blocking`, absent means `blocking`) and `compaction_end` gains an optional `status { generation, summaryTokens }`; both are additive inside protocol v9. A successful automatic compaction produces no toast, no run-state change, and no transcript row; only a `retained_tail` fallback, an overflow retry, and manual `/compact` still notify. The context usage inspector is the single visible trace, reading `status` and the durable `SessionDetail.compaction`, with the generation counter carried inside the checkpoint's opaque `details` so no record schema change is needed. Settings exposes no compaction controls and persisted `contextCompaction` values are ignored (ADR 0061).** | Compaction was correct but intrusive: it toasted, moved the run state, spent a model turn on a tool call, left a transcript row, and always ran at the moment the user was waiting. Codex's graded trigger and increment-scoped threshold show the summary can be paid for off the critical path, and its host-only triggering removes a class of wasted turns. Deriving budgets from the model window also fixes applying one pair of absolute token counts to both a 32k and a 1M window; keeping the hard boundary untouched means none of this trades provider safety for UX. |
| D201 | Bounded subagents behind a `Task` tool | **Agent mode exposes `Task` when the catalog contains one of the four inline builtins or an enabled global document under `~/.agents/subagents/*.md`. The catalog is loaded by Electron main for the next prompt, is capped at 16, and keeps delegate reports out of the parent model context. There is no project-level subagent capability directory; `.pi/agents` is not scanned.** | Keeping delegation as a bounded tool preserves parent ownership of context and permissions while a global user directory makes personal delegates portable across projects (ADR 0062, ADR 0112). |
| D202 | Managed global subagent definitions | *(Page-shape clause superseded by D257 / ADR 0126; the global-only data boundary stands)* **host-core scans global Markdown documents under `~/.agents/subagents`, stores enabled state in `<data>/agent-capabilities/subagents.json`, and exposes them through the Settings > Agent > Subagents page. The page is one fixed-height global list with no project picker or project-level source. The runtime combines enabled global documents with builtins; malformed or deleted documents produce diagnostics or disappear after scanning, and no capability state is written into the Markdown file.** | Personal delegates follow the user without creating repository changes; the explicit global-only boundary avoids a second project precedence model and keeps Extensions focused on Installed and Marketplace (ADR 0063, ADR 0112). |
| D203 | Codex-parity context compaction | **Compaction is rebuilt to match Codex's mechanism, reversing four D200 clauses and keeping the rest. All background pre-computation and the incremental trigger scope are deleted: `prepareNextTurn()` compacts synchronously when the total context crosses `hardLimit` or the model asked for a new window. A checkpoint carries the summary plus recent **user** messages only — pi's cut point still marks the boundary, but its split-turn prefix and recent tail are folded back into the summary input so the summary covers the whole range, and the retained tail is rebuilt newest-first from user messages up to 20,000 tokens (capped at half the hard budget) with the crossing message truncated rather than dropped, then restored to chronological order. Two families run the identical lifecycle: `summary`, and a `fresh_window` rollover that requests no summary and stores a fixed marker text, selected by construction option or `PI_DESKTOP_COMPACTION_STRATEGY` and exposed in neither settings nor i18n. The model-facing `new_context` tool returns (parameterless, Codex's description verbatim, on the host no-confirmation allowlist, never assignable to a subagent) together with two per-window budget reminders appended to the current turn's system prompt — one at `clamp(hardLimit * 0.15, 8k, 32k)` remaining, one at 2,000 — each claimed once and reset on install. host-core persists the whole checkpoint chain (`read_compactions`, `write_transcript_with_compactions`, per-record fork validation, `SessionDetail.compactions`) with `compaction` kept as its newest element. `compaction_start`/`compaction_end` drop `phase`, and `compaction_end` replaces `status` with `mark { id, throughMessageId, generation, summaryTokens, summarized }`; the transcript draws one divider row per compaction after the message it covers, ending the assistant turn it lands inside and dropping a mark whose anchor is gone, and every successful compaction raises one warning toast on top of the fallback/overflow/manual toasts. Deliberate deviations from Codex: the summary precedes the retained users because `buildSessionContext` fixes that order, `hardLimit` stays "window − output reserve" instead of 90% of the window, the tool is registered in both families, and the reminders are system-prompt appends with our own thresholds and wording (ADR 0064).** | The previous round cited Codex while implementing its opposite on four counts, and its Context section claimed Codex has no model-side compaction tool when `new_context` exists. The user asked for Codex's mechanism specifically, after being told it reverses the imperceptibility goal. Parity also buys three things on its own merits: a checkpoint that keeps only user messages is far cheaper and cannot strand a tool call without its result, a visible row makes a lossy operation auditable from the transcript again, and a warning puts the "start a fresh session instead" decision where it belongs. The cost is accepted: the user waits for compaction again. |
| D186 | Bounded provider stream recovery and diagnostics *(429 budget amended by D245)* | **Provider request setup uses one bounded retry for non-rate-limit transient failures. A transient `STREAM_FAILED`, `NETWORK_ERROR`, or `TIMEOUT` after streaming begins is replayed once in the same turn after abortable backoff; the failed assistant is removed from model context and its visible message id is reused. HTTP 429 setup and stream recovery follow D245's shared five-retry budget. Provider `AppError.details` carries only bounded phase, timing, provider status/code, and retry-attempt diagnostics. Mutation guidance uses one fresh read/regeneration after an `Edit` mismatch; a second failed `Edit` for the same path or a second failed shell patch command returns a terminating tool hint instead of repairing old patch artifacts.** | Unbounded or regenerate-driven recovery made transient stream termination expensive and made patch loops consume turns without new information; finite runtime budgets preserve context and user control while keeping failures diagnosable (ADR 0050, amended by ADR 0091 and D245). |

| D187 | Resource-isolated host RPC stdio | **host-core reads stdin and serializes stdout through one dedicated named OS thread per direction, never through Tokio's dynamic blocking pool. The threads retry interrupted and transient `EAGAIN`/`EWOULDBLOCK` errors while preserving NDJSON framing; inability to create a control thread is a structured startup failure. The login-shell PATH probe also treats helper-thread creation as best effort and falls back to the inherited PATH. RPC/tool admission limits remain unchanged.** | Tokio stdio can panic when OS thread creation returns `Resource temporarily unavailable` (errno 35 on macOS), turning temporary resource pressure into `HOST_UNAVAILABLE`; isolating the control pipe removes that process-level crash path while retaining bounded overload behavior (ADR 0051). |
| D191 | Agent-only mode; Chat renamed to read-only | *(superseded by D188/D189: the mode selector returned as `Agent | Plan`, and `chat` migrates to `plan`)* **`agent` is the only session mode the product exposes. The former `chat` profile is renamed `read-only` and keeps its `Read`/`Glob`/`Grep` hard deny in host-core, but it has no UI surface: no top-bar toggle, no composer chip, no Settings row, no palette command or slash alias, and no localized labels. The host normalizes `chat` to `read-only` on every write path (`session.create`, `session.configure`, `session.import`) and the permission gate is negative — anything that is not `agent` gets the read-only surface — so an unknown or legacy value can never widen the tool set. Error codes become `BASH_DISABLED_IN_READ_ONLY` / `WRITE_DISABLED_IN_READ_ONLY`. A boot fix-up rewrites existing `sessions.mode = 'chat'` rows and a stored `defaultMode` of `chat` to `agent`.** | A mode switch the product never intends users to reach is a footgun and dead UI weight: sessions could be stranded on a read-only profile with no way back, and two toolsets doubled the surface every tool, prompt, and permission change had to be reasoned about. Keeping the narrow profile enforced host-side preserves the security boundary for imported and legacy rows without shipping a control for it (ADR 0055). |
| D369 | Effective subagent thinking metadata | *(amended by D395)* **The immediate `Task` result, `SubagentRunResult`, and lifecycle snapshots carry the effective `modelId` and `thinkingLevel` passed to each child run; the topology node and side-dock header show the raw canonical non-`off` level after the model name, while `off`, `omit`, and unsupported reasoning stay model-only. No host protocol, storage schema, provider request, or lifecycle behavior change.** | Delegation cards need the level actually sent after the target model clamps it, not a value re-derived from the parent or the definition (ADR 0202, ADR 0221, E2E-219) |

| D395 | Canonical thinking-level values in the UI | **Amend D369 / ADR 0202: Composer, model configuration, and delegation surfaces render `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` directly instead of translating them. Remove these values from every locale catalog; effective metadata, clamping, provider requests, protocol, and storage remain unchanged. See ADR 0221 and E2E-219.** | Thinking levels are stable protocol values, and locale-specific labels made the same provider/runtime setting vary across the application. |
| D445 | Compaction summary retries and is right-sized before retained-tail recovery | **Amend ADR 0049 decision 1 / D203: the automatic summary request carries a bounded pi-ai `RetryPolicy` (3 retries, 2s/4s/8s backoff, abort-aware; pi-ai classifies what is transient). The preflight guard sizes the prompt pi actually serializes (tool results capped at 2 000 chars) instead of summing raw message estimates. When that prompt still exceeds the window, exactly one reduced input is tried (tool results cut to a 500-char prefix, thinking dropped, no message removed) before the retained-tail fallback runs. `ContextCompactionMark` gains an additive `fallback?: "retained_tail"` derived from persisted `details.fallback`; the transcript row labels such checkpoints as a failed summary instead of `summary ≈N tokens`. No record schema, protocol version, or host-core change. See ADR 0282 and E2E-084.** | Issue #543: six of ten checkpoints on a real long session were the ~112-token recovery notice. The summary request had no retry, the raw-size guard skipped summaries that would have fit, and the row presented every fallback as a successful summary. |

## N. Notification decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D117 | Durable task notification inbox | **Rust host-core exclusively owns a schema-v6 `notifications` table and atomically inserts one structured `task.completed` / `task.failed` row when `session.endTurn` moves a running turn to completed/error only if Electron reports that result was not already visible. Renderer supplies the current chat session through an allowlisted viewing-context IPC and a matching prompt-dispatch snapshot; Main suppresses insertion only when its window is visible/focused and that session matches, while unknown, background, hidden, or unfocused state fails safe to notification. `turn_id UNIQUE` prevents duplicates, abort is silent, session deletion cascades, and only the newest 200 rows remain. The titlebar bell exposes exact unread count, All/Unread, row mark-read/session activation, mark-all-read, and clear with complete keyboard/accessibility behavior. Protocol v4 adds singular `notification.list/markRead/markAllRead/clear`; `session.endTurn` returns an inserted record, Electron emits renderer `notification.changed`, and only while the main window is unfocused it also shows a native system notification whose click restores/focuses the window and emits `notification.activated`. Persisted rows contain structured kind/session/turn/error data plus the session-name snapshot, never localized notification title/body prose. The task inbox has no permission, scheduled-reminder, preference, cloud-notification, or plugin-notification source; plugin-native notifications are the separate D213 surface. D113's profile footer remains unchanged.** | Notifications should recover task outcomes the user did not see, not duplicate a result already visible in the current chat. A bounded host-owned inbox keeps background/unfocused outcomes durable and navigable without violating SQLite ownership, duplicating events, or turning every terminal event into notification history. |

## O. Desktop shell decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D118 | Platform application menu and window chrome | **macOS installs a conventional system application menu and keeps hidden-inset traffic lights. Windows/Linux use the shared 46px frameless shell with localized File/Edit/View/Window/Help menus and renderer-drawn minimize/maximize-or-restore/close controls. Both menu surfaces route renderer-owned actions through a fixed `AppMenuCommand` allowlist; renderer menus route native editing/window actions through a separate fixed allowlist. Target packaging builds the local release host before Electron packaging. This adds platform-ready shell behavior but does not reverse D010: Windows/Linux release qualification remains post-MVP.** | A default Electron menu leaves macOS shell commands incomplete, while a frameless Windows/Linux window otherwise loses both application menus and window controls. Shared allowlists keep behavior consistent without exposing an arbitrary privileged command bridge. |
| D120 | Application update delivery | *(amended by D364 / D603)* **Electron Main exclusively owns a fixed GitHub Releases feed, update polling, typed state, and install lifecycle. Development is disabled; packaged macOS and non-AppImage Linux use notify-and-link delivery, while Windows NSIS and Linux AppImage download in-app and install on quit. Renderer IPC cannot provide feed URLs. Automatic failures stay ambient, explicit checks surface status, and downloaded state remains actionable. The updater always forces `allowPrerelease = false` so prerelease installs (for example `0.2.0-rc.6`) track GitHub's latest stable release instead of electron-updater's default same-channel pin. D126 later publishes every platform feed produced by the tag matrix while macOS remains manual until a signed channel is qualified.** | Keep package installation outside the sandboxed renderer, match delivery to each installer format, and provide one consistent state across menus, Settings, and the update banner (ADR 0022). Without the stable-channel pin, RC builds never surface newer stables because electron-updater treats `rc` as a custom channel. |
| D313 | Main-owned GitHub issue feedback | **GitHub issue forms are the only intake path. The bug form requires description, reproduction steps, expected and actual behavior, app version, and OS; the feature form requires a problem and a proposed change. Settings → Info exposes one Report a problem action on `pi-desktop/app/openFeedback`. Electron Main builds a fixed `bug_report.yml` URL, prefills `app-version` / `os` / `environment` from Main-owned version info, and opens it with `shell.openExternal`. The renderer cannot supply a URL. Feature requests stay on GitHub's template picker. No host-protocol, storage, or update-feed change (ADR 0157).** | Reports without version or steps cannot be triaged, and a renderer-chosen destination would weaken the same Main-owned GitHub URL rule as D120. |
| D330 | Main-owned `openExternal` protocol allowlist | **Every `shell.openExternal` call parses the URL first. Only `http:`, `https:` (hostname plus a written `//`), and `mailto:` (non-empty address) reach the OS, as a normalized href. `file:`, `javascript:`, `data:`, and custom URI schemes throw `DISALLOWED_EXTERNAL_URL` / plugin `INVALID_ARGUMENT`. Window-open handlers deny in-app and catch the error. Workspace files keep using `shell.openPath` after the path gate (ADR 0109). Preview "open in browser" uses the allowlist for web/mail URLs and `openPath` for an in-root file page (ADR 0168).** | Unvalidated `setWindowOpenHandler` → `openExternal` lets a clicked `ms-msdt:` / `file:` / custom-scheme link invoke an OS protocol handler. |
| D332 | Classified plugin file preview and live workspace events | **Amend ADR 0104 / 0105 / 0109 / 0111: add `fs.readPreview` under `fs.read` (text / image data URL / binary / tooLarge, same caps as the host Files tab). Broadcast panel events to docked views as well as detached windows. Deliver `workspace:changed` to panels and plugin processes. The bundled Files view restores Open with default app, search, image preview, and copy path on those public channels.** | `fs.readText` cannot preview images or cap large binaries; docked views missed `appearance:changed`; Files polled for project switches. |
| D334 | Contained in-chat image display | **Amend the desktop `fs/read` workspace-only clause: `fs/read`, `fs/reveal`, and `fs/open` share `resolveOpenablePath` (workspace, `<data_dir>/scratch/`, `<data_dir>/attachments/`, plus `attachments/<sha256>` blobs). Reads `realpath` the target. Add renderer-only `fs/readImageDataUrl` that returns a bounded image data URL or `missing` / `notImage` / `tooLarge` and never non-image bytes. A known image extension wins over client `mimeType`; extension-less blobs accept only the `IMAGE_MIME` allowlist. Chat thumbnails and local Markdown images load through that channel; click opens the host files viewer. Not a plugin API. See ADR 0172 and E2E-187.** | History attachments are extension-less data-root blobs the renderer origin cannot load; an unbounded absolute-path read would leak arbitrary files. |
| D336 | Host-owned plugin completions and session context | **Amend D019: plugins may read the in-flight tool session's model-facing transcript through `pi.session.getLlmContext()` when `session.read` is granted, and may run a one-shot completion through `pi.agent.complete()` when `agent.complete` is granted. `pi.models.list()` lists ready provider/model rows (`models.list`). Credentials never leave Electron main. `includeSessionContext` requires both complete permissions and an in-flight tool session; plugins cannot pass a session id. Completions are rate-braked (8/60s) and size-capped. `session:modelChanged` is pushed after `session.configure`. The bundled first-party Advisor UX is temporarily not shipped; the public APIs remain available to explicitly installed plugins. No protocol/schema bump. See ADR 0174 and E2E-188 / E2E-189.** | Second-opinion tools need the user's models and the current LLM context without holding secrets or calling providers from plugin code. |
| D340 | User-configurable outbound proxy | **Settings → General → Network exposes Proxy as System / Direct / Custom. Custom accepts http/https/socks5 URLs and a bypass list, persisted as optional `AppSettings.networkProxy`. Chromium `session.setProxy` covers the in-app browser and `net.fetch`; the agent sidecar applies an undici dispatcher (SOCKS5 CONNECT or HTTP ProxyAgent) via `sidecar.configure`; host-core marketplace curl uses `--proxy` from the stored blob and does not inherit proxy env (workspace Bash stays clean). OAuth still uses the system browser. No protocol or schema version bump. See ADR 0177 and E2E-190.** | Node fetch ignores the OS proxy, so Clash/V2Ray/SOCKS5 users could browse but not call models. One settings control should own app-owned HTTP. |
| D342 | Import model configuration from local agent stores | **Amend D007: Settings → Import still never auto-imports `~/.pi` (or any other tool). An explicit Model configuration card scans Claude Code, Codex, OpenCode, Pi, and CC Switch (`~/.cc-switch/cc-switch.db`, fallback `config.json`) provider rows, lists drafts without secrets, and `modelConfig/importRun` copies API keys through `providers.create`. A live tool file that matches a CC Switch endpoint and credential is not listed twice. OAuth/subscription tokens stay in the source app. Equivalent providers (normalized base URL + API style + same credential) are skipped; different credentials at one endpoint remain independent rows (ADR 0188). If no global default model exists, the first newly created provider becomes it. Electron IPC only; no host protocol or schema version bump. See ADR 0179, ADR 0188, and E2E-209.** | Users already import sessions from those stores and otherwise retype the same endpoints and keys on the Models page. |
| D351 | Preserve distinct credentials during model configuration import | **Amend D342 / ADR 0179: an imported provider is equivalent only when normalized endpoint, API style, and credential all match. Same-endpoint profiles with different API keys create independent provider rows and remain selectable in Composer. Electron main resolves existing API keys through the host secret boundary; secrets never reach the renderer, logs, or provider metadata. The live-file-versus-CC-Switch scan uses the same credential-aware rule. No host protocol or storage schema version bump. See ADR 0188 and E2E-209.** | CC Switch stores multiple accounts at one gateway endpoint; endpoint-only idempotence silently dropped all but the first profile during import. |
| D344 | Main-owned picker capabilities | **Amend D197 / D334: composer native file and image pickers keep selected absolute paths in Electron main behind a short-lived, sender-bound, one-shot token. `composer/importFiles` accepts only that token and a durable session id; the renderer never supplies source paths. The MVP file picker offers regular files only, so unsupported directory selection and its misleading UI copy are removed. Main retains realpath, regular-file, session-scratch, and size-limit validation. See ADR 0181 and E2E-102h.** | Renderer IPC is not a user-click gate: accepting arbitrary absolute paths in the import payload creates a local file exfiltration primitive. Folder import needs separate bounded traversal and symlink semantics. |
| D314 | Shipped locale registry and language picker | **Amend D073: UI locales are listed in `@pi-desktop/i18n` (`en`, `zh-CN`, `zh-TW`, `tr`). Native names stay untranslated. Settings → General language is a searchable picker (Auto + registry), not three preview cards. Plugin labels keep their `en` + `zh-CN` contract with English fallback for shell locales without a plugin translation; the product changelog follows every shipped product locale. See ADR 0160, ADR 0182, and E2E-091.** | Preview cards cannot scale past two languages; a registry lets additional locales ship without rewriting the Appearance card. |

| D345 | Traditional Chinese shell locale | **Amend D314 / ADR 0160: ship `zh-TW` as an independent full shell catalog with native name 繁體中文. `zh-TW`, `zh-Hant`, `zh-HK`, and `zh-MO` resolve to the Traditional Chinese shell; generic `zh` and Simplified Chinese regions continue to resolve to `zh-CN`. Persisted `AppSettings.language` includes `zh-TW`, Electron packages both `zh-TW` and `zh_TW` locale directories, and the in-app changelog includes a matching `zh-TW` catalog so release notes follow the active Traditional Chinese shell. No host protocol or storage schema change.** | Traditional Chinese users need an independent shell and release-note language; reusing the Simplified Chinese catalog makes Auto detection and visible terminology incorrect. |
| D346 | P0 international shell locales | **Amend D314 / ADR 0160 / ADR 0182: ship complete `de`, `es`, and `fr` shell catalogs with native names Deutsch, Español, and Français. `de-*`, `es-*`, and `fr-*` resolve to their shipped base catalogs; persisted `AppSettings.language` accepts the three ids; matching changelog catalogs keep release notes in the active locale. No host protocol, storage schema, or IPC version change.** | Spanish, French, and German provide the highest-value missing P0 international coverage while the registry and searchable picker already scale to additional locales. |
| D349 | Korean shell locale | **Amend D314 / ADR 0160 / ADR 0183: ship a complete `ko` shell catalog with native name 한국어 and English name Korean. `ko` and `ko-*` resolve to the Korean catalog; persisted `AppSettings.language` accepts `ko`; Electron packages the Korean Chromium locale; and a matching Korean changelog keeps release notes in the active locale. No host protocol, storage schema, or IPC version change.** | Korean users need a distinct complete shell and release-note language, while one base catalog preserves the existing searchable locale contract for regional Korean variants. |
| D350 | Focus-aware native task notifications | **Amend D117 / ADR 0107: `notification/showNative` carries `kind` as `task` or `interactive`. Omitted or unknown values default to `task`. Task banners are suppressed whenever the main window is visible and focused, including a focused background session. Interactive prompts are suppressed only for the exact visible focused session. Interactive prompts never create a durable task inbox row. Plugin notifications stay on their permission-gated path. No host protocol or storage schema change. See ADR 0187 and E2E-065 / E2E-065a.** | Task completions and interactive asks share one native channel but need different focus rules. The field is `kind`; a colliding `source` name is not part of the contract. |
| D358 | Show provider retry causes in the active-turn status | **Amend ADR 0175: `AgentActivity.retrying` may carry bounded, already-redacted error details. The compact retry row stays at rest; hover or keyboard focus reveals the localized summary, stable code/status, and provider message. Intermediate retries never become transcript error rows. See ADR 0196 and US-UI-60d.** | Users need the current retry cause without duplicating the final assistant error. |
| D359 | Summarize first-turn session titles with a main-owned one-shot | **Keep the first-prompt fallback synchronous. After `agent_end`, the renderer calls allowlisted `session/summarizeTitle`. Electron resolves the session model and runs a thinking-disabled one-shot; a valid result persists through `session.rename`. Automatic replacement refuses a persisted `manualTitle` and any title that is neither a default nor the first-prompt fallback. No host schema change. See ADR 0186 and E2E-021a.** | A truncated first prompt is a poor sidebar label, but title generation must not block the turn or expose credentials to the renderer. |
| D361 | Inline image transport uses a 10 MB app-side bound | **Amend ADR 0101 / D197: `MAX_INLINE_IMAGE_BYTES` is 10,000,000. Vision-capable models receive images at or below that decimal 10 MB bound as transient base64; larger images and non-vision models keep the `@path` fallback. Electron main and the sidecar share the constant so replay cannot take a different path. No protocol or schema change.** | MiniMax's OpenAI-compatible endpoint accepts one image up to 10 MB; a higher app bound produced provider rejections after the composer had already inlined the bytes. |
| D316 | Searchable theme picker | **Amend ADR 0160: Settings → General theme is a searchable picker row (same anchored-menu pattern as Language), not three preview cards. System / Light / Dark stay pinned at the top; plugin themes follow after a divider. `AppSettings.theme` and plugin-theme fallback are unchanged. See ADR 0161 and E2E-091.** | Plugin themes wrap a three-column card grid, and Language already solved the growing-list control. |
| D121 | Branded macOS development host | **`pnpm dev` on macOS launches electron-vite through a fingerprinted, ad-hoc-signed PI-Desktop copy of the installed Electron host bundle under `.cache/electron-dev/`. The generated bundle changes only development host metadata, executable name, bundle identifier, and the ICNS resource; it never mutates `node_modules`. Windows/Linux keep the stock development executable, while packaged lanes remain electron-builder-owned.** | AppKit ignores runtime app-name/menu overrides for the top-level application identity and takes the native menu name and About icon from the host bundle; a branded development host is required for parity with packaged PI-Desktop. |
| D129 | Menu-free Windows/Linux window chrome | **The application menu is a macOS system-menu surface only. Windows/Linux retain the shared frameless 46px titlebar and renderer-drawn minimize/maximize-or-restore/close controls, but render no File/Edit/View/Window/Help menu inside the window and reserve no left-side titlebar space for one. Existing application, editing, zoom, fullscreen, and close shortcuts remain available through renderer/native web-content handling; update checks remain reachable from Settings -> Info. This supersedes only the Windows/Linux renderer-menubar portions of D118 and ADR 0021.** | An in-window desktop menu duplicates macOS-specific system-menu chrome, consumes navigation space, and does not belong in PI-Desktop's frameless Windows/Linux titlebar. |
| D130 | Sidebar-footer notification entry | **The durable notification Bell moves from the main titlebar to the separate `32px` action at the right of the expanded sidebar footer, replacing D113's Help shortcut. Its unread badge and complete D117 inbox behavior remain unchanged; the popover opens above and to the right of the footer, and no duplicate Bell remains in the main titlebar. This supersedes only the entry-location clauses of D113 and D117.** | Notification history belongs with the persistent local profile controls and the footer position keeps the main titlebar quiet while preserving a compact, familiar status entry. |
| D141 | Canonical Windows native application identity | *(amended by D443)* **Electron Main sets the product name before readiness and registers `com.pi-desktop.app` as the Windows process AppUserModelID before creating any window. That ID is the existing electron-builder/NSIS application ID; Windows packaging explicitly retains `PI-Desktop` for the executable and Start menu shortcut. Native notification attribution, notification settings, taskbar grouping, installed shortcuts, and packaged executable identity must expose `PI-Desktop`, not the stock Electron host. D121 remains unchanged: Windows development may use the stock Electron executable while its OS-facing runtime identity uses the canonical AUMID.** | `app.setName` changes Electron's internal name but not the Windows identity used by notifications and shell integration. One stable ID across runtime and packaging prevents both the observed notification-source leak and adjacent shell-brand drift without changing the published NSIS upgrade identity. |
| D204 | Empty home task-entry surface | *(supersedes D111's non-docked home-composer clause and its contextual quick-action clauses; starter-grid amendment in D205 is superseded by D206)* **The empty chat home keeps the restrained hero and optional first-run checklist in the scrollable content region. The home composer is a bottom-reserved sibling of the scroller, remains visible at the bottom of the chat surface, and never covers the content.** | The direct composer remains the stable primary action and the flow layout preserves checklist reachability in short windows (ADR 0066). |
| D205 | ChatGPT-inspired empty-home guidance | *(superseded by D206)* **The empty chat home adds a compact four-card developer starter grid between the hero and optional checklist: Explore a codebase, Build a feature, Fix a bug, and Review a change. Each localized card only prefills and focuses the bottom composer; it never sends a prompt or creates a turn. The bottom-reserved composer and single scrollable home flow from D204 remain unchanged.** | The previous hero-only middle left too much unused space and offered no starting cues. ChatGPT's clear empty-state hierarchy improves first-task discoverability while developer-specific prompts keep the surface purposeful rather than promotional. |
| D206 | Remove empty-home developer starter cards | **The empty chat home does not render developer starter cards, starter glyphs, or a contextual quick-action row. It keeps the restrained hero, short supporting line, optional onboarding checklist, and D204's bottom-reserved composer; task entry starts directly in the composer. This supersedes D205 without changing D204's scroll and bottom-reservation layout.** | Review confirmed that the direct composer is the preferred task-entry surface and that the cards add an unnecessary decision layer to the empty home. |
| D208 | Recoverable native-tool path contracts | **Keep D185's deferred Glob/Grep boundary, but make every prompt and schema explicit that Read accepts an existing regular file, Glob accepts a directory, and Grep accepts a file or directory. A directory Read returns `INVALID_ARGUMENT` plus structured Glob recovery args; an explicit-file Grep searches only that file and applies `include` to its basename. Tool errors remain visible on their ToolCallRows, while activity groups report processing duration only and never infer terminal turn failure from a child row; terminal agent events and the dedicated outcome surfaces remain authoritative (ADR 0069).** | Durable sessions showed directory Read and file-as-directory Grep mistakes repeatedly, then displayed recovered work as terminally failed. Compatibility at the narrow host boundary plus one outcome owner removes retries and false failure UI without restoring every search schema to the Agent core. |
| D216 | Cross-platform tray-resident minimize | *(Windows taskbar clause amended by D252 / ADR 0117; explicit Windows/Linux action clauses amended by D256 / ADR 0123)* **Electron Main creates one packaged-resource tray icon on macOS, Windows, and Linux. Explicit application minimize actions and macOS/Linux native minimize hide the window without disposing the host or sidecar; Windows' native taskbar minimize remains an ordinary taskbar-visible OS minimize. Tray click/double-click, Show, and macOS app activation restore and focus the existing window (or create one if it was closed). The localized tray menu exposes Show PI-Desktop and an explicit Quit PI-Desktop action.** | Users need background work to continue without losing the app window, while Windows users also expect the active taskbar button to retain its normal minimize/restore behavior. Main-owned tray lifecycle avoids renderer privilege expansion and keeps explicit exit observable. |
| D218 | Host-owned cross-platform plugin panel chrome | **Plugin panel windows adopt the main window's 46px platform chrome: macOS uses `hiddenInset` with traffic lights at `{x:16,y:16}`, while Windows/Linux are frameless with a 112px custom minimize/maximize-or-restore/close band. The sandboxed plugin preload renders the manifest title and controls in a closed Shadow DOM, offsets content by the titlebar height in addition to existing top padding, and consumes a private sender-validated fixed window-action channel; `window.pluginBridge`, the per-plugin partition, and host protocol v9 do not expand. Reopening a minimized panel restores and focuses it.** | Default Electron frames made plugin tools look detached from PI-Desktop and varied by platform. Preload-owned chrome provides parity without moving untrusted plugin HTML into the host renderer or exposing general Electron window authority (ADR 0081). |
| D234 | Plugin-owned panel surface with a host window-control capsule | **Plugin panels use frameless windows on macOS, Windows, and Linux. The sandboxed preload reserves a transparent 46px safe area and renders only one fixed top-right capsule with exactly three buttons — minimize, maximize/restore, and close — in a closed Shadow DOM. It no longer renders a panel title or development reminder. The plugin owns its title, toolbar, background, and all other visible UI; normal-flow content is offset automatically, fixed/sticky UI uses `--pi-plugin-titlebar-height: 46px`, and plugin-owned drag regions use `-webkit-app-region: drag` with interactive controls opting out. The private sender-validated control channel, localized labels, page-adaptive colors, `window.pluginBridge`, per-plugin partition, host protocol v9, and storage schema remain unchanged. This amends D218 / ADR 0081 and D232 / ADR 0082.** | The host titlebar consumed the plugin's visual hierarchy and still made macOS different from Windows/Linux. A compact host capsule preserves safe native window actions while leaving the panel surface to the plugin. |
| D235 | Strict 46px plugin drag band with a minimal capsule | **Plugin panels reserve exactly 46px for a transparent host drag band on every platform. Normal-flow content is offset by that value, the band blocks plugin clicks outside the capsule, and development panels show a localized reminder that the top 46px is drag-only. The host renders no panel title. The fixed top-right capsule stays inside the band, contains exactly minimize, maximize/restore, and close, and uses a subtle page-adaptive surface without heavy shadow or blur. This amends D234 / ADR 0092; the private sender-validated control channel, closed Shadow DOM, `window.pluginBridge`, protocol v9, and storage schema remain unchanged.** | Frameless panels need a reliable drag target and a clear authoring constraint, but the host band must not grow or compete with the plugin's visual hierarchy. |
| D343 | Custom global UI type scale | **Settings → General → Appearance gains a Font size row under Font. Starbucks-style cup presets (Tall / Grande / Venti / Trenta) plus a percentage slider persist as optional `AppSettings.fontScale` (`1` = product ramp, absent = 1, range 0.8–1.5 in 0.025 steps). The renderer sets `--font-scale` on the root; every `--text-*` token and `--leading-row` is `calc(<product px> * var(--font-scale))`, and shared Lucide wrappers size glyphs with the same multiplier, so body, chrome, headings, code, and icons stay in proportion without a reload. The UI never asks for a px value. Window Zoom In/Out/Reset stays independent. An unreleased leftover `fontSize` px field migrates as `px / 14` when `fontScale` is absent. No host protocol or storage schema version bump.** | The `--text-*` ramp is a frozen set of relative sizes; a single multiplier scales every step at once. Window zoom still scales layout. A reading-only px field would leave two type sizes in one window and force the user to pick a number that only matches `--text-base` (ADR 0180). |
| D232 | Custom global UI font | *(amended by D598)* **Settings → Basics → Appearance gains a searchable Font picker (trigger previews the current family). Selections persist as `AppSettings.fontFamily`, a CSS stack; absent means the built-in `--font-sans` token stack, and the renderer applies the stack by overriding `--font-sans` on the root element without a reload. Four bundled families — Geist, Inter, Noto Sans SC, LXGW WenKai — ship locally as woff2 under the SIL OFL 1.1 with license texts; every custom stack appends a CJK fallback tier and the mono stack is unchanged. Installed system families are enumerated by Electron main using platform tooling only (macOS: `osascript` JXA bridging the CoreText query `CTFontManagerCopyAvailableFontFamilyNames` — the same API dbx's `font_kit::all_families()` calls — with `system_profiler` as a slow fallback; Windows: PowerShell; Linux: `fc-list`), deduplicated/sorted/filtered and cached 60 s, exposed through the additive allowlisted channel `pi-desktop/app/systemFonts`; host protocol v9 and storage schema v10 are unchanged.** | Users want a Codex/dbx-style global font preference, but the sandboxed renderer cannot enumerate OS fonts and the host RPC should stay unchanged for a renderer-only preference. Bundling OFL-licensed families keeps every offered font commercially safe and offline, while the fast CoreText path returns the canonical CSS family names (e.g. PingFang SC) in tens of milliseconds and the 60 s cache bounds repeated enumeration (ADR 0083). |
| D598 | The app ships no fonts | **Amend D232 / ADR 0083: every bundled family is removed. `apps/desktop/src/assets/fonts/` (the four `woff2` files and their OFL license texts), `apps/desktop/src/styles/fonts.css`, and the `@import "./fonts.css";` line in `styles/globals.css` are deleted, and `BUNDLED_FONTS`, the `BundledFont` type, `FontOption.license`, the picker's license badge, and `settings.fontBundled` in all eight locale catalogs go with them. The picker keeps System default (persisted as the empty string) followed by installed system families, enumerated exactly as before through the allowlisted `pi-desktop/app/systemFonts` channel, and a stored stack that matches no option still appears first under Saved (`custom`). Every generated stack now appends the system-only CJK tier `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` with no bundled family in front of it. A previously stored bundled stack (e.g. `"Geist", "PingFang SC", …`) is preserved byte for byte, shows under Saved, and renders through that tier. No protocol version, schema version, or storage migration change.** | Four OFL faces duplicated coverage every target OS already provides, cost about 15.7 MiB of `woff2` in `out/renderer` (7.6 MiB LXGW WenKai plus 7.4 MiB Noto Sans SC), and carried font-file notice obligations for four options beside the list the OS already installs. See ADR 0298, E2E-126, and E2E-092. |
| D230 | User-configurable close behavior with close-to-tray | **Windows/Linux close behavior is a persisted preference stored by Electron main in `<data>/close-behavior.json`. `ask` is the transient unset state: the first close shows a native modal (Cancel / Close to tray / Quit); picking one persists it forever, Cancel keeps the window open and unset. Only `tray` and `quit` are ever settable — Settings -> General renders a two-option radio segment (Close to tray / Quit app) for Windows/Linux only, and `pi-desktop/window/closeBehavior/set` rejects `ask`, so a choice can be switched but never reverted to prompting. `tray` hides the window under the resident D216 tray icon (click restores, menu shows or quits); switching to `quit` leaves that icon in place, because minimize-to-tray still needs it. Close interception runs for every non-macOS close that is not already an approved quit; `quitting` and macOS closes fall through, a `quit` close calls `app.quit()` itself, and `window-all-closed` stays silent only under `tray`, so the boot probe and explicit quits are unaffected and a resident tray never keeps a `quit` session alive. `closeBehavior/set` also fails with `INVALID_ARGUMENT` on macOS. The bounds watchdog skips minimized and hidden windows so a tray-hidden window is never force-restored. macOS keeps the native Dock lifecycle (D216, ADR 0078, ADR 0090).** | Minimizing already hides the window into the D216 tray; the gap was close: it quit outright on Windows/Linux. A fixed close-to-tray would surprise users who expect exit, so the choice is asked once, remembered, and revisitable in Settings — matching how Codex-style shells keep long-running sessions alive without taking over the close button. |
| D363 | Explicit quit confirms before shutdown | **Amend D230 / D216: Cmd+Q, the application-menu Quit item, and the tray Quit item show one native warning (Cancel / Quit). Cancel leaves the app running and allows a later quit to prompt again. Confirm runs the ordered `before-quit` shutdown. A window-close path that already chose Quit in the D230 dialog sets `quitConfirmed` and does not ask again. Boot, supervision, and capture probes skip the dialog, and so does the quit an in-app update performs: `autoUpdater.quitAndInstall()` spawns the platform installer before `app.quit()`, and that installer aborts once the app outlives its wait window, so the update restart must reach the ordered shutdown without a prompt. No IPC, storage, or host-protocol change. See E2E-204.** | An explicit quit tears down host-core, the sidecar, and in-flight work; a one-step confirm prevents an accidental Cmd+Q or tray Quit from doing that, without re-prompting a user who already chose Quit on the close-behavior dialog. |
| D252 | Windows taskbar preserves native minimize/restore | *(Explicit renderer/menu minimize clauses superseded by D256 / ADR 0123)* **Amend D216 / ADR 0078: when the focused Windows main window is toggled from its taskbar button, Electron lets the native `minimize` transition complete instead of hiding the window. The taskbar entry remains available and the next taskbar click restores/focuses it. Explicit renderer/menu minimize actions still hide to the resident tray; macOS/Linux native minimize remains tray-resident. No IPC, storage, host protocol, or background-work changes.** | D216's unconditional `window.hide()` handled the taskbar-originated Windows `minimize` event as a tray hide, unexpectedly removing the taskbar entry and leaving the user with only the tray restore path. |
| D236 | One desktop instance per data directory | **Electron main takes `app.requestSingleInstanceLock()` during module evaluation — after `app.setName`, because the lock lives under the name-derived `userData` path, and before the logger, the persistence outbox, or any other data-directory access. A launch that does not take the lock calls `app.quit()` and boots nothing: the readiness and `before-quit` handlers both return early, so it creates no window, tray, child process, or log line inside the running instance's data directory. The lock holder answers `second-instance` by restoring and focusing its main window through the same path as the tray's Show action, which recreates a window that was closed or hidden into the tray. The lock is requested only when `PI_DESKTOP_DATA_DIR` is unset, so E2E harnesses, the capture rig, and deliberate side-by-side profiles keep the current start-anytime behavior. No IPC channel, host protocol, or storage schema changes.** | A second launch booted a complete second app: another host-core over the single-writer `pi.sqlite` (D002), another outbox and log tree in the same directory, another tray, launcher-chord registration, and updater, leaving two shells divergent over one database. Relaunching the app is a request to see the one already running, and scoping the lock to the installation keeps isolated-data-directory runs launchable (ADR 0094). |
| D367 | Host-owned plugin session import and ownership API | **`pi.session` gains `import`, `importBatch`, `list`, `get`, `listMessages`, `rename`, and `delete`; `contributes.sessionSources` is required for every source; host-core generates ids and scopes every operation to `(pluginId, source, externalId)` ownership; imports never activate project/provider/model bindings. Schema v14 adds `session_import_origins` and `sessions.deleted_at`; protocol v11 is unchanged. Trash keeps the transcript for owner-only purge.** | External-history plugins need durable import/read/update/delete, and the in-flight `session.getLlmContext` and core `session.import` boundaries are not safe plugin ownership boundaries (ADR 0200, E2E-214 / E2E-215) |
| D368 | Explicit plugin project ids and host-owned session refresh | **Permission-gated `pi.project.create({ path })` creates or reuses a project and returns its host-generated id without activating the workspace; import items may bind an existing `projectId`, omitted ids stay unbound, and historical origin paths never become tool roots. Electron main emits `pi-desktop/session/event/changed` after successful plugin imports, renames, and deletes; the renderer reuses `refreshSessions()`, skipped imports emit nothing, and closed project tabs are not reopened.** | Exposing `workspace.set` to plugins would change the user's active workspace, and plugin writes need a host-owned renderer refresh path (ADR 0201, E2E-216) |
| D370 | Local MCP control plane for desktop operations | *(amended by D372)* **An opt-in Streamable HTTP MCP server inside Electron Main binds to `127.0.0.1`, authenticates with a persistent random bearer token, validates supplied Origins against loopback hostnames, writes a mode-restricted connection manifest, and delegates to the same registered IPC handlers the renderer uses. Named tools cover the project/session/Agent flow; `pi_desktop_invoke` reaches a risk-tagged operation catalog; dangerous operations require `confirm: true`; successful external mutations reuse the renderer session-change event. Local-only and fail-soft at startup.** | An external Agent needs to drive the running desktop without a second permission or persistence implementation and without touching the deferred remote Gateway / WebUI boundary (ADR 0203, E2E-220) |
| D372 | Tightened local MCP control-plane boundary | **Amend D370 / ADR 0203: the first-version catalog is the project/session/Agent/workspace flow plus reviewed reads; secret-shaped arguments are stripped; `session/configure` is dangerous; listen addresses are asserted loopback; protocol versions are negotiated rather than echoed; results including `structuredContent` are bounded; renderer session refresh is mutation-only.** | The first catalog still exposed native pickers, secret-write provider/OAuth/MCP paths, and unconfirmed `session/configure`, and treated session reads as renderer mutations (E2E-220) |
| D377 | Plugin desktop control requires native user consent | **A `dangerous` desktop operation invoked through `pi.desktop.invoke` needs the plugin's `confirm: true` and then the user's answer to a host-owned native dialog that shows only the catalog operation id, description, and a bounded argument preview; dismissal, Deny, and a host without a dialog service fail with `PERMISSION_DENIED`. `read`/`write` operations and the MCP contract (D372) are unchanged.** | The controller's `confirm` flag is set by the caller, so a plugin (or a model behind it) could delete sessions or switch a session to `auto` with no human in the loop, and any plugin-drawn confirmation card can be relabeled by a prompt-injected transcript (ADR 0208, E2E-236) |

## P. Transcript storage decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D119 | Transcript file store; SQLite index-only | **Schema v7: message content moves out of SQLite into per-session JSONL files under `~/.pi-desktop/sessions/` — `<id>.jsonl` (a session-header line, then one canonical block-array message line per message, RFC3339 stamps) plus an append-only `<id>.revisions.jsonl` for regenerate branches. `messages` drops `content_json`/`meta_json` and becomes a pure index (ordering, promoted filter columns, extracted `text` feeding FTS); `message_revisions` swaps `messages_json` for `message_count`, with `is_active` tracked in the DB only. Writes are file-first then index transaction; reads skip unknown/torn lines and dedupe repeated message ids keep-last; full rewrites are temp-file + atomic rename; session files are deleted only with their session and never age/orphan-swept. Opening a pre-v7 database archives it as `pi.sqlite.v6.bak` and bootstraps fresh — an explicit breaking reset, with all v1–v6 migration code removed. RPC wire format is unchanged, so Electron/renderer/importers need no changes.** | The database grew without bound carrying tool args/results and thinking payloads; codex/claude-code-style per-session files keep transcripts human-readable, greppable, and portable while SQLite stays a small, fast index (list, search, badges). A dev-phase breaking reset was chosen over migration machinery. |
| D122 | Independent conversation session fork | **Protocol v5 adds host-owned `session.fork`: an idle source's complete active canonical transcript is copied into a new independent session with remapped message/tool-call ids and inherited project/provider/model/mode/thinking/permission configuration. Turns, regenerate revisions, notifications, artifacts, session grants, arbitrary scratch outputs, runtime state, pin state, and parent-child lineage are not copied. Referenced existing pasted/imported inputs are copied into child-owned scratch files and their transcript/checkpoint paths are remapped (ADR 0023). Create branch activates the child; D109 remains unchanged because no message-level branch tree is introduced.** | A single host-owned snapshot preserves canonical blocks and persistence consistency while giving users a Codex-style divergence workflow without conflating independent conversations with regenerate variants. |
| D134 | Assistant response fork and reversible edit | *(edit clause superseded by D137)* **The completed-assistant toolbar exposes Copy, Fork, Edit, and Regenerate but no Delete. Fork calls the existing host-owned `session.fork` with optional `throughMessageId`, producing an independent session whose canonical transcript ends at that response. Edit uses the same isolated child, replaces only the selected assistant text there, and stores original/edited tails as a two-entry D109 revision family so the existing pager can restore either. Both require an idle source, remap message/tool-call ids, and never share the source session id, runtime, transcript, revisions, or provider cache state.** | Response-level divergence and correction should remain reversible without mutating the source or letting an edited history reuse cached runtime state built from different assistant content. |
| D199 | Regenerate branch archived under the host RPC lock | **`session.saveActiveRevision` performs the read, the branch archive, and the `revisionCount` / `activeRevision` stamp in one host call under the state lock, replacing Electron main's `session.get` + `session.replaceMessages` read-modify-write. The stamp rewrites only the root user's transcript line and re-reads the file at write time, so a line appended meanwhile survives; Electron main drains the persistence outbox first and skips the archive with a warning rather than archiving an incomplete branch. `session.replaceMessages` carries each surviving message's owning `turn_id` across a rewrite and is documented as safe only for a caller that owns the whole transcript for the call's duration (ADR 0060).** | Assistant and tool messages reach SQLite asynchronously through the ADR 0041 outbox, so the renderer-side snapshot could predate the turn's final message — and the whole-transcript rewrite then deleted it from both the transcript file and the index, along with every row's `turn_id`. Only the host can read and write the transcript atomically. |

## Q. Still deferred


1. Exact marketplace domain / provider IDs
2. Private marketplace auth mechanism
3. Signature key distribution operational details
4. Remote catalog update channel details (URL/signature)
5. Exact recommended default model per vendor preset

The full open list lives in [open-questions.md](open-questions.md); this
section mirrors only marketplace/catalog items still blocking nothing.

## U. Settings rail iconography

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D143 | Settings directory rail icons | **The five settings destinations use fixed Lucide glyphs: Basics=`SlidersHorizontal`, Model configuration=`Bot`, Import=`Download`, Project archive=`Archive`, Info=`Info`. Refresh/rotate glyphs are not used on this rail.** | Prior mapping reused Settings/RefreshCcw/RotateCw, which read as generic gear/reload rather than the destination semantics; monochrome Lucide keeps the compact directory scannable. |
| D166 | Settings directory split into AI and Shortcuts destinations | **The Settings rail grows from five to seven destinations in order: Basics (`SlidersHorizontal`), 全局 AI/AI (`Sparkles`, new), Shortcuts (`Keyboard`, new), Model configuration (`Bot`), Import (`Download`), Project archive (`Archive`), Info (`Info`). Permissions and Context management move from Basics to the new AI destination; Keyboard shortcuts moves from Basics to the new Shortcuts destination; Developer moves from Basics to Info. Basics keeps only Appearance and Defaults. This supersedes the five-destination count/order of D133 and the five-icon set of D143 (adding `Sparkles` and `Keyboard`) without changing any setting's semantics, the full-page shell, or rail metrics.** | Basics accumulated six unrelated cards, burying global AI behavior (permission mode, context compaction) and shortcut configuration alongside look-and-feel; splitting them gives each concern a scannable home while keeping provider/connection config separate in Model configuration. |

## R. Decision rules going forward

- Architecture-boundary changes require a new ADR
- Implementation defaults can be updated in this log + related specs
- Any reversal of D001–D010 requires explicit baseline bump

## S. Composer input decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D123 | Composer slash commands, three sources | **Typing `/` at position 0 of the composer opens an inline command menu merging (a) pi prompt templates from `<workspace>/.pi/prompts/*.md` and `~/.pi/agent/prompts/*.md` (project overrides user-global on name conflict; frontmatter `description`/`argument-hint`), (b) builtin palette commands through slash aliases defined in one registry shared with palette search, and (c) plugin palette commands. On send, builtin/plugin invocations execute locally through the existing renderer switch / `commandPalette/execute` without creating a session or prompting the model; template invocations are expanded in the Electron main `agent/prompt` handler before persistence (`parseCommandArgs` + `substituteArgs` from pi-agent-core), persisting `content = expanded` plus a new optional `command` field carrying the typed form; unknown `/foo` is sent as literal text.** | Reuses pi's exact CLI semantics and template assets, keeps agent reseed faithful (reseed replays `content`), and keeps the transcript readable by rendering the typed invocation as a chip (ADR 0024). |
| D124 | `@` file references are plain-text light references | **`@` at a token boundary opens a fuzzy file menu over a workspace index served by the new Electron-only channel `pi-desktop/fs/index` (files+dirs, `git ls-files -co --exclude-standard` fast path with ignore-set walk fallback, 8000-entry cap with truncation flag, short TTL cache, workspace-rooted, fails soft without a workspace). Accepting creates the canonical `@rel/path ` reference for files (quoted `@"a b.txt" ` when the path has spaces) and inserts `@dir/` without trailing space for directories; D209 amends completed-file draft presentation without changing the dispatched plain-text path. The model follows references with its Read tool in both Plan and Agent. No prompt content inlining or provider attachment conversion; clipboard file materialization is defined by D197.** | Matches pi CLI's model-facing semantics, avoids context inflation and truncation rules, and keeps user-driven file browsing out of the agent tool/permission path per ADR 0019. |
| D125 | Composer autocomplete interaction and IME contract | **One menu component anchored above the composer, full composer width, focus always stays in the textarea. Keys while open: ↑/↓ cycle with wraparound, Enter/Tab accept, Escape closes only the menu (takes precedence over the composer's clear/blur Escape), typing filters live; Enter never sends while an item is highlighted, and an empty result list counts as closed. The menu closes on outside mousedown, blur, deleting past the trigger character, or session switch. All key handling and trigger detection sit behind the IME guard (`isComposing || keyCode === 229` plus composition start/end tracking): during composition nothing triggers, updates, or intercepts, and state is re-evaluated on compositionend.** | First explicit IME rule in the spec — zh-CN Enter-to-send plus candidate confirmation must never fight the menu; uniform insert-then-dispatch keeps two-Enter flows fast and predictable. |
| D197 | Composer clipboard files become session-scratch references | **When the composer clipboard contains one or more OS files/images, the renderer intercepts the file paste, transfers bounded bytes plus name/MIME metadata through the Electron-only `pi-desktop/composer/pasteFiles` channel, and includes the durable session id. Electron main verifies the session, sanitizes names, and writes unique files below `<data_dir>/scratch/<sessionId>/pasted/`; D209 amends the draft presentation while preserving each returned absolute path as the quoted-or-unquoted `@` reference sent to the agent. Text-only paste remains native. A home composer creates or reuses a durable session first. Clipboard bytes never enter the prompt, workspace, or artifact store, and session deletion removes the pasted files with the scratch root.** | Fixes the broken file/image paste path without dirtying the project or inventing provider-specific binary prompt plumbing; it reuses the existing scratch containment and lifecycle contract. |
| D209 | Composer file references separate compact display from canonical prompt paths | **Completed workspace-file selections and materialized clipboard files become renderer-owned, session-scoped reference chips. A chip persistently displays only the leaf name, exposes the canonical path through tooltip/accessibility metadata, and can be removed without deleting scratch bytes. Immediately before submit, references serialize in stable order after the visible draft with D124's exact quoting, so reference-only drafts, slash templates, and Agent/Plan/Goal mode aliases retain their current behavior. Accepted dispatch clears the active editor but keeps a renderer-only, turn-scoped pre-serialization snapshot while smart Stop can still undo an unanswered send. That undo restores the original text and chips rather than prefilling serialized message content; abort after reply start keeps the partial transcript and restores nothing. Rejected/failed sends retain the active draft. `ComposerPastedFile.name` is the sanitized original leaf label while `path` retains the UUID-backed absolute storage identity. No binary payload, provider attachment, host RPC, or schema is added.** *(amended by D362: chips are inline sentinel-backed elements in the contenteditable draft)* | Long relative paths and UUID-backed scratch paths overwhelmed the prompt row even though only the agent needs them. Separating presentation from serialization preserves exact tool-readable paths, duplicate-name identity, textarea/IME behavior, and the text-only provider contract (ADR 0070). |
| D362 | Accepted `@` files insert the same inline chip as paste | **Amend D209 / D125 in the renderer: accepting a completed workspace file from the `@` menu (Enter, Tab, or click) replaces the trigger token with one private-use sentinel in the draft and stores that token on the reference, the same path clipboard paste already uses. The chip paints at the caret; that confirmation never sends. Directories still insert `@dir/` as text. Token-less references are not a visible draft surface. Workspace-relative chips still drop on project switch; absolute scratch/paste paths stay. No IPC, storage, host-protocol, or schema change.** | After chips moved inline, file accept still stripped `@query` and stored a token-less reference that no longer painted, so Enter made the file vanish. |
| D333 | Work-panel browser is the bundled `pi.browser` plugin | **The work-panel Browser launcher, chrome, and agent CDP ship as bundled plugin `pi.browser` (enabled by default, disableable, not uninstallable). The guest `WebContentsView` and debugger remain host-owned and are reached only through public `pi.browser.*` gated by `browser.cdp`. Guest bounds are clamped to the calling plugin view. Raw CDP is allowlisted (cookies/storage/Target/Fetch denied). Host `BrowserPreview` stays a Plan-safe facade that fails if the plugin is disabled. No protocol/schema bump.** | Users need the whole browser to be optional like Files, without putting arbitrary web content inside a sandboxed plugin view. See ADR 0170. |
| D211 | Global plugin launcher | **A customizable `openPluginLauncher` shortcut defaults to Option+Space on macOS and Alt+Space on Windows/Linux. Electron main registers it during startup and owns one prewarmed 620×440 frameless utility window centered on the display nearest the pointer; macOS uses a cross-workspace panel, while Windows uses a host-core low-level hook for the reserved default Alt+Space chord and retains a focused-window fallback if that hook is unavailable. The sandboxed renderer lists only enabled, ready panel plugins, matches Chinese names by original characters, tone-free full pinyin, or pinyin initials (plus normalized name/id/description), and opens the selected result through the existing plugin panel host. Up/Down selects, Enter/click opens, Escape/blur hides, and IME composition never dispatches. The additive toggle/dismiss/shown IPC is Electron-local; host-core's additive shortcut method/notification carries only the binding event.** | Plugin panels need a keyboard-first entry point that works while PI-Desktop is unfocused, without restoring the full shell or weakening the existing panel sandbox/permission boundary (ADR 0072/0076/0080). |
| D212 | Running composers stage next-turn configuration and stopped turns preserve throughput | **During an active turn, draft text and mode/thinking/permission selectors remain editable. The single submit slot renders Stop only for an empty draft; a non-empty draft renders enabled Send and queues the next prompt. The renderer projects the latest full configuration per session and calls the existing idle-only `session/configure` only after the terminal event, so the running runtime remains pinned; pending Plan/Goal approval still gates editing. User-stopped partial answers preserve `responseDurationMs`; when final provider output usage is absent, visible thinking+answer text is estimated at four Unicode code points per token into optional `responseOutputTokens`. Rust transcript metadata persists both fields, exact usage wins, and the UI marks estimate-only throughput.** | Preparing the next prompt should not wait for the current stream, but host safety requires immutable in-flight configuration. A stopped visible answer still has enough measured data for useful, explicitly approximate generation speed (ADR 0073). |
| D215 | Windows-reserved global shortcut fallback | **On Windows, host-core installs a narrow `WH_KEYBOARD_LL` hook for the effective `Alt+Space` default binding because the shell may reserve it from Electron's `globalShortcut`. The hook consumes only the matching chord and emits `keyboard.shortcut({ binding: "Alt+Space" })`; Electron toggles the existing plugin launcher. Electron calls additive `keyboard.setGlobalShortcut({ binding })` whenever settings change, and host-core enables the hook only for that exact binding. Other platforms and custom bindings remain on Electron's global shortcut path.** | Windows' active-window system menu reservation made the shipped global launcher unavailable whenever PI-Desktop was unfocused. A narrowly scoped host fallback preserves the shortcut without reading text or expanding plugin/renderer privileges (ADR 0076). |
| D217 | Early plugin launcher warm-up | **As soon as Electron is ready, before backend/plugin boot completes, Electron starts creating and loading the retained plugin launcher while it remains hidden. Window creation uses one shared in-flight promise, so a shortcut received during warm-up joins the same renderer load; failures destroy the incomplete window, clear the promise, and remain retryable on the next invocation. Each show still refreshes the live plugin catalog. On macOS, showing the panel relies on its normal activation and skips a redundant application activation/window-stack move.** | Overlapping launcher renderer startup with backend boot and avoiding duplicate macOS activation work removes first-invocation delay and visible stutter without weakening plugin freshness, IPC, or sandbox boundaries (ADR 0080). |
| D219 | Plugin launcher most-recently-used history | **The launcher renderer records each successfully opened plugin id with a timestamp in renderer-local `localStorage` (key `pi.desktop.pluginLaunchHistory`, capped at 24) and presents an empty query in most-recently-used order. A typed query ranks search relevance first and uses recency only as a tiebreaker, so unused plugins sort after the recent ones by name. Corrupted or unavailable storage degrades to the existing name order without breaking launching. This refines D211's presentation without changing IPC, host RPC, permissions, protocol v9, or storage schema v11.** | Keyboard-first launcher users reopen the same plugins repeatedly; remembering the last-used order keeps the most frequent target one Enter away while relevance stays authoritative once the user types. |
| D221 | Renderer output size controls | *(bundled CJK clause superseded by D598)* **The renderer build sets `minify: "esbuild"` explicitly because `electron-vite` hard-defaults its renderer preset to `minify: false`. A `pi-drop-legacy-font-fallbacks` plugin strips comma-prefixed `woff`/`truetype` `src` entries with `enforce: "pre"`, before Vite registers them as assets, since the bundled Chromium always supports `woff2`; a face whose only source is a legacy format keeps it. `BrandLogo` imports 192x192 marks derived from the canonical masters at `src/assets/brand/logo-{light,dark}.png` rather than the 1024px installer icons in `build/`, refining D079/D094 without changing the visual identity. `packaging-footprint.test.mjs` asserts all three so a framework default or a reverted import cannot silently regress them. The two bundled CJK faces stay unsubset per ADR 0083 section 2.** | `out/renderer` fell from 31 MiB to 24 MiB with no feature loss; the unminified default and the installer-icon import were accidental costs, while CJK subsetting would drop glyphs from user content and needs an ADR revision |
| D198 | Goal mode is the second contract mode | **Goal is a third durable operating mode (`agent` / `plan` / `goal`) that reuses the Plan approval pipeline end to end. `EnterGoalMode` switches an active Agent turn into the Goal contract state; `SubmitGoal(title, markdown, question)` writes an immutable host-owned `.pi/goal/<unique-name>.md` artifact and inserts one pending `plan_approvals` row. The single approval table gains a `kind` column (`plan` or `goal`, defaulting to `plan`) in schema v11; the kind — not the projected planning state — selects the prompt, artifact directory, submit tool, and i18n namespace, so one approval bar and one execution queue serve both. Plan and Goal are together the contract modes: they share one tool allowlist (Read/Glob/Grep/BrowserPreview/Bash plus their own submit tool), one host hard deny for Write/Edit/plugin/unknown tools evaluated against the durable mode, the shared `*_IN_PLAN` error codes, and the `PLAN_REQUIRES_INTERACTIVE_SESSION` rejection of unattended runs. An approved Goal executes autonomously in Agent: it chooses its own approach and keeps working until every acceptance criterion is verified or a boundary blocks it, then reports criterion by criterion. The wire `kind` is optional and absent means `plan`, so this is additive inside protocol v9.** | Plan answers "carry out these steps"; users also need "reach this outcome, decide the steps yourself" (Claude Code's plan mode and Codex's goal-shaped runs). Making the goal statement, acceptance criteria, and boundaries an approved contract keeps autonomy auditable, and discriminating one pipeline by kind avoids a parallel table, approval surface, and permission boundary that would inevitably drift. |
| D144 | Sidebar primary chrome at 14px | **Expanded sidebar primary chrome (New task, Plugins, session titles, footer identity name, profile menu actions) uses `--text-base` (14px). Project/group titles and empty-state copy use `--text-md` (13px). Section labels use `--text-sm` (12px). Primary sidebar content must not use the micro `--text-xs` band.** | 13px sidebar body felt undersized next to the 14px chat surface; bumping only primary chrome keeps density while restoring visual balance without a global type-scale change. |
| D145 | Disable browser text correction on editable fields | **Every text `input` and `textarea` in the desktop renderer disables browser text correction: `spellCheck={false}`, `autoCorrect="off"`, and `autoCapitalize="off"`. Shared `Input`/`Textarea` primitives default these values; raw fields (composer, message edit, command palette, global search, settings/plugins/projects search, model search, browser URL bar, provider model combo) set them explicitly. Checkboxes and non-text controls are unchanged.** | Coding prompts, paths, model ids, and URLs must not be red-underlined or auto-mutated by Chromium/OS text correction; the shell is an application, not a document editor. |

| D146 | Startup splash + motion tokens | **While bootstrap is incomplete the renderer shows a branded full-window startup splash (logo, shell name, tagline, accessible `app.starting`, soft progress bar) instead of plain status text. After `ready`, the splash holds a short minimum dwell (~420ms), then fades out (~280ms) over the mounted shell. Global motion uses CSS tokens `--motion-duration-{fast,normal,slow}` and `--motion-ease-{out,in,standard}` with shared overlay/surface enter keyframes; interactive transitions prefer these tokens. Reduced motion collapses splash/overlay motion to near-zero and freezes the progress bar. Crash chrome uses `app.uiCrashed`.** | Boot is a first-run moment that previously felt unfinished; a short branded splash communicates readiness without decorative theatre, and shared motion tokens make shell transitions consistent and silkier while remaining feedback-only. |
| D147 | Interaction detail polish (selection, CJK labels, motion fills) | **Copyable surfaces use theme-aware `::selection` (text-primary mix), `caret-color`, and `accent-color` on the monochrome ramp; focus rings mix accent with transparent (no white wash). High-traffic chrome (jump-latest, stop, menus, search rows, notifications, work-panel tab close, brand chip) transitions via `--motion-duration-fast`. Scrollbars are 8px with a stronger hover thumb. Empty-home stack gap is 24px. Under `lang=zh-CN`, section labels drop uppercase/wide tracking. Undefined `--radius-token-row` is replaced by `--radius-sm`.** | Residual gold-polish gaps after the neutral accent + motion-token pass: browser-blue selection, abrupt hover fills, Latin-only label styling on Chinese chrome, and one undefined radius token. |
| D150 | Composer runtime chip descenders | **Composer toolbar chips (Agent/Plan, Thinking, permission mode, model ID) keep labels fully inked inside the 28px capsule: chip and label line-height is `--leading-compact`, chips do not clip with `overflow: hidden` on the control, and the model label uses horizontal ellipsis without `leading-none`. Descenders on `g`/`y`/`p`/`q`/`j` must remain visible in light and dark.** | `leading-none` plus truncate overflow crushed glyph descenders on model IDs and labels such as Agent / Accept edits, making the bottom toolbar look cut off. |
| D151 | Send re-pins transcript follow | **Starting a turn via send, retry, or regenerate always re-pins transcript follow mode, hides the jump-to-latest pill, and scrolls to the bottom before new content arrives. Manual scroll during a turn still pauses follow; the jump control remains the only non-turn way to resume. This refines D071 without restoring forced scroll on every token.** | Users who scroll up to inspect history still expect the next prompt they send to land at the latest exchange; leaving follow paused after send hid the new turn behind the jump pill. |
| D152 | Direct runtime stream rendering | **Assistant content renders each runtime stream chunk directly through the incremental Markdown block cache. The renderer does not add a requestAnimationFrame typewriter state loop. KaTeX's Vite-inlined fonts remain local-only assets and are admitted by the narrow `font-src 'self' data:` CSP directive.** | The duplicate animation loop could trip React's nested-update guard during sustained streams, while the previous CSP blocked bundled math fonts and produced console errors. |
| D153 | Reasoning sessions default to maximum thinking | *(superseded by D303)* **A newly created session whose inherited default model supports reasoning starts at the highest canonical entry in that model's pi-published `supportedThinkingLevels`. Non-reasoning models and missing capability metadata start at `off`; existing sessions retain their durable choice. This refines D096 without adding a provider override.** | Reasoning-capable models should use their strongest available effort by default while preserving explicit per-session choices and pi-ai's model authority. |
| D264 | Composer typing avoids full sorts and redundant DOM writes | **The `@` file menu picks its visible rows with a bounded top-K selection over the match list instead of sorting every match; the selection returns exactly the row set and order a full sort produced, and the small, kind-grouped command list keeps its full sort. Composer auto-resize and `--composer-dock-height` publication are idempotent: an unchanged height performs no DOM write and no document-wide style invalidation, and the `height: auto` measurement probe is taken only when the box may need to shrink. Growth through seven rows, internal scrolling past the seventh, and contraction on delete or submit are unchanged. Draft file-reference state and the cursor keep their identity and value when a keystroke changes neither, so the draft-cache serialization effect and autocomplete trigger detection stop re-running per keystroke. No IPC, storage, host-protocol, or schema change.** | With a large workspace and the `@` menu open, every keystroke paid a full sort over the whole 8000-entry file index to show 50 rows, plus a forced synchronous reflow from the measurement probe, while a fresh `fileReferences` array identity per keystroke re-ran the draft-cache serialization effect. The cost was typing latency, not correctness; ordering equivalence with the full sort is covered by unit tests. |


## T. Release delivery decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D126 | Three-platform release delivery (lifts D010) | *(amended by D364 / D603)* **Tag builds publish every artifact the matrix produces to the GitHub Release: macOS dmg/zip (arm64), Windows NSIS x64, Linux AppImage + deb (x64), each with blockmaps and the platform's `latest*.yml` electron-updater feed. Publishing the feeds activates D120's in-app update lanes for Windows NSIS and Linux AppImage; macOS stays in notify-and-link mode until a signed channel is qualified. The NSIS artifact name is pinned space-free (`PI-Desktop-Setup-${version}.${ext}`) because GitHub asset URLs mangle spaces. D010's macOS-only scope is lifted per the baseline-bump rule (baseline `0.4.7`); the release pipeline itself was qualified end-to-end on v0.1.1-rc.1/v0.1.1.** | The pipeline builds and validates all three platforms on every tag anyway; keeping installers as expiring Actions artifacts (90-day retention) withheld them from users without adding safety. Publishing the update feeds is the point of shipping: platforms with in-app lanes update silently, and future platform regressions surface through real installs instead of unused artifacts. |
| D364 | Windows portable exe without installer | *(superseded by D603)* **Amend D120 / D126 / ADR 0022: tag builds publish a Windows x64 portable exe `PI-Desktop-Portable-${version}.exe` alongside the NSIS installer `PI-Desktop-Setup-${version}.exe`. The portable target does not write `latest.yml`. Packaged portable runs (`PORTABLE_EXECUTABLE_FILE`) use notify-and-link delivery. NSIS installs keep in-app download and quit-and-install. Data stays in the existing application data directory. Portable requests user execution level.** | Company environments that whitelist a single executable cannot run the NSIS installer. Applying the NSIS updater to a portable run would install the app, so portable stays manual (ADR 0197, E2E-211). |
| D603 | Windows portable delivery uses a normal ZIP | **Amend D364 / ADR 0022 / ADR 0197: tag builds publish a Windows x64 portable ZIP `PI-Desktop-Portable-${version}.zip` alongside the NSIS installer `PI-Desktop-Setup-${version}.exe`. The Windows release helper builds NSIS and ZIP separately, stamps ZIP app metadata with `piDistribution = "zip"`, and keeps the ZIP target out of `latest.yml`. Extracted ZIP runs use notify-and-link delivery; the updater still recognizes `PORTABLE_EXECUTABLE_FILE` for older portable executables. Data stays in the existing application data directory.** | The self-extracting portable wrapper could trigger administrator prompts and did not provide a reliable normal executable identity for the taskbar. A user-extracted ZIP launches `PI-Desktop.exe` directly and preserves the manual-update boundary. |
| D260 | Release documentation is a version surface | **A stable version bump must update every version-bearing surface before the tag: the shipped-locale in-app changelog and its test list, every workspace `package.json` including `docs/package.json` (a third workspace root `scripts/release.mjs` previously skipped), the Cargo workspace version and `host-core` lockfile entry, `APP_VERSION`, and the `<major>.<minor>.x` release line stated in `README.md` and `README.zh-CN.md`. `scripts/check-release-docs.mjs` verifies all of them; `scripts/release.mjs` runs it after bumping and refuses to commit or tag while any surface disagrees, with `--skip-docs-check` reserved for deliberate non-release bumps. Extends D164.** | The in-app changelog gate alone left published documentation behind: the READMEs still advertised the `0.5.x` line at `0.10.8`, and `docs/package.json` sat at `0.5.8`. A tag is irreversible, so the check runs before the tag exists rather than as review etiquette. |
| D371 | Explicit unsigned macOS first-launch helper | *(amended by D406 and D443)* **Every macOS distribution ships an executable `PI-Desktop-macOS-open.command`, placed on the DMG in a visible first-launch row below the drag-to-Applications gesture. It searches only `/Applications/PI-Desktop.app` and `~/Applications/PI-Desktop.app`, verifies `CFBundleIdentifier` is `net.aiuo.pi-desktop`, removes only `com.apple.quarantine` when present, and opens the app. It never uses `sudo`, accepts no arbitrary path, and does not replace Developer ID signing or notarization.** | The unsigned macOS lane can be blocked by quarantine with a misleading damaged-app message, and the terminal-only `xattr -cr` note was broader than the launch failure requires (ADR 0204, E2E-196b) |
| D443 | Canonical application ID and macOS codesign identifier | **Amend D141 / D371 / ADR 0204: the application ID is `net.aiuo.pi-desktop` (`APP_ID`, electron-builder `appId`, macOS `CFBundleIdentifier`, Windows AppUserModelID). Development macOS hosts use `net.aiuo.pi-desktop.dev`. Do not adhoc-sign the unsigned pack in `afterPack`/`afterSign`: nested Electron helpers are still unsigned and `codesign` fails with `code object is not signed at all`. See ADR 0278 and issue #524.** | The owner domain is `net.aiuo.pi-desktop`. Binding the unsigned outer identifier is deferred until a helper-safe pack path exists. |

## V. Extension activation decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D192 | Activation scope shared by every extension kind | **Plugins, user MCP servers and user skills each carry `enabled: boolean` plus `scope: { mode: "global" \| "projects"; projects: string[] }`. `enabled` stays separate so switching an extension off never discards its project list, and the three-state control (`off` / `projects` / `global`) is derived, not stored. Matching is case-insensitive, trailing-separator-insensitive and subdirectory-inclusive; a missing scope resolves to global; a `projects`-mode extension is inactive in a session with no project. Scope is enforced both when a per-turn catalog is assembled and again at dispatch (`tools.execute`, `UserMcpRuntime.callTool`, `loadUserSkillBody`, command execution). Agent-facing surfaces filter on the session's project, app-facing surfaces on the active window's; themes are not scoped at all.** | A single boolean made every extension global, so a work-only MCP server spent context in every unrelated session and the only remedy was toggling by hand on each project switch. One scope shape lets one control and one predicate serve all three kinds, and enforcing at dispatch closes the window in which a session still remembers a tool the user has just scoped away (ADR 0056). |
| D193 | User-owned MCP servers need no plugin | **host-core stores one JSON configuration file per MCP id under `~/.agents/servers` or `<project>/.agents/servers`; enablement and project overrides live only in `<data>/agent-capabilities/mcp.json`. Level-aware `mcp.list`, `mcp.active`, `mcp.upsert`, `mcp.remove`, and `mcp.setEnabled` calls drive the Settings > Agent > MCP page; a project record shadows a global record by id or label before disabled records are filtered. The existing MCP editor and desktop `mcp/test` action provide transport validation and connection feedback.** | A user-owned server is portable configuration, not a plugin package. Separating its file from app-local state lets projects override a global server without mutating the user file and makes deletion pruning deterministic (ADR 0112). |
| D194 | User-owned skills are Markdown documents in `.agents` roots | **host-core scans `~/.agents/skills` and `<project>/.agents/skills`, accepts direct Markdown files and `<skill>/SKILL.md`, and exposes frontmatter `name`/`description` through level-aware `skills.list` and `skills.active`. A single-file import physically copies the source into the selected directory. Enablement and project overrides live in `<data>/agent-capabilities/skills.json`, never in the document; project records shadow global records before disabled records are filtered.** | A skill remains a portable Markdown document, while the app-local state file keeps activation decisions out of user-authored content (ADR 0112). |
| D257 | Capability pages are one workbench that can author | **Refine D193 / D194 and supersede D202's page shape: Settings > Agent > Skills / MCP / Subagents each render one toolbar (level filter as a segmented control with live counts, one search field, project picker, primary actions) above one elevated panel whose rows are divided by level group headers and carry their own level badge. All three pages create, edit, and delete through the host calls that already existed; new capabilities land at the level the filter points at and the primary action names that destination. Destructive row actions live in a per-row overflow menu and arm before firing. Busy state is scoped to the row with the in-flight request, skeletons render on first paint only, later loads dim the rows already on screen, and enablement flips optimistically and reverts only if the host refuses. `skills.reveal` accepts `{ id, level?, projectPath? }` and forwards it to `skills.read`, which already parsed both; a bare id string still works. Subagents stay global-only (no filter, no picker), and every capability-state, precedence, and `.agents` path rule from D193 / D194 / D202 is unchanged.** | The pages listed capabilities but could not manage them: `d24e1ee0` deleted both editor sheets while the create/update/remove/reveal RPCs stayed live, the level was page structure rather than a filter so two headers consumed most of a short page, one pending request disabled every control through `busy={loading \|\| busyKey !== null}`, and awaiting a reload after each toggle replaced the list with skeletons. Revealing a project skill also sent the id alone, which cannot resolve a project record with no global counterpart (ADR 0126). |

## 2026-07-28 — Plugin marketplace, panels, and high-risk APIs

- Official local marketplace provider can browse/search/install `.piplug` packages with checksum verification.
- Plugin panels run in sandboxed isolated windows via `pluginBridge`.
- High-risk plugin host APIs (`fs.write`, `net.fetch`, clipboard, openExternal) are available only with explicit grants.
- Per-plugin auto-update is supported; permission-expanding upgrades require review.

## 2026-07-28 — Official plugin marketplace repository

- Dedicated repo `vastsa/pi-desktop-plugins` is the official marketplace source.
- PI-Desktop fetches `catalog.json` remotely (cached under `~/.pi-desktop/plugins/market/`).
- Plugin maintainers pack sources with repo scripts and publish by pushing to that repository.
- Local bundled catalog remains fallback only when remote fetch fails.

## 2026-07-28 — Marketplace template + detail pane

- Official warehouse gained a practical template plugin `demo.workspace-summary` and CONTRIBUTING guide.
- PI-Desktop marketplace UI now opens a detail pane with README, changelog, and version list via `market.getDetail`.

## 2026-07-28 — Sidebar type balance

- Expanded sidebar primary chrome uses `--text-base` (14px) instead of `--text-md` (13px).
- Project/group titles step to `--text-md`; section labels stay secondary at `--text-sm`.
- Decision D144: keep micro tokens off primary left-rail content so the rail matches body readability without changing the global type ramp.

## 2026-07-28 — Chat markdown prose redesign

- Assistant markdown (`.prose-chat`) was restyled for denser, calmer transcript reading: clearer heading hierarchy, accent-tinted blockquotes, quieter list markers, bordered inline code, zebra/hover tables, and inset code cards with monospace language tags.
- Thinking prose reuses the same hierarchy at secondary color / `text-sm-plus` so reasoning stays visually subordinate to the answer.
- Renderer behavior (streaming block split, GFM/math, Shiki) is unchanged; this is a presentation-only pass in `globals.css` + component/design specs.

## 2026-07-28 — Neutral gray accent (no blue brand)

- `--ds-accent` / `--ds-accent-hover` / `--ds-accent-soft` / `--ds-info` now resolve to the gray scale (dark: white→gray-100→gray-300; light: `#1a1c1f`→`#303030`→`#5d5d5d`) instead of Codex blue.
- Markdown links, blockquotes, focus rings, plugin CTAs, toggles, and selected-session rings inherit the neutral accent automatically via tokens.
- Project color dots and docs/specs updated to drop blue as the brand accent.

## 2026-07-28 — Plugins page light-theme token pass

- Marketplace/plugin chrome CSS dropped raw blue-slate fallbacks (`#4f7cff`, `#2a3144`, `#121826`, …) and now consumes only `--ds-*` tokens.
- Tabs, actions, search, cards, permission modal, and badges adapt to light/dark via the neutral gray accent system.

## 2026-07-28 — Markdown light-theme paper pass

- Light `.prose-chat` / `.code-block` surfaces were retuned for white chat paper: softer underlined links, flat gray code cards (no muddy shadow), quieter blockquotes/tables/kbd/math, and secondary thinking ink.
- Dark markdown treatment is unchanged in spirit (inset charcoal code, light-gray links via accent-soft).

## 2026-07-28 — One Dark Pro code highlighting

- Chat fence highlighting switched from `github-light`/`github-dark` to `one-light`/`one-dark-pro`.
- Code cards paint a single editor surface (`#fafafa` / `#282c34`); nested `pre`/`code`/token backgrounds are forced transparent so there is no double wash.

## 2026-07-28 — Disable text correction on editable fields

- Shared `Input`/`Textarea` primitives default `spellCheck={false}`, `autoCorrect="off"`, and `autoCapitalize="off"`.
- Composer, message edit, palette/search fields, settings/plugins/projects search, model search, browser URL bar, and provider model combo follow the same contract.
- Decision D145: browser/OS spelling and autocorrect chrome stays off across the desktop shell.

## 2026-07-28 — Startup splash and motion tokens

- Boot path paints `StartupSplash` (brand mark, shell name, tagline, progress bar) until host/settings bootstrap finishes.
- Shared CSS motion tokens and overlay/surface enter keyframes polish dialogs, search, toasts, and interactive fills.
- Decision D146: splash is boot feedback with reduced-motion-safe exit; catalogs gain `app.uiCrashed` and finish zh-CN empty-home/custom copy.

## 2026-07-28 — Interaction detail polish

- Theme-aware `::selection`, `caret-color`, and `accent-color` keep copy/edit chrome on the neutral gray accent ramp.
- Hover fills on jump-latest, stop, composer-plus, search rows, profile/notification menus, and work-panel tab close use shared motion tokens.
- CJK section labels under `:lang(zh-CN)` use normal tracking without forced uppercase.
- Empty-home stack gap clamped to 24px; scrollbars refined to 8px with hover thumb; brand chip radius uses `--radius-sm`.
- Decision D147.

## 2026-07-28 — Work panel / settings light-surface polish

- Light work panel uses a quiet `#fafafa` inset column with a white header band so it separates from white chat paper without a heavy border.
- Browser URL, generic field controls, shortcut keycaps, segment tracks, and toggle knobs receive light-theme surfaces and focus rings aligned with settings pills.
- File tree, diff headers, resize handle, and destination filters ease hover fills with shared motion tokens.
- Light dialog scrim softens to 28% ink so elevated white dialogs stay readable.
- Decision D148.

## 2026-07-28 — User-facing i18n copy pass

- English and zh-CN catalogs rewrite high-traffic shell copy away from internal
  jargon: local service instead of host/backend, AI provider instead of bare
  provider, project instead of workspace in user strings, marketplace refresh
  instead of "from repo", temporary chats, and calmer status/error phrasing.
- Empty states, onboarding, settings help, plugin permissions, and notifications
  explain outcomes in plain language while keeping stable i18n keys and
  interpolation names.
- Decision D149.

## 2026-07-28 — Composer runtime chip descenders

- Model, mode, thinking, and permission chips no longer use `leading-none` under
  overflow clipping; labels use `--leading-compact` so descenders stay visible.
- Long model IDs still ellipsize horizontally via `.model-chip-label`.
- Decision D150.

## 2026-07-28 — Send re-pins transcript follow

- Starting a turn from send, retry, or regenerate re-pins the transcript and
  jumps to the bottom even if the user had scrolled up through history.
- Stream follow remains paused only for manual scroll during an active turn;
  the jump-to-latest pill still resumes follow without starting a new turn.
- Decision D151.

## 2026-07-28 — Direct runtime stream rendering

- Assistant responses now display the runtime's progressive chunks directly
  through the incremental Markdown block cache, without a second per-frame
  React state loop.
- Renderer CSP admits only local and Vite-inlined data fonts, allowing bundled
  KaTeX glyphs without opening a remote font origin.
- Decision D152.

## 2026-07-28 — Reasoning sessions default to maximum thinking

- New sessions inherit the app's default model and select its highest
  pi-published thinking level when that model supports reasoning.
- Non-reasoning or unresolved models remain `off`, while existing sessions keep
  their stored thinking preference.
- Decision D153. Superseded by D303 once Settings persisted a per-model
  `defaultThinkingLevel`.

## 2026-07-28 — Work-panel activity rail

- The open work panel now keeps Review, Terminal, and Browser in a compact
  44px activity rail with clear active/open states.
- The content header shows the active resource, closes it directly, and uses a
  bounded keyboard-operable switcher for all open tool and file resources.
- The former horizontally scrolling tabs and hidden header context menu are
  removed; artifact-driven panel opening and session ownership are unchanged.
- Decision D154.

## 2026-07-28 — Sidebar project/session list type density

- Sidebar project group titles and session/thread titles step one token quieter
  than the previous body-chrome sizing so dense lists scan more cleanly.
- Session titles use `--text-md` (13px); project/group titles and empty-state
  copy use `--text-sm` (12px). Primary chrome (New task, Plugins, footer) stays
  at `--text-base`.
- Decision D155; superseded by D159 for the expanded sidebar's primary list
  content.

## 2026-07-28 — Independent window and work-panel resizing

- Native window edges now resize only the Electron shell; work-panel open,
  collapse, close, and divider commits leave outer bounds unchanged.
- The divider uses anchored pointer delta, frame-coalesced preview, rollback on
  cancellation, and a wider stable hit area. Responsive clamping no longer
  overwrites the persisted preferred width.
- Removed the renderer-to-Main `window/resizeBy` channel, programmatic resize
  attribution, and panel-specific window-state offset.
- Decision D156; ADR 0029.

## 2026-07-28 — Single assistant toolbar per user turn

- Provider-level assistant messages separated by tool calls remain canonical
  transcript records for model reseeding, persistence, and fork boundaries.
- The chat transcript composes every assistant/thinking/tool record after one
  user message and before the next into one visual assistant turn, preserving
  order while exposing one aggregate meta row and one Copy/Fork/Retry toolbar.
- Copy joins all contentful assistant fragments; Fork and Retry target the last
  contentful assistant record. Decision D157.

## 2026-07-28 — Turn-boundary context checkpoint compaction

- PI-Desktop now evaluates context after every `turn_end`, before the next
  provider request, with a transient soft reminder and a deterministic hard
  checkpoint guard.
- Durable checkpoint records rebuild model context without deleting or hiding
  visible transcript messages; exact provider overflow receives one compacted
  retry.
- The implementation reuses pi-agent-core primitives. OpenCode DCP remains an
  AGPL-3.0 behavioral reference, not a dependency or copied implementation.
- Decision D158; ADR 0030.

## 2026-07-28 — Sidebar typography aligned with the global body scale

- Expanded-sidebar session titles return to `--text-base` (14px), matching the
  app body and primary sidebar chrome; project/group titles and empty-state copy
  return to the adjacent `--text-md` (13px) tier.
- Section labels and secondary metadata remain at `--text-sm` (12px), and the
  existing compact row pitch, truncation, and sidebar dimensions are unchanged.
- Decision D159; supersedes D155 and restores D144's primary-list hierarchy.

## 2026-07-28 — Icon-free composer prompt row

- Home and thread-docked composer prompt rows render no leading brand icon;
  draft text and placeholder ink align directly with the input gutter.
- The canonical logo remains in the home hero, sidebar, native application
  identity, startup splash, and About surfaces. Session-creation controls keep
  their dedicated message-plus icon. Decision D160; ADR 0031.

## 2026-07-28 — Smooth latest-wins session switching

- Session rows now acknowledge the newest selection immediately, prefetch on
  deliberate hover/focus, coalesce detail reads, and retain five recent
  transcripts for warm revisits with background revalidation.
- Superseded transcript reads no longer block the latest request. Workspace
  alignment overlaps transcript IO where summary metadata permits, while the
  navigation generation still owns the only visible commit.
- The previous complete transcript remains as a dimmed, non-interactive frame
  while React prepares a changed session's Markdown tree; reduced motion uses a
  static progress track. Decision D162.

## 2026-07-28 — Compact sidebar session titles

- Expanded-sidebar session titles use `--text-md` (13px), matching the compact
  project/group tier while primary actions and footer identity remain at
  `--text-base` (14px).
- Row height, truncation, indentation, weight, and sidebar dimensions remain
  unchanged.
- Decision D161; refines D159's session-title size.

## 2026-07-29 — Native width reservation for the fixed work panel

- The docked panel now keeps its committed `364..720px` width while open;
  native edges resize MainChat only.
- Open, collapse/final close, and divider commit set one idempotent native-width
  target. Chat remains stable when the work area can reserve the full width and
  absorbs only the unavoidable shortfall otherwise.
- Maximized/fullscreen geometry waits for normal state. Persisted base bounds
  exclude reservation width/x shift, and background artifacts cannot change the
  visible target.
- Decision D163; ADR 0032 (the window-expansion portion is superseded by ADR 0033:
  the work panel is an internal dock that never expands the OS window). This
  supersedes the contrary portions of D156 and ADR 0029.

## 2026-07-29 — Dual-locale in-app product changelog

- Ship EN + zh-CN product highlights in `packages/shared` and attach them to
  `UpdateState.releaseNotes` from Electron Main when an update is discovered.
- The update banner and Settings → Info surface a compact What's new list in
  the active product locale without a new feed or IPC domain.
- Release tagging requires updating both locale catalogs before the tag build.
- Decision D164; extends D120 / ADR 0022.

## 2026-07-29 — Release process: mandatory dual-locale changelog gate

- Stable app version bumps / tags **must** update
  `packages/shared/src/changelog.ts` (EN + zh-CN) before the tag; shipping
  without catalog entries is a release process failure (D164).
- Codified in the release runbook §4.1, AI development workflow matrix +
  forbidden practices, change checklist, `AGENTS.md`, and `scripts/release.mjs`
  header so agents and humans hit the same gate.
- GitHub auto-generated release notes remain web-only.

## 2026-07-29 — Bounded atomic tool batches in context checkpoints

- Automatic compaction now bounds an oversized final parallel tool-result
  batch inside the checkpoint copy instead of repeatedly failing at the same
  transcript boundary.
- The retained copy preserves every call/result envelope, distributes text
  budget fairly with explicit head/tail truncation markers, and omits duplicate
  provider-irrelevant details; original transcript rows remain complete.
- Decision D158; amends ADR 0030's previous policy of blocking an indivisible
  batch above the retained-tail cap.

## 2026-07-29 — Safe lazy Mermaid diagrams in assistant answers

- Completed `mermaid` fences in answer prose render through a dynamically
  loaded, theme-aware Mermaid chunk only near the viewport; partial streams and
  thinking prose remain source code.
- Rendering is serialized and bounded at 20,000 source characters / 500 edges.
  Strict Mermaid configuration plus DOMPurify SVG sanitization removes links,
  embedded media, foreign HTML, and URL attributes before DOM insertion.
- Invalid or oversized diagrams fall back to source with copy and view controls;
  no IPC, storage, process, CSP, or external-network boundary changes.
- Decision D165.

## 2026-07-31 — Slimmer default work-panel width

- The docked work panel now opens at 280px instead of 420px, a third narrower,
  and its fixed clamp becomes `244..720px`.
- `WORK_PANEL_DEFAULT_WIDTH`, `WORK_PANEL_MIN_WIDTH` (renderer and Electron
  Main), and the `.work-panel` CSS floor stay in sync; divider double-click
  restores the new default.
- D154's 364px floor was sized for a 44px activity rail beside 320px of content;
  the rail became a header switcher, so the floor scales with the default.
- Persisted wider widths remain valid, and the 720px maximum is unchanged.
- Decision D167; supersedes the width clamp in D154/D163 and ADR 0033 §4.

## 2026-07-31 — Project archive presentation redesign (bands superseded by D267)

- Settings → Project archive is rebuilt as three bands: an overview banner with
  four derived counters, a search + Recent/Name sort toolbar, and a grouped
  index in the order Pinned / All projects / Archived with per-section counts.
- Rows gain an always-visible disclosure control, state tags, a single meta line
  (path, branch, session count), a relative last-active time, and a quick New
  task action beside the row menu; the menu now groups create/edit above pin,
  archive/restore, and Close and dismisses on Escape or outside press.
- Archived records stay grouped and softened rather than filtered, so the
  destination still has no visibility toggle (D133). Project storage, search
  matching, batch-of-eight session reveal, and activation semantics are
  unchanged.
- Decision D168; supersedes D133's flat-list presentation. D267 later replaced
  the overview banner and the per-section panels with one quiet description line
  and one panel, retiring the four page-level counters; the row anatomy and
  grouping rules carry over, and the per-group counts remain on the strips.

## 2026-07-31 — Plugins page redesign (presentation amended by D196)

- The original Plugins page was rebuilt as four bands: an overview band with four derived
  counters (installed, enabled, updates, high-risk access), a header that keeps
  one contextual primary action and moves check-updates / apply-auto-updates /
  install-package / load-local into an overflow menu, a segmented
  Installed / Marketplace switch carrying counts, and the tab body.
- Installed rows group by state as Needs attention / Updates available /
  Active / Turned off inside one hairline-separated panel. `status: "error" |
  "load_error"` and `errorMessage` are now surfaced instead of dropped; row
  actions collapse to a hover-revealed panel button plus an overflow menu
  (auto-update, Uninstall as a danger item) beside an always-visible switch.
- Permissions are tiered from the risk column of
  `07-plugins/13-plugin-permissions-matrix.md`: risk-tinted chips with collapsed
  overflow on rows, and High / Medium / Low sections in the detail sheet and the
  install dialog. Upgrade reviews tag permissions the new version adds as New,
  and the install queue deduplicates the declared set against the diff.
- Details move from a nested sidebar to a right-side sheet (scrim, Escape and
  outside-press dismiss, sticky install action, selectable version rows).
  Marketplace cards render a monogram glyph and never fetch `iconUrl`, so the
  renderer performs no remote image loads.
- Decision D169; supersedes the flat list, pill tabs, and inline detail pane of
  `07-plugins/07-plugin-marketplace.md` §7/§14.

## 2026-07-31 — Renderer stylesheet split into per-surface partials

- `apps/desktop/src/styles/globals.css` becomes an import-only entry point. The
  rules move into 22 partials in the same directory, each owning one surface:
  `tokens`, `base`, `chrome`, `chat-shell`, `composer`, `sidebar-threads`,
  `messages`, `prose`, `ui-kit`, `overlays`, `theme-overrides`,
  `composer-menus`, `settings`, `destinations`, `projects`, `sessions`,
  `work-panel`, `providers`, `chat-links`, `composer-autocomplete`, `plugins`,
  `responsive`.
- Import order **is** the cascade and must not be reordered: tokens and base
  first, feature layers in build order, the responsive / reduced-motion tail
  last so it can still override what precedes it.
- The split is contiguous — no rule changed position relative to another. The
  joined partials reproduce the pre-split file byte for byte, and the built
  renderer CSS is byte-identical before and after, so Tailwind v4 resolves the
  `@theme` block from `tokens.css` unchanged.
- Style assertions load the effective cascade through
  `apps/desktop/test/helpers/styles.mjs`, which inlines the local `@import`
  lines in declaration order. Tests must not read a partial directly.
- Sidebar session styles live in both `sidebar-threads.css` and `sessions.css`
  because the original file interleaved them; the file headers cross-reference.
- The design-token scales now live in `styles/tokens.css`; the guard in
  `scripts/check-style-tokens.mjs` walks the whole `src` tree and is unaffected.
- Decision D170; the single-file layout assumed by `04-ux/07-ui-design-system.md`
  §Typography and `04-ux/08-component-spec.md` no longer holds.


## 2026-07-31 — Plugin skills activation and the plugin devkit

- `contributes.skills` is activated. `PluginRuntime.getSkills()` reads each
  declared skill file at prompt time, only for plugins granted
  `agent.prompt.inject`, and only through the containment guard the gated `fs`
  APIs use. The agent runtime renders a `# Plugin skills` section capped at
  16 KiB total and 8 KiB per skill — its own budget, not the 32 KiB instruction
  chain of ADR 0037 — and orders it after the built-in skills but before
  project instructions, so a user's own files keep the last word. Runtime reuse
  keys on a skills digest, so enabling a plugin, revoking the permission, or
  editing a skill file retires the idle runtime instead of reusing a stale
  prompt. Closes roadmap gap R2.
- Plugin authoring ships as a first-party package, `@pi-desktop/plugin-devkit`,
  which owns `scaffold` / `check` / `pack` over one implementation shared by the
  `pi-plugin` CLI, the `PluginScaffold` / `PluginCheck` / `PluginPack` agent
  tools served from Electron main, and the plugins page's New plugin from
  template action. `check` reproduces the rules host-core enforces, so passing
  it implies install will pass; `pack` writes store-only (method 0) `.piplug`
  entries because `extract_zip_bytes` accepts nothing else. Closes roadmap gap
  R3's template and `check`/`pack` items.
- A bundled plugin was rejected as the delivery vehicle: a plugin cannot produce
  a `.piplug` (no archive API in `HOST_API_ALLOWLIST`) and scaffolding would
  need high-risk `fs.write.workspace` for a capability the application should
  provide itself.
- The built-in `plugin-development` skill activates only for plugin workspaces —
  a plugin `manifest.json` at the workspace root, or a loaded development plugin
  inside it — so an ordinary session pays only for three tool descriptions.
- Development plugins are watched and hot reload on save, debounced 300 ms,
  ignoring `node_modules` / `.git` / `dist` / `target`, capped at 16 plugins, and
  re-armed across restarts. A reload can never widen a permission set: the
  manifest is compared against the set approved when the folder was picked and a
  new permission stops the reload with `PERMISSION_DENIED`, while removed
  permissions do take effect. A failed reload keeps the watch so the fixing save
  recovers the plugin, and reports through a toast plus `pluginChanged` —
  host-core has no RPC for a runtime-side load failure, so the registry row does
  not move to `load_error`. Closes roadmap gap R3's hot-reload item.
- Decision D171; recorded as ADR 0039.
- The prompt-injection half of this decision was replaced the same day by
  D174: skills now reach the model as a catalog plus a `Skill` tool. The devkit,
  hot-reload and workspace-gate clauses stand unchanged.

## 2026-07-31 — Creating a plugin from a template opens the folder

- Creating a plugin from a template now also opens the chosen folder as the
  active project (`workspace.set`, which registers the project and switches to
  chat), not just as a loaded development plugin. Loading only makes the plugin
  run; development needs the sources inside the workspace the agent, the file
  panel and the built-in `plugin-development` skill all read, and requiring the
  user to re-pick the same folder through Open folder was pure friction.
- The activation runs in the renderer through the existing `activateProject`
  action rather than from the template IPC handler, so project state, the sidebar
  project list and the navigation intent guard keep their single owner.
- The success toast distinguishes the two outcomes: if the folder cannot be
  opened as a project the plugin stays loaded and the toast says only that,
  instead of claiming a workspace that is not there.
- Loading an existing local plugin folder (Load local plugin) deliberately keeps
  its current behavior: running someone else's plugin is not a reason to switch
  the user's project.
- Decision D172; no ADR — this completes the flow ADR 0039 describes.

## 2026-07-31 — Work panel header menu: tools first, no duplicated entries

- The unified header menu lists the four tools (Review, Terminal, Browser,
  Files) first, in a fixed order, and only then — after a divider, and only when
  they exist — the resources the transcript opened. The previous layout listed
  every open tool twice: once in the resource switcher and again in the
  create-new section, which made "open" and "switch to" indistinguishable.
  Each tool row now carries its own open state and its own close control, so a
  single row is the whole affordance for that tool.
- Activating a tool that is already open activates its existing tab instead of
  replacing it with a fresh singleton, so the Browser keeps its URL. The header
  action cluster is pinned right (`margin-left: auto`) so the close/collapse
  controls no longer slide with the label length, and the trailing close slot in
  each row is always reserved so labels and open dots never shift.
- Menu rows own real DOM focus (WAI-ARIA menu pattern) rather than a roving
  highlight: the trigger's ArrowDown/ArrowUp opens on the active or last row,
  Arrow/Home/End walk rows only, Delete/Backspace closes the focused row while
  the menu stays open with focus on its neighbor, and Escape/Tab/selection
  return focus to the trigger. Only a session switch dismisses the menu
  implicitly — selecting a row closes it explicitly, so the previous
  active-tab-keyed auto-dismiss (which fired whenever a background artifact
  changed the active tab) is gone.
- Missing `panel.tabs.file` was the reason a bare Files tab showed a literal
  `file` label; the catalogs now carry it plus `panel.tools`, and the obsolete
  `panel.openTool` is removed.
- Decision D173; no ADR — presentation and input handling only, inside the
  existing work-panel architecture (ADR 0033).

## 2026-07-31 — Plugin skills are model-invoked

- `contributes.skills` is activated at load time behind `agent.prompt.inject`.
  Each entry may be a path or `{ path, id?, name?, description? }`; front matter
  in the document supplies `name` / `description` when the manifest does not.
- The base system prompt carries only a catalog — skill id, name, and a
  description trimmed to 240 chars. Bodies are not in the prompt; the model
  fetches one through a built-in `Skill` tool that Electron main serves locally
  against `plugins.loadSkillBody(id)`, so the sidecar never holds skill text.
- Caps: 32 skills per plugin, 128KB per document. A manifest without
  `agent.prompt.inject` still validates — skills predate the permission gate — and
  the runtime simply skips them.
- Skill ids join the runtime-reuse key in `packages/agent-runtime/src/runtime.ts`,
  so enabling or disabling a plugin rebuilds the runtime instead of serving a
  stale catalog.
- Rejected: user-facing slash commands. A skill is guidance the agent should
  reach for when a task calls for it, not a command the user has to know exists.
- Decision D174; closes the "parsed but never activated" gap in
  `07-plugins/14-plugin-roadmap.md` R2.

## 2026-09-11 — User-invoked Skills in the composer (D393)

- D174's model-invoked catalog remains the Skill body-loading and security
  contract, but its rejection of a user-facing slash entry made active Skills
  difficult to discover for users who already knew the workflow they wanted.
- D393 / ADR 0219 adds active built-in, plugin, and user Skills as the final
  group in the composer `/` menu. Selection inserts the exact id; Electron
  main revalidates the current project scope and asks the model to call the
  local `Skill` tool. The typed command remains the transcript chip, and no
  host protocol or durable schema changes.

## 2026-09-11 — Windows work-panel chrome keeps one resource action cluster (D394)

- The open work-panel header now keeps one compact resource switcher. Resource
  close is available from the existing unified context-menu rows, so a second
  `X` does not sit beside the Windows native close control.
- The viewport-fixed work-panel toggle remains the sole panel-level collapse
  control. Subagent detail uses a back chevron, and Windows/Linux native
  controls remain fixed at the window edge.
- Decision D394 amends D154 / D357 / ADR 0195. This is renderer-only and does
  not change panel state, window geometry, IPC, protocol, or storage. See ADR
  0220 and E2E-067.

## 2026-09-11 — Canonical thinking-level values in the UI (D395)

- Thinking levels are stable protocol values, but translating them made the
  same provider/runtime setting vary with the application locale.
- Decision D395 / ADR 0221 amends D369 / ADR 0202: Composer, model
  configuration, and delegation surfaces render `off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, and `max` directly. These values are removed from
  every locale catalog; effective metadata, clamping, provider requests,
  protocol, and storage are unchanged. See E2E-219.

## 2026-09-11 — Renderer and plugin-panel scrollbars share one compact contract (D396)

- Windows' classic scrollbar made the right-side work-panel Files view visibly
  heavier than the conversation even though the host renderer already had a
  quiet custom scrollbar. The sidebar also retained a separate width and thumb
  opacity override, so the app had two scrollbar treatments.
- Decision D396 amends D300: every renderer scroll container uses the same 6px,
  trackless, transparent-at-rest scrollbar with the same hover, focus-within,
  scroll-reveal, and dragged-thumb states. The sidebar-specific override is
  removed. The plugin-panel preload applies the same contract and 300ms reveal
  mark to docked and detached plugin documents, including the bundled Files
  view. An external page loaded inside the Browser guest remains page-owned.
- This is a presentation-only change; there is no protocol, storage, host
  runtime, or external-page behavior change. See `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, and E2E-157.
## 2026-09-11 — Composer accepts native file and folder drops (D397)

- Native file-system drops into the Composer now prevent the browser default
  and use one accent outline around the complete shell without changing its
  layout. Regular files reuse the bounded session-scratch paste bridge and
  become removable leaf-name chips; folders are never read, traversed, or
  copied.
- The preload resolves the path of each user-dropped `File` with Electron's
  `webUtils.getPathForFile`. The renderer inserts a dropped folder's complete
  native path at the caret as literal `@<path>/` text, preserving mixed item
  order, the surrounding draft, focus, and the caret after asynchronous file
  saving. No host RPC, protocol, workspace, or durable-schema change is added.
- Decision D397 amends ADR 0101's previous drag/drop scope. See ADR 0222 and
  E2E-102i.
## 2026-09-11 — Message quotes and renderer-owned side chats (D-LOCAL-message-quotes)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- Every user message and every assistant turn gains a Quote action beside Copy,
  Edit, Delete, Fork, and Retry. It inserts a `> `-prefixed Markdown blockquote
  plus a `chat.quoteSource` attribution line into the active session's composer
  draft, uses the live text selection when it lies inside the clicked message
  row and the message's own text otherwise, caps the excerpt at 2000 characters
  with a trailing ellipsis, focuses the composer, and never sends.
- Open side chat forks the anchored assistant or user message through the
  existing `session.fork` without activating the child, so the main conversation
  keeps its visible session. The child is registered as a renderer-owned side
  chat of the parent and the work panel opens one `sidechat` tab that streams
  from the same event stream through the shared background-transcript reducer,
  with Add to main chat, Open as a conversation, a compact Send/Stop input, and
  the existing permission card.
- Closing the tab or opening the child as a conversation removes the
  registration and its transcript projection; the durable child remains an
  ordinary session in the sidebar, session lists, and search. No protocol,
  storage-schema, IPC channel, or permission change. See ADR message-quotes-and-side-chats and E2E-CHAT-quote-prefill
  through E2E-CHAT-side-chat-close.

## 2026-09-11 — Context usage display preference (D398)

- The context usage inspector's leading figure — the trigger ring arc
  (`strokeDashoffset`), percentage, token label, popover heading, tooltip,
  and `aria-label` — is configurable via `AppSettings.contextUsageDisplay`
  (`"remaining"` or `"used"`). Default and fallback for absent or
  unrecognised values is `"remaining"`.
- When `"used"`, the ring fills by `usedRatio`, and text shows the
  used-capacity pair instead of the remaining pair.
- Warning and critical color thresholds (remaining ≤ 25 % / ≤ 10 %) stay
  based on remaining capacity regardless of display mode.
- Settings → AI → Defaults adds a segmented control (Remaining / Used) after
  Link open destination and before Enter-to-send.
- Decision D398 amends D347 / ADR 0184. See ADR 0223 and E2E-250.

## 2026-09-11 — Project groups can be manually reordered (D399)

- Retained project groups expose a grip that appears on hover and keyboard
  focus. Native drag/drop inserts the source before or after the target based
  on the pointer position; ArrowUp/ArrowDown on the focused grip provides the
  keyboard path, and Escape cancels an active drag.
- Reordering writes contiguous normalized-path `order` values and switches
  the renderer-local project sort to `manual`. Pinned and archived priority,
  project activation, host workspace identity, session ordering, and on-disk
  directories are unchanged.
- Decision D399 amends D093. No protocol, host, IPC, or durable project-schema
  change is introduced; see the sidebar interaction specs and E2E-253.

## 2026-09-11 — Restore deferred tools from effective session context (D400)

- A new prompt or mode switch clears the in-memory deferred activation set, then
  restores successful activation evidence from the effective session context.
  `ToolSearch` rows contribute `addedToolNames`; successful deferred-tool rows
  contribute their own tool name.
- Restoration keeps only names still in the current mode's deferred catalog.
  Failed, interrupted, and missing-result placeholder rows are ignored, and
  assistant/user prose is never parsed as activation evidence. Host
  permissions, workspace containment, and audit behavior remain unchanged.
- Decision D400 amends D185 / ADR 0048. See ADR 0225 and E2E-008a.

## 2026-07-31 — Plugin themes ship CSS files

- `contributes.themes` declares `{ id, label, path, base? }` and requires
  `ui.theme`. `path` is a plugin-relative `.css` file; `base` (`light` | `dark`,
  default `dark`) names the palette the overrides layer on.
- The main process reads the file and runs `sanitizeThemeCss()`: no `@import`, no
  `url()` outside `data:`, no unparseable `url(`, no `javascript:` /
  `expression(`, no markup sequences, 256KB cap, 8 themes per plugin. The
  renderer receives finished text over `plugin/themes` and injects it into one
  `<style id="pi-plugin-theme">` appended after the app's own stylesheets.
- `AppSettings.theme` widens to `plugin:<pluginId>:<themeId>`. When the providing
  plugin is disabled, uninstalled, or fails to load, the app falls back to
  `system` rather than rendering an unstyled shell.
- Rejected: a token-JSON contribution. It would have been safer to validate, but
  it can only express the tokens we thought to enumerate; a stylesheet lets a
  theme reach a surface the token list forgot, and the sanitizer plus
  append-order rule bound the risk to appearance.
- Decision D175.

## 2026-07-31 — Plugin MCP servers over stdio and remote HTTP

- `contributes.mcpServers` declares `{ id, label?, transport }` plus exactly one
  transport's fields: `stdio` takes `command` / `args` / `env`, `http` takes
  `url` / `headers`. Permissions are separate: `mcp.server.local` for stdio,
  `mcp.server.remote` for HTTP.
- `apps/desktop/electron/main/plugin-mcp.ts` speaks protocol `2025-06-18` —
  `initialize`, `tools/list`, `tools/call` — as NDJSON over stdio or streamable
  HTTP/SSE. Budgets: 10s connect, 100s per call, 8 `tools/list` pages, 4MB per
  stdio line, 64 tools per server, 8 servers per plugin. Connection is lazy;
  teardown follows unload.
- Discovered tools register as `plugin_<pluginIdSafe>_<serverId>_<toolName>` in
  the existing plugin tool map, so they inherit the audit trail, the timeout, and
  the disable switch with no new routing. They are always `risk: "medium"`: the
  schema and description come from a third party, so a self-declared risk level
  is not trustworthy.
- `env` and `headers` resolve only from the plugin's own settings via
  `{ "setting": "<key>" }`; the host environment is never passed through (D018).
  A stdio child gets `PATH`, temp/locale vars, and the declared values — nothing
  else. `command` must be a bare PATH name or plugin-relative; `url` must be
  `https` unless the host is loopback.
- Both transports ship rather than stdio alone: a hosted MCP endpoint is common
  enough that stdio-only would have pushed plugins to wrap it in a local shim,
  which is strictly worse — an extra process and an unreviewable proxy.
- Decision D176; ADR [0038](../../adr/0038-plugin-mcp-bridge.md).

## 2026-07-31 — Resident plugin services and their restart policy

- `contributes.services` declares `{ id, label?, autoRestart? }` behind
  `background.service`, at most 4 per plugin. The plugin calls
  `pi.services.register({ id, start, stop })`; the broker calls `start` after
  `onLoad` (5s budget) and `stop` before `onUnload`, so a service is never live
  outside the plugin's own lifetime.
- A service lives in the plugin's `utilityProcess`, so a crash takes it down with
  the process and the supervisor restarts the whole plugin: backoff 1s, 2s, 4s,
  8s, 16s capped at 30s; at most 5 attempts; a process that survives 60s is
  healthy and the counter resets. `autoRestart: false` opts out. After the last
  attempt the plugin stays `failed` — a visible failure beats a silent crash
  loop.
- Per-service state (`starting` | `running` | `stopped` | `failed`) and the
  restart count are read over `plugin/services` and rendered as chips on the
  Plugins page; every transition emits `pluginChanged` with `reason: "service"`
  and a `plugin.service.*` audit entry.
- Manual enable / disable outranks the supervisor: an explicit action cancels the
  pending timer and clears the attempt counter.
- Decision D177; ADR
  [0040](../../adr/0040-plugin-resident-services-and-message-bus.md).

## 2026-07-31 — Inter-plugin message bus routes declared topics only

- `pi.bus.publish` / `subscribe` require `bus.publish` / `bus.subscribe` **and** a
  matching entry in `contributes.bus`: publishers list concrete topics,
  subscribers list patterns. A granted permission alone routes nothing, so the
  manifest stays a complete description of what a plugin says and hears.
- Topics are dot-separated segments (`[a-zA-Z0-9][a-zA-Z0-9_-]*`, ≤8 segments,
  ≤128 chars). `*` matches one segment; `**` matches one or more trailing
  segments and may appear only last.
- Routing lives in the broker. A message carries `topic`, `from`, `payload`, and
  a host-assigned `at`; the publisher is excluded from its own fan-out; delivery
  is fire-and-forget over a new one-way `{ t: "event" }` frame, so a wedged
  subscriber cannot stall the sender. That frame also makes the previously
  stubbed `pi.events.on` / `off` real.
- Caps: 64KB per payload, 16 subscriptions per plugin, 100 publishes per rolling
  10s window, failing with `LIMIT_EXCEEDED` / `RATE_LIMITED` and an audit line.
- A payload conveys data, never capability: receiving a message grants the
  subscriber nothing it did not already hold, so a topic should be treated as
  public within the app.
- Decision D178; ADR
  [0040](../../adr/0040-plugin-resident-services-and-message-bus.md).

## 2026-08-02 — Bash tool inherits the user's login-shell PATH

- On Unix, the first Bash call probes the user's login shell for its PATH —
  `$SHELL` (fallback `/bin/zsh` → `/bin/bash` → `/bin/sh`) with `-lic
  'printf %s "$PATH"'` — so `-l` sources login files and `-i` sources the
  interactive rc, matching a fresh terminal. The probe is bounded to 5s and
  cached per process (`OnceLock`); only the last stdout line is kept (rc
  banners are ignored), stderr is discarded (missing-tty noise), and a
  non-zero exit, missing shell, or timeout silently falls back to the host
  PATH.
- Every Bash subprocess gets the probed PATH injected via `cmd.env("PATH",
  ...)`; `bash -lc` still re-runs the bash profile at startup (conda/brew
  hooks may prepend/dedupe/reorder entries on top of the injected base).
  Agent commands remain POSIX bash; the resolved bash binary is unchanged.
  Windows keeps `bash -c` with the host environment (no change).
- Fixes macOS Finder/Dock launches where `bash -lc` alone cannot see nvm,
  pnpm, or Homebrew tooling initialized in `~/.zshrc` / `~/.zprofile`.
- Decision D181; ADR
  [0045](../../adr/0045-bash-inherits-user-login-path.md).

## 2026-08-02 — Route process logs into category files

- The `app`, `host`, and `agent` channels remain local NDJSON files, but each
  channel is now a directory containing focused `<category>.log` files. App
  records use explicit lifecycle/session/tool/permission/plugin/provider/
  persistence/updater/diagnostics/terminal/runtime categories; host and agent
  stderr is classified into the same categories, with timing lines isolated
  in `timing.log`.
- Every record carries a `category` field. Child stderr is buffered by line,
  decoded as UTF-8, and stripped of ANSI control sequences before it is
  persisted. Unknown child output goes to `runtime.log`.
- Rotation remains 5 MB with two rotated files, but the limit applies to each
  category file. The logger uses byte length for UTF-8 records and treats
  rotation and disk failures as best effort. Existing flat log files are not
  deleted during migration.
- Decision D182; ADR [0046](../../adr/0046-categorized-process-logs.md).

## 2026-08-02 — Context usage inspector

- Replace the oversized context ring with a compact Codex-style trigger that
  combines a remaining-capacity ring, `Context` label, and percentage. Hover
  and keyboard focus open a non-modal panel *(superseded by D225: the trigger
  is click-toggled)* with the context window, exact
  provider input/output/cache/reasoning usage, aggregate generation speed in
  `tokens/s`, and each unique tool type in first-seen execution order.
- Tool rows aggregate repeated calls and expose call count, argument tokens,
  result tokens, total estimated footprint, share bar, and cumulative known
  duration. Runtime estimates use pi-agent-core's existing four-characters-
  per-token heuristic; provider-reported usage remains the authoritative total
  and the UI labels tool rows as estimates.
- Generation speed is a completed-turn snapshot from provider output and final
  stream duration; active assistant streams do not show a live token-rate
  counter.
- The context-window total comes from the matching `pi-ai` model metadata used
  by the agent sidecar; provider metadata and the 128K default remain fallbacks
  for unknown models.
- `UiMessage.responseDurationMs`, `UiMessage.toolUsage`, and the optional
  `tool_end.toolUsage` event field are additive, so older persisted messages
  and peers remain readable.
- The inspector panel is rendered at the document body level as a fixed,
  collision-aware viewport overlay. It follows transcript scroll and window
  resize, flips around the trigger, and clamps to viewport margins instead of
  being clipped by the transcript scroll container.
- The inspector resolves its context-window total from the same `pi-ai` model
  record passed to the agent sidecar, enriching cached/discovered model rows;
  provider metadata and the 128K default remain fallbacks for unknown models.
- Decision D184; ADR [0047](../../adr/0047-context-usage-inspector.md).

## 2026-08-02 — Lazy per-turn tool activation

- The sidecar keeps a complete local registry but sends only the mode's core
  tools and local `ToolSearch` on a new prompt. (`CompactContext` was also
  always-active here until D200 removed the tool; D203 restores it as
  `new_context`, again always-active.)
  Agent follows pi's coding-agent core (`Read`/`Bash`/`Edit`/`Write`), while
  Chat keeps (`Read`/`Glob`/`Grep`). Agent-mode `Glob`/`Grep`,
  `BrowserPreview`, plugin tools, `Skill`, and plugin-development helpers are
  represented by bounded compact catalog entries instead of full parameter
  schemas.
- An exact-name or capability search activates at most four matches for the
  next model turn. `addedToolNames` lets pi-ai providers with native deferred
  search serialize those definitions at the load point; other providers use
  the rebuilt active tool list. Activation resets before the next user prompt.
- Host permissions, workspace and scratch containment, timeouts, and audit
  behavior are unchanged. Persisted tool results retain activation markers for
  valid transcript reconstruction.
- Decision D185; ADR [0048](../../adr/0048-lazy-per-turn-tool-activation.md).

## 2026-08-04 — Bound provider stream recovery and diagnostics

- Provider request setup now has one bounded pi-ai retry. A transient stream,
  network, or timeout failure after streaming begins gets one same-turn retry
  with a short abortable backoff; the failed assistant is removed from model
  context and the visible assistant id is reused.
- `terminated` and equivalent incomplete stream messages map to
  `STREAM_FAILED`. A second failure remains terminal and carries bounded phase,
  timing, provider status/code, and retry-attempt diagnostics when available.
- Mutation recovery is explicitly finite: use `Edit` for one unique local
  replacement, use `Write` for a coherent rewrite, then allow one fresh
  read/regeneration after a mismatch. A second same-path `Edit` failure or
  failed shell patch command emits the terminating tool hint instead of
  repairing an old patch artifact.
- Decision D186; see [ADR 0050](../../adr/0050-bounded-provider-stream-recovery.md).

## 2026-08-04 — Recover automatic compaction failures with a retained tail

- Automatic threshold and provider-overflow compaction failures now attempt a
  deterministic, aggressively bounded retained-tail checkpoint before ending
  the turn. The previous checkpoint summary is preserved when available, the
  complete visible transcript remains untouched, and host persistence plus the
  hard-budget recheck remain mandatory.
- The summary input is preflighted against the model window so an obviously
  oversized summary request goes directly to the bounded recovery path instead
  of waiting for a provider rejection or timeout.
- The lifecycle event marks recovery with `fallback: "retained_tail"`, so the
  renderer keeps the run active and shows a warning. Manual `/compact` remains
  fail-fast and never silently discards historical context.
- Decision D158; amends ADR 0030 and adds ADR 0049.

## 2026-08-04 — Resource-isolated host RPC stdio

- Host-core no longer uses Tokio's stdio adapters for its NDJSON control pipe.
  One named OS thread reads stdin and one named OS thread serializes stdout,
  keeping per-message framing and retrying interrupted or transient
  `EAGAIN`/`EWOULDBLOCK` errors.
- This closes the process-exit path where Tokio's blocking pool panicked after
  the OS refused another worker thread with `Resource temporarily unavailable`
  (errno 35 on macOS). Failure to create a control thread is reported as a
  startup error; it is not an unhandled thread-spawn panic.
- The login-shell PATH probe uses `thread::Builder` as well and falls back to
  the inherited PATH when the optional helper cannot start.
- Decision D187; see [ADR 0051](../../adr/0051-host-rpc-stdio-resource-isolation.md).

## Plan checkpoint and shell decisions (0.4.14)

The earlier local Plan operating-state decision remains recorded as D188 for
history. D189 is the implementation authority and supersedes D188 and ADR
0052. D190 defines the shell execution contract used by D189. The agent-only
decision developed in parallel is renumbered D191 (ADR 0055) and is superseded
by D188/D189; the three decisions that shipped alongside it follow as D192,
D193, and D194.

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D188 | Replace Chat profile with Plan state | *(superseded by D189)* **PI-Desktop has one pi Agent and one product selector: `Agent | Plan`. Plan is that Agent after entering planning state, never a second Agent, planner model, planner service, or permission mode. Agent remains the default. Persisted sessions, app defaults, and scheduled values stored as `chat` migrate to `plan`; the internal `page = "chat"` route may remain as a conversation-surface detail. Plan exposes `Read`, `Glob`, `Grep`, `BrowserPreview`, `Bash`, `CompactContext`, and `ExitPlanMode`; it denies `Write`, `Edit`, plugin tools, and unknown tools. Plan retains permission-mode selection: Bash prompts under `ask` and `accept-edits`, and runs without confirmation under `auto`, so Plan is planning intent rather than a strict read-only security profile.** | Historical pre-checkpoint Plan contract; retained to explain the supersession chain |
| D189 | Plan checkpoint artifact, approval, and execution epoch | **The same pi Agent uses `Agent | Plan`, with Agent default. Plan calls `SubmitPlan(title, markdown, question)` as the only tool in its assistant batch. Rust host-core writes the submitted Markdown bytes unchanged to a new immutable unique file under `<workspaceRoot>/.pi/plan/*.md`; it stores the relative artifact path, SHA-256, and byte size together with structured title/question fields in the existing `plan_approvals` row. No title/question wrapper is added and no prior artifact is replaced. The approval surface displays title, question, an artifact opener, absolute expiry, and status, and offers only Approve or Reject. Approve requires an explicit `ask`, `accept-edits`, or `auto` permission mode, with Ask selected by default; Reject carries no mode. The approval expires at one absolute 30-minute deadline and uses `PLAN_APPROVAL_TIMEOUT`. The same `plan_approvals` row carries `execution_id` and `execution_state` through `queued → running → completed|interrupted`. A startup transaction marks prior pending approvals and queued/running execution states interrupted before serving RPC; no work is replayed. Pending interruption/rejection/expiry leaves the session Plan; an already-approved queued/running interruption leaves the session Agent. One active turn, idle-only configuration, and one pending approval/queued-or-running execution per session are enforced. Scheduled Plan is rejected before provider, artifact, or queue work with `PLAN_REQUIRES_INTERACTIVE_SESSION`. Protocol v9 and storage schema v10 carry the contract without a serialized process-epoch field.** | Immutable host artifacts preserve the submitted checkpoint while one approval/execution row and a startup process fence prevent restart replay without losing the already-approved Agent state |
| D190 | Selectable command shell catalog and execution identity | **Host-core exposes stable platform-aware catalog IDs: `windows-powershell`, `cmd`, `git-bash`, and `bash`; the platform catalog contains only IDs supported by that platform. `defaultCommandShell` persists in host settings, and settings writes reject unavailable or wrong-platform IDs. If a persisted choice later becomes unavailable, the effective shell intentionally falls back to the first available platform shell. The `Bash` tool and `tools.execute` protocol name remain unchanged; each turn pins the effective shell ID and dialect, and host rejects a stale ID/dialect before spawn with `COMMAND_SHELL_CHANGED`. Shell identity is the catalog selection, not an executable path hash. Bash streams stdout and stderr separately, uses a mandatory 60-second default timeout with a 1–300 second override, and cancellation/timeout shuts down the complete process tree.** | Users can choose the command language without multiplying protocol tools, while platform validation, explicit fallback, and turn-pinned catalog identity keep execution predictable |
| D604 | Trust the network endpoints the user enters themselves | **Amend ADR 0243 / 0245 / 0247 for user-supplied URLs; follow ADR 0142 / 0257 / 0300. A URL the person typed into a settings field — a market source, a git remote, an MCP OAuth endpoint, a generated-image URL — is judged by the user-endpoint policy: loopback, RFC1918, CGNAT, link-local, ULA, site-local and `.local` are reachable, and plain `http` is usable. ONE switch decides that: `networkPolicy.mode` (`relaxed` / `strict`), **`relaxed` by default**, which folds in the earlier per-surface acknowledgements — the plaintext flag, the WebDAV `allowInsecureHttp` checkbox and the `networkProxy.allowFakeIp` opt-in are gone, and a stored `allowInsecureUserEndpoints: false` migrates to `strict`. The first plaintext hop to a user endpoint tells the shell once (`insecureNoticeAcknowledged`). Third-party content keeps the public-only rule in either mode, with the checked address pinned: a registry record, a catalog body, a document URL inside a catalog, and every redirect target. Cloud metadata, `unspecified`, multicast, reserved and documentation addresses stay refused on every input. The default proxy bypass list gains `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16`. No host protocol or storage schema bump: `networkPolicy` is one section in the existing app settings, validated on write.** | Refusing a LAN address the user typed did not remove the request — it moved the same work into a shell or a browser next to the app, so the boundary cost the feature without preventing a decision the user had already made. Third-party content is where the SSRF risk lives, so that half of the boundary is unchanged. See ADR 0304. |

## 2026-08-05 — Agent-only mode

- `agent` is the only session mode. The former `chat` profile is renamed
  `read-only`; host-core still hard-denies Write/Edit/Bash for it, but nothing
  in the UI can select, display, or command it.
- The mode gate is negative everywhere (`mode != "agent"` → read-only surface)
  and `chat` normalizes to `read-only` on every host write path, so a legacy or
  unknown value fails closed instead of widening tools.
- `BASH_DISABLED_IN_CHAT` / `WRITE_DISABLED_IN_CHAT` become
  `BASH_DISABLED_IN_READ_ONLY` / `WRITE_DISABLED_IN_READ_ONLY`.
- Database open rewrites `sessions.mode = 'chat'` and a stored `defaultMode` of
  `chat` to `agent` — a data fix-up inside schema v7, not a version bump.
- Decision D191, superseded by D189; see
  [ADR 0055](../../adr/0055-agent-only-mode.md). The mode concept it removed
  returned as Plan (D188/D189, ADR 0052/0053); the entry is retained because the
  `read-only` normalization and the `chat` fix-up it describes shipped.

## 2026-08-05 — Structured tool-result presentation in the transcript

- Expanded tool rows no longer render `JSON.stringify` of the arguments and the
  result. A pure renderer module maps each known payload to labeled blocks: file
  and written content as highlighted code, commands as shell, stdout and stderr
  as separate blocks, Glob results as clickable paths, Grep hits grouped per
  file, failures as an error note. Unmapped plugin payloads degrade to
  label/value fields and labeled blocks; only nested objects keep a JSON body.
- The pi-ai result envelope carries the structured payload in `details` and
  repeats it as text for the model. Only the structured half is rendered, so no
  byte is shown twice.
- Collapsed rows carry outcome chips (exit code, match/file counts, replacement
  count, written or read size, `truncated`, `scratch`) so a result reads without
  expanding. A successful exit earns no chip.
- Search results follow the host's `outputMode`: grouped hits, a path list, or
  per-file totals. A host `notice` (scoping, clipped lines, Read window) renders
  as a neutral note under the blocks it qualifies, never as an error.
- Edit rows draw their own diff only when no ReviewChangeCard owns one, keeping
  workspace edits single-sourced. The inline permission card shares the same
  block renderer for its args preview.
- Blocks are built on expansion only and highlighting is skipped above 100 KB or
  800 lines; lists and diffs are capped and report the hidden remainder.
- Decision D192; renderer-only presentation, so no ADR. See
  `04-ux/08-component-spec.md` §9 and E2E-145.

## 2026-08-05 — A silent assistant turn re-runs once before it is an error

- A turn that ends with no tool call and no visible text is no longer reported
  as complete. The runtime pops the empty assistant out of model context,
  appends a no-output nudge to the system prompt, and calls `agent.continue()`
  once — reusing the visible bubble id and swallowing the first attempt's
  `turn_end` / `agent_end`, so a successful recovery is invisible to the user.
- Blank visible text triggers it even when reasoning content is present. The
  observed failure was exactly that shape: a 2830-character conclusion in
  thinking and an empty `text`, which reached the user as nothing. The timing
  log keeps `thinkingOnly` so the two shapes stay distinguishable.
- The nudge rides on `state.systemPrompt` rather than `prepareNextTurn`, which
  only shapes in-flight turns and whose context is discarded once the loop
  stops. It is restored only if still unchanged, so a concurrent prompt rebuild
  wins.
- A second silence is terminal: retriable `EMPTY_MODEL_RESPONSE`, which the
  existing assistant error row renders with a "Try again" action. One re-run per
  prompt, so overflow recovery in the same prompt cannot multiply attempts.
- Decision D193; recovery inside the existing loop contract, so no ADR. See
  `03-runtime/02-agent-runtime.md` §5e, `03-runtime/08-error-codes.md` §3.2,
  and E2E-146.

## 2026-08-05 — Per-tool output budgets, scoped search, and stated collaboration rules

- The single 256KB / 4000-line cap is replaced by per-tool budgets: 48KB for
  Read/Glob/Grep, 96KB for Bash stdout, 96KB tail-kept for Bash stderr, 2000
  chars per line everywhere. Search results are re-fetchable — narrow the
  pattern, advance the offset — so they earn the tighter half; a failing
  command's last line is the actionable one, so stderr keeps its tail.
- `Read` paginates with `offset` / `limit` and never refuses on file size. The
  old >512KB rejection said "use Grep or Bash to sample it", which is how an
  unpaginated read became an unbounded `sed` pipeline. `Grep` takes `path`,
  `include`, `outputMode`, `headLimit`; `Glob` takes `path`, `limit`; both order
  by modification time, newest first.
- An explicit `path` disables parent ignore files. Without that, scoping a
  search to `node_modules` or `dist` returned zero and pushed the model back to
  shell — and Grep could not read its own spill files.
- Over-budget Bash output spills into the per-session scratch dir so the marker
  names a real file. Read/Glob/Grep embed no marker: `content` stays
  byte-faithful so text copied out of it still matches for `Edit`, and the
  window metadata plus `notice` carry the same facts as sibling fields.
- The system prompt now states collaboration rules outright — answer in the
  user's language, a sentence before each tool batch, never more than one batch
  without visible text, answer in text rather than only in reasoning, finish end
  to end — and states a preference for the scoped tools over shell equivalents.
  "Prefer concise, actionable answers" was the only nearby rule, and a reasoning
  model executed it as saying nothing.
- Decision D194; tool schemas widen without breaking callers and prompt text is
  not an interface, so no ADR. See `03-runtime/16-tool-result-limits.md`,
  `03-runtime/02-agent-runtime.md` §7, and E2E-147.

## 2026-08-05 — MCP servers and skills the user owns, scoped per project

- Plugins, user MCP servers and user skills now share one activation shape:
  `enabled` plus `{ mode: "global" | "projects", projects: [] }`. The boolean
  stays separate from the scope so switching something off keeps the project
  list it was narrowed to, and the `off` / `projects` / `global` control the UI
  renders is derived from the pair rather than stored as a third mode.
- Matching is case-insensitive and trailing-separator-insensitive because macOS
  and Windows both hand us case-varying spellings of one directory, and a scoped
  path covers its subdirectories so a monorepo root does not have to be listed
  package by package. A `projects`-scoped extension is inactive in a session
  with no project: "these projects" is a claim about projects.
- Scope is checked when the per-turn catalog is built **and** again at dispatch.
  A session outlives the prompt that listed its tools, and a tool the model can
  see is a tool it will try to call, so filtering in one place leaves a hole
  between re-scoping and the next prompt. Themes stay unscoped — appearance is
  app-wide, not a per-project capability.
- Adding an MCP server is a paste. `parseMcpImport` reads the `mcpServers`
  document every README prints plus the `servers`, bare-map and single-object
  variants, infers `http` from a `url` because half the configs omit `type`, and
  reports per-entry skip reasons so one bad entry in fifteen is not fatal.
- A user MCP server connects on first use and caches its tools; a failed
  handshake stays failed until the user edits it or presses Test. Saving a change
  to what the server *is* drops the connection, renaming it does not — a stale
  tool list is worse than a missing one.
- A user skill is one `SKILL.md`. D174's contract is untouched, which is why the
  editor requires a description and puts it above the body: the description is
  the only part that enters the prompt.
- Four tabs rather than one merged list. Plugins are installed, MCP servers are
  configured, skills are written; their rows need a connection light, a byte
  counter and a permissions matrix respectively, and one list would hide all of
  that behind a lowest-common-denominator row.
- Decisions D192, D193, D194; new host-core registries, new RPC methods and a
  new main-process runtime, so ADR 0053. See `07-plugins/01-plugin-system.md`
  and `07-plugins/03-plugin-api.md`.

## 2026-08-05 — Permission-gated external paths and portable native search

- Explicit `path` arguments for `Read`, `Glob`, `Grep`, `Write`, and `Edit` are
  classified against the durable session workspace and scratch roots before
  the normal risk matrix. In `ask` and `accept-edits`, an outside path emits
  the existing permission card with the requested path preview; in `auto`, it
  executes without a card. Allow-once and the existing tool-scoped
  allow-session grant remain available, while denial, timeout, and cancellation
  return `TOOL_DENIED` without touching the path.
- The approved resolver canonicalizes the deepest existing ancestor again at
  execution time, so `..` and symlink escapes cannot skip the boundary. The
  outside location is not promoted to a workspace root; external reads and
  searches retain absolute paths, and external mutations stay outside Review
  and workspace artifact records.
- The sidecar exposes the host's bounded search controls (`Read.offset/limit`,
  `Glob.path/limit`, and `Grep.path/include/outputMode/headLimit`) with the
  canonical `filesWithMatches` spelling; the host normalizes common
  `files_with_matches` and `files-with-matches` provider aliases. Guidance
  prefers native tools and portable workspace-relative paths, with shell search
  as a bounded, platform-specific fallback.
- Decision D195; the external path capability and widened search schemas change
  the host/runtime boundary, so ADR 0057. See
  `03-runtime/03-tools-and-permissions.md`, `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/15-workspace-ignore-rules.md`, `03-runtime/16-tool-result-limits.md`,
  and E2E-019/E2E-019e.

## 2026-08-05 — Extensions page density and theme-readable actions

- The Extensions destination no longer renders the four-card numeric overview
  band. Installed, MCP, Skills, and Marketplace remain separate tabs; tab
  counts, installed state-group counts, and the pending-update alert retain
  actionable state without duplicating it in a static summary row.
- Shared primary and secondary buttons use semantic accent, surface, text, and
  border tokens. Primary actions invert the current theme surface; secondary
  actions keep an opaque elevated surface and visible border in both themes.
- Decision D196 amends the presentation portion of D169 without changing
  plugin, MCP, skill, marketplace, permission, or runtime contracts. See ADR
  0058, `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `07-plugins/07-plugin-marketplace.md`, and E2E-024N/E2E-060b.

## 2026-08-05 — Clipboard files become session-scratch references

- The composer now distinguishes native text paste from a clipboard payload
  containing files or images. File bytes are sent to Electron main only after
  the renderer has a durable session id; a home composer creates or reuses one
  before the transfer.
- Main validates the session and writes bounded, uniquely named files under
  `<data_dir>/scratch/<sessionId>/pasted/`. The draft receives ordinary
  `@absolute/path` references, with quoting for whitespace, so the existing
  Read/Glob/Grep path semantics handle the pasted material without binary
  prompt content or project mutations.
- Decision D197 and ADR 0059 define the new renderer/main boundary. See
  `04-ux/08-component-spec.md` §11.7–11.8,
  `03-runtime/01-ipc-protocol.md` §13c,
  `03-runtime/03-tools-and-permissions.md` §4b,
  `03-runtime/04-data-storage.md`, and E2E-102.

## 2026-08-06 — Goal mode joins Plan as a contract mode

- Sessions now persist one of three operating modes: `agent`, `plan`, or
  `goal`. The Composer-left chip cycles Agent → Plan → Goal → Agent, and
  `/goal-mode` (`builtin.mode.goal`) is its palette/slash entry.
- Goal negotiates a goal statement, acceptance criteria, and boundaries instead
  of ordered steps. `EnterGoalMode` and `SubmitGoal` mirror `EnterPlanMode` and
  `SubmitPlan`, writing `.pi/goal/<unique-name>.md` and one pending
  `plan_approvals` row. `plan_approvals.kind` (schema v11) is the only
  discriminator; a submit tool run against the other kind fails with
  `PLAN_KIND_MISMATCH`.
- Plan and Goal are the contract modes. The host hard deny for
  Write/Edit/plugin/unknown tools, the Bash-follows-permission-mode rule, the
  `*_IN_PLAN` error codes, the single-pending-approval invariant, and the
  `PLAN_REQUIRES_INTERACTIVE_SESSION` rejection of scheduled runs all apply to
  both, evaluated against the session's durable mode.
- After approval the session becomes Agent and the queued execution carries the
  kind, so a Goal run chooses its own approach, self-checks against every
  acceptance criterion, stops at a stated boundary, and reports criterion by
  criterion.
- Decision D198 defines this. See `03-runtime/01-ipc-protocol.md` §5.4,
  `03-runtime/02-agent-runtime.md` §5b/§7.2a,
  `03-runtime/03-tools-and-permissions.md` §10.1,
  `03-runtime/04-data-storage.md` §4.6a/§7,
  `03-runtime/06-host-rpc-protocol.md` §5.1,
  `03-runtime/08-error-codes.md`, `03-runtime/10-session-state-machine.md`,
  `04-ux/04-builtin-commands.md`, and `04-ux/08-component-spec.md` §11.

## 2026-08-06 — The regenerate branch is archived under the host RPC lock

- Turn completion used to archive the finished regenerate branch with a
  read-modify-write from Electron main: `session.get`, then
  `session.replaceMessages` to stamp `revisionCount` / `activeRevision` on the
  user root. Assistant and tool messages reach SQLite asynchronously through the
  persistence outbox (ADR 0041), so the snapshot could predate the turn's final
  message and the whole-transcript rewrite deleted it from the transcript file
  and the index, along with every row's `turn_id`.
- `session.saveActiveRevision` now performs the read, the archive, and the stamp
  in one host call under the state lock. The stamp rewrites only the root user's
  transcript line and re-reads the file at write time, so a line appended in the
  meantime survives. Electron main drains the outbox first and skips the archive
  with a warning rather than archiving an incomplete branch.
- `session.replaceMessages` carries each surviving message's owning `turn_id`
  across the rewrite, and is documented as safe only for a caller that owns the
  whole transcript for the duration of the call.
- Decision D199 and ADR 0060 define this. See
  `03-runtime/04-data-storage.md` §4.9/§7,
  `03-runtime/06-host-rpc-protocol.md` §4, and E2E-118.

## 2026-08-06 — Context compaction becomes imperceptible

- Compaction is host-driven and silent. The `CompactContext` tool, the
  `<context_management>` soft-boundary nudge, and the host no-confirmation
  allowlist entry are gone, so a long session never spends a model turn asking
  to be compacted and never grows a transcript row for it.
- `contextBudget()` keeps the D158 hard limit and headroom untouched, derives
  the retained-tail target from the model window instead of settings, and adds
  a background limit at 70% of the hard budget. Background pre-computation also
  requires growth of at least the retained-tail target since the newest
  checkpoint's baseline, so a large tail cannot re-trigger every turn.
- Generation and installation are separate. A checkpoint is built only in
  provider-idle windows — while a tool executes, and after a run ends — so the
  summary request never shares the provider connection with a streaming turn.
  It installs at the next turn boundary or prompt if its base is still active,
  its anchor still exists, and it still fits the current model's budget;
  otherwise the unchanged blocking hard boundary handles it. A failed
  background build is discarded with no event, no persistence, and no ADR 0049
  fallback.
- `compaction_start`/`compaction_end` gain optional `phase`, and
  `compaction_end` gains optional `status { generation, summaryTokens }`; both
  are additive inside protocol v9. A successful automatic compaction notifies
  nobody. The context usage inspector is the only visible trace, and Settings
  exposes no compaction controls at all.
- Decision D200 and ADR 0061 amend D158 / ADR 0030 / ADR 0049. See
  `03-runtime/01-ipc-protocol.md` §6, `03-runtime/02-agent-runtime.md` §5.1/§7.1,
  `03-runtime/03-tools-and-permissions.md` §0/§2/§10.1,
  `03-runtime/06-host-rpc-protocol.md`, `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md` §7.3/§8.3/§11.5,
  `04-ux/09-interaction-patterns.md` §3A, and E2E-084.

## 2026-08-06 — Context compaction is rebuilt to match Codex

- The previous round cited Codex and then implemented its opposite on four
  counts. Codex compacts only synchronously, measures the whole context by
  default, emits a `ContextCompaction` item and a `Warning` for every
  compaction, and has a real model-facing tool (`new_context`). D200's Context
  section also stated that Codex has no such tool, which is wrong. The user
  asked for Codex's mechanism after being told it reverses the imperceptibility
  they had asked for one round earlier.
- Compaction is inline again. Background pre-computation, its 70% limit, the
  increment-scoped trigger, and the three idle call sites are deleted;
  `prepareNextTurn()` compacts when the context crosses `hardLimit` or the model
  called `new_context`, matching Codex's `should_roll_over`.
- A checkpoint carries the summary plus recent user messages, nothing else. pi's
  cut point still marks the boundary, but its split-turn prefix and recent tail
  are folded back into the summary input, so no message leaves the model context
  uncovered — the reason a filtered tail alone would have been a data-loss bug.
  Retention is newest-first to 20,000 tokens with the crossing message truncated
  rather than dropped, and assistant messages take their tool calls with them, so
  no orphaned call reaches a provider.
- Both Codex families exist: the summary path, and a `fresh_window` rollover
  that asks for no summary and installs a fixed marker text. The family is an
  internal switch (construction option, then
  `PI_DESKTOP_COMPACTION_STRATEGY`), absent from settings and i18n, because no
  user can judge that trade-off from a settings row and Codex does not ask them
  to.
- `new_context` is parameterless with Codex's description verbatim, sits on the
  host no-confirmation allowlist, and is never assignable to a subagent. Two
  budget reminders — at `clamp(hardLimit * 0.15, 8k, 32k)` and at 2,000 tokens
  remaining — are appended to the current turn's system prompt, claimed once per
  checkpoint window, and never persisted or shown.
- host-core keeps the whole checkpoint chain, per-record valid, because one
  transcript row per compaction has to survive a restart, a rewrite, and a fork.
  `compaction_end` drops `phase` and carries `mark` instead of `status`; the
  transcript draws a divider row after the message each checkpoint covers, and
  every successful compaction raises one warning toast. The context inspector
  keeps its line, now the newest mark's.
- Three deviations from Codex are deliberate: the summary precedes the retained
  users because `buildSessionContext` fixes that order, `hardLimit` stays
  "window − output reserve" rather than 90% of the window (we have no separate
  full-window guard), and the tool is registered in both families rather than
  only the rollover one.
- Decision D203 and ADR 0064 amend D200 / ADR 0061 and restore D158 / ADR 0030's
  visibility property. See `03-runtime/01-ipc-protocol.md` §6,
  `03-runtime/02-agent-runtime.md` §5.1, `03-runtime/03-tools-and-permissions.md`
  §2/§10.1, `03-runtime/04-data-storage.md` §2.1,
  `03-runtime/16-tool-result-limits.md` §4, `04-ux/08-component-spec.md`
  §7.3/§7.4/§8.4a/§11.5, `04-ux/09-interaction-patterns.md` §3A, and E2E-084.

## 2026-08-06 — Bounded subagents behind a `Task` tool

- A session can delegate one self-contained piece of work to a subagent and get
  back a single written report. Definitions are Markdown documents — four
  inline builtins (`explorer`, `code-reviewer`, `test-runner`, `fixer`) plus
  enabled global user documents under `~/.agents/subagents/*.md`, re-read on
  every launch, capped at 16, with malformed documents degraded to launch
  diagnostics. There is no project-level subagent capability source.
- A definition declares its own `tools` from Read/Glob/Grep/BrowserPreview/
  Bash/Edit/Write and is read-only (`Read, Glob, Grep`) when it declares none. A
  delegate never inherits mutation rights from its session, cannot reach plugin,
  skill, mode or meta tools, and has no `Task` tool of its own. Its calls run
  through the same `tools.execute` host path, so containment and permission
  modes are unchanged.
- A definition may pin `model: <provider>/<model>`, resolved once per launch in
  Electron main against configured providers (by id, vendor key or display name,
  8 distinct providers maximum). An unresolvable pin fails the `Task` call with a
  tool error instead of falling back to the session model.
- `Task` is offered in Agent mode only. Fan-out comes from execution modes: the
  session Agent runs `toolExecution: "parallel"`, every other tool is
  `sequential`, and only an all-`Task` batch runs concurrently, capped at 4
  slots and each delegate at its own `maxTurns` (default 24, maximum 80). The
  sidecar serializes same-path `Write`/`Edit` calls through a `PathMutex`.
- The parent's model context gains the bounded report (12k chars) and nothing
  else. Delegate messages and tool rows are emitted and persisted with
  `parentToolCallId` / `agentName` in the message `meta`, but the runtime skips
  them when rebuilding context, and a delegate's termination collapses into the
  tool result rather than reaching Electron main's turn handling.
- The transcript nests attributed rows one level inside their `Task` row and
  keeps them out of the turn stream and the minimap. One `Task` stays compact;
  two or more in an activity group derive one renderer-only delegation card
  with aggregate status and a main-agent-to-delegate topology. Nodes reuse the
  existing row disclosure, structured outcome and nested rows. The topology is
  derived from persisted attribution on live and reload, adds no protocol or
  storage shape, and invents neither delegate dependencies nor an unavailable
  parent-summary node. Pending permission requests become a per-session queue:
  head-only answering, id-matched removal, whole queue denied on abort, and a
  card that names the delegate that asked and how many wait behind it.
- Decision D201 and ADR 0062 define this. See
  `03-runtime/02-agent-runtime.md` §5f/§7.2b/§8,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `03-runtime/04-data-storage.md` §4.7a,
  `04-ux/03-permission-ux.md` §6a, `04-ux/08-component-spec.md` §9.9, and
  E2E-119.

## 2026-08-07 — Empty home uses direct bottom task entry

- Empty chat home uses a direct bottom composer and keeps the hero and optional
  onboarding content in one scrollable region.
- The home composer is a bottom-reserved sibling of that region, so it remains
  visible at the bottom while checklist content scrolls independently on short
  windows.
- Decision D204 and ADR 0066 define the layout. See
  `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, and E2E-063 / US-UI-64.

## 2026-08-07 — Empty home gains developer starter guidance (superseded)

- The empty home now presents four compact, localized developer starters under
  the hero so the middle surface is useful without becoming a marketing panel.
- Activating a starter pre-fills and focuses the composer. It does not send a
  prompt or create a session turn, and short-window scrolling still preserves
  access to every block.
- Decision D205 defined this amendment to D204 before D206 superseded it. See
  `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, and E2E-063 / US-UI-64.

## 2026-08-07 — Empty home removes developer starter cards

- The empty home no longer renders development task cards, starter glyphs, or
  contextual quick actions.
- The hero, optional onboarding checklist, and direct bottom composer remain;
  task entry starts directly in the composer.
- Decision D206 supersedes D205 while retaining D204's scrollable layout. See
  `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, and E2E-063 / US-UI-34 / US-UI-48.

## 2026-08-07 — Work panel gains a direct keyboard entry point

- `Cmd/Ctrl + J` is a customizable renderer shortcut named `openWorkPanel`.
  It reveals the active session's retained work-panel context at the committed
  width without creating a resource tab; the context menu remains the place to
  create Review, Terminal, Browser, or Files. No active session and the
  Settings page are no-op contexts. *(Open-only clause amended by D221: the
  shortcut also collapses the visible panel.)*
- Artifact-driven resource creation, session ownership, background-event
  isolation, collapse behavior, and width persistence remain unchanged.
- Decision D207 supersedes D128's no-global-shortcut clause and amends D142's
  no-launcher presentation. See ADR 0068, `04-ux/01-ui-ia.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`, and
  E2E-056.

## 2026-08-10 — Native path mistakes recover without false turn failure

- Read is file-only, Glob is directory-only, and Grep accepts a file or
  directory; directory Read errors include structured Glob recovery args.
- Recovered tool errors remain visible on their own rows but no longer turn the
  containing processing group into a terminal failure surface.
- D185's deferred Agent search tools remain unchanged. Decision D208 and ADR
  0069 define the compatible tool and transcript contracts.

## 2026-08-10 — Composer file references use compact draft chips

- Completed workspace-file selections and pasted session-scratch files now live
  as renderer-owned, session-scoped references instead of exposing their
  canonical paths in the textarea.
- The composer shows only removable leaf-name chips. Full paths remain available
  to tooltips and assistive technology, and duplicate leaf names retain distinct
  canonical identities.
- Immediately before the existing submit dispatcher, references serialize after
  visible text with the unchanged quoted-or-unquoted `@path` grammar. Reference-
  only sends, slash templates, and Agent/Plan/Goal aliases keep their existing
  behavior; failed sends retain both text and references.
- An accepted send retains only an in-memory, session/turn-scoped copy of its
  pre-serialization draft while unanswered smart Stop remains possible. That
  Stop restores the original text and chips; after reply content begins, abort
  preserves the partial transcript and restores no draft.
- `ComposerPastedFile.name` is the sanitized original leaf label, while `path`
  keeps the UUID-backed absolute storage name. Clipboard bytes, scratch
  containment, cleanup, host RPC, storage schema, and provider payloads remain
  unchanged.
- Decision D209 and ADR 0070 amend the draft-presentation clauses of D124 / ADR
  0024 and D197 / ADR 0059. See `03-runtime/01-ipc-protocol.md` §13c,
  `03-runtime/03-tools-and-permissions.md` §4b,
  `04-ux/07-ui-design-system.md` §8.1, `04-ux/08-component-spec.md` §11.7–11.8,
  `04-ux/09-interaction-patterns.md` §8a, and E2E-102/E2E-102a.

## 2026-08-11 — Global corners use an Apple-inspired shape hierarchy

- Fixed radii use a regular 4/6/8/10/12/14/16/18/20/24px ladder. Compact and
  medium desktop controls use rounded rectangles; explicit pill and circle
  tokens remain reserved for semantic capsules, equal-width icon controls,
  switches, tracks, avatars, and dots.
- Nested surfaces follow Apple's concentricity rule when their corners align:
  the outer radius equals the inner radius plus the inset between their edges.
  Structural full-width shell panels remain square.
- The composer keeps its 20px visible radius through the shared radius scale.
  Experimental `corner-shape` rendering is deferred because Electron 37's
  Chromium 138 runtime does not support it.
- Decision D210 amends D072's previously pixel-preserving radius ladder without
  changing its token-only enforcement. ADR 0071 records the rationale. See
  `04-ux/07-ui-design-system.md` §6.2 and US-UI-72.

## 2026-08-11 — Global plugin launcher and uninterrupted next-turn preparation

- Option+Space on macOS and Alt+Space on Windows/Linux opens a centered,
  frameless plugin launcher. It searches launchable panels by Chinese name,
  full pinyin, pinyin initials, normalized name/id, and description, then opens
  the highlighted result through the existing panel host.
- During an active answer the composer draft and mode, thinking, and permission
  choices remain editable for the next turn, while Send remains disabled. The
  renderer flushes only the newest full choice after the host reports idle.
- User-stopped partial responses retain elapsed duration and exact provider
  output when present; absent final usage falls back to a visibly approximate
  output count so generation throughput survives persistence and reload.
- Decisions D211/D212 and ADRs 0072/0073 define the native-window, IPC,
  in-flight configuration, and transcript metadata contracts. See
  `03-runtime/01-ipc-protocol.md`, `03-runtime/02-agent-runtime.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, and E2E-120.

## 2026-08-12 — Plugins can request and send native notifications

- `pi.ui.notify` remains an in-app Toast for compatibility. Plugins with the
  existing `notify` permission gain `getNotificationPermission`,
  `requestNotificationPermission`, and `showNativeNotification` APIs.
- Native plugin notification objects remain owned by Electron main. The API
  returns a best-effort `granted` / `denied` / `unknown` / `unsupported` state
  because Electron has no cross-platform read-only permission query. Native
  plugin notifications do not create durable task inbox rows or session
  activation events.
- Decision D213 and ADR 0074 define the public API and the separation from
  D117's application-owned task notification contract. See
  `07-plugins/01-plugin-system.md`, `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, and E2E-122.

## 2026-08-12 — Development plugins get an explicit permission-ceiling reload

- Automatic development-plugin reloads continue to reject manifest permission
  additions, preserving the no-silent-widening boundary.
- The Plugins page now offers Reload for `source: "dev"` rows. The new
  `plugin/reload` invoke resolves the registered folder, reloads it through the
  existing Electron runtime path, and re-arms the watcher with the current
  declared permissions as its new ceiling.
- Decision D214 and ADR 0075 define this additive renderer/main IPC surface.
  Host RPC and storage schema versions remain unchanged; see
  `07-plugins/10-plugin-devex.md`, `07-plugins/12-plugin-ipc-and-host-services.md`,
  and E2E-022B.

## 2026-08-12 — Windows reserves the plugin launcher chord

- Windows' `Alt+Space` system-menu reservation can cause Electron's global
  shortcut registration to fail while the application is unfocused. The host
  core now owns a narrow low-level keyboard hook for the default binding,
  consumes the chord, and emits `keyboard.shortcut` to Electron. Electron
  toggles the existing launcher window; custom bindings continue to use the
  normal Electron global shortcut path.
- Decision D215 and ADR 0076 define this additive host integration. Protocol
  version 9 and storage schema 11 remain unchanged.

## 2026-08-13 — Plugin launcher renderer warms during startup

- Electron starts creating and loading the retained plugin launcher as soon as
  Electron is ready, before backend/plugin boot completes, while keeping the
  window hidden.
- Shortcut delivery during warm-up joins the same in-flight creation promise;
  failed warm-up remains retryable, and each visible invocation still refreshes
  the plugin catalog. macOS reveals the panel through one normal activation
  path, without a redundant application focus steal or window-stack move.
- Decision D217 and ADR 0080 supersede only D211/ADR 0072's first-use lazy
  creation clause. IPC, host RPC, protocol v9, and storage schema v11 are
  unchanged.

## 2026-08-12 — Approval cards focus on the artifact and remember the mode

- Plan/Goal approval cards now show only the title, host-created artifact
  opener/path, Reject, and Approve. Submitted question/description, status,
  validity/deadline, and inline warnings are not rendered.
- The selected Ask / Accept edits / Auto approval mode is remembered in
  renderer-local device preferences and becomes the next approval's default;
  Ask remains the safe fallback.
- Title-derived artifact filenames preserve Unicode alphanumeric characters so
  localized plan titles remain recognizable. The host's existing internal
  deadline remains a compatibility/fail-closed boundary but is not exposed by
  the approval card.
- Decision D215 and ADR 0076 amend D189/ADR 0053. Protocol and storage versions
  remain unchanged.

## 2026-08-14 — Plugin launcher remembers recently opened plugins

- The shortcut-invoked launcher records every successfully opened plugin id in
  renderer-local `localStorage` and shows an empty query in most-recently-used
  order, so the last opened plugin stays one Enter away.
- Typing keeps search relevance authoritative and uses recency only as a
  tiebreaker between equally relevant matches; corrupted or unavailable storage
  degrades to the existing name order without breaking launching.
- Decision D219 refines D211's presentation. IPC, host RPC, protocol v9, and
  storage schema v11 remain unchanged.

## 2026-08-14 — New task stays out of history until it carries input

- Clicking New Task now opens an unpersisted draft: the renderer no longer
  calls `session.create` (or reuses an old empty draft) at click time. The
  first message — or pasted file attachments, which need a session to attach
  to — materializes the session, which then appears in the sidebar history
  titled with the prompt.
- Composer toolbar selections made before the first message (mode, thinking
  level, permission mode, model) are retained on the draft and applied when
  the session is created; a toolbar-only interaction creates no history row.
- The sidebar history filter drops sessions whose title is still a default
  untitled value, which hides legacy empty drafts created before this change
  as well as any future accidentally empty sessions.
- Decision D220 supersedes the empty-draft reuse clause of D088/D093: there is
  nothing to reuse because no draft session exists until first input. Protocol
  v9, host RPC, and storage schema v11 are unchanged; the change is confined
  to the renderer store, Composer, and Sidebar.

## 2026-08-21 — New Task creates an immediate durable empty slot

- New Task now resolves the current project or Temporary group by its most
  recent non-archived session. An empty latest session is selected and reused;
  a non-empty latest session causes one real empty session to be created,
  refreshed into the sidebar, and selected before the first prompt.
- The renderer serializes same-group New Task requests so rapid repeated clicks
  cannot race multiple empty-session inserts. The rule is shared by project
  groups and path-less Temporary sessions; an older empty row is intentionally
  untouched when a newer non-empty session is the latest.
- `SessionSummary.messageCount` is derived by host-core from `sessions.last_seq`
  and replaces title heuristics as the empty predicate. Empty rows are visible;
  title localization and manual renaming remain presentation concerns.
- Decision D252 supersedes D220 and ADR 0084. The startup home remains an
  unpersisted renderer draft, but explicit New Task is eager and durable.
  `messageCount` is additive inside protocol v9; storage schema v11 is
  unchanged. See ADR 0113 and E2E-011b / E2E-011d / E2E-011e.

## 2026-08-14 — The work panel shortcut toggles instead of only opening

- `Cmd/Ctrl + J` (`openWorkPanel`) now collapses the visible work panel as well
  as revealing a closed one, going through the same store action as the header
  collapse control. Collapsing retains the session's tabs, active resource,
  Browser resource, and committed width, so a second press restores the
  previous surface.
- The shortcut id stays `openWorkPanel` so existing keybinding overrides keep
  working; only the Settings → Shortcuts label changes to describe toggling.
- The no-active-session and Settings no-op contexts, artifact-driven resource
  creation, session ownership, and background-event isolation are unchanged.
- Decision D221 amends D207 and reverses ADR 0068's rejected toggle
  alternative; D128's and D142's remaining clauses stand. See ADR 0085,
  `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, and E2E-056. Protocol v9, host RPC, IPC
  channels, and storage schema v11 are unchanged.

## 2026-08-14 — A recorded change is a list row, not a card

- The review change card flattens into a single line on the `.tool-row` rhythm
  (24px row, disclosure caret, mono path, `+`/`−` counts on the right): the 1px
  border, 2px status rail, icon plate, status pill, second meta line, shadow,
  and light-theme white fill are all gone, leaving hover fill as the only row
  chrome. The 280px-default Review panel was spending most of its width on that
  chrome instead of on the path.
- Status now travels as a Git-style letter (`A`/`M`/`D`) tinted by the existing
  per-status accent, so it is never carried by color alone; the localized status
  word — plus the rolled-back state, which the row shows as a strikethrough —
  stays in the row's accessible name. The expanded hunks, hash-guarded rollback,
  `aria-expanded`/`aria-controls` disclosure, and message ownership are
  unchanged; rollback becomes a borderless text action.
- The Review tab's summary bar loses its icon, tinted band, and pill border,
  and the tab body drops its inset fill so the list reads flat. The Git-diff-era
  `.diff-file*` rules that no surface had rendered since the Review tab became a
  session change history were deleted (`.diff-file-counts` survives, renamed
  `.diff-counts`).
- Decision D222 refines the presentation of D097's Review tab and the
  message-owned card; the review truth model, rollback semantics, and panel
  ownership rules stand. Presentation-only: see `04-ux/08-component-spec.md`
  §4.2/§4.4/§4.5 and §5. Protocol v9, host RPC, IPC channels, and storage
  schema v11 are unchanged.

## 2026-08-14 — PI-Desktop stays a regular macOS application

- The plugin launcher window asked Electron for `visibleOnFullScreen` without
  `skipTransformProcessType`, so Electron ran
  `TransformProcessType(kProcessTransformToUIElementApplication)` on the whole
  process and PI-Desktop vanished from the Dock and Cmd+Tab. ADR 0080's boot
  warm-up made that happen on every launch. The launcher now passes
  `skipTransformProcessType: true`; the process type is never transformed, and
  `app.dock.hide()`/`app.setActivationPolicy` remain forbidden in Main.
- The launcher keeps `canJoinAllSpaces` and `FullScreenAuxiliary`: it still
  covers every regular Space and PI-Desktop's own fullscreen window. Overlaying
  another application's fullscreen Space is given up — macOS reserves it for
  accessory apps — and invoking the launcher from one activates PI-Desktop.
- macOS activation restores the shell from `did-become-active` as well as
  `activate`, gated on a booted, non-quitting app with no visible window, so
  Cmd+Tab and App Exposé resurface a tray-hidden window (D216/ADR 0078) while
  launcher and plugin-panel activations leave the main window where it is.
- Decision D223 constrains ADR 0072's launcher window and completes D216's
  restore paths; ADR 0080's warm-up and launcher latency budget stand. See
  ADR 0086, `03-runtime/07-process-model.md` §5, and E2E-127. Protocol v9, host
  RPC, IPC channels, and storage schema v11 are unchanged.

## 2026-08-14 — Revealed work panel with no resource lists its four tools

- `Cmd/Ctrl+J` reveals the panel without creating a tab, which left the body as
  blank space below the title bar. The body now renders an empty state — tiled
  icon, title, one line of copy — followed by the same four tools the header
  menu lists (Review, Terminal, Browser, Files) as plain 28px entry rows.
- A row calls the same create-or-select path as its menu counterpart, so it
  cannot produce a duplicate tab. The rows exist only while the body has no tab
  at all; the shortcut itself still creates nothing, keeping D128's
  artifact-driven entry model intact — the rows are a user choice, not a side
  effect of revealing the panel.
- The empty body is not exposed as a `role="tabpanel"` because no tab labels it;
  its rows are buttons inside a `role="group"` labelled "Tools".
- All panel empty states (the no-resource body and each tab's own) now share one
  `WorkTabEmpty` component on the proportions the rest of the app already uses
  (`.ext-empty`, `.projects-empty`): 38px round tiled icon, title, muted copy
  wrapping at 34ch instead of 48ch because the panel can be 244px wide.
- Entry rows stay restrained — hover fill and a focus ring, no cards, no hero
  art, no large icons — so this does not reintroduce what D206 removed from the
  empty home, and it stays inside design-system §14's "no marketing-style empty
  states".
- No action button in the "open a project" empty states: `openProject()` resets
  the panel context and hides the panel, so the button would undo the surface
  that offered it.
- Decision D224 is renderer-only. Protocol, host RPC, and storage schema are
  unchanged.

## 2026-08-14 — Context usage inspector opens on click

- The inspector trigger no longer opens on `pointerenter` or focus. A click —
  or `Enter`/`Space` on the focused button — toggles the panel, and the 140ms
  hover-grace close timer that kept it alive between trigger and panel is
  deleted with it. Reading a token breakdown, scrolling the tool list, and
  selecting text inside the panel all outlast a pointer that wanders off, which
  the hover model punished.
- Dismissal is explicit: a second activation, a capture-phase pointerdown
  outside both trigger and panel, or `Escape`, which also returns focus to the
  trigger. The existing rule that scrolling the trigger out of view closes the
  panel stands, as does the body-level collision-aware placement (ADR 0047 §6).
- The panel stops being a tooltip. It carries `role="dialog"` with the localized
  `Context` label; the trigger swaps `aria-describedby` for
  `aria-haspopup="dialog"` and keeps `aria-expanded`/`aria-controls`. Keyboard
  users gain a stable panel instead of one that vanished on blur.
- Decision D225 amends D184/ADR 0047 and is renderer-only. Protocol, host RPC,
  and storage schema are unchanged.

## 2026-08-14 — A run row's command lives in its head, not in its body

- Expanding a `run` row opened with the command it had just printed in its
  collapsed head, so the first thing the reader met was the line they already
  had, and the output they expanded for started below it. The body now carries
  only the channels the command produced (Output, Errors); the command appears
  once, in the head.
- The head therefore grows the two things the body no longer offers. A copy
  button beside the chevron yields the command as it was written — the head's
  summary is squeezed onto one line, so it is not what gets copied — and the
  outcome is stated in words (`Done`, `Failed`, `Denied`, `Working…`) with a
  dot tinted to match. The dot pulses while the command runs and replaces the
  row's spinner; the label carries the meaning, so the tint is decoration and
  `prefers-reduced-motion` stills it.
- Withholding the command is gated on `hideSummaryArg`, the option that means
  "the collapsed row already shows this argument". `PermissionCard` builds its
  presentation without it and so keeps showing the command it is asking about,
  which is the whole point of that card. The generic argument fallback is
  suppressed for the same reason: a command withheld because the head shows it
  must not return as an argument the moment it prints nothing.
- The head is a flex row holding the disclosure button, the copy button, and a
  pointer-only chevron, because a button cannot nest inside a button. Hover fill
  moved from the header to the head so it does not stop short beneath the new
  controls, and `:has()` keeps a row with nothing to expand unfilled. Copy and
  chevron are quiet until hover, focus, or expansion; the status label is always
  visible. The chevron duplicates the header for pointers only
  (`aria-hidden`, `tabIndex={-1}`), and the visible status doubles as the row's
  live region, so the outcome is announced once rather than twice.
- This replaces the withdrawn in-place terminal card: reverted for reproducing
  panel chrome inside the transcript. The row keeps its standard disclosure
  shape and gains only what the reader was missing.
- Decision D226 refines D192's structured tool presentation and is
  renderer-only. Protocol, host RPC, IPC channels, and storage schema are
  unchanged. See `04-ux/08-component-spec.md` §9.2/§9.3/§9.5/§9.10 and E2E-129.

## 2026-08-14 — A run row reports what the command did

- The row's outcome was the tool call's status, so a command that exited 1 could
  read `Done` whenever a layer forgot to flag the call as failed. It is now read
  from the shell's own report: `exitCode` non-zero is `Failed`, a killed shell
  that reports no code at all is `Failed`, and only `exitCode: 0` is `Done`. The
  host already applied that rule when marking Bash results; the row no longer
  depends on it having been applied upstream.
- Tools that report no exit code fall back to the call's status. A row with
  neither — an import, a half-written message — states nothing rather than
  claiming success, and hands the announcement back to the hidden live region.
  The auto-open on failure follows the derived outcome, so a failing command
  opens its own row whichever layer noticed.
- The expanded body loses its card. A `run` row's blocks drop the heading, the
  border, the fill and the per-block copy button, leaving the output as plain
  monospace text that reads like the terminal it came from. The 260px cap and
  its scroll stay: a long build must not bury the rest of the transcript.
- Dropping the headings would have left `Errors` distinguished by tint alone, so
  each channel's name is still rendered for assistive technology — visually
  hidden, semantically present.
- Decision D227 refines D226 and is renderer-only. Protocol, host RPC, IPC
  channels, and storage schema are unchanged. See
  `04-ux/08-component-spec.md` §9.2/§9.3/§9.5/§9.10 and E2E-129.

## 2026-08-14 — Mid-stream rate limits use the bounded retry

> Superseded by D245 on 2026-08-19; the one-retry behavior below is retained as
> the historical decision and is no longer the active provider policy.

- A mid-stream HTTP 429 is now classified as retryable `PROVIDER_RATE_LIMITED`
  and joins `STREAM_FAILED`, `NETWORK_ERROR`, and `TIMEOUT` in the runtime's
  same-turn bounded replay path: one 750 ms abortable backoff, the failed
  assistant is removed from model context, and the turn is replayed once with
  the same visible assistant bubble.
- The retry budget is unchanged — one same-turn retry per prompt. A second 429
  remains terminal and emits the normal assistant error plus lifecycle `error`
  event with `retryAttempt: 1` and `providerStatus: 429` in the details, so the
  transcript keeps its manual retry action.
- Request-setup 429s were already covered by pi-ai's one bounded retry that
  honors `Retry-After` up to the 8-second cap; this closes the post-stream gap
  where that wrapper can no longer act.
- Decision D233 refines D186 and is runtime-only. Protocol, host RPC, IPC
  channels, and storage schema are unchanged. See
  `03-runtime/02-agent-runtime.md` §5d, `03-runtime/08-error-codes.md`, ADR
  0091, and E2E-149.

## 2026-08-15 — A stopped mutation loop says so

- D186's repeat guard counted every same-path `Edit` failure alike, so the two
  failures it allows could both be spent on errors that already told the model
  what to do next. `EDIT_TAG_MISMATCH`, `EDIT_TAG_UNKNOWN`, and
  `EDIT_LINES_UNSEEN` each hand back the live tag or the withheld content, so
  each now gets one free attempt per path. Every other code still counts on its
  first occurrence, and a write that lands clears that path's history.
- The guard stops the loop by terminating the tool batch, which pi-agent-core
  reads as "no more work". The turn therefore ended with a failed tool card and
  no final message, indistinguishable from a model that chose to say nothing.
  The runtime now finalizes the assistant row with
  `MUTATION_RETRY_BUDGET_EXHAUSTED` — retriable, so the transcript keeps its
  retry affordance — and emits the matching error event, which also records the
  turn as `error` rather than `completed`.
- Decision D228 refines D186 and is runtime-only. Protocol, host RPC, IPC
  channels, and storage schema are unchanged. See
  `03-runtime/18-line-anchored-edit-contract.md` §9.3,
  `03-runtime/03-tools-and-permissions.md` §4d,
  `03-runtime/08-error-codes.md` §3.3, ADR 0089, and E2E-140/E2E-141.

## 2026-08-15 — A file permission carries a range, and a delete is recoverable

- The three fs permissions were workspace-wide switches: `fs.read.workspace`
  reached `.env`, and `recursive: false` bounded one `fs.remove` call while a
  `glob` plus a loop reached the whole tree. A permission now says whether a
  plugin may touch files at all; `manifest.fs` says which ones, per mode, with
  globs relative to the mode's root. `fs.read` may ask for the whole tree —
  egress is confined to `manifest.net.domains`, so a broad read no longer
  carries anything out — but `fs.write` and `fs.delete` are refused a whole-tree
  pattern at validation time.
- Every `pi.fs.*` call passes four gates in a fixed order and a later gate can
  only refuse: declared ∩ granted, `realpath` containment on both sides (so a
  symlink out of the workspace fails where a string comparison passed), the
  unconditional credential deny-list plus the host's own data directory, then the
  declared scope. Outside the scope the user is asked natively — deny / allow
  once / allow this session — and a session answer lives in memory and dies with
  the process. A host with no consent service refuses rather than assumes yes.
- Deletion is bounded rather than scoped alone, because it is the one operation
  re-running the plugin cannot undo. `own: true` lets a plugin remove what it
  wrote itself, tracked by a path+mtime ledger in its own data directory and
  invalidated the moment the user edits the file; anything else needs a declared
  scope. Removal goes through `shell.trashItem`, stays non-recursive, and is
  braked at 50 removals per rolling minute. The host copies none of the user's
  data to provide the undo — the operating-system trash is the whole mechanism.
- `root: "userSelected"` trades standing power for reach: `pi.fs.requestDirectory()`
  asks the user to pick a directory, needs no manifest scope inside it, and the
  handle is memory-only. This is what keeps whole-disk plugins possible without
  a permanent grant.
- The pre-scope names still install and are downgraded on load: `fs.read.workspace`
  keeps the whole tree, `fs.write.workspace` can write nothing until the manifest
  says where, `fs.delete.workspace` becomes `own: true`. Capability is reduced
  rather than a hole left open; the marketplace preflight and `pi-plugin check`
  both name the downgrade so an author sees it before a user does.
- Decision D229 continues ADR 0008 D009 and implements the confirmation policy
  `07-plugins/13-plugin-permissions-matrix.md` promised but never enforced. The
  manifest gains `fs`, and `pi.fs.remove` / `pi.fs.requestDirectory` join the
  brokered API; host RPC and storage schema are otherwise unchanged. See
  ADR 0088, `07-plugins/02-plugin-manifest-schema.md` §5.2,
  `07-plugins/04-plugin-security.md` §6, and
  `07-plugins/13-plugin-permissions-matrix.md`.

## 2026-08-16 — Proactive background subagent delegation

- `Task` stops blocking: it starts a delegate in the background and returns a
  `delegationId` immediately. Three new Agent-mode core tools drive the
  lifecycle — `TaskWait` (converge on running delegations, `mode: "any"` +
  `minCompleted` for early convergence, settled delegations re-readable by id),
  `TaskList` (status report) and `TaskStop` (stop running delegations). The
  runtime owns a per-session delegation registry; delegates still running at
  run end, on parent abort, or on dispose are stopped.
- The base system prompt gains a `## Delegation` section (when the catalog is
  non-empty) with positive trigger patterns — parallel exploration, adversarial
  review, multi-file implementation, context-economy searches, batch sharding —
  and convergence rules; the `Task` description is rewritten to lead with those
  triggers.
- Builtins grow to four: `explorer` is rewritten in the omo-slim style
  (tool-choice guidance, parallel searches, `<files>`/`<answer>` report shape),
  and a new write-capable `fixer` implements multi-file changes from a complete
  spec (`tools: [Read, Glob, Grep, Edit, Write, Bash]`, `maxTurns: 40`,
  `<summary>`/`<changes>`/`<verification>` report shape).
- Builtin and user definitions may declare `permission: inherit | ask |
  accept-edits | auto` (default `inherit`). The sidecar attaches the scope to
  the delegate's `tools.execute` calls; host-core resolves the call under that
  mode instead of the session's effective permission mode, with the contract
  modes' hard deny and the external-path gate still in force. A project
  definition may not declare a scope: it arrives with the repository, so the
  declaration is dropped at parse time with a warning and its delegates run
  under the session's effective mode. `fixer` ships with `accept-edits`, so it
  writes inside the workspace without prompting while Bash and external paths
  keep the session's behavior.
- `TaskWait` blocks the turn, so its `timeoutSeconds` defaults to 600 and is
  clamped to 900. A timeout returns the finished reports plus a note to call
  again, so the ceiling costs one round-trip and keeps Stop responsive.
- `MAX_SUBAGENT_CONCURRENCY` becomes a per-session running cap of 10; `Task`
  fails with a tool error when the session already runs 10 delegates.
- Decision D231 amends D201/ADR 0062 and touches the sidecar, host-core's
  `tools.execute` permission resolution, the builtin definitions, the system
  prompt, and the renderer's tool presentation mapping. See ADR 0089 and
  `03-runtime/02-agent-runtime.md` §5f/§5f.1.

## 2026-08-17 — Plugin panels leave the visible surface to plugins

- Plugin panel windows are now frameless on macOS, Windows, and Linux. The
  preload reserves the same transparent 46px safe area on every platform and
  draws only a fixed capsule in the top-right with minimize,
  maximize/restore, and close.
- The host no longer renders the manifest title or a development safe-area
  reminder. Plugin authors own the title, toolbar, background, and all other
  visible panel UI; fixed or sticky UI uses the existing
  `--pi-plugin-titlebar-height` variable and plugin-owned drag regions can use
  `-webkit-app-region: drag`.
- Decision D234 amends D218 / ADR 0081 and D232 / ADR 0082. The private
  sender-validated control channel, closed Shadow DOM, localized labels,
  theme-adaptive capsule, `window.pluginBridge`, protocol v9, and storage
  schema remain unchanged. See ADR 0092, `07-plugins/01-plugin-system.md`,
  `04-ux/07-ui-design-system.md`, and E2E-024D.

## 2026-08-17 — Plugin panels keep a strict 46px drag band

- Plugin panels reserve exactly 46px for a transparent host drag band on every
  platform. Normal-flow content is offset by that value, and clicks in the
  band are unavailable outside the capsule.
- The host renders no panel title. Development panels show a localized,
  non-interactive reminder that the top 46px is drag-only; production panels
  keep the reminder hidden. The minimal capsule stays fixed at the top-right
  inside the band with minimize, maximize/restore, and close.
- Decision D235 amends D234 / ADR 0092. The page-adaptive capsule keeps its
  closed Shadow DOM, localized labels, focus and reduced-motion behavior,
  private sender-validated control channel, `window.pluginBridge`, protocol
  v9, and storage schema. See ADR 0093 and E2E-024D.

## 2026-08-18 — One desktop instance per data directory

- Launching PI-Desktop while it is already running no longer starts a second
  app. Electron main takes the single-instance lock before it touches the data
  directory, and the duplicate launch quits before it creates a window, a tray,
  a child process, or a log line.
- The running instance answers the relaunch by restoring and focusing its main
  window through the tray's Show path, so a window that was closed or hidden
  into the tray comes back instead of a second shell appearing beside it.
- Decision D236 protects D002's single SQLite writer and the singletons around
  it (outbox, tray, launcher shortcut, updater). The lock is scoped to the
  installation, so runs with their own `PI_DESKTOP_DATA_DIR` — E2E harnesses,
  the capture rig, side-by-side profiles — start as before. No IPC, host
  protocol, or storage schema changed. See ADR 0094,
  `03-runtime/07-process-model.md`, and E2E-150.

## 2026-08-18 — Vendor-account (OAuth) login

- A provider row can now be authenticated by a vendor subscription. The seven
  pi-ai OAuth vendors — anthropic, openai-codex, github-copilot, openrouter,
  kimi-coding, xai, radius — ship at once because the card list is derived from
  `models.getProviders().filter(p => p.auth.oauth)` rather than hardcoded.
  `registerBunOAuthFlows()` runs once at startup: pi-ai loads flows through a
  dynamic import with a variable specifier, which electron-vite cannot bundle.
- Credentials live in the existing encrypted secret store under the new ref
  `secret:provider:<id>:oauth`, beside (never instead of) the row's API key.
  `has_secret` widens to "either credential" so existing readiness checks keep
  working; `has_oauth` and a non-secret `oauthAccountLabel` are new.
  `auth_kind` gains `oauth` — it was already a free string, so host protocol
  v9 and storage schema v10 are unchanged. Deleting a provider deletes both
  refs and both `secrets_meta` rows.
- Electron main owns login/logout: `oauth.ts` implements pi-ai's
  `CredentialStore` over `secrets.*`, serializes `modify` per provider for
  locked refresh, and bridges `AuthInteraction` to the renderer through
  `providersOauthVendors/Start/Respond/Cancel/Logout` plus the
  `pi-desktop/providers/oauth/event` stream. Browser-callback, device-code,
  select and paste-a-code steps all travel that one stream, so a single dialog
  renders whatever the vendor asked for and cancel aborts the local callback
  server or the polling loop.
- The sidecar resolves auth per request. An OAuth row launches with
  `apiKey: ""`; the runtime injects `resolveAuth`, which calls the host-proxy
  method `provider.resolveAuth`. Main answers it locally — never forwarding to
  host-core — after checking `(sessionId, providerId)` against the binding
  table it rewrites on every launch, and returns a short-lived `ModelAuth`
  (`apiKey`/`headers`/`baseUrl`, which is how Copilot pins its per-account
  endpoint). A refresh token never leaves main, and the sidecar receives
  strictly less than the long-lived API key it gets for a keyed row.
- `matches()` needs no new field: a vendor row's `apiKey` is permanently `""`
  and the per-launch `resolveAuth` closure disappears through `JSON.stringify`,
  so an OAuth session reuses its warm runtime across turns.
- Model discovery and the connection test go through the account:
  `providers.listModels` reads `models.getAvailable` (which applies the
  vendor's own `filterModels`, so Copilot lists what the subscription
  includes), and the test proves the account by resolving auth instead of
  probing `/models`. A row's `apiStyle` follows the selected model — Copilot
  spans wire APIs — and two styles are added: `openai_codex_responses` and
  `pi_messages`.
- Settings → Model configuration gains a Vendor accounts section above the
  provider list; a signed-in row shows its account label and default model, and
  its edit dialog exposes only those non-secret fields instead of API-key inputs.
- Decision D237 extends D028/D031 and touches host-core secrets and providers,
  Electron main, the agent runtime's provider binding, and the settings UI.
  See ADR 0095 and `03-runtime/14-secrets-storage.md`.

## 2026-08-18 — Independent vendor OAuth accounts

- D240 amends D237 / ADR 0095. The provider row id is the OAuth account
  identity, and every login creates a new row even when `vendorKey` is the same
  as an existing account. Each row owns its own pi-ai collection, credential
  store, refresh serialization chain, and `secret:provider:<id>:oauth` ref.
- Settings now has one owner per concept: Vendor accounts renders and removes
  OAuth rows; AI services renders API-key/custom rows only. A connected OAuth
  row remains selectable in the default model control, while removing it clears
  or repairs a default that points at the deleted id.
- The sidecar binds a set of exact OAuth provider ids and main resolves auth by
  that id. Subagent vendor/name aliases are accepted only when unique, so a
  duplicate vendor account cannot be selected accidentally. See ADR 0098,
  `03-runtime/11-provider-model-system.md`, and E2E-151.

## 2026-08-18 — Builtin subagents inherit the parent permission mode

- The builtin `fixer` no longer declares `permission: accept-edits`; like the
  other builtins, it defaults to `permission: inherit` and uses the parent
  session's effective permission mode.
- In `auto`, builtin delegate calls therefore auto-allow the same in-root,
  high-risk, and explicit external-path operations as the parent. `ask` and
  `accept-edits` keep their existing approval boundaries, and explicit
  non-`inherit` scopes on eligible builtin or user definitions remain
  intentional overrides.
- Decision D242 amends D231 / ADR 0089. Host-core's external-path gate and
  containment checks are unchanged; the fix removes an accidental builtin
  scope override rather than weakening the security boundary. See ADR 0100,
  `03-runtime/02-agent-runtime.md` §5f/§5f.1, and E2E-142.

## 2026-08-18 — Model-aware image attachment transport

- Clipboard images remain compact structured composer references instead of
  being inserted as base64 or forced into visible `@path` text. Electron main
  validates the source against the session roots and stores image bytes under
  `<data>/attachments/<sha256>`; the durable user message stores only the ref,
  kind, name, MIME type, and size.
- The exact pi-ai model record owns visual capability. A model with
  `input.includes("image")` receives eligible images as transient image blocks
  through the sidecar. Unknown/custom models, non-vision models, and images
  above the 10 MB inline bound receive a safe scratch/project path fallback;
  replayed content-store images use a session `replayed/` copy. An explicit
  `supportsImages` binding override may enable or disable the published image
  capability for that exact endpoint; discovery cannot promote an unknown model
  without such an override.
- Decision D243 amends the image portion of D197 / ADR 0059, and D392 / ADR 0218
  amends its capability-resolution rule. It fixes the
  observed GPT vision gap without moving provider logic into the renderer or
  putting binary data into host persistence. See ADR 0101,
  `03-runtime/01-ipc-protocol.md` §5.1/§13c,
  `03-runtime/04-data-storage.md`, `04-ux/08-component-spec.md` §11.7–11.8,
  and E2E-102c–102e / E2E-163.

## 2026-09-11 — Effective image-input overrides across Composer and transport (D392)

- Advanced model settings persist `supportsImages` per provider/model binding as
  a three-state value. `null` or an absent value follows the published model
  record; `true` or `false` explicitly enables or disables image input for that
  endpoint.
- Composer model rows, attachment status, and Electron main transport all use
  the same effective binding capability. The shared published `ModelInfo` is
  not mutated, and unknown/custom models remain conservative without an explicit
  override.
- Decision D392 amends D243 / ADR 0101. See ADR 0218,
  `03-runtime/13-model-catalog-and-selection.md` §11.2,
  `04-ux/08-component-spec.md` §11.7–11.8, and E2E-163.

## 2026-08-19 — models.dev is the primary model catalog

- D266 amends D136 / ADR 0027. Electron main loads the public
  `https://models.dev/api.json` catalog with a bounded timeout and matches
  provider records by vendor key or normalized API URL. Settings, Composer,
  and runtime model metadata use the matching record first.
- The catalog maps display names, context/output limits, input modalities,
  reasoning options, tool-call and structured-output flags, and prices into the
  existing model surfaces. API keys and OAuth credentials never accompany the
  request. `catalogSource` distinguishes models.dev from the pi-ai fallback in
  renderer metadata without changing the host schema.
- If the remote catalog cannot be loaded or has no matching record, the pinned
  pi-ai catalog supplies known native models and adapter compatibility. Custom
  or account-specific provider discovery and explicit IDs remain available
  after that fallback. See ADR 0133, `03-runtime/11-provider-model-system.md`,
  `03-runtime/13-model-catalog-and-selection.md`, and E2E-066/E2E-080/E2E-154.

## 2026-08-19 — The work panel becomes a plugin extension point

- Decision D246. A plugin declares work panel surfaces with `contributes.views`
  (id, plain or localized title, icon token, HTML entry, order), gated by the
  new low-risk `ui.view` permission. `ui.view` and `ui.panel` are independent,
  so a plugin may ship docked views, a detached window, or both.
- A view renders as a main-process `WebContentsView` positioned from a
  renderer-measured rect — the mechanism the preview browser has used since
  D100 — and reuses the plugin's existing isolation wholesale: the same
  sandboxed preload, the same `persist:pi-plugin-<id>` partition as that
  plugin's panel window, and the same `net.domains` egress filter. The egress
  policy and partition name are shared functions so the two placements cannot
  drift apart. An `<iframe>` was rejected because Electron cannot give one its
  own partition, which would make a docked view strictly less isolated than the
  detached window it replaces.
- Icons are tokens from a host-owned closed list, never plugin markup: the icon
  is drawn inside host chrome, so SVG there would be an injection surface and
  would let a plugin impersonate the host. An unknown token degrades to a
  lettered tile rather than failing validation.
- The view list is filtered by activation scope, unlike contributed themes
  (D-themes/`pluginThemes`), which stay unfiltered because the selected theme is
  one global app setting. A view is scoped work, so a project-scoped plugin must
  not offer it elsewhere. Permission, scope, and entry existence are re-checked
  on open; the renderer is never the authority.
- Decision D247. Review, Terminal, and Files move out of the host and ship as
  bundled first-party plugins on that same `contributes.views` channel, leaving
  Browser as the only built-in tool. This gives the plugin API a first-party
  consumer, so a gap in it becomes a shipped-feature bug. It requires new
  `pi.review.*` and `pi.terminal.*` APIs; `terminal.pty` is classified critical
  because a PTY is arbitrary execution as the user, and it is accepted
  deliberately rather than sidestepped with private first-party privileges.
- See ADR 0104, ADR 0105, `07-plugins/02-plugin-manifest-schema.md` §4/§5/§7,
  `07-plugins/03-plugin-api.md` §6, `07-plugins/13-plugin-permissions-matrix.md`
  §2/§3, `04-ux/08-component-spec.md` §5, and E2E-152.
## 2026-08-18 — Compact context usage summary

- The context inspector keeps the click/keyboard trigger, remaining percentage,
  used/window counts, turn total, completed-turn speed, exact provider values,
  aggregate tool summary, checkpoint summary, body-level portal, placement,
  outside dismissal, and Escape focus return.
- The default panel becomes a short summary: turn/speed values are unboxed,
  provider and tool usage become compact inline rows, and the per-tool rows,
  share bars, source badges, explanatory estimate paragraph, and used-capacity
  meter are removed. The `~` aggregate tool total still signals estimation.
- Decision D244 amends D103 / D184 / ADR 0047. Protocol, storage, runtime
  accounting, and model metadata remain unchanged. See ADR 0103,
  `04-ux/08-component-spec.md`, and E2E-060d / US-UI-61.

## 2026-08-19 — OpenCode-style bounded provider 429 retry

- HTTP 429 is now handled by one runtime-owned policy in both request setup
  and stream recovery. The budget is five retries after the initial request,
  shared across phases and disabled inside pi-ai's nested retry wrapper.
- Retries stay silent and abortable. `retry-after-ms`, `retry-after` seconds,
  and HTTP-date values take precedence over the 2-second exponential fallback;
  positive 25% jitter and a 30-second cap keep the client bounded. Failed
  response status and headers are captured from fetch because pi-ai's ordinary
  response callback does not expose setup failures.
- Main sessions and builtin subagents reuse the visible assistant row and
  suppress intermediate lifecycle/error events. Exhaustion emits one terminal
  `PROVIDER_RATE_LIMITED` error with `retryAttempt: 5` and `providerStatus: 429`;
  aborting during the wait starts no later provider request.
- Authentication, model-selection, malformed-request, and context failures
  remain terminal. Other transient provider failures retained one setup or
  mid-stream retry until D258 gave them their own shared bounded budget.
- Decision D245 amends D186 and D233. See ADR 0091,
  `03-runtime/02-agent-runtime.md` §5d, `03-runtime/08-error-codes.md`, and
  E2E-149.

## 2026-08-19 — Files ships as the first bundled plugin

- Decision D248 implements the first step of D247. Browsing the project is now
  the bundled `pi.files` plugin, reached through `contributes.views` like any
  third-party one, and the host's tool list no longer carries a Files entry.
  Review and Terminal stay built in until their capabilities exist as plugin
  APIs.
- Bundled plugins carry `source: "builtin"`. host-core reconciles its registry
  against the directory Electron reports in `PI_DESKTOP_BUILTIN_PLUGINS_DIR` on
  every launch, so an app update refreshes version and contributions, while the
  two pieces of state the user owns — enabled, and activation scope — carry
  across. They cannot be uninstalled, only disabled, and a plugin dropped from a
  newer build leaves no orphan registry row.
- Only the *tool* migrated. A `file:<path>` tab is a transcript artifact — a
  file link or plan checkpoint the conversation opened — and stays host-owned,
  exactly like Review's artifacts. The same split will apply when Review moves.
- Writing the plugin proved D247's premise immediately: `fs.glob` returns a
  flat, 500-capped file list with no directories and cannot back a lazy tree, so
  `pi.fs.list` was added under the existing `fs.read` permission. It applies the
  same guards as `glob` — declared scope, deny-list, protected paths, skipped
  heavy directories — because a listing is a read; directories are always
  returned so a narrow scope still yields a navigable tree.
- See ADR 0105, `07-plugins/03-plugin-api.md` §3/§6,
  `07-plugins/13-plugin-permissions-matrix.md` §2,
  `04-ux/08-component-spec.md` §5, and E2E-153.

## 2026-08-19 — The builtin command surface is reduced to five core entries

- Decision D250 freezes the first-party registry at `builtin.session.new`,
  `builtin.agent.compact`, and the three `builtin.mode.*` entries. Their only
  builtin composer aliases are `/new`, `/compact`, `/agent-mode`, `/plan-mode`,
  and `/goal-mode`.
- Session deletion, abort, project, settings, plugin, log, rename, command
  palette, reload-window, and DevTools entries are removed from the registry
  and renderer dispatch. The legacy `newChat`, `openProject`, and
  `openSettings` aliases are removed as well. Dedicated UI workflows and plugin
  commands are unaffected.
- Mode aliases keep the one-shot `/mode <prompt>` behavior: mode changes first,
  then the remaining text is sent as the visible user turn. Former aliases are
  no longer supported builtin contracts.
- See ADR 0106, `04-ux/04-builtin-commands.md`, ADR 0024, ADR 0034, and
  E2E-117.

## 2026-08-19 — The panel's built-in interactive terminal is removed

- Decision D251 supersedes D249 and the terminal clauses of ADR 0019/0105.
  The work panel no longer owns an interactive shell; users use an external
  terminal for interactive shell work.
- Browser remains the host-built work-panel tool. Files remains a bundled
  plugin, Review and `file:<path>` remain artifact surfaces, and contributed
  plugin views remain available beside them.
- Agent Bash stays non-interactive and transcript-owned: command, output,
  status, copy behavior, and its terminal icon remain unchanged. The removal
  deletes only terminal-specific PTY UI, IPC, types, dependencies, packaging,
  and tests; the desktop protocol version does not change.
- No plugin PTY permission or bundled-plugin replacement is introduced.
- See ADR 0108, `04-ux/08-component-spec.md` §5, and E2E-058.

## 2026-08-24 — Windows taskbar minimize keeps the taskbar entry

- Decision D252 amends D216 / ADR 0078 for the native Windows taskbar path.
  Clicking the focused window's taskbar button completes the ordinary native
  minimize and keeps the PI-Desktop taskbar entry. Clicking it again restores
  and focuses the window; clicking the entry while the window is merely covered
  keeps the existing bring-to-front behavior.
- Explicit renderer/menu minimize actions remain tray-resident, as do the
  macOS/Linux native minimize paths. The resident tray, background processes,
  window bounds, IPC, and storage contracts are unchanged.
- See ADR 0117, `03-runtime/07-process-model.md`,
  `04-ux/09-interaction-patterns.md`, and E2E-124.

## 2026-08-24 — Renderer-owned queued prompts and graceful Send now

- Decision D253 adds a per-session, renderer-local FIFO queue for prompts sent
  while an agent is running. The queue holds the visible prompt and its draft
  snapshot, supports independent removal, survives session switches, and is
  intentionally not persisted or replayed after restart.
- The composer has one submit slot. While a run is active, a non-empty draft
  renders Send and appends to the queue; an empty draft renders Stop, so the
  user clears the draft to expose the immediate-stop action. After the owning
  session's `agent_end`, the renderer drains one item through the existing
  `agent/prompt` path. Send now promotes one item and calls additive
  `pi-desktop/agent/stop`; the sidecar sets pi-agent-core's one-shot
  `finishTurn` decision, so the current assistant response/tool batch
  completes and the durable turn closes normally before the prioritized prompt
  starts. Immediate abort keeps its current behavior and never clears the
  queue.
- This changes renderer state ownership and adds a public Electron IPC channel,
  but does not change host-core protocol v9, storage schema v11, or the
  one-running-turn constraint. See ADR 0118 and E2E-011f.

## 2026-08-24 — Subagents use event-driven idle and duration timeouts

- Decision D254 replaces the default subagent turn cap with a 600-second idle
  watchdog and a 21,600-second total-duration ceiling. The idle timer resets
  for turn, message, and tool lifecycle events and pauses during tool
  execution; the duration timer includes tool execution. (Amended by D260: the
  idle default is now 300 seconds and every agent event resets the timer.)
- A timeout returns `timed_out` with `SUBAGENT_IDLE_TIMEOUT` or
  `SUBAGENT_DURATION_TIMEOUT`, preserving the latest partial assistant output
  where available. Fatal provider errors, parent aborts, and explicit
  per-definition `maxTurns` remain unchanged.
- `maxTurns` is now optional (`none`, `0`, and omission mean unlimited), with
  explicit values capped at 80. Definitions may override the watchdogs via
  `idle-timeout` and `max-duration` within their documented bounds; invalid
  values warn and fall back to defaults. (Amended by D260: the builtins each
  declare an explicit backstop rather than running unlimited.)
- Builtin `explorer` gains `Bash` for bounded repository inspection while
  `code-reviewer` remains read-only. Shared status types, runtime timing,
  delegation topology, i18n, and E2E coverage expose the new timeout outcome.
- See ADR 0119, `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/08-error-codes.md`, `03-runtime/09-logging-and-observability.md`,
  and E2E-155.

## 2026-08-25 — Collapsing the work panel restores the base window bounds

- Decision D255 supersedes ADR 0033. The renderer still lays the work panel
  out as an in-flow flex column, but requests a native reservation equal to the
  committed panel width before presenting it. Exit keeps the panel mounted
  until the zero-width reservation succeeds, so folding the right panel returns
  the application window to its chat-only bounds instead of letting MainChat
  consume the released column.
- The target-state reservation planner, constrained-display behavior, Browser
  measured-bounds sync, Main-owned native edge resize, and session-scoped panel
  state remain unchanged. See ADR 0122 and E2E-056.

## 2026-08-25 — Window controls use native taskbar minimize

- Decision D256 amends D216 / D252 for Windows/Linux renderer and native-menu
  minimize actions. The custom top-right minimize button now uses the native
  OS minimize transition, so the taskbar entry remains available for restore;
  close-to-tray remains controlled only by the remembered close behavior.
- macOS native minimize stays tray-resident, and the resident tray, close
  preference, IPC shape, host protocol, and background lifecycle are otherwise
  unchanged.
- See ADR 0123, `03-runtime/01-ipc-protocol.md`,
  `04-ux/09-interaction-patterns.md`, and E2E-124.

## 2026-08-27 — Agent capability pages become one workbench

- Decision D257 refines D193 / D194 and supersedes D202's page-shape clause for
  Settings > Agent > Skills / MCP / Subagents. Each page is now one toolbar
  (segmented level filter with counts, one search field, project picker,
  primary actions) above one panel divided by level group headers, and all
  three pages create, edit, and delete through host calls that already existed
  before this change.
- Per-row busy replaces page-wide locking, skeletons are first-paint only, and
  enablement flips optimistically with a revert on host rejection.
- `skills.reveal` now carries `level` and `projectPath` so a project skill with
  no global counterpart resolves; the handler still accepts a bare id.
- Renderer-only apart from that payload widening: no host-core change, no new
  RPC, no storage or schema change. Every capability-state, precedence, and
  `.agents` path rule from D193 / D194 / D202 is unchanged.
- See ADR 0126, `04-ux/06-settings-ia.md`, and E2E-103.

## 2026-08-27 — Release documentation is a version surface (D260)

- Stable app version bumps / tags **must** update every version-bearing
  surface before the tag: the shipped-locale changelog and its test list, all
  workspace package versions (including the previously skipped
  `docs/package.json`), the Cargo workspace + `host-core` lockfile versions,
  `APP_VERSION`, and the release line stated in `README.md` /
  `README.zh-CN.md` (D260, extends D164).
- `scripts/check-release-docs.mjs` verifies the whole set; `scripts/release.mjs`
  invokes it after bumping and refuses to commit or tag on failure.
- Codified in the release runbook §4.1, AI development workflow matrix +
  Definition of Done + forbidden practices, change checklist, and `AGENTS.md`.

## 2026-08-26 — Transient provider failures share a bounded retry budget

- Decision D259 amends D186 / D245 and ADR 0050 / ADR 0091. Non-429 transient
  provider failures now share one bounded budget of four retries after the
  initial attempt across request setup and stream delivery, so an upstream
  gateway 502/503/504 recovers whether it arrives before headers or mid-stream.
  Only the failed request is replayed; the session and its tool state are
  untouched.
- The budget admits `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and retryable
  `PROVIDER_ERROR`. Non-429 delay honors `retry-after-ms`, `retry-after`
  seconds, then HTTP-date before a deterministic 1s/2s/4s/8s schedule, capped at
  8 seconds, and captured headers are kept for every status that can state a
  delay.
- The main session, builtin subagents, and one-shot composer enhancement share
  one policy. The 429 five-retry budget stays separate. Exhaustion records
  `retryAttempt: 4`.
- Authentication, model-selection, malformed-request, and context failures
  remain terminal. No IPC, storage, host protocol, or provider-config change.
- See ADR 0128, `03-runtime/02-agent-runtime.md` §5d,
  `03-runtime/08-error-codes.md`, E2E-096, and E2E-149.

## 2026-08-27 — The subagent idle watchdog bounds silence, not slowness

- Decision D260 amends D254. Every agent event re-arms the idle timer, a single
  streamed token arriving as `message_update` included, so the watchdog fires
  only on total unresponsiveness. A delegate that keeps producing output is
  never idle-terminated however slow its turn is, and the pause across tool
  execution is unchanged.
- Because the window now measures dead air rather than work, the default idle
  timeout drops from 600 to 300 seconds, sized from the measured 174-second
  p99.9 wait between a delegate's last streamed token and its next response
  rather than from how long work may take. It must stay below the 600-second
  `TaskWait` default so a genuinely stuck delegate settles as `timed_out`
  within one wait instead of holding the parent for a full window and beyond.
  The 21,600-second duration ceiling and the 10–21,600 override bounds are
  unchanged.
- `TaskWait` expiry now reports "Still running after Ns" and states that this
  is not a failure and the delegates keep working, so the parent stops reading
  an ordinary unfinished wait as a failed delegation.
- The builtins gain a turn backstop sized to their job — `explorer` 60,
  `code-reviewer` 50, `test-runner` 40, `fixer` 80 — replacing unlimited turns,
  so a delegate that loops without converging ends as `truncated` with its
  partial report rather than running to the duration ceiling.
- No IPC, storage, host protocol, or provider-config change. See ADR 0129,
  `03-runtime/02-agent-runtime.md` §5f, `03-runtime/08-error-codes.md`, and
  E2E-155.

## 2026-08-27 — The mounted transcript is a window, not the loaded history (D261)

- Decision D261 refines ADR 0120 / D258 in the renderer. Those bounded what
  crossed the IPC boundary and what locating a page costs; the renderer still
  mounted every row it had paged in and kept it mounted for the session's life.
- The mounted history becomes a trailing window: 15 rows in the first commit
  after a session switch, a 60-row steady state, grown 40 at a time. Reaching the
  top grows the window while it is partial and fetches an older page only once
  the window covers all loaded history.
- `content-visibility: auto` was already skipping layout and paint for those
  offscreen rows, but it retains their React trees, Markdown ASTs, and Shiki
  token arrays — the wrong resource on a low-memory Windows machine, which is
  where the chat area was reported as progressively less responsive in a long
  session. Windowing bounds retained memory and per-frame reconciliation at once.
- Window growth takes the same pre-paint scroll anchor as a fetched page, because
  both add height above the reading position. The window resets per session and
  is clamped to the loaded history, so a stale budget cannot over-mount. The
  hydration spacer stays scoped to the first commit: a permanent spacer under the
  steady-state window would put a blank viewport in front of the growth trigger.
- The conversation minimap is built from the mounted entries. It resolves a click
  by finding the marker's node in the scroller, so the full set would have drawn
  dashes that jump nowhere. The tradeoff is that the browser's own find-in-page
  only reaches mounted rows.
- No IPC, storage, host protocol, or pagination change. See ADR 0130,
  `04-ux/08-component-spec.md` §8, and E2E-159.

## 2026-08-28 — Large text pastes become session-scratch references (D262)

- Text-only pastes at or below the persisted `largePasteThreshold` remain
  native textarea input; the default is 600 characters and valid values are
  integers from 1 through 1,000,000.
- Larger text is transferred as exact UTF-8 `text/plain` bytes through the
  existing paste bridge and stored under the owning session's
  `<data_dir>/scratch/<sessionId>/pasted/` directory. The Composer inserts a
  generated `@<temporary-name> ` token at the original caret/selection and
  keeps its canonical path mapping in the renderer draft, including cached and
  unanswered smart-Stop snapshots.
- Dispatch resolves the generated token in place exactly once. It is not
  appended as a basename, sent as a duplicate structured attachment, or
  written into the workspace. Existing clipboard file/image chip behavior and
  scratch cleanup remain unchanged.
- The setting is an additive app-settings JSON field; host normalization gives
  older settings the default without a database migration. See ADR 0131,
  `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md` §8.1,
  `04-ux/08-component-spec.md` §11.7–11.8,
  `04-ux/09-interaction-patterns.md` §8a, and E2E-102g.

## 2026-08-28 — A cross-display drag is user intent, not an OS adjustment (D263)

- Decision D263 amends D255 / ADR 0122 in Main. The work-panel reservation is
  planned from remembered base bounds and reconciled against the last rect Main
  applied. That reconcile treated every display change as one `displayChanged`
  boolean and reused the remembered base bounds, which is right for an OS re-fit
  and wrong for a window the user dragged to another display.
- Reported as issue #18 and reproducible on every release from 0.10.0: dragging
  the window across a display boundary made it jump on pointer release. The
  reconcile was wired to each native `move`, so it ran mid-drag and re-planned
  from the origin display's base bounds; the target work area then clamped that
  x to its edge and kept the old display's y. Panel state was irrelevant — a
  closed panel requests width 0 but still re-plans and calls `setBounds`.
- The boolean becomes a `DisplayTransition` of `none`, `os-adjusted`, or
  `user-moved`. `os-adjusted` preserves ADR 0122 verbatim so a constrained
  display keeps the user's intent and a roomy one restores the full reservation.
  `user-moved` derives base bounds from where the window now is, with only the
  origin normalized into the target display's work area. The size is kept even
  on a smaller display, because base bounds are the restorable intent under ADR
  0122 and a shrink would be persisted with no way back; the reservation absorbs
  the shortfall instead.
- Attribution keys off an unaccounted native `move` stream rather than a
  deadline, because Electron exposes no drag-begin/drag-end pair for native
  moves and a deadline would make correctness depend on main-process
  scheduling and on maximized windows that defer geometry. The `move` handler
  only marks the pending drag and defers reconciliation until the stream goes
  quiet, so Main never fights the window server mid-drag. Display topology
  events clear the marker first, so a hotplug right after a drag stays
  OS-owned.
- The same misattribution had been writing stale coordinates to
  `window-state.json`, reopening the window on the display the user had left. A
  `user-moved` transition now advances the remembered display key and persists,
  normalized the same way as the reservation path because a maximized window
  defers geometry and leaves the save as the drag's only consumer, while
  `os-adjusted` still refuses to. An unconsumed marker is retired on a deadline
  so it cannot leak into a later OS display change. A forced Stage Manager recovery clears
  the pending attribution because it is not user intent.
- No IPC, storage, or host protocol change; `window/setWorkPanelReservation`
  keeps its shape. See ADR 0132, `03-runtime/01-ipc-protocol.md`, and E2E-160.

## 2026-08-28 — Composer typing is a measured latency path (D264)

- Per-keystroke lag in the chat composer had three measured causes, all on the
  typing path and none of them a correctness bug. With the `@` menu open, each
  keystroke fuzzy-matched up to the whole workspace file index (8000 entries)
  and then fully sorted every match to display 50 rows; a bounded top-K
  selection now returns the same rows in the same order for 0.25–0.78 ms per
  keystroke instead of 2.4–3.0 ms. `filterCommands` keeps its full sort: the
  command list is small and its comparison is grouped by command kind, where a
  top-K pass buys nothing.
- The auto-resize effect forced a `height: auto` measurement probe on every
  keystroke, and each probe is a synchronous reflow. The probe cannot simply be
  dropped, because it is the only reading that reveals the draft now needs
  fewer rows: at a fixed applied height an overflowing box reports that height,
  not the content's. That is also why reading at the applied height is
  equivalent while the content overflows — the single `scrollHeight` reading is
  then the full content height. The probe is therefore reserved for the case
  where the box may need to shrink: applied height above the minimum and
  content no longer filling it.
- Republishing an unchanged `--composer-dock-height` is not free. The property
  lives on `document.documentElement`, so every `setProperty` invalidates style
  for the whole document, including the transcript. Skipping the write when the
  rounded height is unchanged keeps typing inside one row off that path, and
  height and `overflowY` are written only when the computed value differs from
  what was last applied.
- The remaining cost was React identity churn. `Array.prototype.filter`
  allocates even when it drops nothing, so the reference filters now return the
  existing array unchanged and the draft-cache serialization effect keyed on
  `fileReferences` stops re-running per keystroke; the same no-op guard covers
  the `workspacePath` effect and `clearDraftForKey`. `setCursor` ignores an
  unchanged value because `onSelect` fires on every caret move, which had made
  plain arrow-key navigation re-render the composer and re-run autocomplete
  trigger detection.
- No IPC, storage, host protocol, or schema change, and no new dependency.
  Behavior is unchanged: identical menu rows and order, the same 28px one-line
  floor, and the same seven-row cap. See `04-ux/08-component-spec.md` §11.5 and
  US-UI-55.

## 2026-08-29 — An expanded delegate run scrolls in place (D271)

- Decision D271 refines D201 / D268 / ADR 0062 in the renderer. Opening one
  delegation node inlined the delegate's entire run into the parent transcript,
  so a delegate that made forty tool calls added forty rows at once.
- Three unbounded surfaces were involved. `.subagent-run` had no height limit,
  `.tool-fields` was the only detail block without the 260px cap that
  `.tool-row-content`, `.tool-file-list` and `.tool-match-list` already carried,
  and D268 had routed the joined `TaskWait` reports — bounded at 50k characters
  by the runtime — into a `note`, which has no cap either.
- The scroll deliberately sits on a new inner `.subagent-run-rows` wrapper
  rather than on `.subagent-run`: the collapse rail is absolutely positioned at
  `left: -8px`, outside the run's padding box, so an `overflow` on the run would
  have clipped the rail that marks the delegate-context boundary. The heading
  stays outside the scroll area so the attribution cannot scroll away from the
  rows it labels.
- The scroll area is a labelled, focusable `role="group"`, because a pointer
  user could scroll it and a keyboard user could not otherwise reach it.

## 2026-08-29 — A lifecycle row is a subagent row (D268)

- Decision D268 refines D201 / D265 / ADR 0062 and ADR 0089 in the renderer.
  D265 made every `Task` call a full-width delegation card, but left the three
  lifecycle rows (`TaskWait`/`TaskList`/`TaskStop`) as generic tool rows. Those
  rows are the only place a settled outcome appears — `Task` returns the moment
  the delegate starts and says `running` forever — so they were simultaneously
  the most informative and the least readable part of a delegation.
- The visible defects were narrow. A lifecycle row is called with delegation
  ids, so `getToolSummary` printed a bare UUID list; its result payload had no
  per-tool mapping, so the body fell back to pretty-printed `delegations[]`
  JSON; and its label read "Delegated", which is what `Task` does, not what a
  wait or a stop does.
- The fix reads the roster the runtime already returns. `details.delegations[]`
  (`TaskWait`/`TaskList`) and `details.stopped[]` (`TaskStop`) carry the agent
  name, status and registry timestamps, which is exactly what a reader needs:
  the row summarizes by agent name with repeats counted, badges a rolled-up
  status from the shared `chat.subagentStatus.*` vocabulary, and renders the
  roster as a named field table led by the joined reports.
- Deliberately unchanged: a lifecycle row is still **not** a topology node and
  still must not inflate the subagent counts (`isDelegationActivityItem`), the
  runtime and its `delegationId` contract are untouched, and no IPC, storage or
  host-protocol surface moves. This is presentation only.

## 2026-08-28 — One delegation reads as a card, like a fan-out (D265)

- Decision D265 amends D201 / ADR 0062 in the renderer. That decision reserved
  the delegation card for two or more `Task` calls in one activity group and
  left a lone `Task` as a compact tool row. The same work therefore looked like
  two different features, and the single case — the common one — was the one
  that lost the outcome, the recorded runtime and the delegate's step count.
- Every `Task` call in an activity group now renders as a delegation card: root
  node, connector, one node per delegate. Nothing else about the card changes,
  so the aggregate header, the live-open-once rule, the node disclosures and the
  print-the-report-once rule carry over unchanged.
- The aggregate header is count-aware. English gains `_one` forms for the four
  status labels; Chinese has a single plural category, so its `_other` forms
  carry every count and drop the English plural marker that made a one-node card
  say "1 个 Subagents".
- No IPC, storage, host protocol, or delegation-runtime change: the card is
  still derived on both live and reload from the persisted `parentToolCallId` /
  `agentName` attribution. See ADR 0062 §6, `04-ux/08-component-spec.md` §9.9,
  and E2E-119.

## 2026-08-28 — The titlebar band is reserved on every platform (D266)

- Decision D266 fixes a macOS-only regression on the destination pages. The
  46px band at the top of the main pane is an opaque, absolutely positioned
  `.main-titlebar`, so scrolling route content passes underneath it on every
  platform. Only `win32` and `linux` padded `.page-frame` for it, and that
  reservation was framed as a window-controls concern — macOS draws its traffic
  lights natively, so darwin looked exempt.
- It was not. The band is opaque regardless of who draws the window controls, so
  on macOS it covered the Plugins page header: the title row was clipped and the
  Installed / Marketplace segmented control sat at the window's top edge.
- `.page-frame` now reserves `--ds-toolbar-height` plus an 8px buffer on darwin
  as well, matching what `.thread-content` already did for the transcript on all
  three platforms. The fix covers Plugins, Scheduled, and Pull requests, since
  they share the frame.
- Surfaces that stack above the band keep their current treatment: the plugin
  detail sheet renders at `z-index: 60` and still starts at the top edge, with
  only `win32` / `linux` dropping below the band to clear the window controls.
- Renderer CSS only: no IPC, storage, host protocol, or component-structure
  change. See `04-ux/08-component-spec.md` §2.3 and E2E-087a.

## 2026-08-29 — The project archive is one workbench, not three bands (D267)

- Decision D267 revises D168's presentation for Settings → Project archive and
  adopts the D257 one-workbench composition already used by Skills / MCP /
  Subagents: a quiet intro line, one toolbar, one panel.
- The overview banner is gone. It was a decorative gradient card holding four
  `--text-xl` counter tiles, which the design system forbids outright. The four
  page-level counters go with it: every total they carried is already legible
  from the per-group strip counts in the panel, so restating them above the
  toolbar duplicated numbers and gave the destination a header no sibling page
  has. This retires D168's overview-counter requirement along with the
  `project.statProjects`, `project.statOpen`, `project.statArchived`, and
  `project.statSessions` keys, which are removed from both catalogs. The intro
  is now one quiet description line, matching the capability pages.
- The three per-section panels become one panel: Pinned / All projects /
  Archived are non-interactive in-panel header strips with their counts, so the
  page has one elevated frame and no heading nested inside the list. The
  bespoke sort pill reuses the shared segmented-control primitive, and row
  geometry matches the capability rows (32px controls, 14px list gap, a 28px
  row glyph); the external uppercase section labels are dropped.
- Beyond the four retired counter keys this is presentation only: row anatomy,
  row menu grouping, search matching, the batch-of-eight session reveal,
  activation semantics, and accessibility semantics are all unchanged. No IPC,
  storage, host protocol, or component-ownership change, so no ADR is required.
- See `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`, E2E-038, and
  US-UI-23.

## 2026-08-29 — History continuation keeps the conversation outline reachable (D269)

- Decision D269 amends D108 / D261 / ADR 0130 in the renderer. D261 made the
  mounted history a trailing window and fed the minimap the mounted entries so
  no dash could point at a withheld row. That was correct about dashes, but it
  left the outline with nothing to say about the history it was hiding, and
  D108's visibility rule then removed the rail entirely whenever the mounted
  tail had fewer than two markers or fit one viewport.
- Two transitions make that reachable in normal use. A bounded tail can be one
  tool-heavy turn that collapses below one viewport, and a fetched older page
  can land entirely outside the trailing mounted window. Neither necessarily
  changes `scrollTop`, and the only escalation trigger was a native scroll
  event, so upward travel could stop with older history still on disk and no
  rail to navigate with.
- The outline now stays present while earlier history exists — withheld loaded
  rows (`hiddenAbove > 0`) or an older host page (`hasMoreBefore`) — and carries
  one dotted earlier-history continuation at its top. It is a real control, not
  a message dash: it runs the same two-stage grow-then-fetch path, is disabled
  and labeled while a page is loading, and never claims a message preview.
  Ordinary message dashes are still built only from mounted rows, so D261's
  reachability rule holds exactly.
- Progress no longer depends on a scroll event. The transcript's existing top
  loading row is the observed boundary: while it stays inside the near-top band
  after an underfilled tail, a fetched-but-withheld page, or a window
  transition, the transcript keeps escalating. The near-top scroll check is
  unchanged and now shares one threshold constant with the observer.
- Once no earlier history remains, D108's two-marker-plus-overflow rule applies
  unchanged, so a completed short conversation still shows no rail. Renderer
  only: no IPC, storage, host protocol, or pagination change, and the mounted
  window budgets are untouched.
- See `04-ux/08-component-spec.md` §7 and §8, ADR 0130, and E2E-159.

## 2026-08-30 — One model picker for both credential kinds (D270)

- Decision D270 refines D237 / D240 in the renderer. Settings → Model
  configuration carried two copies of the same model picker: the AI service
  dialog had the full one, and the vendor account dialog had a reduced copy of
  it that had drifted.
- The copy shared the list and the `ModelBinding` shape but had no Advanced
  disclosure, so an account's per-model context window, max output and thinking
  levels were not editable, and it had no explicit binding persistence — an
  account could not configure the same model capabilities as an AI service.
- One shared renderer component now owns row merging, filtering, selection, the
  custom-model entry, the chosen pane, the Advanced disclosure and the
  explicit model-binding persistence. Both dialogs render it; only the left
  pane heading differs, and the vendor dialog additionally passes its saving
  state. The account dialog grows to the provider dialog's two-pane size and the
  duplicated chosen-pane / custom-model CSS is deleted. D283 later supersedes
  the catalog-gating clauses for thinking levels.
- Renderer only: no IPC, host protocol, storage, or provider-config schema
  change, so no ADR is required. The single user-visible change is that vendor
  accounts now offer the same per-model advanced controls and explicit binding
  persistence as AI services.
- See `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md` §19,
  `03-runtime/11-provider-model-system.md` §10, and E2E-162.

## 2026-08-30 — Quitting stops plugins as a shutdown, not as a crash (D272)

- Decision D272 refines spec 07 §3.1 in the main process. `before-quit` disposed
  the plugin *watchers* and left the host child processes to be killed by the
  process teardown that followed.
- An exit nobody announced is indistinguishable from a crash. Nothing set
  `disposing`, so the guard at the top of `handleChildExit` never applied and a
  normal quit ran the crash path per plugin: a `PLUGIN_CRASHED` error log at
  `exitCode: 0`, a "stopped unexpectedly" toast, and `superviseCrash` scheduling
  restarts into an app that was closing. The toast arrived twice, because the
  runtime and the `onPluginCrash` handler each sent one for the same event.
- The cost was diagnostic. In one local profile 613 of 633 crash reports were
  this, all within five seconds of `app shutdown`, which left the 20 real ones
  effectively invisible.
- `disposeAll()` now owns quit: mark every plugin disposing and cancel its
  pending restarts first, in one pass, so a child that dies while a sibling is
  still stopping is already covered; dispose watchers; then stop services and run
  `onUnload` in parallel across plugins. The sequence is bounded — 1.5s per
  `onUnload` (shorter than the 5s an explicit unload gets, because the user has
  asked the app to close) and 3s overall, after which the children are killed
  outright. The duplicate toast in `onPluginCrash` is deleted.
- Main process only: no IPC, storage, host-protocol, or manifest change, so no
  ADR is required. Plugins gain one guarantee they did not have — `onUnload` runs
  on quit — and the user stops seeing failure toasts on every clean exit.
- See `07-plugins/05-plugin-lifecycle.md` §3.1.

## 2026-08-30 — A model's habitual argument name is accepted, not corrected (D273)

- Decision D273 refines spec 03 §4 in the agent runtime. The tool schemas named
  `path` and `pattern`; models sent `file_path` and `query` anyway.
- The numbers made it a design problem rather than a model problem. Of 1679
  failed tool calls in one local month, 852 were a parameter-name miss. 724 of
  those were `Read` called with `file_path` — 87% of every `Read` failure, and
  enough on its own to put `Read`'s error rate at 11%. `Write` (55), `Edit` (56),
  `Grep` (13), and `Glob` (4) repeated the pattern with the same two aliases.
- An argument name is a pretraining habit, not something a description can talk a
  model out of. The rejection also came from the validator before the call
  reached the host, so the turn was spent on an error the model had no way to
  anticipate and, from its side, no reason to expect.
- `Read`, `Write`, `Edit`, and `BrowserPreview` now accept `file_path` beside
  `path`; `Glob` and `Grep` accept `query` beside `pattern`. Both spellings are
  optional in the schema so either one validates, and the runtime folds the alias
  onto the canonical name before anything downstream sees it — the write-lock
  key, the `tools.execute` args, and the persisted transcript carry canonical
  names only, so nothing below this line learns two spellings. Exactly one of
  each pair is required; the canonical name wins when both arrive.
- `Bash.timeout` had a second version of the same problem: 69 failures were a
  timeout in milliseconds (600000, 900000, 1800000) against a field capped at 300
  seconds. The schema maximum widens to 3600000 — above the largest value
  observed, 1_800_000 — so a millisecond value validates at all, and the runtime
  reads a value of at least 1000 as milliseconds, clamped to the honoured
  300-second ceiling. The threshold
  is 1000 rather than 300 deliberately: something like 301 is far more likely a
  seconds value that overshot the cap, and rewriting it to 0.301s would be worse
  than the error it earns today.
- Runtime only: no IPC, storage, or host-protocol change. host-core's schemas and
  its argument parsing are untouched, because the runtime normalizes above them
  and `tools.list` has no other consumer.
- See `03-runtime/03-tools-and-permissions.md` §4.

## 2026-08-31 — Retry an unchanged edited prompt (D274)

- Decision D274 amends D137 in the renderer. Confirming a valid user-prompt
  edit now always dispatches the existing edit-resend/Regenerate path, even
  when the trimmed text is identical to the original.
- The inline controls say Retry and Cancel in the active locale. Retry keeps
  the existing revision archive, identity-based truncation, slash-command
  expansion, and attachment behavior; Cancel and Escape leave the prompt
  untouched.
- Renderer and i18n only: no IPC, storage, host-protocol, or runtime contract
  change. See ADR 0135, `04-ux/08-component-spec.md`, and E2E-073.

## 2026-08-31 — Preserve the active task boundary across context compaction (D275)

- Decision D275 amends D203 / ADR 0064 in the agent runtime. Checkpoints now
  persist an opaque `details.retainedTailMode` boundary.
- While a provider must continue an active tool turn, the checkpoint retains
  only the latest user message, bounded by the existing 20,000-token limit. At
  a completed turn boundary, before a new prompt, or for manual compaction, it
  retains no naked historical user messages; the summary is authoritative and
  the next prompt is the new task.
- Legacy checkpoints without the mode normalize to their latest user message.
  The visible transcript, host-owned storage, and protocol shape are unchanged.
  See ADR 0136, the runtime/storage/tool-result specs, and E2E-164.

## 2026-08-31 — A visited session keeps its own mounted pane (D276)

- Decision D276 amends D162 and ADR 0130 clauses 4–5. The chat surface mounts
  one pane per recently visited session, bounded to three, so switching is a
  visibility swap instead of re-pointing one transcript at different data.
- A warm switch reveals the destination pane with its own scroll position on the
  first frame. A cold switch keeps the current pane fully legible under the thin
  progress track with the composer inert; the opacity dim is removed.
- First activation still settles at the newest turn; a revisit restores that
  pane's offset. Hidden panes keep their layout box, stay inert, and perform no
  follow scrolling, pagination, or measurement.
- Renderer only: no IPC, storage, host-protocol, or runtime contract change. See
  ADR 0137, `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  E2E-011, E2E-071d, and E2E-071g.

## 2026-08-31 — Concurrent subagents may message each other directly (D277)

- Decision D277 extends D201 / ADR 0062 / ADR 0089 without amending them. A
  session-scoped mailbox lets concurrent delegates exchange bounded text through
  one opt-in tool — `Peer(action=...)` — declarable in a definition's `tools:`
  list. The `action` parameter selects the operation: `send` (with `to?`,
  `text`, `topic?`, `inReplyTo?`), `inbox` (with `from?`), or `wait` (with
  `timeoutSeconds?`, `from?`). The three operations were originally three tools
  (`PeerSend` / `PeerInbox` / `PeerWait`); ADR 0140 folded them into one tool so
  peer messaging counts and reads as a single capability.
- It exists because the parent writes every brief before any delegate starts, so
  it cannot always know the directions are independent. The path lock prevents a
  torn write but not a stale premise, and relaying notes through a parent that
  is blocked in `TaskWait` would spend the context delegation exists to protect.
- Opt-in and default-off: no builtin declares `Peer`, so every existing
  definition keeps ADR 0062 isolation. A definition declaring only `Peer` and no
  working tool is refused at `Task` time.
- Addressing is by agent name, never delegation id; the sender is bound by the
  runtime at spawn, so `from` is not a model input. The `Peer` tool is built per
  delegate and stays out of the session tool catalog, so the parent has no
  second channel to its delegates.
- Messages are in-process: no `permissionScope`, no host-core call, no tool
  budget. Bounds are 2,000 characters per message, 64 messages per inbox
  (oldest dropped, loss reported), 60 sends per run, and a 120-second wait
  ceiling below the 300-second idle watchdog. Draining is destructive.
- Peer traffic never enters the parent's model context, and a delegate is told
  its report remains the only thing the parent reads. No cross-session
  messaging, no messaging with the parent, no nested delegation, no durable
  history.
- Runtime and shared only: no IPC, storage, host-protocol, or renderer change,
  and no `AgentEventEnvelope` change — a peer message is already a delegate tool
  call attributed by `parentToolCallId` and `agentName`. See ADR 0138, ADR 0140,
  `03-runtime/02-agent-runtime.md` §5f.2, and E2E-165.

## 2026-09-01 — Subagent model selection (D278)

- Decision D278 extends D201 / ADR 0062 / ADR 0089 in the agent runtime and
  provider-model system. The `Task` tool gains an optional `model` parameter
  (`"provider/modelId"`) that overrides the delegate's frontmatter pin for that
  run. Resolution priority: Task.model → definition frontmatter pin → session
  model.
- `ModelBinding.availableForSubagents` (boolean, default false) is an opt-in
  flag on provider model bindings. When enabled, the model appears in the
  delegation catalog injected into the parent agent's system prompt. The parent
  sees a model summary listing all available delegation models.
- When the parent specifies a model that is not configured or not enabled for
  delegation, the Task tool returns a tool error listing available models. An
  exact repeat of the current session provider/model is treated as inheritance,
  equivalent to omitting `model`, so an empty delegation catalog does not turn
  the parent model into a false unavailable-model error.
- Implementation clarification (2026-09-13, ADR subagent-model-opt-in):
  `subagentProviders` may contain definition-only pins and is not an override
  allowlist. The additive `subagentModelKeys` launch field carries opt-in
  separately, defaults to empty, and participates in runtime reuse matching.
  Only launch opt-in keys enter that reuse snapshot. Successfully authorized
  on-demand results use a separate cache, must not overwrite a pin with a
  different provider id, and do not retire an idle runtime. Repeating a
  definition's own pin key is omit. On-demand matching uses unique provider
  lookup. The Task catalog discloses each definition's default model.
- Scope clarification (2026-09-15, issue #386): the opt-in governs every entry
  point through which the AI picks a model for delegated work, not only
  `Task.model`. A `session/collaboration/spawn` `modelKey` naming a model
  without the opt-in is refused with `PERMISSION_DENIED` before a worker is
  created; omitting the key, or naming the default model's own key, remains
  inheritance. `models.list` still reports every ready model with its flag —
  the flag advises the caller and is authoritative only in Electron main.

- Models not pre-resolved at sidecar launch are resolved on-demand via the
  `provider.resolveSubagentModel` RPC to Electron main, where credentials and
  the models.dev snapshot live.
- See `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/11-provider-model-system.md` §7, and E2E-166.

## 2026-09-01 — Native window edge resize settles before recovery (D279)

- The main window keeps Electron's native edge and corner resize ownership on
  every platform, including the frameless Windows/Linux shell, with the
  existing 1040×700 minimum. Renderer drag regions do not replace OS hit
  testing or introduce a second resize path.
- Bounds recovery waits for a 300ms stable native bounds snapshot before it can
  restore a tiny/shelved window. Normal base bounds remain debounced by 600ms
  after the last resize/move event, while close still flushes the latest stable
  state. A panel reservation's expected `setBounds` result is excluded from
  cross-display user-move attribution.
- No IPC, storage, host protocol, or renderer resize contract changes. This
  refines D156/D163 and is covered by E2E-167.

## 2026-09-01 — Expanded sidebar width is user-resizable (D280; superseded by D408)

- The expanded sidebar owns a persisted preferred width with a `240..520px`
  clamp and a `275px` default. The right-edge renderer handle previews width
  from the pointer-down position, lets MainChat reflow continuously, and saves
  only on pointer release.
- The handle is a vertical ARIA separator. ArrowLeft/ArrowRight adjust it in
  16px steps, Home and End select the bounds, and keyboard changes commit
  immediately. Escape, pointer cancellation, lost ownership, and unmount roll
  back an in-progress pointer gesture to its starting width.
- Sidebar collapse remains independent from the preferred expanded width. No
  IPC, native-window bounds, work-panel reservation, or project/session order
  contract changes. See ADR 0141 and E2E-168.
- D408 later pinned the live shell at 275px and hid the handle. D459 / ADR 0290
  restores the resizable handle and adds collapse below 160px.


## 2026-09-01 — Non-loopback HTTP MCP endpoints are supported (D281)

- User-owned and plugin-declared MCP servers accept absolute `http://` and
  `https://` URLs, including trusted LAN addresses. Unsupported schemes and
  malformed URLs remain invalid.
- The user MCP editor shows an explicit unencrypted-connection warning for
  non-loopback HTTP. Plugin-declared endpoints still require
  `mcp.server.remote` and a host covered by `manifest.net.domains`.
- The MCP client turns off automatic redirects, limits the chain to five hops,
  accepts only HTTP(S) targets, and re-checks the plugin egress policy for every
  hop. A redirect to an undeclared host is blocked before the next request.
- Marketplace catalog and package download rules remain unchanged: non-loopback
  HTTP package downloads are still refused. See ADR 0142 and E2E-024K/E2E-100.

## 2026-09-01 — User-renamable task titles (D282)

- A task name is session metadata and can be edited from the Sidebar session
  overflow/right-click menu or the Project archive task row. Both entry points
  open the same localized modal editor with focus management, Escape/Cancel
  dismissal, and a 1–80 Unicode code-point input bound.
- The existing `session.rename` IPC/RPC path validates and trims the title at
  the host boundary, returning `INVALID_PARAMS` for blank or overlong values.
  A successful rename updates only `sessions.title`; it does not update
  `updated_at`, transcript data, message count, project binding, empty-session
  state, or historical notification title snapshots.
- A custom title continues to suppress first-prompt automatic title generation.
  The current summary is projected consistently in the Sidebar, topbar, Project
  archive, and search after save and after restart. See ADR 0143 and E2E-021a.

## 2026-09-01 — User-configurable thinking-level overrides (D283)

- `ModelInfo` remains the raw models.dev record. An existing `ModelBinding` no
  longer overwrites its published reasoning fields or capability tags, so a
  catalogued reasoning model remains visible as such in Settings.
- Settings always renders the seven canonical thinking levels. Published levels
  seed new known-model bindings; unknown and catalogued non-reasoning models
  show the same choices unselected and can be explicitly enabled for a
  compatible endpoint.
- The exact model binding owns effective thinking capability. Its explicit
  levels are preserved at save time and used by Composer, Electron main, and
  the sidecar without intersecting them with the catalog. Empty or `off`-only
  bindings resolve to `off`; there is no automatic reasoning inference. No IPC,
  storage, or host protocol change. See ADR 0144 and E2E-005/E2E-050/E2E-162/
  E2E-163.

## 2026-09-01 — Settings rail uses a compact label scale (D284)

- Settings navigation uses short, parallel destination labels: General, AI,
  Shortcuts, Instructions, Models, Skills, MCP, Subagents, Import, Projects,
  and Info. The Chinese locale uses the corresponding concise labels 常规、AI、
  快捷键、指令、模型、技能、MCP、子智能体、导入、项目 and 信息.
- Visual clusters are named Preferences, Agent, Workspace, and System
  (偏好、智能体、工作区、系统). Destination IDs, order, search behavior, and
  content ownership remain unchanged.
- Rail labels may stay shorter than the descriptive selected-page title, such
  as Model configuration or Project archive, so the navigation stays aligned
  without removing context from the content pane.

## 2026-09-01 — Native macOS Intel release lane (D285)

- D285 extends D126 and ADR 0145. Tag builds now use `macos-15` for arm64 and
  `macos-15-intel` for Intel x64, alongside the existing Windows x64 and Linux
  x64 lanes.
- The static macOS targets expose DMG and ZIP without a fixed architecture;
  each native runner passes the matching electron-builder flag and builds the
  Rust host sidecar locally. The workflow rejects a runner architecture that
  does not match the matrix entry.
- macOS updater feeds are renamed per architecture before artifact upload and
  merged into one `latest-mac.yml` during publication. macOS remains
  notify-and-link until a signed in-app channel is qualified.

## 2026-09-02 — Work panel outer and inner resize ownership (D286)

- With the right work panel open, the outer native right edge and right corners
  resize the panel target (`244..720px`) while preserving the base conversation
  width. Main previews and commits that target through an Electron-local event;
  left and other native edges retain base chat resizing.
- The inner renderer divider resizes the base conversation width through the
  bounded `window/setWorkPanelChatWidth` channel (`1040..10000px`) while the
  panel reservation remains unchanged. Pointer updates are serialized and
  cancellation restores the press-time target.
- This is an Electron-local behavior change; the host protocol remains v9.
  See ADR 0146 and E2E-056/E2E-167.

## 2026-09-03 — Transcript settle veil and pre-paint follow (D287)

- A session whose first commit is bounded (history above the initial mount
  budget) mounts under an opaque skeleton veil in that same commit. The veil
  covers the transcript scroller only; the docked composer stays visible and
  usable. It lifts once the scroller's `scrollHeight` and `clientHeight` have
  read the same for three consecutive frames, or after a 600ms cap, and fades
  over 160ms. Each sampled frame re-pins a pinned transcript so the revealed
  frame is at the newest turn. The minimap and jump control mount after the
  veil lifts. Short transcripts never show it.
- Pinned follow re-pins inside the content ResizeObserver callback, before the
  browser paints, instead of requesting a frame from it: the requested frame
  landed after the grown content had already painted unpinned once. The
  content is observed on its border box so the composer's published bottom
  reserve (padding) is a follow trigger too; the scroller itself is observed
  so viewport resizes keep the bottom in view.
- Sending clears the composer before the host round trip and restores the
  draft if the store rejects the send; text typed after a failed send is never
  overwritten. The send reads the textarea's live value, and the two silent
  refusals (model not configured, paste still saving) now surface a toast.
  See E2E-071i.

## 2026-09-03 — User row inserted before the host round trip (D288)

- The user's prompt appears in the transcript in the frame it is sent, not
  when the host echoes it. Before this the row waited on the host's turn setup
  (runtime launch, `session.beginTurn`, attachment preparation, persistence)
  and a slow host left the transcript unchanged for visibly long after Enter.
- The renderer mints the message id (`crypto.randomUUID()`), inserts the row
  under it (`optimisticUserMessage`), and sends the id as
  `AgentPromptRequest.messageId`. The host persists and echoes the durable row
  under that id when it is a UUID the session does not already hold, otherwise
  it mints its own. The echo therefore upserts the optimistic row in place; a
  durable read that already holds the echo wins over it, and one that does not
  yet hold it keeps the row visible (`mergeLiveSessionMessages`).
- The optimistic row shows the typed text and its file references under their
  source paths; the echo brings the expanded slash body, the `command` chip,
  session-scoped attachment refs and revision metadata.
- Withdrawal: when the send never reached the host (rejected by a pending plan,
  or the IPC failed) the renderer removes its own row object only, so a failure
  after persistence leaves the durable echo in place next to the error row.
  Smart stop already treats the row as the sent prompt and pulls it back into
  the composer. A visible session inserts into `messages`; a background session
  (queued prompt draining) inserts into its renderer cache, where the echo
  lands too.
- Edit-resend follows the same path: the rewritten prompt replaces the old row
  immediately and the host echo settles it. See E2E-071i.

## 2026-09-03 — Explicitly disable application keyboard shortcuts (D289)

- Application shortcut overrides have three states: an absent property uses the
  platform default, a valid portable binding string customizes it, and explicit
  JSON `null` means `Unbound` and dispatches nothing. Invalid strings retain the
  existing safe fallback to the default.
- Settings exposes Disable separately from Restore default and renders a
  localized Unbound state. Unbound actions do not participate in conflicts and
  remain editable. The shared state drives renderer matching, macOS menu
  accelerators, and the global plugin launcher.
- Unbinding `openPluginLauncher` unregisters any prior Electron global shortcut,
  disables the Windows host hook, and removes the focused-window fallback. The
  host hook starts disabled until Electron applies the effective settings.
  Configurable macOS native-role menu items become role-less clickable items when
  unbound so Electron cannot restore their default accelerator.
- The existing settings JSON, IPC methods, protocol version, storage schema, and
  plugin-local shortcut contract remain unchanged. See ADR 0148 and E2E-072.

## 2026-09-04 — Calm running status motion in the transcript (D290)

- Replace the high-contrast text shimmer used by the Working indicator and live
  activity labels with static readable text plus compact status markers. The
  pre-stream Working indicator uses three small staggered dots; active activity
  labels use one small pulse marker, while tool spinners and the existing
  assistant streaming rail retain their state feedback.
- The marker pulse is compositor-friendly, capped at a one-second loop, and is
  disabled under `prefers-reduced-motion`; the status remains visible as static
  text and dots. No protocol, storage, or runtime behavior changes. See ADR
  0149 and E2E-053/E2E-083.

## 2026-09-04 — Replace the empty-home mascot sprite with a calm inline agent mark (D291)

- Replace the randomized raster pose atlas in the empty-home hero with a 100px
  inline SVG containing a compact neutral agent, a thin orbit, and one signal
  point. The core breathes slowly and the eyes blink occasionally.
- The mark is deterministic and decorative. Pointer hover does not alter its
  cadence or geometry; reduced motion freezes its CSS animation while keeping
  the same size, placement, and semantic colors.
- No protocol, storage, or runtime behavior changes. See ADR 0150 and
  E2E-046/E2E-099/US-UI-17.

## 2026-09-04 — Keep the work panel inside the fixed application window (D292)

- The work panel remains an in-flow right column. Opening and collapsing it
  animates flex allocation inside the existing client area instead of expanding
  or shrinking the native BrowserWindow.
- The renderer-owned inner divider adjusts the persisted `244..720px` panel
  width; native window edges resize only the application window and never rewrite
  the panel preference. Escape, cancellation, and lost pointer capture restore
  the press-time panel width.
- The `window/setWorkPanelReservation` seam is retained for compatibility but
  normalizes every valid request to `{ requested: 0, reserved: 0 }`. The native
  Browser view still follows the renderer-measured panel rectangle. See ADR
  0151 and E2E-056/E2E-160/E2E-167.

## 2026-09-04 — Play an eight-frame waving mascot on empty home (D293)

- Replace the empty-home inline SVG agent mark with a processed eight-frame
  GIF in the existing 100px slot. The loop holds the idle frame briefly, then
  plays the wave; pointer hover does not change cadence.
- Reduced motion swaps the GIF for the still first-frame PNG through CSS. The
  mark stays decorative with no random selection, JavaScript timer, or hover
  state.
- No protocol, storage, or runtime behavior changes. See ADR 0152 and
  E2E-046/E2E-099/US-UI-17.

## 2026-09-04 — Theme-specific empty-home mascot GIFs (D294)

- Replace the single empty-home mascot GIF with dedicated light and dark
  eight-frame assets plus matching still PNGs. CSS follows
  `document.documentElement[data-theme]`; anything other than `light` uses
  the dark pair.
- Reduced motion still swaps to the first-frame PNG of the active theme.
  Playback, hover, and decorative role are unchanged.
- No protocol, storage, or runtime behavior changes. See ADR 0152 and
  E2E-046/E2E-099/US-UI-17.

## 2026-09-04 — Notification inbox lists failures only (D295)

- The sidebar-footer inbox renders only `task.failed` rows, and its unread
  badge counts only unread failures. Routine successful completions had
  buried the rows that actually need attention.
- Host-core still persists `task.completed` rows unchanged. They continue to
  drive the sidebar session outcome badge and the unfocused-window native
  notification; only the inbox popover filters them out at the renderer
  boundary (`inboxNotifications` / `inboxUnreadCount`).
- Mark-all-read and clear still operate on the full durable record, so hidden
  completions are read or removed together with the visible failures. No
  protocol or storage changes. Supersedes only the "task completion rows"
  clause of D117.

## 2026-09-04 — Extensions page draws no dividers (D296)

- The Extensions destination replaces every in-flow rule with tone and
  spacing: the header and toolbar lose their bottom borders, the segmented
  tabs sit on a tinted pill track with the active tab raised by shadow, and
  the installed index is a stack of soft tiles under each group label instead
  of one hairline-separated panel. Marketplace source settings, category
  chips, cards, empty states, the row detail block and the detail sheet's
  install strip and sections follow the same three-layer scheme (page, tile,
  raised). Chips that carried inset rings are filled instead.
- Hairlines remain only on floating layers — row and page menus, tooltips,
  the detail sheet and dialogs — where an edge is an elevation cue rather than
  a partition. The menu group separator becomes a gap.
- The detail sheet reserves the titlebar band on every platform, not only
  Windows/Linux: the route surface keeps a transform after its entry
  animation, so the sheet's fixed layer stacks inside the route and the band
  painted over its title row on macOS.
- Capture rig: the plugins fixture is re-seeded after the page mounts (the
  mount refresh had been replacing it), the marketplace search and detail
  calls are stubbed while seeded, and `pi-plugins-row-details` /
  `pi-plugins-sheet` scenes are added. No protocol, storage, or runtime
  behavior changes. Refines the Installed-tab clause of D169 and §3.5 of the UI
  IA.

## 2026-09-05 — Scrollbars show only on hover or while scrolling (D300)

- Every renderer scroll container now uses the one quiet scrollbar defined in
  `base.css`: 8px, trackless, thumb transparent at rest. The thumb is painted
  only while the owning scroller is hovered (`:hover::-webkit-scrollbar-thumb`)
  or carries `data-scrolling`, and strengthens under the pointer or while
  dragged. Previously the global thumb was always visible at 16% ink and only
  the two sidebar lists hid it at rest (D147, E2E-157).
- `lib/scrollbar-reveal.ts`, installed from `main.tsx`, supplies the state CSS
  cannot express: a passive capture `scroll` listener on `document` marks the
  element that scrolled with `data-scrolling` and clears it 800 ms after its
  last scroll event; a viewport scroll marks `<html>`. Programmatic scrolls
  (pinned-follow while streaming) reveal the thumb too, matching macOS overlay
  bars. Disposal clears every mark it set.
- Partials no longer set `scrollbar-width` or `scrollbar-color` (ask-tool
  options, sub-agent rows, tool fields, sidebar lists). WebKit and Chromium
  ignore `::-webkit-scrollbar` on any element that sets either, so those
  surfaces had been rendering an always-visible native bar instead of the
  custom one. The sidebar lists keep their 6px width, 20% ink, and
  focus-within reveal on top of the global rule; the code-block override is
  removed as redundant. `interaction-polish.test.mjs` asserts the rest/reveal
  rules and the absence of the standard properties;
  `scrollbar-reveal.test.mjs` covers the mark lifecycle. Supersedes the
  scrollbar clause of D147 and generalises the sidebar treatment in the UI
  design system §sidebar. No protocol, storage, or runtime behavior changes.

## 2026-09-05 — Divider-free surfaces across the app (D297)

- Extends D296 from the Extensions page to every renderer surface. In-flow
  strokes — panel rings, card outlines, row and section dividers, left rails,
  form-field borders, inset hairline chips, the sidebar footer and rail seams,
  the work panel's edge and header rules, the composer's elevation stroke —
  are replaced by three tonal layers plus spacing: page, `--ds-tile`
  (3.5% text mix; hover 6%, deep 8%) and `--ds-raised` with
  `--ds-raised-shadow`. The tokens live in `tokens.css`; the D296
  `--plugins-*` variables alias them.
- Lists become stacks of tile rows with a 2–6px gap (settings rows, shortcut
  map, capability pages, provider and model rows, project archive, session
  import, notification inbox, version history). Selection (theme and language
  cards, segmented controls, level filters) is a raised pill or tile plus the
  existing check; no selected border. Form controls are tile fills with an
  accent focus ring. Markdown loses code-block, table, blockquote and heading
  rules (zebra rows, tile plates, spacing). Subagent trees draw connectors as
  2px tinted bars on a tile group with raised nodes.
- Floating layers keep their edge: menus, popovers, autocomplete, the search
  dialog, dialogs, tooltips, toasts and hover cards retain
  `0 0 0 0.5px border-default` plus shadow, but rules inside them are gone.
  Control affordances (switch focus ring, scrollbar padding, spinner strokes,
  status-dot knockouts) are not dividers and stay.
- The theme-card check glyph takes `--ds-bg-primary` ink instead of `#fff`,
  which was invisible on the white dark-theme accent. Style tests assert the
  new scheme per file. No protocol, storage, or runtime behavior changes.
  Supersedes the stroke rows of §6.4 in the UI design system and the D148
  0.5px field stroke.
## 2026-09-05 — Streaming replies are checkpointed and recovered (D299)

- The assistant reply currently streaming in a session is checkpointed by
  Electron main to host-core at most every 1.5 s (`session.saveInflightMessage`)
  into `sessions/<id>.inflight.json`, one atomically replaced file per session.
  Previously a reply became durable only at `message_end`, so an app quit,
  sidecar crash, or restart mid-reply lost the whole text the user had already
  watched stream; after relaunch the session showed only the prompt.
- The checkpoint is transient. The final row of the same id removes it, a
  `completed`/`error` turn end removes it, and the host boot sweep plus a
  sidecar-loss `session.endTurn { recoverInflight: true }` promote a leftover
  whose final row never landed into the transcript as the turn's `aborted`
  assistant row. A user Stop leaves it for the arriving final row. A late
  checkpoint for an already-indexed id is dropped. Delegate replies are not
  checkpointed.
- Quit flushes the checkpoints, aborts active turns through the sidecar, and
  waits (bounded, 2 s) for their aborted rows to drain before host-core is
  disposed. The sidecar used to be killed while host-core was already closing.
- Renderer Stop no longer rewrites the transcript to settle a started reply;
  it settles in memory and leaves the durable copy to the runtime's aborted
  final row. That rewrite raced the outbox append and could delete the reply
  it was meant to keep, and it wrote the renderer's display-capped rows back
  over the full ones. The unanswered-prompt undo (and message delete) now
  rewrite from the full durable transcript merged with the live rows, and the
  undo is re-evaluated on that merge. ADR 0153, E2E-171.

## 2026-09-05 — Composer drafts survive remounts and window switches (D301)

- Composer drafts stay in renderer memory per session, but the cache is now a
  module-level map rather than a `useRef` inside one Composer instance. Home
  and docked composers still remount when the empty state toggles, and
  `ChatSurface` still unmounts when leaving chat for Settings/Plugins/other
  pages; those remounts previously dropped the in-memory Map, so unsent input
  vanished on a window/page switch (issue #38).
- The next mount hydrates from the same slot. Unmount (layout cleanup),
  session switch, file-reference changes, and window blur/visibility-hidden
  capture the live contenteditable value so a keystroke that has not
  re-rendered yet is not lost. If Chromium wipes the contenteditable while the
  window is in the background, focus/visibility restore paints the cached
  value back. Home file references are keyed by the empty session id, not the
  `__home__` cache key.
- A successful send still clears only the submitting session's slot; deleting
  a session still drops its slot; nothing is written to disk.
  `composer-draft-cache.ts` plus `composer-draft-cache.test.mjs` cover
  isolation, prune, remount, and Composer wiring. Extends E2E-011c. No
  protocol, storage, or runtime behavior changes.

## 2026-09-05 — An expanded delegate run follows its latest output (D302)

- Decision D302 refines D271 / D071 in the renderer. D271 put a delegate's
  nested rows in a bounded `.subagent-run-rows` scroller so expanding a
  forty-call run would not grow the parent transcript, but that scroller had
  no stick-to-bottom. A live card therefore stayed at the offset it had when
  opened while thinking, tool, and answer rows appended below the viewport
  (issue #37).
- The nested scroller now uses the parent transcript's pinned-follow
  contract independently: expanding pins to the newest row, content growth
  follows the bottom while pinned, and the first real upward gesture pauses
  follow and shows a nested jump-to-latest control. Layout clamps and
  programmatic `scrollTo` never count as that gesture. Native overflow
  anchoring is disabled on `.subagent-run-rows` so it cannot fight pinned
  follow.
- The jump control overlays a relative wrapper around the scroller, never
  `.subagent-run`, so the absolutely positioned collapse rail stays
  unclipped. Presentation only: no IPC, storage, host-protocol, or runtime
  change. E2E-173.

## 2026-09-05 — New sessions start at the binding default thinking level (D303)

- Settings already persists `ModelBinding.defaultThinkingLevel` and E2E-163
  requires that value to be the level a new session starts at. The home draft
  Composer chip and `persistSessionAndSelect` instead seeded
  `highestSupportedThinkingLevel`, so a user who chose Low still opened every
  new session at Max (or the strongest enabled level). Launch-time fallback
  could never reach the stored default because the session row already carried
  that strongest level.
- New drafts and newly persisted sessions now take the selected model's
  binding default, clamped onto the enabled ladder. Strongest-enabled remains
  the fallback only when the binding has no stored default. Switching models
  on a draft without an active session also reseeds from the new model's
  default; an existing session still preserves its current level when the new
  model supports it.
- No protocol, storage, or runtime clamp change. Existing session rows keep
  their stored `thinkingLevel`. Supersedes D153. See E2E-082 / E2E-163 /
  E2E-174.

## 2026-09-05 — New Task reveals the empty destination before host IO (D305)

- New Task used to await `session.list`, `session.create`, another
  `session.list`, and `session.get` before leaving the previous transcript.
  That chain made the click feel stuck: the old conversation stayed on screen,
  then jumped to empty. The list refresh existed only so a first message sent
  moments earlier would not look empty; the renderer already knows that case
  from `runningSessions`, live rows, and submitted drafts.
- Creating a session now clears the previous conversation on the first frame
  and inserts the durable row from the `session.create` summary. Reusing the
  group's latest empty session commits an empty transcript on that same frame.
  Send and paste wait for the in-flight create instead of opening a second
  slot; keystrokes typed on the empty home during create move onto the new
  session.
- Decision D305 amends D252 / ADR 0113 timing only. The reuse rule, durable
  empty slot, and protocol/storage versions are unchanged. ADR 0154,
  E2E-011a / E2E-011d / E2E-011g.

## 2026-09-05 — Startup splash shares the macOS sidebar glass (D304)

- On macOS the boot splash (`.startup-splash`) drops its opaque
  `--ds-bg-primary` fill for the sidebar glass recipe: `--ds-sidebar-glass-tint`
  plus the top/bottom sheen gradients, over the window's native `under-window`
  vibrancy. The shell mounts under the splash as soon as `ready` flips, ahead
  of the minimum dwell; behind glass it would bleed through the tint, so on
  darwin the shell stays `visibility: hidden` while the splash is loading and
  fades in with an opacity transition (not an animation, so the sidebar's own
  `sidebar-in` mount animation is not replayed) under the splash's exit fade —
  a cross-fade from glass into the opaque main pane and glass sidebar.
- Windows and Linux keep the opaque splash; the rule is scoped to
  `:root[data-platform="darwin"]` like the sidebar rule. Splash, sidebar, and
  rail share one glass selector so the recipe cannot drift. The glass tokens'
  comment now names both consumers. `macos-sidebar-vibrancy.test.mjs` asserts
  the splash uses the tint and sheen on darwin and stays `--ds-bg-primary` in
  the base rule. Extends §8.3 of the UI design system; no protocol, storage,
  or runtime behavior changes. E2E-076.

## 2026-09-05 — Search/read truncation is a cut, not a window (D306)

- `Read.truncated` was true whenever a file continued after the returned
  window, and the 48KB / 500-line cap cut ordinary source and spec tables.
  Almost every Read then showed the UI truncated chip and told the model to
  Grep, including after an explicit `offset`/`limit` that had already been
  filled.
- `truncated` is now true only when this result was cut short: the byte
  budget stopped the window, a line was clipped, or Grep/Glob hid remaining
  hits behind their caps. A filled Read window of a longer file is
  `truncated: false`; `notice` names the next offset instead of nagging Grep.
- Default Read window returns to 2000 lines (max 4000). `BUDGET_SEARCH` is
  128KB / 4000 lines so that window of typical source actually fits.
  Per-line clip is 16,384 characters so a decision-log row survives while a
  minified one-liner still clips.
- Decision D306 amends D033 / D194. Host-core tool results, sidecar Read
  schema copy, and the truncated chip contract. No ADR: the field stays
  boolean and callers that already honored `truncated` keep working. See
  `03-runtime/16-tool-result-limits.md` and E2E-147 / E2E-175.

## 2026-09-05 — Revision payloads follow the live branch (D307)

- A regenerate family's active variant was archived once, on the first
  `agent_end` after the regenerate, and never touched again. The live branch
  kept growing: every later prompt appended to it, and a turn that ended in a
  provider error never reached `agent_end` at all. Paging the root away and
  back restored the archive taken at that first `agent_end` and rewrote the
  transcript and its JSONL from it, deleting every later turn. A real session
  had 17 messages (a turn that edited files) exposed this way.
- Every operation that discards the live branch now writes it back over its
  own variant first. `session.activateRevision` reads the durable transcript,
  finds the family (root id, or the first user message stamped with that
  `revisionRootId`), refreshes the variant the root's `activeRevision` stamp
  names, and only then switches; when the family is present the prefix comes
  from the transcript, not the renderer's copy. The regenerate path in the app
  process passes `revisionIndex` to `session.saveRevision` so the discarded
  tail refreshes its variant instead of being dropped as "already archived".
  `session.saveActiveRevision` refreshes an already-archived index.
- A refresh is one more line in the append-only revisions file (last record
  for `(rootUserId, revisionIndex)` wins, as `read_revision` already did) plus
  a `message_count` update; no index row is minted. A branch that was stamped
  by regenerate but never archived because its turn failed is stored as a new
  variant, so it can never bury the previous one.
- The switch also carries each surviving message's owning `turn_id` across the
  index rebuild (it used to reset the whole session's attribution, as
  `replace_messages` once did) and keeps checkpoints whose anchors survive.
- Decision D307 amends D109. Host-core `sessions.rs` / `rpc/mod.rs` and the
  regenerate path in the app main process; no renderer change. No ADR: the
  file format and protocol shape are unchanged, `revisionIndex` is an optional
  parameter. See `03-runtime/04-data-storage.md` §4.9 and
  `03-runtime/06-host-rpc-protocol.md`.

## 2026-09-05 — Zhipu / Z.AI named endpoint presets (D308)

- Adding 智谱 required knowing which of four URLs to paste. The add-provider
  dialog now offers a Service select for China and international standard API
  plus GLM Coding Plan. Choosing one fills the name, locks the published
  Base URL, and stores the models.dev `vendorKey`.
- Rows stay `openai_compatible` + `chat_completions`. pi-ai already speaks
  those hosts; PI-Desktop does not add a Zhipu apiStyle or SDK.
- Completions requests on a matching URL or vendorKey set `thinkingFormat:
  "zai"` and `zaiToolStream: true`, because the stored provider id is a UUID
  and cannot use pi-ai's `zai` / `zai-coding-cn` provider-name detection.
- Decision D308 amends D024. See ADR 0155, `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, and E2E-005D.

## 2026-09-05 — Add-provider common path is Service + key (D309)

- The add-provider form stacked Service, Name, Base URL, API key, and API
  format. Named endpoints already know name, URL, and wire format.
- A new dialog starts with Service. Named Zhipu / Z.AI and OpenCode Go then
  show Service + API key and a host summary. Custom endpoint then shows Name,
  Base URL, and API key. Advanced keeps Name (named) and API format (custom).
- OpenCode Go moves into the Service select so users do not look for it under
  API format.
- Decision D309 amends D308. See ADR 0156, `04-ux/06-settings-ia.md`, and
  E2E-005 / E2E-005B / E2E-005D.

## 2026-09-05 — Custom format beside the key; top models.dev vendors (D310)

- Custom endpoint now keeps API format beside the API key instead of Advanced.
- Service lists models.dev-backed international and China first-party
  endpoints, each with a published URL and wire style.
- Decision D310 amends D309. See `04-ux/06-settings-ia.md` and E2E-005.

## 2026-09-05 — Searchable Service picker without discovery jank (D311)

- The Service control was a native `<select>` with optgroups. Opening it in
  the overlay was sluggish, and there was no way to filter ~20 vendors.
- It is now a searchable anchored menu, matching the default-model picker:
  type to filter by localized name, vendor key, alias, or host; groups stay
  International / China with Custom first.
- Picking a named vendor no longer probes `/models` until an API key is
  present. Typing a key no longer paints `loading` on every keystroke; the
  hook waits for the 600 ms debounce. Switching endpoints clears the previous
  list immediately so stale models do not linger.
- Decision D311 amends D310. See `04-ux/06-settings-ia.md` and E2E-005 /
  E2E-005D.

## 2026-09-05 — Flat vendor Service list and Xiaomi (D312)

- Service options no longer split International / China. Custom stays first,
  then one searchable vendor list.
- Xiaomi is a named endpoint: models.dev `vendorKey: "xiaomi"`,
  `https://api.xiaomimimo.com/v1`, Chat Completions. Aliases `mimo` and
  `xiaomimimo` match the catalog.
- Decision D312 amends D310 / D311. See `04-ux/06-settings-ia.md` and
  E2E-005.

## 2026-09-05 — Shipped locale registry and language picker (D314)

- Language in Settings → General was three preview cards (Auto / 简体中文 /
  English). That does not scale, and names were hard-coded.
- UI locales now live in `@pi-desktop/i18n`: `en`, `zh-CN`, and `tr`. Native
  names stay endonyms. Auto still follows `app.getLocale()` through preload.
- The Appearance card keeps Theme as three preview cards. Language is a
  searchable picker: Auto pinned at the top with the detected native name,
  then shipped locales. Search matches native name, English name, and id.
- Plugin labels and the changelog stay `en` + `zh-CN` with English fallback.
- Decision D314 amends D073. See ADR 0160, `04-ux/02-i18n-english-first.md`,
  `04-ux/06-settings-ia.md`, and E2E-091.

## 2026-09-05 — Grep prefers a system `rg` when installed (D315)

- Codex searches with shell `rg` when the machine has it. PI-Desktop keeps
  Grep as the model-facing tool and uses a user-installed `rg` as its
  implementation backend when one is on the process PATH or Unix login PATH.
- The result shape, 128KB / `headLimit` budget, newest-first order, and
  explicit-`path` ignore exception stay host-defined. `rg` is exec'd with a
  null stdin and argv, not through Bash. Spawn failure or exit 2 falls back
  to the in-process `ignore` + `regex` searcher. `PI_DESKTOP_RG` selects a
  binary; `PI_DESKTOP_DISABLE_RG` forces the fallback.
- The agent still calls Grep rather than shelling out to `rg`. Read is
  unchanged. No `rg` binary is bundled.
- Decision D315 amends ADR 0057 / D195. See `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/02-agent-runtime.md` §7, and E2E-147.

## 2026-09-05 — Searchable theme picker (D316)

- Theme in Settings → General was three preview cards (System / Light /
  Dark), with plugin themes wrapping into the same grid.
- Appearance now uses the same searchable picker as Language: System,
  Light, and Dark pinned at the top, plugin themes after a divider.
  Search matches labels, descriptions, ids, and plugin ids.
- `AppSettings.theme` and the unavailable-plugin fallback to `system`
  are unchanged.
- Decision D316 amends ADR 0160. See ADR 0161, `04-ux/06-settings-ia.md`,
  and E2E-091.

## 2026-09-05 — A2A addressing spans sessions on the same host (D318)

- Decision D318 amends ADR 0147. The local A2A broker stays in host-core with
  capability-token auth and durable tasks; same-context-only discovery and
  send are lifted so two A2A-capable delegates in different open sessions can
  coordinate.
- `a2a.agents.list` returns every other live agent; cards carry `contextId`.
  `a2a.message.send` may address any registered peer (omitted `to` still
  prefers a same-session peer). Task access is membership — requester or
  worker — not context. `A2A_CROSS_CONTEXT_DENIED` is kept on the wire list
  and is no longer produced.
- Live peer ids are unique across the registry: a colliding `card.name` is
  suffix-uniquified at register and the runtime adopts the returned
  `agentId`. `a2a.task.event` / `a2a.push` gain `recipientContextId`; each
  session runtime delivers an event only when that field matches its
  `sessionId`.
- Unchanged: the parent cannot call `A2A`, settled delegates deregister, no
  nested delegation, no remote agents. See ADR 0162,
  `03-runtime/02-agent-runtime.md` §5f.2, and E2E-165c.

## 2026-09-05 — Live/durable transcript merge keeps chronological order (D317)

- Revalidating a running session used the bounded durable page as the array
  prefix and appended every live-only row after it. A long session that had
  accumulated more than the newest-100 page therefore painted old history at
  the bottom of D261's trailing mounted window, hiding the just-sent user
  prompt while the turn kept running. Stop plus another switch looked like a
  restore because the idle path skipped the merge and showed the durable page.
- `mergeLiveSessionMessages` now stitches in chronological order: live rows
  older than the page stay before it, overlapping completed rows prefer the
  durable copy, and an optimistic or streaming tail stays after it. A
  previously appended older prefix is healed back in front when its
  `createdAt` precedes the page.
- Decision D317 amends ADR 0120 / D261 / ADR 0137. See
  `04-ux/09-interaction-patterns.md` § session isolation, and E2E-177.

## 2026-09-05 — Restore a missing sessions row from its transcript / outbox (D318)

- A long session could vanish from the sidebar and reset the transcript to
  the first user row while hundreds of turns sat in
  `session-message-outbox.json`. The SQLite `sessions` row was gone;
  `session.appendMessage` failed `session not found`; the outbox paused at
  that head and never drained.
- Host boot now restores every live JSONL whose sessions row is missing,
  reinserting the row and rebuilding the search index from the file.
  `session.appendMessage` does the same restore, or inserts a stub row
  under the existing id when the file is also gone, so a queued outbox can
  drain. `session.delete` drops that session's outbox entries so a stub
  cannot resurrect a user-deleted conversation.
- Decision D318 amends ADR 0041 / D119. See `03-runtime/04-data-storage.md`,
  `03-runtime/07-process-model.md`, and E2E-178.

## 2026-09-05 — Parent agents collaborate across conversations (D321)

- Decision D321 amends ADR 0147 / ADR 0162. Agent-mode session runtimes
  register a `kind: "parent"` A2A card for their lifetime and expose `A2A`
  as a core parent tool so two conversations on the same host can
  coordinate.
- Discovery and send are kind-scoped: parents see other parents, subagents
  see other subagents. A parent cannot address a subagent, including its
  own, so `Task*` remains the only channel to delegates.
- Inbound parent events queue; an idle session prepends them to the next
  user prompt rather than auto-starting a turn. A conversation is reachable
  after it has an Agent runtime this process.
- See ADR 0164, `03-runtime/02-agent-runtime.md` §5f.2, and E2E-165d.

## 2026-09-05 — Sent file references stay chips and open on click (D320)

- Composer chips serialized to full `@path` text in the user bubble, so the
  node the user placed in the input became a long path after send. Scratch
  absolute paths were not clickable.
- The transcript now renders those tokens as composer-matching leaf-name
  chips. Workspace HTML opens in the side browser; other allowed files open
  with the OS default application via `pi-desktop/fs/open`.
- Decision D320 amends D209 / ADR 0070. See ADR 0163,
  `04-ux/08-component-spec.md` §8.3 / §11.8, `04-ux/09-interaction-patterns.md`
  §8a.2, `03-runtime/01-ipc-protocol.md` § fs, and E2E-180.

## 2026-09-05 — Relative transcript paths preview and open (D322)

- Relative file paths in assistant markdown were often not clickable, and
  `./` / `../` links in a viewed markdown document resolved from the
  workspace root instead of the file's directory.
- The renderer now linkifies bare workspace file tokens in markdown, and
  resolves `./` / `../` against the viewed file when previewing markdown
  in the files tab. Parent escapes stay inert. The remark plugin is a
  unified attacher so opening a session does not crash on `tree.type`.
- Decision D322. See `04-ux/08-component-spec.md` §8.3 and E2E-182.

## 2026-09-05 — Live parent turns stay transparent (D323)

- D297 replaced the streaming left rail with a whole-turn `--ds-tile` so the
  tint fading in/out would not reflow text. That boxed ordinary thinking,
  tools, and answer fragments the same way as a subagent card.
- A streaming parent turn now stays on the page background like a completed
  turn: no rail, no reserved 14px inset, no whole-turn tile. The tile remains
  only on the delegation card (D319) and the nested `.subagent-run`.
- Decision D323 amends D101 / D297. See `04-ux/08-component-spec.md` §8.4 /
  §9.9 and E2E-059a / US-UI-60.

## 2026-09-05 — Idle session switch keeps a not-yet-flushed completed tail (D324)

- After a turn finished, switching away and back reloaded the durable
  `session.get` page and dropped assistant/tool rows that were still only in
  the renderer (the persistence outbox had not flushed them yet). User
  prompts survived because they are written before the model runs.
- `selectSession` now merges live rows for an idle session that still has
  live provenance, the same way a running session already did. The live
  flag is cleared only once the durable page contains every live id.
- Decision D324 amends D317 / ADR 0137. See
  `04-ux/09-interaction-patterns.md` § session isolation, and E2E-183.

## 2026-09-05 — Parent A2A is always in the Agent catalog (D325)

- D321 registered the parent only after a successful broker mint, then
  injected `A2A` into the catalog. A late or failed register left the
  model with no `A2A` tool. `ToolSearch` also never lists core tools, so
  the model treated a missing on-demand hit as "A2A does not exist".
- Agent mode now puts `A2A` in the core catalog at runtime construction.
  The first call (or first prompt) mints the token. The tool is never
  deferred. Cross-conversation guidance is in the Agent system prompt
  whenever the mode is Agent, not only after register.
- Decision D325 amends ADR 0164 / D321. See
  `03-runtime/02-agent-runtime.md` §5f.2 and E2E-165d.

## 2026-09-05 — Withdraw A2A and Peer coordination (D326)

- The in-process `Peer` mailbox (D277 / ADR 0138 / ADR 0140) and the host-core
  A2A stack (ADR 0147 / ADR 0162 / ADR 0164 / D318 / D321 / D325) are
  withdrawn. There is no sibling channel and no parent-to-parent channel.
- `A2A` and `Peer` are not core tools, not assignable subagent tools, and not
  `ToolSearch` results. A definition that names either is treated as an
  unknown tool and dropped with a parse warning.
- Handshake protocol version moves 10→11 and no longer advertises `"a2a"`.
  Storage schema moves 12→13 and drops the A2A tables. A mixed v10/v11 pair
  is rejected at handshake.
- Decision D326 is recorded as ADR 0165, which supersedes ADR 0147, ADR 0162,
  and ADR 0164. See `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `03-runtime/06-host-rpc-protocol.md` §3–§4, and E2E-165.

## 2026-09-06 — Completed replies survive process restart (D327)

- Closing the app after a finished turn reloaded only user prompts (issue #42).
  User rows are durable before the model runs; assistant/tool rows go through
  the async outbox after `message_end`. D324 kept those live rows across an
  in-process session switch; process teardown drops renderer memory.
- `message_end` now checkpoints the finished snapshot before the outbox
  append, and `settleIf` will not wipe a newer turn that started during that
  write. `completed`/`error` `session.endTurn` deletes `.inflight.json` only
  when that id is already indexed. Boot recovery promotes a leftover whose
  turn is `completed` as a `complete` assistant row, not `aborted`.
- Host handshake awaits the outbox drain before the renderer can `session.get`,
  then `session.recoverInflightMessages` promotes leftover completed
  checkpoints the outbox did not land. Boot recovery skips completed leftovers
  so the finished outbox row can win.
- Decision D327 amends D299 / ADR 0153 / ADR 0041. See
  `03-runtime/04-data-storage.md` §2.1 and §5, `03-runtime/07-process-model.md`
  §5, `03-runtime/10-session-state-machine.md` §4, E2E-171, and E2E-184.

## 2026-09-06 — Parent-judged subagent lifetime (D328)

- The parent agent was aborting unfinished delegates because `TaskWait`
  expired, the model closed, and `agent_end` killed leftover runs. Idle and
  duration watchdogs were a second, independent kill.
- Decision D328 amends ADR 0089 / ADR 0119 / ADR 0129. The runtime no longer
  arms idle or duration timers. Parent idle does not abort delegates. When
  they finish, the runtime prompts the parent with their reports in the same
  durable turn. `TaskList` / timed-out `TaskWait` carry a heartbeat. Only
  `TaskStop` and user Stop abort a delegate.
- See ADR 0166, `03-runtime/02-agent-runtime.md` §5f, and E2E-155.

## 2026-09-06 — Agent-chosen Bash timeout (D329)

- The 300-second Bash override ceiling killed long builds and rejected
  explicit `timeout: 600` / `1800`. Default 60 seconds is unchanged.
- Decision D329 amends D190 / D273 / ADR 0054: honour 1–21,600 seconds;
  values above that ceiling are milliseconds, converted and clamped.
  Timeout and abort still kill the process tree.
- See ADR 0167, `03-runtime/03-tools-and-permissions.md` §5, and E2E-115.

## 2026-09-06 — Main-owned openExternal allowlist (D330)

- Chat markdown, plugin panels, the launcher, OAuth, and the embedded preview
  could hand a raw URL to `shell.openExternal`. A clicked `file:`,
  `javascript:`, `ms-msdt:`, or custom scheme reached the OS protocol handler.
- Electron Main now parses every such URL. Only http(s) with a hostname and
  `mailto:` with an address open. Disallowed URLs throw so OAuth reports
  `opened: false` and plugins keep `INVALID_ARGUMENT`. Workspace files stay
  on `shell.openPath`.
- Decision D330 amends ADR 0109. See ADR 0168, `05-security/01-security.md`,
  `07-plugins/04-plugin-security.md` §8, and E2E-185.

## 2026-09-06 — Accepted `@` files stay as inline chips (D362)

- Completing a workspace file from the `@` menu still replaced the trigger
  with an empty string and stored a token-less reference. That was the
  chips-above-textarea contract; after chips moved into the contenteditable
  draft, only sentinel characters paint, so Enter made the file disappear.
- Accepting a file now inserts one private-use sentinel at the caret and
  stores that token on the reference, matching clipboard paste. Enter/Tab
  confirm the menu and do not send. Directories still insert `@dir/` as text.
  Workspace-relative chips still drop on project switch (absolute scratch
  paths stay); their sentinels are stripped from the draft with them.
- Decision D362 amends D209 / D125. See `04-ux/08-component-spec.md` §11.8,
  `04-ux/09-interaction-patterns.md` §8a.1, and E2E-102a.

## 2026-09-06 — Bundled Files preview and live workspace events (D332)

- The Files plugin could not preview images, did not expose Open with default
  app after reveal replaced the header action, polled for project switches, and
  missed theme/locale events while docked.
- `fs.readPreview` classifies one readable file as text, image, binary, or
  tooLarge under the existing `fs.read` gate. Panel events now reach docked
  views. `workspace:changed` is delivered to panels and plugin processes.
- Decision D332 is recorded as ADR 0169. See `07-plugins/03-plugin-api.md` §3/§5/§6,
  `04-ux/08-component-spec.md` §5.2.2, and E2E-153.

## 2026-09-06 — Work-panel browser is the bundled `pi.browser` plugin (D333)

- The work-panel Browser launcher, chrome, and agent CDP were a host-built
  `HEADER_TOOLS` row plus a Main-owned guest. Files already proved a first-party
  surface can ship as a bundled plugin; users need the same enable/disable
  product for the whole browser without putting arbitrary web content inside a
  sandboxed plugin view.
- Bundled `pi.browser` owns chrome and the agent `Browser` tool. The guest
  `WebContentsView` and debugger stay host-owned and are reached only through
  public `pi.browser.*` gated by `browser.cdp`. Guest bounds are clamped to the
  calling plugin view. Raw CDP is allowlisted (cookies/storage/Target/Fetch
  denied). Host `BrowserPreview` stays a Plan-safe facade and fails if the
  plugin is disabled. No protocol/schema bump.
- Decision D333 amends ADR 0019 / 0104 / 0105 / 0108. See ADR 0170,
  `07-plugins/03-plugin-api.md`, and E2E-008b.

## 2026-09-07 — Contained in-chat image display (D334)

- Pasted/uploaded images are stored as extension-less `attachments/<sha256>`
  blobs. The renderer origin cannot load them, so history turns showed a chip
  instead of the picture, and `fs/open` treated the ref as workspace-relative.
- `fs/read`, `fs/reveal`, and `fs/open` now share `resolveOpenablePath`
  (workspace, scratch, attachments, plus the blob ref). Reads `realpath` the
  target. `fs/readImageDataUrl` returns only a bounded image data URL.
  Client `mimeType` cannot reclassify a non-image extension.
- Decision D334 is recorded as ADR 0172. See `03-runtime/01-ipc-protocol.md`,
  `04-ux/08-component-spec.md` §8.3, and E2E-187.

## 2026-09-07 — Host-owned plugin completions and session context (D336)

- Plugins could register tools but could not list authenticated models, read
  the current LLM context, or spend the user's provider quota on a side call.
- `pi.models.list`, `pi.session.getLlmContext`, and `pi.agent.complete` are
  public host APIs. Credentials and the wire call stay in Electron main.
  Session context is bound to the in-flight tool session (D019 amended).
- The bundled first-party Advisor UX is temporarily not shipped. The public
  APIs remain available to explicitly installed plugins.
- Decision D336 is recorded as ADR 0174. See `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, and E2E-188 / E2E-189.

## 2026-09-07 — OpenCode Go session routing headers (D337)

- OpenCode Go rejects LLM requests that omit `x-opencode-session`
  (`MissingSessionID`). pi-ai 0.85 does not emit that header; the official Pi
  coding-agent injects it in the agent layer.
- Decision D337 amends ADR 0116: agent-runtime sends `x-opencode-session`,
  `x-opencode-client: pi-desktop`, and a PI-Desktop `User-Agent` on session,
  subagent, prompt-enhancement, and plugin one-shot requests to OpenCode Go
  and any `opencode.ai` host, using the durable conversation id.
- See `03-runtime/02-agent-runtime.md` §6.2, `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, ADR 0116, and E2E-005D.

## 2026-09-07 — Explain quiet active turns with live agent activity status (D338)

- The transcript showed a generic running timer before the first event, but a
  provider wait, retry backoff, or parent-side delegated-work wait could still
  leave no row that explained the delay. Users could only infer activity from
  the Stop button.
- The existing normalized `status` event now carries an optional runtime-owned
  `AgentActivity` phase: `starting`, `waiting-model`, `retrying`, or
  `waiting-subagents`. The renderer stores it per session and renders one
  compact localized status row with elapsed time; it does not add a percentage,
  duplicate progress card, or alter abort semantics.
- Decision D338 is recorded as ADR 0175. See `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `04-ux/09-interaction-patterns.md`, and
  E2E-008c / E2E-094.

## 2026-09-07 — Per-provider User-Agent override (D339)

- Gateways and vendor subscriptions inspect User-Agent. pi-ai, Anthropic OAuth,
  OpenCode, and Codex each stamp a different default, and Codex overwrites
  User-Agent after extra headers. The schema listed `headers` but never stored
  or sent them.
- Decision D339: each AI-service and OAuth row may store optional
  `config_json.userAgent`. Empty keeps adapter defaults. A non-empty value is
  last-writer `User-Agent` on that row's outbound HTTP via a fetch wrapper plus
  stream-option headers. Advanced UI only; first OAuth login does not collect
  it. `matches()` includes `userAgent`.
- See ADR 0176, `03-runtime/12-provider-config-schema.md`, and E2E-005G.

## 2026-09-08 — Per-provider custom HTTP headers (D341)

- Gateways need more than User-Agent. ADR 0176 left the schema `headers` map
  unimplemented and used a sparse single-field Advanced editor.
- Decision D341: each AI-service and OAuth row may store optional
  `config_json.headers`. Empty keeps adapter defaults. A non-empty map is
  last-writer on that row's outbound HTTP via a fetch wrapper plus
  stream-option headers. Leftover `userAgent` migrates into
  `headers["User-Agent"]`. Reserved auth and hop-by-hop keys are rejected.
  Advanced UI is a compact key/value editor. First OAuth login does not
  collect headers. `matches()` includes the map.
- See ADR 0178, `03-runtime/12-provider-config-schema.md`, and E2E-005G.

## 2026-09-08 — User-configurable outbound proxy (D340)

- Model calls, marketplace downloads, updates, and the in-app browser each
  used a different HTTP stack, and none of them honored a product setting.
  Node `fetch` in the sidecar ignored the OS proxy.
- Settings → General → Network adds System / Direct / Custom. Custom is one
  HTTP or SOCKS5 URL plus a loopback bypass. Chromium sessions, main
  `net.fetch`, sidecar undici, and host-core marketplace curl share it.
  Workspace Bash does not inherit proxy credentials.
- Decision D340 is recorded as ADR 0177. See `04-ux/06-settings-ia.md`,
  `03-runtime/07-process-model.md`, and E2E-190.

## 2026-09-08 — Main-owned picker capabilities (D344)

- The composer picker previously returned native absolute paths to the renderer,
  which could then replay arbitrary paths through `composer/importFiles`; it also
  advertised folders while the importer rejected directories.
- Picker IPC now stores user-selected paths in Electron main behind a short-lived,
  sender-bound, one-shot token. Import accepts only that token and a durable
  session id, while the MVP picker offers regular files only.
- Decision D344 is recorded as ADR 0181. See `03-runtime/01-ipc-protocol.md`,
  `04-ux/08-component-spec.md` §11.7–11.8, and E2E-102h.

## 2026-09-08 — Custom global UI type scale (D343)

- The `--text-*` ramp is a frozen set of relative sizes. Window zoom scales
  layout together with text and is not a type preference. A reading-only px
  field would leave two type sizes in one window.
- Settings → General → Appearance adds Font size: Starbucks-style cup
  presets Tall / Grande / Venti / Trenta plus a percentage slider (80%–150%), persisted as
  optional `AppSettings.fontScale` (`1` = product ramp). The renderer sets
  `--font-scale` so every `--text-*` step and shared Lucide icon scales in
  proportion.
- Decision D343 is recorded as ADR 0180. See `04-ux/06-settings-ia.md`,
  `04-ux/07-ui-design-system.md`, and E2E-193.

## 2026-09-08 — P0 international shell locales (D346)

- Ship complete German, Spanish, and French shell catalogs, searchable native
  names, regional base-locale resolution, and matching in-app changelog
  catalogs. Extend `AppSettings.language` with `de`, `es`, and `fr` without a
  host protocol, storage schema, or IPC version change.
- Decision D346 is recorded as ADR 0183. See `04-ux/02-i18n-english-first.md`,
  `04-ux/06-settings-ia.md`, and E2E-091.

## 2026-09-08 — Composer-docked context usage inspector (D347)

- The compact context inspector hung under the newest assistant turn and
  scrolled out of reach. Collaborators agreed to move the single entry next
  to the model picker rather than keep two copies of the same numbers.
- Decision D347: the inspector lives in the composer right toolbar, left of
  the model × reasoning chip, and always mirrors the newest assistant turn
  that reported usage. The trigger is the ring plus percentage. The popover
  heading is remaining tokens plus percentage; inner section rules stay
  forbidden (D297). Assistant meta keeps the model badge.
- See ADR 0184, `04-ux/08-component-spec.md` §8.3 / §11.3, and E2E-060d.

## 2026-09-08 — macOS sidebar uses the source-list vibrancy material (D348)

- The washed-gray dock reproduced with a **dark app theme and a dark OS** on
  macOS 26. Syncing `nativeTheme.themeSource` alone would fix dark-app +
  light-OS; it does not keep `under-window` charcoal when Liquid Glass still
  paints a light plate under dark appearance. That is why the material changes
  from D304's `under-window` to `sidebar`.
- Decision D348: the main window uses Electron `vibrancy: "sidebar"`.
  `nativeTheme.themeSource` follows the app theme preference (`system` /
  `light` / `dark` / plugin base) so native menus and the vibrancy plate match
  the renderer. The assignment is process-wide, so Windows/Linux
  `shouldUseDarkColors` at window creation also follows the app preference
  next to `windowSetBackgroundColor`. Re-apply when a `plugin:` theme
  disappears. Only re-set vibrancy when `themeSource` actually changes. The
  thin `--ds-sidebar-glass-tint` recipe is unchanged. Amends D304.
- `macos-sidebar-vibrancy.test.mjs` asserts the sidebar material, preference
  mapping, settings/pluginChanged apply path, and the darwin live-window
  vibrancy guard. See `04-ux/08-component-spec.md` §1.7 and US-UI-74 / E2E-076.

## 2026-09-08 — Session title summaries and focus-aware native task notifications (D359/D350)

- The initial prompt remains visible immediately as a normalized 48-character
  fallback. After the first turn, Electron resolves the session's effective
  provider/model and runs the main-owned `session/summarizeTitle` one-shot with
  thinking disabled; the renderer persists a successful result through
  `session.rename`.
- Renderer-local session metadata persists `manualTitle`. Automatic title
  generation skips that marker and any persisted title that is neither a known
  default nor the first-prompt fallback, so manual and already-summarized titles
  survive renderer restart without a host schema change.
- Native task completion and interactive prompt alerts share an Electron IPC
  entry but have explicit `kind` values. Task banners are suppressed whenever
  the main window is visible and focused, including focused background sessions;
  interactive prompts retain exact-visible-session suppression so a focused
  background request still alerts. Durable task insertion remains D117's
  visibility decision and plugin notifications remain separate.
- See ADR 0186 / ADR 0187, `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `04-ux/08-component-spec.md`, and
  E2E-021a / E2E-065.

## 2026-09-08 — Preserve distinct credentials during model configuration import (D351)

- CC Switch can store multiple named profiles at one gateway endpoint. Endpoint-only
  import matching created the first row and silently skipped profiles with
  different API keys.
- Import equivalence now includes normalized endpoint, API style, and the
  credential. Same-endpoint profiles with different keys create independent
  providers and remain selectable in Composer; unchanged credentials remain
  idempotently skipped.
- Electron main resolves existing API keys through the host secret boundary
  for matching. Raw values never reach the renderer, logs, or provider metadata.
- Decision D351 amends D342 and ADR 0179. It is recorded as ADR 0188 and is
  covered by E2E-209. No host protocol or storage schema change.

## 2026-09-08 — Parent fatal error aborts leftover delegates (D352)

- D328 kept leftover delegates running after parent idle so long jobs could
  finish. A terminal parent 429 still closed the durable turn and showed
  Continue, while a subagent on another model kept `isRunning` true.
- Decision D352 amends D328 / ADR 0166. Parent idle is unchanged. A terminal
  parent error aborts leftover delegates, skips the resume prompt, and leaves
  the session idle so Continue is accepted. The failed TurnOutcomeCard survives
  a later `agent_end`.
- See ADR 0189, `03-runtime/02-agent-runtime.md` §5f, and E2E-155.

## 2026-09-09 — Disambiguate Intel macOS release artifacts (D353)

- The native macOS lanes could produce generic version-only installer names,
  making the Intel download easy to confuse with the arm64 download.
- Decision D353 amends D285 / ADR 0145: the Intel x64 lane passes target-specific
  electron-builder patterns and publishes `PI-Desktop-<version>-Intel.dmg` and
  `PI-Desktop-<version>-Intel-mac.zip`. The x64 updater feed keeps those URLs
  and checksums; arm64 keeps the generic macOS names.
- This is a release-asset naming change only. Updater ownership, signing, and
  notify-and-link delivery remain unchanged. See E2E-092.

## 2026-09-09 — Label both macOS release architectures (D354)

- D353 left the arm64 macOS asset with a generic version-only name while using
  `-Intel` only for the x64 asset, so `PI-Desktop-0.14.4.dmg` still did not
  identify its architecture.
- Decision D354 amends D353 / ADR 0145: both native lanes pass target-specific
  naming templates and publish `-arm64` or `-x64` DMG/ZIP suffixes. The
  per-architecture updater feeds keep the final URLs and checksums.
- This changes release asset naming only. Updater ownership, signing, and
  notify-and-link delivery remain unchanged. See E2E-092.

## 2026-09-09 — Last-request occupancy in the context inspector (D355)

- The composer inspector mixed last-message occupancy with a visual-turn sum,
  so cache read and turn total could exceed the context window after a tool
  loop.
- Decision D355 amends D103 / D184 / D244 / D347 / ADR 0047 / ADR 0103 /
  ADR 0184: occupancy, remaining capacity, used/window counts, turn total,
  and provider cache/input/output/reasoning/hit-rate are the last
  usage-bearing assistant message. Occupancy is
  `input + output + reasoning + cacheRead + cacheWrite`. Speed and the
  aggregate tool row still describe the visual turn.
- Renderer only. Host completed-turn rollups and Token Insights stay additive
  billing. See ADR 0193 and E2E-060d.

## 2026-09-09 — Optional subagent thinking override and readable selected levels (D356)

- The subagent editor now offers inherit-session, do-not-send, and the seven
  canonical thinking levels. Do-not-send is stored as `thinkingLevel: omit`.
- `omit` keeps the agent's bookkeeping state at `off` but uses the low-level
  provider stream so no thinking override is synthesized. Existing inheritance
  and explicit `off` remain distinct.
- Model-configuration thinking chips use an accent/inverted-text selected state
  in both themes so enabled levels are obvious. No storage schema or protocol
  version change is required. See ADR 0194 and E2E-203.

## 2026-09-09 — Viewport-fixed work panel toggle (D357)

- Decision D357 amends D128 / D207 / D221 and ADR 0068 / ADR 0085. AppShell
  owns one viewport-fixed toggle at the top-right of every non-Settings route.
  It is the pointer equivalent of `Cmd/Ctrl + J`: it reveals the active
  session's retained context without creating a tab and collapses a visible
  panel without deleting tabs. With no session it is disabled.
- The toggle is the sole panel-level collapse control. The work-panel header
  keeps resource close only. Windows/Linux window controls stay viewport-fixed
  at the window's right edge; while the panel is open the header reserves that
  band plus the toggle so close-tab remains reachable.
- No host protocol, IPC channel, or native application-menu command. Artifact
  triggers and session-scoped contexts are unchanged. See ADR 0195 and
  E2E-056 / E2E-070 / US-UI-57.

## 2026-09-09 — Windows portable exe without installer (D364)

- Windows tag releases published only `PI-Desktop-Setup-<version>.exe`, which
  company environments that whitelist a single executable or block installers
  cannot run.
- Decision D364 amends D120 / D126 / ADR 0022: the Windows x64 lane publishes
  `PI-Desktop-Portable-<version>.exe` alongside the NSIS installer. The
  portable target does not write `latest.yml`. Packaged portable runs
  (`PORTABLE_EXECUTABLE_FILE`) use notify-and-link delivery; NSIS keeps
  in-app download and quit-and-install. Data stays in the existing application
  data directory. Portable requests user execution level.
- See ADR 0197 and E2E-211.

## 2026-09-22 — Trust the network endpoints the user enters themselves (D604)

- An endpoint the user typed themselves — a model base URL, an MCP server, a
  market source, a git remote, a generated-image URL — may resolve to loopback,
  RFC1918, CGNAT, link-local, ULA, site-local or `.local`. Plain `http` to such
  an endpoint is usable. One host-owned switch decides all of it —
  `settings.networkPolicy.mode` (`relaxed` | `strict`), **`relaxed` by
  default** — and it replaces the earlier per-surface acknowledgements
  (`networkProxy.allowFakeIp`, `configSync.allowInsecureHttp`, the plaintext
  flag); a stored `allowInsecureUserEndpoints: false` migrates to `strict`. The
  first plaintext hop shows one informational notice.
  `https` to a LAN host needs no opt-in.
- Third-party content is unchanged. A registry record, a market catalog body, a
  document URL inside a catalog and every HTTP redirect target keep the
  public-only policy with the checked address pinned to the connection. The
  shared client takes the origin of each hop, and only the first hop of a request
  the user started may be `user`.
- Cloud metadata (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`,
  `metadata.google.internal`, `metadata`, `instance-data`), `unspecified`,
  multicast, reserved and documentation addresses stay refused everywhere,
  including in a user-supplied field.
- The default proxy bypass list gains the private ranges, so a configured proxy
  no longer swallows a local model server, NAS or MCP endpoint. See
  `05-security/01-security.md` §4.1/§4.2, `04-ux/06-settings-ia.md`, and
  ADR 0304.

## 2026-09-22 — Windows portable delivery uses a normal ZIP (D603)

- Decision D603 amends D364 / ADR 0022 / ADR 0197. The Windows x64 lane now
  publishes `PI-Desktop-Portable-<version>.zip` beside the NSIS installer.
  The release helper builds the two targets separately and stamps the ZIP app
  metadata with `piDistribution = "zip"`; the ZIP target does not write
  `latest.yml`.
- Users extract the ZIP and launch `PI-Desktop.exe` directly. The ZIP run uses
  notify-and-link update delivery, while the updater keeps recognizing
  `PORTABLE_EXECUTABLE_FILE` for older portable executables. The existing data
  directory and NSIS in-app update lane are unchanged.
- See ADR 0197 and E2E-211.

## 2026-09-09 — Name every quiet interval on the live activity row (D365)

- ADR 0175 named only `waiting-model`, `retrying`, and `waiting-subagents`.
  Compaction, silent-turn recovery, the post-tool gap before the next request,
  and `starting` still looked like a stuck generic wait. A parent wait on
  delegates also omitted what those delegates were doing.
- Decision D365 amends D338 / ADR 0175: `AgentActivity` adds `preparing`,
  `compacting`, and `recovering`; `starting` is shown as its own label; and
  `waiting-subagents` carries a live running snapshot (`name`, `lastPhase`,
  `lastToolName`) that updates on child tool/thinking changes, not on every
  token. The row stays one compact inline status and does not restore an
  activity-group capsule.
- See ADR 0198, `03-runtime/01-ipc-protocol.md`, `03-runtime/02-agent-runtime.md`,
  `04-ux/09-interaction-patterns.md`, and E2E-008c / E2E-094.

> D366 is unassigned. It was first used for the plugin session import decision,
> which was renumbered to D367 / ADR 0200 while syncing with `main`, and then
> for a docs-deploy-only-from-releases decision (with ADR 0199) that was
> reverted on 2026-09-09. Both D366 and ADR 0199 stay retired; do not reuse
> them. D376 is likewise unassigned: `main` renumbered the remote-control
> amendment it briefly carried to D374 and assigned D375 to the rollout
> sequence, so D376 stays retired too.

## 2026-09-09 — Host-owned plugin session import and ownership API (D367)

- External-history plugins need durable import/read/update/delete operations, but
  the existing in-flight `session.getLlmContext` and core `session.import`
  boundaries are not safe plugin ownership boundaries.
- Decision D367 / ADR 0200 adds the P0/P1 `pi.session` methods: `import`,
  `importBatch`, `list`, `get`, `listMessages`, `rename`, and `delete`.
  `contributes.sessionSources` is required for every source. Host-core generates
  ids and scopes all operations to `(pluginId, source, externalId)` ownership;
  imports never activate project/provider/model bindings.
- Schema v14 adds `session_import_origins` and `sessions.deleted_at`; protocol
  v11 remains unchanged. Trash preserves the transcript for owner-only purge.
  P2/P3 create, message mutation, binding, batch-delete, and tag APIs remain
  deferred. See ADR 0200 and E2E-214/E2E-215.

## 2026-09-09 — Explicit plugin project ids and host-owned session refresh (D368)

- Imported sessions need an explicit way to belong to a durable project, but
  exposing `workspace.set` to plugins would also change the user's active
  workspace. Plugin writes also need a host-owned renderer refresh path.
- Decision D368 / ADR 0201 adds permission-gated `pi.project.create({ path })`.
  It creates or reuses a project and returns its host-generated id without
  activating the workspace. Import items may provide an existing `projectId`;
  omitted ids remain unbound, and historical origin paths do not become tool
  roots. List/get projections report the explicit binding.
- Electron main emits `pi-desktop/session/event/changed` after successful plugin
  imports, renames, and deletes; the renderer reuses `refreshSessions()`, while
  skipped imports emit nothing and closed project tabs are not reopened. See
  E2E-216.

## 2026-09-09 — Effective subagent thinking metadata (D369)

- Delegation cards need the thinking level actually passed to each child run,
  not a value re-derived from the parent or definition after the target model
  clamps it.
- Decision D369 / ADR 0202 adds effective `modelId` and `thinkingLevel` to the
  immediate `Task` result, `SubagentRunResult`, and lifecycle snapshots. The
  topology node and side-dock header show the raw canonical non-`off` level
  after the model name; `off`, `omit`, and unsupported reasoning remain
  model-only. No host protocol, storage schema, provider request, or lifecycle
  behavior changes. D395 / ADR 0221 removes translation of the canonical value.
  See E2E-219.

## 2026-09-09 — Explicit unsigned macOS first-launch helper (D371; amended by D406)

- The default macOS lane remains unsigned, and a downloaded trusted artifact can
  still be blocked by Apple's quarantine check with a misleading damaged-app
  message. The existing `xattr -cr` note was terminal-only and broader than
  the launch failure requires.
- Decision D371 / ADR 0204 adds an executable `PI-Desktop-macOS-open.command`
  to every macOS distribution. The DMG places it in a visible first-launch row
  below the drag-to-Applications gesture.
- The helper searches only `/Applications/PI-Desktop.app` and
  `~/Applications/PI-Desktop.app`, verifies `CFBundleIdentifier` is
  `com.pi-desktop.app`, removes only `com.apple.quarantine` recursively when
  present, and opens PI-Desktop. It never uses `sudo`, accepts no arbitrary
  path, and does not replace Developer ID signing or notarization. The opening
  note keeps the explicit trusted-source warning and a narrow Terminal
  fallback. See E2E-196b.

## 2026-09-09 — Local MCP control plane for desktop operations (D370)

- An external Agent needs to drive the running desktop for project, session,
  Agent, workspace, and reviewed application operations, while the deferred
  remote Gateway / WebUI boundary remains unchanged.
- Decision D370 / ADR 0203 adds an opt-in Streamable HTTP MCP server inside
  Electron Main. It binds to `127.0.0.1`, authenticates with a persistent
  random bearer token, validates supplied Origins against loopback hostnames,
  writes a mode-restricted connection manifest, and delegates to the same
  registered IPC handlers used by the renderer.
- Named tools cover the common project/session/Agent flow; `pi_desktop_invoke`
  reaches an explicit risk-tagged operation catalog. Secret channels and
  renderer-only native pickers are excluded, while dangerous operations require
  `confirm: true`. Successful external mutations reuse the existing renderer
  session-change event so visible state follows the control call.
- The endpoint is local-only and fail-soft at startup; it does not create a
  remote authentication, cloud sync, or second permission implementation. See
  `02-architecture/01-architecture.md`, `03-runtime/01-ipc-protocol.md`,
  `05-security/01-security.md`, and E2E-220.

## 2026-09-10 — Tighten the local MCP control-plane boundary (D372)

- D370's first catalog still exposed native pickers (`plugin/loadDev`),
  secret-write provider/OAuth/MCP paths, and `session/configure` without
  confirmation, and treated session reads as renderer mutations.
- Decision D372 amends ADR 0203: the first-version catalog is the
  project/session/Agent/workspace flow plus reviewed reads; secret-shaped
  arguments are stripped; `session/configure` is dangerous; listen addresses
  are asserted loopback; protocol versions are negotiated rather than echoed;
  results including `structuredContent` are bounded; renderer session refresh
  is mutation-only. See E2E-220.

## 2026-09-10 — Remote Agent Control uses a dedicated Host boundary (D373)

- Remote control is a post-MVP capability and must not expose the existing
  Electron IPC, `host.proxy`, or Rust host-core stdio boundary.
- Decision D373 / ADR 0205 defines a logical Agent Host that owns Sessions,
  Turns, event cursors, approvals, attachments, workspace policy, and crash
  recovery. A production Gateway owns identity, routing, rate limits,
  revocation, and audit, while the Agent Host connects outbound.
- RACP v1 keeps the semantic operation model independent of transport:
  WebSocket JSON-RPC is the primary interactive binding, HTTP/JSON + SSE is
  the browser binding, and gRPC over TLS is the native/Gateway binding. The
  bindings share event sequences, snapshots, idempotency, authorization, and
  error semantics. See the remote architecture, protocol, security, and
  rollout specifications and E2E-221 through E2E-230.
## 2026-09-10 — Amend the remote Agent Control target before implementation (D374)

- A review of the D373 draft against the shipped desktop found that the
  remote approval vocabulary was narrower than the local
  `allow-once` / `allow-session` / `deny` and Plan/Goal permission-mode
  contracts, that pending permission requests were connection state rather
  than Host state, that per-token deltas would exhaust the replay window,
  that three required bindings and two IDLs were more than v1 can carry, and
  that browsers cannot satisfy header-only authentication on WebSocket and
  SSE.
- Decision D374 amends ADR 0205: `RACP-WS` is the only normative v1 binding
  with `RACP-HTTP` as the browser profile and `RACP-GRPC` reserved; typebox
  in `packages/shared` is the single contract source; the first deliverable
  is the headless `packages/agent-host` module that desktop IPC, local MCP,
  and RACP all call; cursors are `{ epoch, sequence }` with ephemeral deltas
  and an in-memory first log; the turn queue moves into the Host; host-core
  exposes `permissions.pending`; remote approvals carry the full local
  decision vocabulary; a remote permission ceiling defaults to `ask`; the
  approval lifetime becomes a bounded Host policy for remote subscribers;
  the Host link is a relay profile; browser clients use a cookie profile;
  the Gateway identity source is decided at R3; and the first deployment is
  single-tenant. See the amended remote architecture, protocol, security,
  and rollout specifications and E2E-221 through E2E-230.

## 2026-09-10 — Sequence remote control around recorded demand (D375)

- Issues #176 and #140 ask to operate projects on a remote Linux or WSL
  machine from the local desktop; issue #100 asks for task and approval
  notifications on Telegram, WeChat, Slack, or a webhook with simple commands
  back. No recorded request asks for a browser or phone client of the
  desktop, and the maintainer has publicly committed to #100.
- Decision D375 amends ADR 0205 a second time: rollout R2 becomes the
  SSH-tunnel remote Host, with a `pi-host` bundle downloaded from GitHub
  Releases by a bootstrap script uploaded over the user's own SSH session,
  checksum-verified, bound to loopback, paired with the desktop, reached
  through a port forward on the `RACP-WS` header profile, and rendered by the
  unchanged renderer through a desktop RACP client adapter under
  `lib/api.ts`. RACP gains the remote-host profile (`session/configure`,
  `session/fork`, `session/rename`, `session/delete`, `session/compact`,
  `workspace/list`, `workspace/read`, `workspace/diff`, `terminal/*`) and the
  reverse tool relay (`tools/advertise`, `tool/execute`) in the same
  milestone, which is not split. A remote session lives on its Host; provider
  configuration is written over SSH; the SSH-paired desktop device is exempt
  from the remote permission ceiling unless `applyCeilingToPairedDevices` is
  set; queued turns are persisted by host-core and held after a restart; the
  remote approval lifetime defaults to 30 minutes. R3 becomes the outbound
  messaging integration, webhook first. The Gateway, browser profile, and
  gRPC binding stay specified but unscheduled, and the Gateway identity
  source is fixed to the PI account service of the pi-backend specification.
  See the amended remote specifications and E2E-231 / E2E-232.

## 2026-09-10 — Remote control stays user-local: no first-party identity (D385)

- The maintainer requires that a user's client never authenticate through a
  service the project operates and that remote control stay entirely on the
  user's own machines and infrastructure.
- Decision D385 amends ADR 0205 a third time and withdraws D375 item 10: no
  project-operated identity, account, or relay service is in the path; the
  only credential a client holds is a device token issued by the user's own
  Host at pairing; a Gateway, if ever scheduled, is self-hosted by the user
  and admits clients with those Host-issued credentials; OIDC federation and
  the pi-backend account service are out of scope. The Host's only outbound
  connections are the user's SSH hosts, the user's own messaging channels,
  the model providers the user configured, and the read-only GitHub Releases
  download of `pi-host`. The SSH-tunnel topology, device pairing, and the
  messaging integration already satisfy the rule.

## 2026-09-10 — Persist the Host-owned turn queue in host-core (D386)

- D375 moved queued prompts into the Host and chose persistence; the
  headless Agent Host module needs a store that survives a restart and never
  starts work by itself, and host-core owns SQLite exclusively.
- Decision D386 / ADR 0213 adds schema v15 with the `turn_queue` table and
  the additive `session.queuePush` / `session.queueList` /
  `session.queueRemove` / `session.queuePrioritize` methods. Push is idempotent per principal and key,
  bounded at eight entries per session, and cascades with session deletion.
  The module restores entries when host-core answers, holds every restored
  session until a controller attaches, and drains one entry only after the
  active turn's terminal event. Protocol stays v11; the renderer's in-memory
  queue is retired, and its "send now" becomes RACP `turn/prioritize` plus
  a graceful stop.


## 2026-09-10 — Trusted extensions run in the Agent sidecar (D387)

- Plugins are sandboxed and run outside the agent, which is right for
  distributed, untrusted code but leaves no surface for code that must sit
  on the agent loop itself: tools that execute in-process, hooks on every
  turn and provider request, and slash commands with session context.
- Decision D387 / ADR 0214 adds trusted extensions as the second extension
  surface. The contract is the `ExtensionAPI` of `pi-coding-agent`, adopted
  at the same pinned version as `pi-ai` and `pi-agent-core`; the sidecar
  reuses its loader and `ExtensionRunner`, one Runner per session, with the
  API implemented over the runtime's existing hooks. Extensions are labelled
  "Trusted extension", disabled until the user enables each entry, and
  discovered from `~/.pi/agent/extensions`, `<workspace>/.pi/extensions`, or
  a manual path; D007 stays: `~/.pi` is never imported. Every API member is
  Supported, Deferred (v2), or Unsupported; unsupported members are inert
  with a diagnostic and never throw; terminal-UI surfaces stay unsupported.
  Plugins, host-core RPC, protocol version, and schema are untouched in v1;
  the new traffic is sidecar proxy methods and Electron IPC. Delivery starts
  with the bundling spike (E2E-245). Spec:
  `07-plugins/16-trusted-extensions.md`; scenarios E2E-241 to E2E-245.
## 2026-09-10 — Extend provider retries and show bounded progress (D378)

- The runtime-owned provider retry budgets surfaced short provider outages
  earlier than the product target, and the active-turn row showed only a retry
  number without the current wait or its bound.
- Decision D378 amends D245 / D259 and ADR 0091 / ADR 0128: both the HTTP 429
  and admitted non-429 transient provider paths receive ten retries after the
  initial attempt, with setup and stream failures sharing one counter per error
  class. The two classes stay separate, pi-ai's nested retry remains disabled,
  and non-429 waits stay at the 8-second cap after the 1/2/4-second schedule.
- `PROVIDER_RETRY_MAX_RETRIES` becomes the shared runtime/renderer budget
  constant. The active-turn status derives a countdown from the existing
  `retryDelayMs` and `since` fields and renders the attempt bound, for example
  `Retrying in 0s · attempt 9/10`. No host protocol, storage schema, provider
  configuration, or unrelated recovery policy changes. See ADR 0206 and
  E2E-096 / E2E-149.

## 2026-09-10 — Name downgraded and non-native builds at boot (D380)

- Installing 0.14.5 over a data directory that 0.14.6-rc.4 had migrated to
  schema 14 produced three silent host restarts and "Can't reach the local
  service"; only `logs/host/runtime.log` said `database schema version 14 is
  newer than supported 13`. An Intel macOS build on Apple Silicon likewise ran
  under Rosetta with no hint.
- Decision D380 extends the Linux glibc guard pattern (E2E-195): Electron
  parses host-core's schema refusal from the last stderr, stops supervising on
  the first failure, and pushes `hostStatus` with `DB_SCHEMA_TOO_NEW` plus both
  schema numbers so the banner can say which version to install. Boot also
  detects a non-native build (`sysctl.proc_translated` on macOS, `os.machine()`
  elsewhere) and ships `archMismatch` on the boot status; the renderer shows a
  dismissible hint naming Intel / Apple Silicon. No new error code: both keep
  `HOST_UNAVAILABLE` and reuse the status-token `message` channel. No downward
  migration is attempted. See E2E-239 / E2E-240.

## 2026-09-10 — Allow three same-path mutation recovery failures (D379)

- The previous repeat guard ended a prompt after two counted failures on one
  `Edit` path or recognized shell patch key. That boundary could stop the model
  while it was still applying a distinct recovery hint from the prior failure.
- Decision D379 amends D186 and ADR 0087 / ADR 0207: the same-path mutation
  guard allows three counted failures per prompt. Recoverable error codes keep
  their one-code grace, successful mutations clear the path history, and the
  third counted failure returns `terminate: true` with
  `MUTATION_RETRY_BUDGET_EXHAUSTED`. The same limit applies to recognized shell
  patch commands. No IPC, storage, host-protocol, or tool-result shape changes.
  See E2E-140 / E2E-141.

## 2026-09-10 — Plugin desktop control requires native user consent (D377)

- A code and documentation review found that a plugin holding
  `desktop.control` could run `dangerous` catalog operations (session
  delete, permission-mode change, tool approval) with no human in the loop:
  the shared controller's `confirm: true` is set by the plugin itself, and
  the only confirmation was whatever card the plugin chose to draw. The same
  review found the Electron `fetch` service let an allowlisted host redirect
  a plugin request to an undeclared host, that `manifest.main` and
  `ui.panel` skipped path containment, and that the spec 15 security
  denylist and ignore layers had never been implemented in host-core.
- Decision D377 (ADR 0208): a `dangerous` desktop operation from a plugin
  needs the plugin's `confirm: true` and then the user's answer to a
  host-owned native dialog that names only the catalog operation,
  description, and a bounded argument preview; refusals and headless hosts
  fail with `PERMISSION_DENIED`. The MCP contract (D372) is unchanged.
- In the same change, without new decisions: `pi.net.fetch` has one path,
  the runtime hop loop that re-checks `net.domains` before every redirect;
  `manifest.main` and `ui.panel` are validated and resolved inside the
  plugin; host-core enforces the spec 15 security denylist
  (`WORKSPACE_PATH_DENIED`), app defaults, `.pi-desktopignore`, and
  `<data_dir>/ignore` for unscoped walks; the path resolver follows
  dangling symlinks so a write through one cannot leave the workspace; and
  a `tools.execute` for an unknown session returns `SESSION_NOT_FOUND`
  instead of inheriting the global workspace. See E2E-234 through
  E2E-238.

## 2026-09-10 — PowerShell 7 as a selectable Windows command shell (D381)

- Issue #151: a Windows user who installs PowerShell 7 (`pwsh.exe`) had no way to
  run `Bash` under it. PowerShell 7 installs side by side with, and never
  replaces, the in-box 5.1 that ADR 0054's `windows-powershell` entry resolves,
  and the catalog exposed no other entry: `crates/host-core/src/tools/shell.rs`
  had no `pwsh.exe` resolution path, and `COMMAND_SHELL_IDS` listed four IDs.
- Decision D381 (ADR 0209) adds the stable ID `windows-pwsh` ("PowerShell 7") to
  the Windows catalog, amending ADR 0054 §1. It resolves
  `%ProgramFiles%\\PowerShell\\7\\pwsh.exe` (plus `%ProgramW6432%` when the host
  process is 32-bit), then `pwsh.exe` on PATH; a miss returns `SHELL_NOT_FOUND`
  naming both searched locations. It keeps the `powershell` dialect and the
  pinned non-interactive script, and it is never selected implicitly, so the
  platform default and existing users' shells are unchanged.
- Protocol, storage, and tool surfaces are additive: `CommandShellId` gains one
  member while the folded settings validation and the first-available fallback
  need no new code path, and no RPC method, tool name, or schema migration is
  added. See E2E-112.

## 2026-09-10 — A settled subagent reads back why it failed (D382)

- A delegate that ended `failed`, `timed_out`, or `aborted` showed only its
  outcome capsule and an elapsed time. The reason existed but had no reader:
  `SubagentRunResult.error` travels on the delegation roster entry, while a
  node and its dock render the `Task` row's own result, which ADR 0089 fixes at
  `running` the moment the delegate starts. A delegate that died before
  emitting a message row therefore left a panel of steps and no explanation.
- Decision D382: the delegation's `error: { code, message }` is collected from
  the lifecycle rows' `details.delegations[]` and `details.stopped[]` with the
  same last-write-wins rule as the settled status, and the dock closes with an
  error card that reuses the transcript error card's visual language and its
  `errors.<code>` vocabulary, falling back to the localized
  `chat.subagentStatus.*` outcome when a code is not registered. The card
  follows a non-success terminal outcome rather than the error field alone, so
  a completed or running delegate never shows one. No runtime, IPC, storage, or
  tool-result change: the runtime already reported the error, and this stops
  discarding it. See `04-ux/08-component-spec.md` §5.7 and E2E-198.

## 2026-09-10 — A delegate can declare its own output limit (D383)

- A subagent definition could bound its turns but not its response length.
  `maxTurns` ran through the frontmatter, the record, the input, the editor
  draft and the runtime, while the only output bound a delegate had was the
  one its model binding published: `ModelBinding.maxTokens` in
  `packages/agent-runtime/src/model-capabilities.ts` caps every caller of that
  model, so raising it for one long-winded delegate raised it for the session
  too. `SubagentDefinition`, `SubagentDraft` and `UserSubagentRecord` had no
  `maxTokens`, and `SubagentRun` never passed one.
- Decision D383 (ADR 0210): a definition may declare `maxTokens`, parsed under
  the same loose key spellings as `maxTurns` and bounded by a 200000 ceiling.
  Omitting it, `none` or `0` follows the model's published limit; a value
  outside 1–200000 is treated as a typo that is reported and ignored or
  clamped rather than forwarded. The declared value overrides `maxTokens` on
  the model the delegate builds for itself, so the adapter's derived
  `max_tokens` / `max_completion_tokens` / `max_output_tokens` carry it while
  the session's own requests keep the model binding. It is stored in the
  capability document's frontmatter and edited beside the turn limit in the
  editor's existing Advanced disclosure. No new IPC, tool-result, or storage
  shape: the field rides the existing subagent record and input. See E2E-119 /
  E2E-155.

## 2026-09-10 — Plan-safe plugin actions and summon-window shortcut (D384)

*(the summon-window half is superseded by D438, which replaced the pair, and by
D439, which moved the toggle off the macOS close-window chord; the plan-safe
plugin-action opt-in below stays)*

- Plan and Goal modes could not invoke plugin tools at all, even for
  read-only actions like fetching a URL through the bundled Browser
  plugin, and the keyboard shortcut catalog only exposed a close-window
  binding with no symmetric way to bring a tray-hidden window back.
- Decision D384 amends ADR 0052 / ADR 0053 with a per-action plugin
  opt-in: a plugin tool may declare a `planSafeActions` list naming the
  exact actions it considers safe in contract modes. The runtime hides
  plugins without such a list in Plan and Goal, the host admits the
  declared list in `tools.execute`, and the desktop runner rejects any
  call whose action is not in the list. The bundled Browser plugin
  declares `["navigate", "snapshot", "screenshot", "console"]`; the
  mutating actions stay Agent-only. The shortcut catalog gains
  `summonWindow` (`Mod+Shift+W`) in the `window` group, paired with
  `closeWindow` (`Mod+W`), and the desktop main process registers it
  through `globalShortcut` and the native menu. See ADR 0211 and
  E2E-PLAN-005.

## 2026-09-17 — One window toggle replaces the summon/close pair (#360, D438)

- Issue #360 item 3 asks for the summon-window and hide/close-window global
  shortcuts to become one key. D384 shipped the opposite arrangement —
  `summonWindow` (`Mod+Shift+W`) as the "symmetrical counterpart" of
  `closeWindow` (`Mod+W`), mirrored by `04-ux/09-interaction-patterns.md` §1.1 —
  so D438 supersedes exactly that half of D384; the plan-safe plugin-action
  opt-in from the same decision is untouched. The numbering skips D435 and D437,
  which other in-flight work already claims.
- The catalog ships one `toggleWindow` id in the `window` group, and
  `closeWindow` and `summonWindow` leave `KEYBOARD_SHORTCUT_IDS`, so neither
  retired chord is spent on anything: neither is a shipped default, registered
  with `globalShortcut`, a settings row, or a menu accelerator, and the freed
  `Mod+Shift+W` becomes available to plugins again. D439 later moved the
  toggle's own default off `Mod+W`, which D438 had chosen; the merged id, the
  toggle semantics, and the migration below are unchanged by that.
- Pressing the key is a decision, not a close. `windowToggleAction` hides a
  visible, focused window through `Window.hide()` and otherwise shows and
  focuses it (hidden, minimized, or behind another application all count as
  "not visible"). `Window.hide()` is the whole hide path, so the Windows/Linux
  close-behaviour prompt, its `Quit` choice, `window-all-closed`, and
  `before-quit` are never reached, no window is destroyed, and the app keeps
  running; the tray icon, the same key, or macOS application activation brings
  the window back. `windowControl("close")` remains the window's own close
  button, which is still the only way into the close behaviour.
- Persisted `settings.keybindings` can still name the two retired ids, and the
  same rule applies in both processes: `migrateKeybindingOverrides` folds the
  map as it is read — in Electron main before it registers accelerators or
  builds the menu, and in the renderer store before any consumer sees it — so
  no surface can act on the retired ids. The rules are ordered and idempotent:
  an existing `toggleWindow` override wins unchanged; otherwise the first
  retired entry that carries a *binding* wins, `closeWindow` first because
  hiding is the toggle's primary job; a retired entry that is only `null` is
  honoured when no binding competes, so an explicit unbind is never replaced by
  a shipped default; and a stored value equal to its own retired default carries
  no intent (the settings UI deletes overrides that match a shipped default), so
  `Mod+W`/`Mod+Shift+W` values are dropped rather than resurrected. Nothing is
  rewritten in storage: the folded map is what the next shortcut save persists,
  and an older release reading a newer map simply ignores the unknown id.
- The window-visibility key is a supported global shortcut on macOS, Windows,
  and Linux, so it is documented as one: menu label and settings row are
  localized in all eight catalogs, and the settings card shows a single Window
  row instead of two contradictory ones.
- See ADR 0211 (amended), `04-ux/09-interaction-patterns.md` §1.1 and §1.4,
  `04-ux/06-settings-ia.md` (shortcuts tab), `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`, `03-runtime/01-ipc-protocol.md`
  (`NATIVE_MENU_ACTIONS`), E2E-072, and
  `apps/desktop/test/window-toggle-shortcut.test.mjs`.

## 2026-09-17 — The window toggle avoids the macOS close-window chord (#360, D439)

- D438 merged the pair onto `Mod+W`, but that binding cannot be the default of a
  *process-wide* accelerator: macOS spends `Cmd+W` on its own close-window
  command, so claiming it globally takes the chord away from every other
  application instead of only closing this window. `Mod+W` is therefore the one
  key the toggle must not hold.
- The catalog now ships `toggleWindow` on `Alt+Shift+W` — no platform modifier,
  so it is one chord on macOS, Windows, and Linux — which collides with no
  shipped default, no reserved editing chord, and no platform command. The
  merge, the hide/show semantics, and the fold of the retired
  `closeWindow`/`summonWindow` overrides stay exactly as D438 defined them.
- On macOS `Mod+W` is now also refused to plugins (`isReservedKeybinding`), so
  the platform keeps the chord it owns even though the app no longer uses it.
- A stored `toggleWindow` value that only repeats a default this release ships
  or already superseded carries no user intent, so the fold drops it: a profile
  that persisted the short-lived `Mod+W` default moves to `Alt+Shift+W` instead
  of freezing the macOS chord, while a real rebind (`Ctrl+Alt+T`) and an
  explicit unbind (`null`) survive untouched, and a retired customization still
  wins over a dropped superseded default.
- The number is D439 because D435 and D437 were already claimed by other
  in-flight work. **Note**: this log currently carries two `D438` entries — the
  window-toggle merge above (#360, the pre-rebind decision) and the Git-checkout
  decision (ADR 0273) near the end of the file. The latter was appended after the
  toggle's D438 had merged, so its number needs to move to D440 or the next free
  id; this entry does not rewrite another decision's text.
- See ADR 0211 (amended again), `04-ux/09-interaction-patterns.md` §1.1 and
  §1.4, `04-ux/06-settings-ia.md` (shortcuts tab), `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`, E2E-072, and
  `apps/desktop/test/window-toggle-shortcut.test.mjs`.

## 2026-09-10 — Remove diagnostic timing log streams (D385)

- The timing-only process log streams introduced by D137/D183 are retired:
  sidecar `[timing]` records, host `tool timing` records, boot phase timing,
  updater timing records, the dedicated `timing` category, and
  `PI_DESKTOP_TIMING` are no longer emitted.
- Key lifecycle, state-change, permission, tool, plugin, provider, persistence,
  updater, and error records remain. Existing audit fields and UI/protocol
  duration metadata remain unchanged because they support security forensics,
  transcript presentation, and bounded provider diagnostics rather than verbose
  process logging.
- Existing timing files are historical local data and are not deleted or
  migrated automatically.

## 2026-09-11 — Agent extensions are a plugin contribution (D388)

- D387 shipped ExtensionAPI modules as a second surface with its own
  registry, settings tab, and enablement store. The maintainer wants one
  surface: a pi CLI extension should become a PI-Desktop plugin and be
  installed, enabled, scoped, and shown like one.
- Decision D388 / ADR 0215 amends D387: modules are declared as
  `contributes.agentExtensions` and gated by the new high-risk permission
  `agent.extension`; the manifest is invalid without it, and a plugin whose
  recorded grants omit it loads with the modules skipped and audited.
  Enablement and project scope are the plugin's. "Import pi extension"
  copies a pi CLI extension into `<dataDir>/plugins/imported/<slug>` with a
  generated manifest and registers it as a development plugin; the confirm
  before the picker is the trust decision. The standalone registry, its
  store file, the Settings destination, and the list / enable / rescan /
  add-path / remove channels are removed; the plugin row shows the
  `agentExtension` capability, the permission, load state, registered
  names, and diagnostics. The sidecar loader, Runner, hooks, command and
  prompt bridges are unchanged. Marketplace distribution of plugins holding
  `agent.extension` waits for signing. Spec 16 §1 to §3, §10.2, §11;
  E2E-241 to E2E-245 re-executed on plugin-form fixtures.

## 2026-09-10 — DeepSeek reasoning_content replay on aggregators (D389)

- DeepSeek thinking mode requires every replayed assistant message to include
  `reasoning_content`. Turns that produced no thinking still need the field as
  `""`; omitting it returns HTTP 400.
- pi-ai auto-detects that flag only when `model.provider === "deepseek"` or the
  base URL contains `deepseek.com`. PI-Desktop stores a UUID as `model.provider`,
  so SiliconFlow, Volcengine, custom proxies, and other aggregators never match.
- Decision D389 amends D024: Completions rows whose `vendorKey`, URL, model id,
  or catalog `family` identifies DeepSeek receive
  `requiresReasoningContentOnAssistantMessages: true`. `thinkingFormat` is not
  changed by that match, so OpenRouter and other aggregators keep their existing
  thinking wire shape. See E2E-005E and `03-runtime/11-provider-model-system.md`.

## 2026-09-10 — Regenerates truncate under the host RPC lock

- Retry, regenerate, and edit-resend used to load the whole transcript in
  Electron main, archive the discarded tail, and `session.replaceMessages` the
  kept prefix. That JSON-RPC line is one NDJSON record: an 80 MB session both
  exceeds the 64 MiB stdin cap and races the 130 s client deadline, leaving
  `turns.status = running` after the UI has failed (issue #211).
- `session.truncateFrom` now performs the cut, the leftover-turn abort, and the
  discarded-branch archive inside one host call. `agent/prompt` loads only a
  bounded `session.get` for launch configuration.
- Oversized control-pipe lines are drained and answered with `LIMIT_EXCEEDED`
  instead of ending the stdin reader.
- Decision D390 and ADR 0216 define this. See
  `03-runtime/04-data-storage.md` §4.9/§7,
  `03-runtime/06-host-rpc-protocol.md` §4, `03-runtime/01-ipc-protocol.md`,
  and E2E-246.


## 2026-09-11 — Host stdout sender must not outlive serve

- ADR 0216 stopped regenerate from shipping the kept transcript and stopped an
  oversize line from killing the stdin reader. On Windows that was not enough:
  the Alt+Space hook held a strong stdout sender, so after stdin ended the
  writer thread never stopped, host-core stayed alive, and Electron reported
  `host RPC timeout: session.replaceMessages` (issue #211).
- The hook now stores a weak sender. Serve waits at most 5 s for the stdout
  writer. Electron rejects a request line over 64 MiB before writing.
  Host-side `LIMIT_EXCEEDED` peeks the JSON-RPC id from the truncated prefix.
- Decision D391 and ADR 0217 define this. See
  `03-runtime/07-process-model.md`, `03-runtime/06-host-rpc-protocol.md` §7,
  and E2E-247.

## 2026-09-11 — Selection overlay for quotes (D-LOCAL-selection-overlay)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- Quote no longer has to be reached at the end of the answer: a non-empty text
  selection inside one transcript row floats one overlay **above** it, centered
  on the selection and clamped into its clipping ancestors' rects (the transcript
  scroller is one) and capped by the top of the docked composer. It is portaled
  like the app's other body-portaled popovers and follows the selection while the
  thread scrolls, rather than hiding.
- The overlay offers Add to chat (`chat.addToChat`), Ask in side chat
  (`chat.askInSideChat`) and Copy (`chat.copy`). Add to chat writes the excerpt
  into the active session's composer draft under D-LOCAL-message-quotes's quote contract; Ask in
  side chat forks at that row and sends the excerpt as that child's prompt, so
  the question is answered in the panel instead of the visible conversation; Copy
  writes the Markdown to the clipboard. Every action clears the native selection,
  a drag that crosses rows raises no overlay, and a read-only projection renders
  none.
- The excerpt is recovered from the rendered DOM instead of
  `Selection.toString()`: a range touching a formula expands to the whole formula
  and quotes KaTeX's `application/x-tex` annotation as `$…$` or `$$…$$`; a code
  block becomes a fence with its language and a delimiter longer than any
  backtick run inside it; a table row becomes one `a | b` line; inline code keeps
  its backticks and file-reference chips keep their code text. The row action and
  the overlay share this one recovery path.
- The 2000-character cap, the `> ` blockquote, the `chat.quoteSource`
  attribution, focus, and the no-send/no-session/no-transcript-write boundaries
  are unchanged. Two deviations from the reference implementation are deliberate,
  because the quote lands in a Markdown draft this app renders back: formulas use
  `$…$` / `$$…$$` (remark-math), and table rows use `a | b`. Renderer-only; no
  protocol, storage-schema, IPC, or permission change beyond the composer's
  `data-composer-dock` hook. See ADR message-quotes-and-side-chats and E2E-CHAT-quote-prefill, E2E-CHAT-selection-markdown, E2E-CHAT-selection-side-chat.

## 2026-09-11 — Response annotations as prompt attachments (D-LOCAL-response-annotations)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- Selecting text in an assistant turn and choosing Add to chat attaches a
  **numbered annotation** to that turn: an id, the anchored turn, the excerpt
  (Markdown, 2000-character cap), an empty comment field, and capture order as
  the numbering. Annotations are renderer-owned session state; re-annotating the
  same excerpt is a no-op, and they are neither persisted nor sent on their own.
- The answer body is left alone: this app never inserts a marker into the text the
  user reads. A `:codex-annotation{index="N"}` directive the model writes (the
  instruction asks it to cite every annotation it addresses) renders as a small
  numbered reference whose tooltip is the excerpt, and no marker joins a
  selection, quote, or copy. The composer shows one attachment chip with the
  count, whose tooltip lists `N. excerpt`, plus one control that drops them all.
  The chip never enters the editable text, so D209's smart Stop and D301's draft
  retention are untouched.
- A send with annotations composes `# Response annotations:` + the instruction +
  `<response-annotations>` with `[{"text","annotation","source":{"messageId"}}]` +
  `## My request:` + the user's text, and consumes them. The visible draft, the
  optimistic row, the sidebar title, and the edit seed stay annotation free; a
  stored prompt that carries the block is displayed as its request.
- Quoting a user message and the side chat's Add to main chat keep D-LOCAL-message-quotes's draft
  quote. No protocol, storage-schema, IPC channel, or permission change. See
  ADR response-annotations and E2E-CHAT-annotation-attachments, E2E-CHAT-annotation-session-state.
- *(Amended 2026-09-12.)* Add to chat, and the assistant turn's annotate action,
  open a compact comment editor instead of attaching silently: the excerpt is
  snapshotted before focus collapses the selection, the comment is multiline and
  optional, Save attaches or updates the annotation with the comment in
  `annotation`, and Cancel/Escape discards it without sending. Re-annotating an
  excerpt that is already attached reopens that annotation's editor, and the
  composer's count chip opens a list where each excerpt's comment can be edited
  or that item removed beside the existing clear-all. The editor belongs to the
  session it was opened in, and a save for an annotation that was already sent
  or removed changes nothing. No protocol, storage-schema, IPC channel, or
  permission change.
- *(Floating-index amendment, ADR floating-annotation-index.)* The user-requested collapsible floating
  index replaces the composer popover. Matching source badges and non-interactive
  highlights use renderer-only text offsets, never inserted Markdown. Locate reveals
  history and releases follow mode; duplicate identity now includes source row and
  selected occurrence. List/badge/prompt numbering stays identical. Send-scoped
  lifecycle and host boundaries remain unchanged. See E2E-CHAT-annotation-source-index.
## 2026-09-11 — Right panel uses a tab strip and data-driven add menu (D399)

- Issue #229 replaces the right panel's combined resource menu with a
  horizontally scrollable header tab strip and a fixed tight `+` trigger. Only
  the strip scrolls; tabs use ARIA tab semantics, close on their own hover or
  focus affordance and middle-click, and keep the active resource in view.
- The `+` menu has one **Tools & panels** group: host-owned Review followed by
  the current scoped `contributes.views` metadata. Files and Browser remain
  plugin data rather than a renderer hardcoded list. Shortcut labels are
  conditional on a real binding. The same list is used by the no-tab New
  launcher, so closing the final tab keeps the panel open instead of hiding it.
- The viewport-fixed toggle remains the sole collapse control and keeps the
  existing customizable `Mod+J` binding. Its icon has explicit collapsed and
  expanded states, and its localized tooltip/accessibility name includes the
  resolved binding when present.
- A new profile starts with a 360px panel width inside the existing 244–720px
  range; persisted widths are left unchanged. No protocol, storage schema,
  plugin manifest, or native-window reservation changes. ADR 0224, UX §4–§5,
  and E2E-056 define the shipped behavior.

## 2026-09-11 — Reserve chat width for composer controls (D401)

- MainPane and its chat surface retain a 515px minimum when the sidebar or
  in-flow work panel changes width. Side docks cannot consume or paint over the
  reserved composer space.
- The composer toolbar stays on one row with non-shrinking left and right
  control groups. Mode and permission labels remain single-line and ellipsize
  inside their chips when localized text is longer than the label slot.
- No IPC, storage, or native-window reservation changes. See ADR 0226 and
  E2E-168.
- D408 supersedes the live 515px floor with a 450px MainChat floor.

## 2026-09-11 — Long-press the project title to reorder (D402)

- Retained project groups no longer render a reorder grip. A 400ms still
  press on the project title arms a pointer reorder; pointer travel beyond
  8px before that delay cancels the press so a click still selects the
  project and toggles collapse.
- After the title is armed, moving the pointer highlights another group in
  the same pinned/archived bucket; release inserts before or after that
  group from the pointer's vertical midpoint. ArrowUp/ArrowDown on the
  focused title is the keyboard path, and Escape cancels an active drag.
- Reordering still writes contiguous normalized-path `order` values and
  switches the renderer-local project sort to `manual`. Host workspace
  identity, session ordering, and on-disk directories are unchanged.
- Decision D402 amends D399 / D093 / ADR 0227. See ADR 0228 and E2E-253.

## 2026-09-11 — Press-and-move project title reorder (D403)

- Mouse and pen reorder by pressing the project title and moving 8px. A
  click with no qualifying movement still selects the project and toggles
  collapse. Touch does not start a reorder so the list can scroll.
- An accent insertion line shows before or after the target group from the
  pointer's vertical midpoint. ArrowUp/ArrowDown and Escape are unchanged.
- Decision D403 amends D402 / D093 / ADR 0228. See ADR 0229 and E2E-253.

## 2026-09-11 — Skill ships with the Agent core tool set (D404)

- `Skill` joins the Agent-mode core tool set, so its schema is present on the
  first provider request whenever the skill catalog is non-empty. It is no
  longer part of the deferred catalog and never appears under `# On-demand
  tools`.
- Registration is unchanged: the tool exists only with a non-empty catalog, and
  Plan and Goal still omit it entirely. Every other on-demand capability and
  `ToolSearch` itself keep their lazy behavior.
- Decision D404 amends D174 / D185 / ADR 0048 / ADR 0219. See ADR 0230 and
  E2E-254.

## 2026-09-11 — Ideographic comma opens the slash menu (D405)

- A `、` committed as the first character of an empty composer draft is
  rewritten to `/` before trigger detection runs, so a Chinese IME reaches the
  ordinary slash menu without switching input methods.
- Only that position is rewritten: a `、` anywhere later in the draft stays
  ordinary punctuation, and the `@` file menu is unaffected.
- Decision D405 amends D123 / D139 / ADR 0024. See ADR 0231 and E2E-255.

## 2026-09-12 — Keep macOS DMG opening guidance text-only (D406)

- macOS DMGs expose `PI-Desktop-macOS-opening-help.txt` with the Finder label
  `If app won't open, read this.txt` and no longer include or expose the executable
  `PI-Desktop-macOS-open.command`.
- macOS ZIP packages retain both the opening note and the executable helper.
  The note provides the narrow Terminal fallback for trusted unsigned builds;
  signed and notarized builds do not need it.
- Decision D406 amends D371 / ADR 0204. See ADR 0232 and E2E-196b.

## 2026-09-12 — Restore archived projects after session import (D407)

- A core or plugin import that adds a new project-bound session clears the
  renderer's archived presentation state for that session's normalized project
  path during the import-triggered refresh.
- Pathless sessions, skipped imports, history-only plugin paths, and ordinary
  refreshes preserve archive state. The host model and all existing IPC,
  plugin, storage, and data-format contracts remain unchanged.
- Decision D407 records the issue #250 fix. See ADR 0236 and E2E-257.

## 2026-09-13 — Prioritize MainChat in the three-column shell (D408)

- The in-flow shell treats MainChat as the first-priority column: a hard 450px
  minimum, a panel capped by the live budget (`client width - 450px - expanded
  sidebar`, no fixed maximum), and an expanded sidebar that yields at the
  threshold while its
  exit animation still counts toward the shared budget.
- A manual sidebar reopen spends work-panel width first and otherwise targets
  460px. Closing the panel restores only a sidebar the layout collapsed; a
  manual collapse stays collapsed.
- The native window never participates: the reservation seam stays at zero and
  no panel width or x-offset geometry is applied.
- Preview mode unmounts MainChat and gives the client area to the work panel
  beside the sidebar. AppShell supplies a window-level chrome row for shell
  actions and native controls; macOS reserves 88px in windowed mode and 8px in
  fullscreen when the sidebar is collapsed.
- Decision D408 records the issue #267 behavior. See ADR 0238 and
  E2E-LAYOUT-three-column-width-priority.

## 2026-09-13 — Host-owned session collaboration messages (D409)

- Rust host-core owns a durable ledger for plugin-mediated messages between real
  Session IDs. A delivery is bound to its actual durable target turn before
  execution, and the result is derived from that turn's persisted terminal
  state rather than assistant-text polling.
- The reviewed plugin gateway authenticates the source from the active Agent
  tool invocation. Existing target sessions retain their project, model,
  context, and permission configuration; new workers inherit the initiating
  session's project and permission ceiling.
- Completion callbacks are durable and at-most-once. Session-message
  provenance is persisted with transcript rows and is immutable across
  replacement or regeneration. Restart recovery retains queued work but never
  replays an unclaimed or interrupted turn automatically.
- Decision D409 amends ADR 0237, ADR 0165, and ADR 0213. See ADR 0239 and
  E2E-PLUGIN-session-orchestrator-real-workers.

## 2026-09-13 — Independent session discovery and navigable collaboration projections (D410)

- The reviewed plugin gateway exposes a bounded `session/collaboration/list`
  read for non-deleted Agent sessions, including sessions created outside
  Session Orchestrator. It returns no project paths, credentials, transcripts,
  or message previews; `send` continues to use the real Session ID and the
  existing host authorization path.
- Sidebar collaboration summaries now carry readable provider/model labels and
  bounded creator/created-session references. The renderer presents those
  references as keyboard-focusable navigation buttons and opens the durable
  session through the existing selection path.
- Decision D410 amends ADR 0239. See ADR 0240 and
  E2E-SESSION-independent-top-level-communication /
  E2E-SESSION-hover-card-model-and-links.

## 2026-09-12 — Steer the active turn with Alt+Enter

- Normal Send/Enter remains a Host-owned follow-up; Alt+Enter submits input to
  the current durable turn using a required expected turn id.
- Reuse pi-agent-core steering at the next model-request boundary, preserve
  started tools, and retain the active model/workspace/permission configuration.
- Stop and ended targets reject without redirecting input to another turn.
  Accepted input remains history without independent replay after cancellation.
- Journal accepted user input with a provisional preceding reply when needed;
  finalize only an indexed streaming assistant in place and retain completed
  message idempotency. See ADR active-turn-steering and E2E-AGENT-alt-enter-steers-active-turn.

### Unified transcript reading and complete search navigation

[ADR transcript-reading-ownership](/adr/transcript-reading-ownership) amends
[ADR session-content-search](/adr/session-content-search) with one renderer
reading view for ordinary history and search, shared by MainChat and the subagent
dock. Live/model caches remain canonical. Nested targets receive capped parent
Task context through additive `navigationParent`; parser source offsets locate
hidden Markdown and file-chip matches. Read ownership rejects interrupted pages,
and explicit message actions hydrate canonical input when history is partial or
text is capped. Validation: E2E-SESSION-content-search-and-message-navigation.

## 2026-09-13 — Harden session collaboration navigation and delivery

- Collaboration references now carry `available`. A reference to a session that was
  deleted or is otherwise gone is reported with `available: false`; the renderer renders
  it as text instead of a navigation control, and opening a session that no longer exists
  reports a visible error instead of committing an empty transcript.
  `session_collaboration_messages.source_session_id` intentionally has no foreign key, so
  a delivery record survives deletion of its sender and is reported as unavailable.
- The six `session/collaboration/*` operations are first-party-plugin-only: they require
  an authenticated plugin tool invocation context, so they are excluded from the
  MCP-visible catalog while remaining available through `pi.desktop.listOperations` and
  `pi.desktop.invoke`. This amends the "same reviewed operation catalog" claim of
  ADR 0203 / D370 and the `desktop.control` row of the plugin permission matrix.
- Settling a delivery now asserts that the conditional `queued` to `running` claim
  actually changed a row, so losing that race cannot create a second turn for one
  delivery, and `spawn` evaluates its worker limits inside the same transaction as the
  session insert.
- Electron delivery settlement no longer drops a settlement recorded before a host
  restart, and a drain that is already running picks up settlements queued during it
  instead of deferring them to an unrelated trigger. A persisted delivery failure keeps a
  stable `CODE: message` form.
- Review fixes for the orchestration refresh path bound the model-catalog lookup work per
  read instead of relying on cache eviction, and replace E2E boot conditions that could
  not fail with observations the probe does not itself guarantee.
- See ADR 0239, ADR 0240, E2E-SESSION-hover-card-model-and-links.

### Global sidebar conversation pins (issue #306)

[ADR global-sidebar-pins](/adr/global-sidebar-pins) amends ADR 0016: conversation
pins occupy one global section above standalone and project history, including
closed or collapsed projects. Archive visibility and session sorting still
apply. Pins carry project context and are removed from normal history before
date grouping and row limits. Persisted metadata and host ownership stay intact.
Validation contract: E2E-SIDEBAR-global-pinned-conversations.

## 2026-09-13 — Vendor the file view as an updatable plugin (issue #304)

- The work panel's file view is no longer `pi.files`. It is a vendored copy of
  the third-party `pi.file-manager` release, shipped from
  `apps/desktop/resources/plugins/` and recorded in its own `UPSTREAM.md`. The
  old plugin is removed, and host-core drops its stale registry row on the next
  launch.
- Bundled means default and non-removable, not frozen: a bundled plugin can be
  updated from the marketplace, that update survives the next launch, and a
  build that ships a strictly newer version still wins. `uninstall` refuses by
  ID against what the build ships, not by the row's `source`, so an updated
  plugin stays uninstallable and a plugin dropped from a build is removable
  again.
- A marketplace entry is offered as an update only when it is strictly newer.
  Equality is not an update, and an older catalog version is not one either.
- Editing writes stay inside the plugin's own process, which keeps the workspace
  path jail, atomic writes, conflict detection, and its write audit. The host
  gateway does not mediate them: a manifest cannot declare a whole-tree write.
- See ADR 0241 (supersedes ADR 0105), ADR 0104, E2E-153,
  E2E-PLUGIN-bundled-plugin-keeps-a-marketplace-update.

## 2026-09-14 — Delta-only coalesced streaming updates (D412)

- Append-only `message_update` frames carry `stream: "delta"` and the new
  chunk only. Growing `content`/`thinking` stay in the runtime accumulator and
  in `message_end`. Retry replacements still send a full snapshot.
- A 16ms coalescer concatenates pending deltas and flushes before tool,
  terminal, abort, error, and retry events so order is preserved.
- AgentHost applies deltas to live items and skips a hot-path `JSON.stringify`
  for small delta frames. Inflight checkpoints reconstruct the snapshot from
  the same deltas. The renderer concatenates same-frame deltas, then patches
  the live row. Unchanged activity parts keep object identity.
- Protocol version remains 11. See ADR 0242, E2E-STREAM-long-turn-keeps-realtime,
  and issue #299.

## 2026-09-13 — Skill market public-HTTPS catalog fetch (D413)

- Skill Market search/fetch run in Electron main. Renderer CSP still forbids
  the network. Install is existing `skills.create`.
- Shared `isSafePublicHttpsUrl` / `isPublicHostname` / `isPublicIpLiteral` are
  the syntactic classifier. Main re-checks DNS and every redirect hop.
- Scanned ids are sanitized to host `valid_capability_id`. Preview shows the
  assembled body; over 128 KiB is not written.
- See ADR 0243, E2E-SKILL-MARKET-NET-BOUNDARY / EXPANSION / INSTALL / ID-ALIGN,
  and issue #287.

## 2026-09-14 — Harden the MCP market public-network boundary (D414)

- MCP market source and catalog endpoint validation is shared by Renderer and
  Electron Main. It accepts credentials-free public HTTPS only and rejects
  loopback, private, CGNAT, link-local, multicast, reserved, documentation,
  benchmark, ULA, and site-local address ranges, including mapped and
  compatible IPv6 forms.
- Main resolves each hostname immediately before the request and pins the
  selected public address to the HTTPS socket. Redirects are followed manually,
  checked and pinned at every hop, and limited to five hops. Source responses
  are capped at 4 MiB, calls accept at most 16 sources, and browse/search
  caches are bounded by age, key count, and entry count.
- Registry npm/PyPI package versions and runtime/package arguments are retained
  in install templates. Only `streamable-http` public HTTPS remotes are mapped;
  remote header placeholders become explicit install values. Cross-origin MCP
  redirects do not forward caller headers.
- Manual user-owned MCP configuration keeps ADR 0142's explicit local/LAN
  endpoint policy. See ADR 0245 and E2E-MCP-MARKET-*.

## 2026-09-14 — Opt-in subagent inheritance of the parent tool catalog (D415)

- A subagent definition may declare `tools: inherit` (alone or with assignable
  extras). Builtins stay on today's whitelist.
- At spawn the runtime unions the live `toolCatalog` minus Task*, mode
  switches, `asktool`, `new_context`, and `ToolSearch`. Skill/MCP/plugin tools
  the parent is allowed to call are included; child ToolSearch/new_context do
  not mutate parent runtime state.
- host-core keeps the `inherit` token so inherit-only documents load and
  Settings round-trips them. See ADR 0246, issue #215, PR #319, and
  E2E-SUBAGENT-inherit-parent-tools.

### Tray session shortcuts (issue #293)

[ADR tray-session-shortcuts](/adr/tray-session-shortcuts) amends the D216 native
tray menu with Running, Unread, and Pinned groups after global priority
assignment: each non-empty group keeps up to three rows, then overflowing groups
reclaim the share smaller groups leave unused, in priority order, up to nine rows
in total. Host session/inbox reads and runtime events remain the
source of truth; renderer organization is mirrored without a persistence
change. macOS single-click opens the menu without restoring the window;
selection is delivered after bootstrap and uses normal session navigation.
Validation contract: E2E-TRAY-bounded-session-navigation.

## 2026-09-14 — Preserve local annotation and side-chat contracts across upstream integration

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- Local ADRs now use semantic names `message-quotes-and-side-chats`,
  `response-annotations`, and `floating-annotation-index`; former local 0223–0225
  collided with upstream ADRs. Local D398–D400 references use `D-LOCAL-*`, and
  local E2E-249–259 references use `E2E-CHAT-*`. Upstream identities are unchanged.
- Upstream transcript modules, composer hooks, store slices, delta streaming,
  work-panel tab strip/launcher, and text-only Alt+Enter steering remain canonical.
  Quote/annotation controls and side-chat registrations have no upstream equivalent
  and remain renderer-owned additions at those seams, not duplicate legacy modules.
- Send/queue consumes only acknowledged unchanged annotations in the submitting
  session. Failures retain them; concurrent edits/new attachments survive. Steering
  leaves annotations pending, and annotation-only steering submits nothing.
- Request-only queue previews/edit seeds hide the recognized annotation block;
  ordinary headings and stored/wire content remain intact. Editing does not restore
  consumed attachments. No native Pi session unification is introduced.
- See ADR response-annotations and E2E-CHAT-annotation-ack-and-steering.

## 2026-09-14 — Native Pi session continuation (D421)

- Native Pi v3 sessions are discovered as source-discriminated projections and
  continued through the coding-agent SDK against their original JSONL.
- Rust host-core remains authoritative for Desktop SQLite and Desktop
  transcripts; native turns never enter the Desktop outbox or create imports.
- Exact version/newline/cwd/trust/provider/auth checks and a cooperative lease
  with byte/leaf validation make uncertain ownership fail closed. Unsupported
  native mutations remain explicit rather than silently succeeding.
- See ADR 0254 and E2E-SESSION-native-pi-*.

## 2026-09-14 — Git clone accepts only syntactically public hosts (D416)

- Home Clone git project still accepts https/http/ssh/`git@host:path` remotes
  without embedded passwords or `file:` URLs.
- Hosts are classified with the shared `isPublicHostname` helper used by the
  market guards. Private and loopback literals fail in the parser.
- Git's own DNS/SSH is unchanged; there is no Electron Main pin.
- See ADR 0247 and E2E-CLONE-public-hostname-rejects-private.

## 2026-09-14 — Theme CSS validation only inspects CSS that runs (D417)

- The `ui.theme` sanitizer masks comment bodies and string literals before the
  `@import`, markup, and script keyword checks, one space per masked character so
  offsets still point at the source, and keeps every `url(...)` argument verbatim
  so a real reference is still judged by its target.
- A character-level three-state scan, not a `/* … */` strip: in
  `content: "/*";` the browser sees a string, and a naive strip would read a
  comment there and hide the real `@import "x.css";` behind it.
- `examples/plugins/hello/themes/midnight.css` loads again. Only the false
  rejection narrows: no new capability, no format change, and sheets that never
  name a banned token behave exactly as before. See issue #334 and E2E-024J.

## 2026-09-14 — Themed package assets and native window backgrounds (D418)

- `contributes.themes[].assets` declares package-relative image and font files
  (whitelisted extensions, 4 MB summed). The host resolves each inside the plugin
  package, refuses the dependency directory, rewrites every matching `url()` to
  `plugin-asset://<pluginId>/<path>`, and serves it through a privileged
  host-owned scheme whose handler answers only from the loaded plugin's declared
  list. An undeclared reference is still refused and the raw path never reaches
  the renderer, so the `data:`-only rule and every existing rejection are
  unchanged. Permission stays `ui.theme`.
- `contributes.windowAppearance.backgroundColor.{light,dark}` accepts
  `#rrggbb` / `#rrggbbaa` behind the new `ui.window.appearance` grant. It applies
  only while one of that plugin's themes is the selected theme and only off
  macOS, and it is restored by derivation: the renderer recomputes the colour
  from the persisted preference and the live catalog, so a switch, a disable, and
  an uninstall all converge on the host palette with no stored value to unwind.
- Built-in themes reach the same value through one shared table
  (`packages/shared/src/theme.ts`): `BUILTIN_THEMES` holds each palette's
  `windowBackground` once and `isThemeColorScheme` holds the built-in-id
  question once, read by the renderer, main, the panel host, the panel preload,
  and the theme picker. The pair `#ffffff` / `#181818` was restated in four
  files before this, so the built-in and contributed paths could drift apart.
  See ADR 0248, issue #335, and E2E-024J.

## 2026-09-14 — The dock column is a token, not a literal (D419)

- The work-panel column and the bars inside it take their surface from
  `--ds-bg-dock` and `--ds-bg-dock-raised`. In light those are `#fafafa` and
  `#ffffff`; in dark they are `var(--ds-bg-secondary)` and `transparent`, which
  is exactly what the base rules resolved to before.
- Six `:root[data-theme="light"]` literals in `work-panel.css` used to raise
  specificity above the base rule *and* skip the variable, so the whole column
  stayed host-coloured under any contributed theme. Those overrides are gone.
- The design-system surface table now records both tokens, and §6.4 states the
  rule they exist to enforce: a surface colour the shell paints must come from a
  token. A literal inside a `:root[data-theme]` override is the failure mode.
- Same class of hole remains in `settings.css` (rail, search fields, toggle
  knob, capability search) and a few other sheets; see issue #339.

## 2026-09-14 — Structured, bounded, and redacted process logs (D420)

- Every app/host/agent NDJSON record has a stable dot-separated `event` and
  top-level correlation fields. A normal tool call emits one completion or
  failure record; an unexpected sidecar exit emits interruption records for
  active tools. The tool protocol and transcript remain unchanged.
- Central logging redacts credential formats, sensitive keys, and local paths;
  bounds strings and structured values; and caps each record's `data` at 8 KiB.
  Host-core audit payloads receive corresponding shaping and a serialized
  payload cap.
- Tool results retain outcome, error/code, duration, field names, content-block
  count, and stdout/stderr sizes rather than copying raw arguments, output, or
  plugin responses. Child stderr and main-process fallbacks use stable events;
  development console mirrors contain the same sanitized record.
- See ADR 0250 and E2E-034.

## 2026-09-15 — Deleting a project removes its owned sessions (D421)

- `projects.remove({ path })` is the new additive host RPC. It removes one
  durable project row, every session attached to that row, those sessions'
  transcript/scratch/review files, and the project's durable memory, and it
  never touches the project folder on disk. An unknown path returns
  `{ removed: false, sessionsRemoved: 0 }` instead of an error, and the desktop
  removes its own record for that path anyway: a stale recent-project entry is
  the only thing that can keep such a row visible.
- The Projects index is a union of four sources (group projections of durable
  rows, `pi.desktop.recentProjects`, session-derived projects, and the active
  workspace). Deletion therefore removes the renderer-local record in the same
  action; deleting only the database row leaves the row visible, which is why
  the previous manual workaround also required clearing renderer storage.
- A path that is a root of a stored multi-folder project group is refused with
  a message so the group keeps a valid primary root; legacy single-root
  projections delete normally.
- The delete is refused while any attached session has a running turn (1008 /
  `CONFLICT`, "project has running sessions"): a live turn still owns its tools
  and working directory and is still appending to its transcript, so the bulk
  delete waits for the project to be idle instead of resurrecting a stub
  session afterwards. The renderer blocks the same action up front with
  `project.deleteRunningBlocked`. Single-conversation delete keeps its current
  semantics.
- The action is deliberately absent from `CONTROL_OPERATION_SPECS`, so local
  MCP control cannot delete projects. See ADR 0251 and
  E2E-PROJECT-delete-removes-project-and-owned-sessions.

## 2026-09-13 — Host turn-end event for plugins (D422)

- `session:turnEnded` is delivered to plugin processes, plugin panel pages, and
  docked views with `{ sessionId, turnId, reason }`, where `reason` is
  `completed`, `aborted`, or `error`, once per turn actually started by
  `session.beginTurn` (a user submission, an approved plan execution, or a
  scheduled run).
- The announcement runs at the end of turn teardown, after the durable
  `session.endTurn` attempt, and carries the `turnId` of the terminal runtime
  event rather than whichever turn is active. The plugin tool context's
  `turnId` is populated with the same identity, forwarded from the host.
- The finalizer is the single entry every terminal path funnels through and it
  requires an explicit `turnId`: a terminal event that carries none, or one
  whose turn no longer owns the session, settles nothing and announces nothing.
  The turn's record is keyed by `(sessionId, turnId)`, so a repeat terminal
  event joins the first claim instead of announcing twice.
- The event needs no permission, has no ack and no replay, is not guaranteed
  across plugin crash, reload, or host quit, and does not prove that every
  in-flight tool of the turn has exited. No published host emits it yet: the
  release that ships it has not been published.
- Decision D422 is recorded by ADR 0252.

## 2026-09-15 — Remove the subagent turn limit (D423)

- `maxTurns` was the last definition-level kill switch left after ADR 0166
  withdrew the idle and duration watchdogs, and the parent cannot size it: it
  cannot see the delegate's live work, so it cannot tell a delegate that is one
  turn from converging from one that never will. The shipped backstops (60, 50,
  40, 80) had no derivation, and the editor's own starting state was unlimited.
- Decision D423 removes the field from `SubagentDefinition`, the frontmatter
  parser, `UserSubagentRecord` / `UserSubagentInput`, the host-core registry,
  the five built-in documents, `SUBAGENT_PRESETS`, and the Subagent editor's
  Advanced disclosure. A delegate ends only when it finishes, when the parent
  calls `TaskStop`, when the user Stops, or when a terminal parent error aborts
  it.
- An existing document that declares `maxTurns` keeps loading: the key is now
  unrecognized frontmatter and is ignored exactly like any other unknown key,
  with no error, no warning, and no rewrite of the user's file. A definition
  that relied on the cap therefore loses it silently.
- The `truncated` subagent status leaves the shared run-status union, the
  renderer outcome union, the `chat.subagentStatus` catalog entry in every
  locale, and the delegation topology's warnings count. `timed_out` stays in
  the type even though D328 withdrew the watchdogs that produced it.
- No protocol version, schema version, or storage change: host-core's subagent
  input struct still ignores unknown fields, and the registry parses Markdown
  frontmatter rather than a table column.
- See ADR 0253, `03-runtime/02-agent-runtime.md` §5f,
  `04-ux/06-settings-ia.md` §7, E2E-155, and
  E2E-SUBAGENT-legacy-turn-limit-frontmatter-is-ignored.

## 2026-09-15 — Theme assets are absolute paths (D422)

- ADR 0248 required theme assets to be package-relative, which forced a plugin to
  copy a user-chosen image into its own package. A development plugin is watched
  recursively, so every copy reloaded the plugin and closed that plugin's panel
  window; the plugin's own data directory could not be referenced at all.
- `normalizeThemeAssetPath` (SDK) and `normalize_theme_asset_path` (host-core) now
  accept absolute paths only (`C:/art/bg.png`, `/art/bg.png`, or either spelled as
  a `file:` URL). Package-relative asset references stop resolving; themes that
  declared them are the only affected surface.
- `pi.themes.upsert` resolves asset references in the sheet and registers them in
  that plugin's asset map for as long as the plugin stays loaded, so a theme can
  pick up a new image without any file write inside the package.
- Unchanged: the extension whitelist, the summed 4 MB budget for declared assets,
  `.`/`..` rejection, the `url()` → `plugin-asset://` rewrite, `nosniff`,
  `no-store`, and revocation on unload. Absolute keys are percent-encoded in the
  URL and decoded by the handler.
- A plugin can now hand the renderer any local file it can read. Manifest-declared
  assets stay auditable in a static file; runtime-registered ones do not survive
  the plugin.
- See ADR 0255, `07-plugins/02-plugin-manifest-schema.md`,
  `07-plugins/04-plugin-security.md`, and ADR 0248 §1 (superseded for path
  resolution).

## 2026-09-15 — DeepSeek reasoning across compaction (D424)

- OpenCode / third-party DeepSeek relays reject empty `reasoning_*` echoes after
  context compaction drops assistant thinking (#296). Official `deepseek.com`
  still accepts `""` (#223 / D389).
- Decision D424 amends D389 / ADR 0136: restore `thinkingSignature` on history
  rebuild; stash recent thinking in checkpoint `details.retainedReasoning` and
  replay it after the summary; set `requiresNonEmptyReasoningReplay` for
  non-official DeepSeek Completions rows so the pi-ai patch fills a documented
  placeholder instead of `""`. See ADR 0256 and E2E-005E.

## 2026-09-15 — Plugin real-time capabilities (D425)

- Plugins gain four host-mediated capabilities: background microphone capture,
  background playback, system-wide accelerators, and real-time bidirectional
  connections. The host owns every device and transport; plugins exchange typed
  frames and never receive a device handle, a raw socket, or a Node stream.
- New permissions `audio.capture.background` (high),
  `audio.playback.background` (medium), `keyboard.globalShortcut` (medium),
  `net.websocket` (high), plus `contributes.globalShortcuts` (at most 8
  accelerator → own-command entries) as the declarative form. `ui.microphone`
  keeps its panel-scoped meaning and is not widened.
- Shortcut registration is refused rather than taken over:
  `SHORTCUT_CONFLICT`, `SHORTCUT_UNAVAILABLE`, `INVALID_ACCELERATOR`,
  `LIMIT_EXCEEDED`. An accelerator can only run one of the owning plugin's own
  commands — no key monitoring, no raw events, no hooks.
- Implemented in this change: `keyboard.globalShortcut` and `net.websocket`
  (host-owned sockets, confined to `manifest.net.domains`, bounded, and released
  with the plugin). The two audio permissions are declared, present in the
  plugin API, and gated: with the grant the host has no device backend, so every
  call is answered with a coded `UNSUPPORTED` refusal that is audited, until the
  device service lands. See ADR 0257,
  `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`, and
  E2E-PLUGIN-global-shortcut-owns-only-its-own-command.

## 2026-09-15 — Trusted extension custom agents (D426)

**Add the PI-Desktop `registerAgent` ExtensionAPI contract for trusted extensions. A plugin registers bounded model metadata and a `stream` or `complete` callback; the plugin owns endpoint and authentication. The sidecar exposes a redacted model registry, assigns `extension-agent:<encoded-agent-key>` ids, and routes idle `setModel` through Electron main to the existing host-owned `session.configure` binding. The host never receives or persists plugin transport credentials, and `registerProvider` is a compatibility alias for the same plugin-owned stream shape. See ADR 0258, `07-plugins/16-trusted-extensions.md`, and E2E-TRUSTED-EXTENSION-custom-agent-stream-and-binding.**

The pinned upstream pi-coding-agent package has `registerProvider` but no
`registerAgent`; the PI-Desktop member is therefore an explicit adapter contract,
not an unreviewed upstream registry passthrough.

## 2026-09-15 — Plugin-declared providers are Host-owned rows (D427)

**A plugin may declare `contributes.providers`, and the Host materializes each entry as a provider row in the native Settings → Provider list, owned by that plugin (`providers.owner_plugin_id`, schema v17; row id `plugin:<pluginId>:<declaredId>`). The declaration is re-read on every load and is authoritative for its own fields, so a dropped entry is deleted together with both credential references; `providers.update` / `providers.delete` refuse a plugin-owned row with `PROVIDER_OWNED_BY_PLUGIN`. A non-empty declaration needs the new high-risk `provider.register` permission, and an `oauth` block or `authKind: "oauth"` is refused until a Host-owned login flow exists. See ADR 0259, `07-plugins/02-plugin-manifest-schema.md` §5.4, `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/04-data-storage.md` §4.3/§7, and E2E-PLUGIN-declared-provider-appears-in-the-native-provider-list.**

It deliberately does not include plugin OAuth: the `provider.oauth` permission
and a Host-owned plugin login flow are future work, so a declared provider has no
OAuth login, token refresh, or account label today.

## 2026-09-15 — Side chats materialize on first Send (#421)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

Side-chat opening and selection quote prefill are renderer-only drafts. The
first explicit nonempty Send creates the anchored child, with concurrent
submissions deduplicated and failed drafts retained. Closing unsent drafts
creates no history; existing children remain. See the
[message quotes and side chats ADR](../../adr/message-quotes-and-side-chats.md)
and E2E-CHAT-side-chat-fork.

## 2026-09-15 — A tooltip never outlives its trigger (D428)

- **The shared tooltip hook in `apps/desktop/src/components/ui.tsx` gains one
  lifecycle contract: at most one themed tooltip is painted at a time
  (claiming the slot closes the previous owner), and a visible tooltip closes
  when its anchor unmounts, when the window loses focus, when the document is
  hidden, on Escape, or when the pointer that revealed it leaves the anchor.
  Every close also cancels a show that has not painted yet, so Escape or a
  window blur inside the delay no longer paints a tooltip on an unfocused
  window. A trigger that moves in the DOM within a quarter second without being
  replaced keeps the tooltip instead of blinking it, and a tooltip revealed by
  keyboard focus is not closed by unrelated pointer movement. The guard
  listeners (window blur, visibility, Escape, pointer) are installed once for
  the whole renderer instead of once per trigger. No delay, offset, placement,
  or text behavior changes.**
- **Row-level hover paint and hover-revealed row actions now follow the same
  "still relevant?" rule: an idle row's hidden overflow control is
  pointer-inert so the space it occupies belongs to the row — a click there
  opens the conversation, or activates and toggles the project group, as the
  title does — and a no-hover pointer gets the controls revealed under
  `@media (hover: none)` so it never meets a hidden target. A window that loses
  focus drops the row's and the project title's hover paint and hides the
  revealed actions instead of leaving them latched.**
- Renderer only: no protocol, storage, host, permission, or migration change.
  See `04-ux/09-interaction-patterns.md` §6.4 and §9.1c,
  E2E-UI-tooltip-never-outlives-its-trigger, and
  E2E-UI-row-actions-do-not-swallow-the-row-click.

Users reported a tooltip that occasionally never went away (the trigger
unmounted, the window lost focus, or the pointer left the window without a
leave event) and a session row whose hidden overflow control silently opened
its menu instead of the conversation.

## 2026-09-15 — Turn-queue priority block and row actions (D429)

- "Send now" becomes a priority block instead of a head jump: a promoted entry
  takes `MAX(priority) + 1` inside its session (schema v18, nullable `priority`),
  so several promotions are delivered in the order they were clicked and the
  waiting queue keeps its own `position` order behind them. Promoting an entry
  that already carries a priority is `CONFLICT`, not another move.
- The queued row gains move up, move down, and edit beside Send now and remove.
  Move up/down swaps a waiting entry with its adjacent waiting neighbour through
  `session.queueReorder` and never crosses the promoted block; editing removes
  the row and returns its captured draft (text plus inline file references) to
  the composer, and is refused while the input is non-empty.
- A promoted row is locked until the Host delivers it: move up/down, edit, and
  remove are disabled, and Send now reads as already decided.
- The promoted block is delivered as adjacent user messages: the first promoted
  entry starts the turn at the boundary and the rest are injected into that same
  turn through the steering channel, so the model answers once for the whole
  block instead of once per row. An injected entry's own turn is canceled; an
  entry the runtime refuses to accept stays queued and leaves at the next
  boundary as its own turn.
- A settled turn is authoritative for the queue. A terminal event can be dropped
  (Main never forwards one that names a turn it no longer owns) or never
  emitted, and a turn left active inside the Host held its session's queue
  forever — the "Send now, then Stop" stall. The settlement now closes the turn,
  and a drain request that arrives while a pass is running is retried instead of
  dropped. See ADR 0265, `03-runtime/01-ipc-protocol.md` (§5.6),
  `03-runtime/04-data-storage.md`, `04-ux/08-component-spec.md` (§11), and
  E2E-QUEUE-promote-orders-delivery-by-click.

## 2026-09-16 — A manual disclosure keeps the reader's place (D430)

- **A manual disclosure hands its own title to the scroller that owns it,
  synchronously, before the expansion state changes.** The content
  `ResizeObserver` still re-pins a pinned transcript on every content resize
  (D287) and cannot tell a stream from a reader expanding a row, so the reader
  states their intent first: the transcript leaves follow mode and the scroller
  restores that title's viewport offset from inside the same observer, for as
  many frames as the height keeps changing (an activity group animates its
  `grid-template-rows`). `overflow-anchor: none` on `.thread-scroll` means this
  has to be explicit.
- **The anchor is the title element's offset from the scroller's top edge, not a
  `scrollTop`, and the browser's own boundary clamping is adopted as the new
  anchor.** A correction the content cannot reach, and a height change above the
  title, are both handled without fighting the browser frame after frame. There
  is no delayed "take the bottom back" compensation: the hold ends on real scroll
  input, the jump-to-latest control, a new turn, or a navigation.
- **Every scroll owner holds its own position and passes the hold outward.** The
  transcript scroller and the nested delegate dock (`useFollowScroll`, D302) share
  one controller; growing the dock grows the transcript's content, so an outer
  scroller still in follow mode would drag the same title away.
- **Input is attributed to the scroller that can consume it.** Only input that
  really moves a container may release follow or a held position: a press on a
  row, a control or an editable field is an ordinary click, a keystroke in a text
  field belongs to the field, and input a nested scroller consumes is not the
  outer scroller's gesture. Arrow keys still scroll and Space still activates a
  focused title.
- **Programmatic immediate scrolling records the `scrollTop` the scroller
  actually reached**, and a sub-pixel tolerance is applied only to scroll events
  no gesture produced. At DPR 1.1 follow asked for 841 and got 840.909; compared
  strictly that fraction read as the reader scrolling up and dropped follow mode.
  Real gestures are still compared exactly, so a one-pixel scroll unpins.
- Renderer only: no protocol, storage, host, permission, or migration change.
  See `04-ux/09-interaction-patterns.md` §9.1 and
  E2E-CHAT-disclosure-toggle-keeps-reading-position.

Readers reported that clicking a tool, thinking or activity title to expand it
dragged the whole transcript up by the height of the opened detail, in a session
that was sitting at the bottom — including after the turn had finished.
## 2026-09-16 — The delete dialog, not the menu, owns the running-task refusal (#360, D431)

- Amends the renderer half of D421. The sidebar menu and the Projects index menu
  refused Delete project with a transient `project.deleteRunningBlocked` warning
  whenever any of the project's sessions was running, and returned before
  `ProjectDeleteDialog` was ever mounted. The refusal vanished with the toast
  and left no path forward, so a project with one live task could not be deleted
  at all — which is how #360 ("项目管理中无法真正删除项目") reads.
- Both menus now always open the dialog. Each surface passes the project's live
  running session ids (`runningSessions[session.id]`, over the rows it already
  matches: `entry.sessions` in the sidebar, `sessionMatchesIndexProject` in the
  index), and the dialog derives its copy from that prop on every render, so a
  turn that starts or finishes while the dialog is open is reflected before the
  user confirms.
- The dialog adds a warning line naming `{{count}}` running sessions and swaps
  its confirm label to `project.deleteRunningConfirm` ("Stop tasks and delete").
  Confirming aborts exactly those sessions and only then calls `deleteProject`,
  so removing a running turn stays a second, explicit confirmation of a stated
  consequence. Cancelling removes nothing.
- The host guard is unchanged: `projects.remove` still refuses with 1008 /
  `CONFLICT` while an attached session has a running turn, and the dialog still
  maps that refusal to `project.deleteRunningBlocked`. A turn that starts after
  the abort loop is what that fallback covers.
- Renderer only: no protocol, storage, host, permission, or migration change,
  and no new default. `project.deleteRunningBlocked` keeps its meaning, copy,
  and every translation. See ADR 0251, D421, and
  E2E-PROJECT-delete-running-sessions-are-named-and-stopped.

## 2026-09-16 — Plugin `workspace` fs roots follow the calling session (D432)

- Every plugin `pi.fs.*` call whose mode root is `workspace` resolved the one
  window-global visible workspace, so a plugin agent tool invoked from session B
  (project B) read project A's root as soon as the user switched tabs, and failed
  `NOT_FOUND` for every session at once when no workspace was visible (D093 fixed
  the same rule for built-in tool execution; it never reached a plugin).
- `plugin-runtime.ts` now resolves that root with a new private `fsRoot(loaded, rule)`
  helper: the project of the tool session that invoked the call, asked for through
  the additive host service `getWorkspacePathForSession`. `plugin-services.ts` wires
  it from the session-to-project map it already keeps, so no new source of truth is
  introduced.
- Unchanged: the visible workspace stays the root for a panel-bridge call, which has
  no tool session, and for a session the host does not track; a `userSelected` mode
  still keeps the directory the user picked through `requestDirectory()`.
- A session root now resolves when no workspace is visible at all, so a temporary
  chat keeps working per session instead of failing for every session at once. A
  panel call in that state still fails closed. `NOT_FOUND` for a `workspace` root is
  therefore narrower: neither the invoking session's project nor a visible workspace
  resolved.
- No permission, realpath-containment, deny-list, or declared-scope/consent gate
  changes, and the plugin API surface does not change: `pi.workspace.get` still
  answers with the visible workspace and its project group.
- See ADR 0266, `07-plugins/03-plugin-api.md` §3,
  `07-plugins/13-plugin-permissions-matrix.md` §6, and
  E2E-PLUGIN-fs-root-follows-the-calling-session.

## 2026-09-16 — Quotes, annotations, and side chats are removed (ADR 0268)

- Quote, the text-selection overlay, response annotations (comment editor,
  floating index, source badges, composer attachment), and renderer-owned side
  chats are removed from every surface. Message action rows keep Copy, Edit,
  Delete, Fork, Retry, and Regenerate; the composer keeps its draft, chips, smart
  Stop, and per-session draft slots; the work panel keeps its other tab kinds;
  `session.fork` and the Fork action are unchanged.
- Sends no longer compose a `# Response annotations:` block, and the display-side
  reduction `requestTextWithoutAnnotations` is gone, so a prompt stored before the
  removal is shown exactly as it was stored in the transcript, the edit seed, and
  the queue preview.
- Retired and never reusable: `D-LOCAL-message-quotes`, `D-LOCAL-selection-overlay`,
  `D-LOCAL-response-annotations`, `D-native-sidechat-stream`, and the E2E IDs
  E2E-CHAT-quote-prefill, E2E-CHAT-selection-markdown,
  E2E-CHAT-selection-side-chat, E2E-CHAT-annotation-attachments,
  E2E-CHAT-annotation-session-state, E2E-CHAT-annotation-source-index,
  E2E-CHAT-annotation-ack-and-steering, E2E-CHAT-side-chat-fork,
  E2E-CHAT-side-chat-stream, E2E-CHAT-side-chat-add-to-main,
  E2E-CHAT-side-chat-promote, E2E-CHAT-side-chat-close, and
  E2E-SESSION-native-side-chat-fork-survives-close.
- No host protocol (v11), storage schema (v15), IPC channel, permission, or Rust
  change. See ADR 0268.

## 2026-09-16 — A control with no label states its square geometry

- `.icon-btn` is shared with label-driven pills, so it takes its width from its
  content — glyph plus 8px of side padding. Every icon-only use of it was
  therefore taller than it was wide: the sidebar collapse control and the
  composer's add button rendered 31×28, the composer's enhance and undo
  controls 35×28 inside `.composer-right`, and the settings provider actions
  30×28 from their 14px glyphs. The same control in the conversation topbar was
  already a 28×28 square, so one function had two sizes.
- Those controls now state `.icon-btn-square`, which pins both axes to the new
  `--ds-control-size` (28px) token, keeps `flex: 0 0` so a crowded toolbar row
  cannot shrink the control back out of square, and drops the side padding that
  under the global `border-box` would leave a 12px content box for a 15px
  glyph. Icon-only controls now match the square the topbar toggle, the
  work-panel actions, and the send/stop controls already used.
- `.composer-right .icon-btn` no longer sets inline padding. The label-driven
  model/thinking chip sets its own padding with `!important`, so that
  declaration only ever widened the icon-only controls beside it; the
  maximizing enhance control keeps its label geometry while it is loading.
- Renderer only: no protocol, storage, host, permission, or migration change.
  See `04-ux/07-ui-design-system.md` §11.1 and `04-ux/08-component-spec.md`
  §3.7.

## 2026-09-16 — One geometry for every chrome icon control

- The preview- and route-band lane actions (`.title-nav-btn`) rendered as 22px
  tiles with `--radius-2xs` and a `--ds-tile` seat, beside 28px siblings: the
  same dock toggle in the conversation topbar, the viewport-fixed work-panel
  toggle, and the work-panel's own actions. One control, two sizes and two
  shapes, in the same 46px band.
- Those actions now take the shared chrome-control geometry (the `.ct-icon-btn`
  group): a 28px square from `--ds-work-panel-toggle-size`, `flex: 0 0` so a
  crowded band cannot squeeze them out of square, `--radius-md`, a transparent
  seat with the semantic hover wash, and the 15px glyph every other chrome
  control uses. `.title-nav-btn` keeps only its press feedback and active tone.
- The preview action lane is derived from the control it reserves room for:
  `--ds-preview-action-lane-width: calc(2 * var(--ds-work-panel-toggle-size) + 4px + 8px)`,
  so the panel header's reserve and the buttons cannot drift apart.
- Renderer only: no protocol, storage, host, permission, or migration change.
  See `04-ux/08-component-spec.md` §2.

## 2026-09-16 — The macOS traffic-light reserve has one source (D433)

- The renderer's windowed lead-in for the macOS traffic lights was a hand-copied
  `76px`: five declarations across `apps/desktop/src/styles/chrome.css` and
  `apps/desktop/src/styles/work-panel.css` — `.main-titlebar-left` (`64px`, that
  number minus the row's own 12px padding), `.conversation-topbar.ct-collapsed`
  (`--ct-lead-inset`), `.sidebar-header`,
  `.window-chrome-row:not(.sidebar-expanded)`, and the preview
  `.work-panel-header` (`calc(76px + var(--ds-preview-action-lane-width))`) —
  each with its own `[data-fullscreen="true"]` sibling. None of them was tied to
  the `trafficLightPosition` the main process hands Electron, so either side
  changing on its own would have drifted from the other.
- The native geometry now has one home, `packages/shared/src/window-chrome.ts`:
  `MAC_TRAFFIC_LIGHT_POSITION` (`{x:16,y:16}`) and
  `MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH_DIP` (`60`), with
  `MAC_TRAFFIC_LIGHT_EDGE_DIP` (`16 + 60 = 76`) as the cluster's right edge. The
  main process positions the buttons from those constants, and the renderer
  injects the edge into `--ds-traffic-light-edge` at boot. Every consumer reads
  `--ds-window-lead-inset`, which `chrome.css` composes once for
  `:root[data-platform="darwin"]` as `--ds-traffic-light-edge` +
  `--ds-traffic-light-gap` (`12px`) = `88px`.
- The buttons used to sit flush against the green light, with a 0 gap. The
  reserve now keeps `12px` of breathing room between the cluster's right edge and
  the first shell control, which is why windowed mode moved from `76px` to
  `88px`.
- The per-selector `[data-fullscreen="true"]` overrides are gone. Fullscreen
  hides the buttons, and the same token's `[data-fullscreen="true"]` rule drops
  the reserve to the ordinary `8px` gutter for every consumer at once.
- Windows and Linux are unchanged: `--ds-window-lead-inset` keeps its `0px`
  default and those platforms still use the renderer-drawn controls in the 120px
  right-side band. Plugin-panel windows create a plain frameless `BrowserWindow`
  with no native traffic lights, so they are unaffected.
- Renderer + shared constant only: no protocol, storage, host, permission, or
  migration change, and no new default.
- See `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`, and
  E2E-LAYOUT-three-column-width-priority.

## 2026-09-16 — The work-panel header's buttons are one group

- The work-panel header read as two clusters: the action group inside the header
  (`+` and maximize, 4px apart) and the viewport-fixed collapse toggle outside
  it. The separator between them was compounded from four declarations on
  `.work-panel-actions` — `margin-right: 8px`, `padding-right: 8px`, a 1px
  `--ds-border-subtle` divider, and a separate `--ds-work-panel-toggle-gap: 20px`
  lane token — for a real 37px gap plus a hairline rule, so the same three
  28px squares in the same 46px row looked like two unrelated clusters.
- One token now spaces the whole row. `--ds-work-panel-control-gap: 4px`
  replaces `--ds-work-panel-toggle-gap` and is the header's flex gap (tab strip
  to action group), the `.work-panel-actions` gap (`+` to maximize), and — spent
  by the header's right padding as
  `calc(size + inset + control-gap)`, 44px — the gap from the action group to
  the fixed collapse toggle. `.work-panel-actions` states spacing only: the
  divider, inset, and margin are gone.
- The lane still reserves the whole toggle, and the `+` trigger still clears the
  toggle by 36px inside the lane (4px + the 28px maximize control + 4px), so the
  `WORK_PANEL_HEADER_PROBE` 24px assertion and E2E-152's hit-region contract
  still hold.
- Renderer only: no protocol, storage, host, permission, or migration change,
  and no new default. See `04-ux/08-component-spec.md` §5.2,
  `04-ux/07-ui-design-system.md` §4.3, and
  E2E-LAYOUT-three-column-width-priority.

## 2026-09-16 — The work-panel controls are quiet icons, not filled seats

- The work-panel header's `+` and maximize controls were painted with a
  `--ds-tile` seat of their own, and the viewport-fixed collapse toggle added
  `--ds-tile-deep` plus `--ds-raised-shadow` while `aria-pressed="true"`. In the
  light theme that turned a row of three 28px controls into filled squares, with
  the toggle reading as a raised circular pill floating over the panel header —
  nothing like the top-left dock toggle and new-task controls beside them.
- `+` and maximize now join the shared chrome-control group in `chrome.css` —
  the same rule that seats the topbar's dock toggle, the viewport-fixed panel
  toggle, and the preview/route-band lane actions — so they take one geometry
  (28px square, `--radius-md`, `flex: 0 0`), one transparent seat, the semantic
  `--ds-bg-hover` wash on pointer, and the `opacity: 0.4` disabled state. Their
  duplicated rules in `work-panel.css` are gone; the partial keeps only the
  action group's spacing.
- The toggle's pressed state drops the fill and the raised shadow and keeps the
  engaged ink, so the open state is the glyph swap plus `--ds-text-primary`.
  `aria-pressed` still carries the state to assistive technology, and
  `.app-work-panel-toggle` keeps its viewport-fixed ownership and `no-drag`
  carve-out.
- Keyboard focus is unchanged: the global `:focus-visible` outline applies as it
  does to every other chrome icon control, so removing the retired
  `:focus-visible` background wash costs no focus affordance.
- Renderer only: no geometry, gap, inset, protocol, storage, host, permission, or
  migration change, and no new token. See `04-ux/08-component-spec.md` §2.3 and
  §5.2, `04-ux/07-ui-design-system.md` §4.3, and
  E2E-LAYOUT-three-column-width-priority.

## 2026-09-17 — Builtin subagents can be switched off (D434)

- Settings > Agent > Subagents listed the five shipped defaults as read-only
  rows while the user's own documents had an enablement switch, so one delegate
  could not be turned off at all: copying a builtin and disabling the copy left
  the shipped definition in the catalog, because disabled user documents are
  filtered out before the loader merges and so shadowed nothing.
- Every Built-in row now carries the same switch. The handle is stored in
  `<data>/agent-capabilities/subagent-builtins.json`, a file of its own because
  the user-document scan prunes state for ids it can never see, and host-core
  exposes it through `agents.disabledBuiltins` / `agents.setBuiltinEnabled`.
  Electron main hands the disabled handles to `loadSubagentDefinitions`, which
  drops them from the delegation catalog while `subagent/catalog` still returns
  the builtin, flagged `enabled: false`, in its new `builtins` list.
- A switched-off builtin keeps its row, dimmed, so the switch is the way back
  on. A user document of the same handle keeps working and keeps shadowing the
  shipped definition, reveal and delete stay absent because a builtin is not a
  file, and an unavailable host contributes no exclusions. See ADR 0270,
  `04-ux/06-settings-ia.md` §2, `03-runtime/01-ipc-protocol.md` §12c, and
  E2E-SUBAGENT-settings-lists-builtin-defaults.

## 2026-09-17 — Judge a public-network address on the route the request will dial (D436)

- The skill market's main-process guard classified the target host with a
  *local* resolver while `net.fetch` dials through Chromium's proxy stack
  (ADR 0177). Under a TUN / fake-IP resolver that answer is a synthesized
  `198.18.0.0/15` address for a connection the app never makes, so every
  catalog source was refused as "blocked by the app's address check"
  (issue #419).
- Each hop now asks the session that carries `net.fetch`
  (`Session.resolveProxy`) for its own decision, and the shared
  `classifyProxyRoute` reduces that answer to `proxied` / `direct` / `unknown`.
  On a `proxied` route `isAcceptableResolvedAddress` tolerates only the
  resolver-artifact class (`benchmark`); every real internal class and an
  unanswered resolver still refuse. A `direct` route keeps the pre-change
  semantics by default; an explicit `allowFakeIp` setting may permit only the
  benchmark placeholder. A `DIRECT` entry anywhere in the list is read as
  `unknown` because Chromium may fall back to it, and `unknown` stays strict.
- Refusals and the market's `failureDetails` now carry `route`, so a fake-IP
  refusal on a direct route reads apart from one on an unreadable route.
- The MCP market now asks the Electron session for its route per hop: fully
  proxied hops use `net.fetch` so fake-IP sources can reach the configured proxy,
  while direct and unknown hops retain the pinned Node HTTPS guard and strict
  public-address rule by default. The explicit `allowFakeIp` setting permits
  only benchmark placeholders for transparent router/TUN deployments; real
  private answers remain refused. See ADR 0245.
- See ADR 0272, `05-security/01-security.md` §4.1,
  `03-runtime/09-logging-and-observability.md`, and
  `06-delivery/04-e2e-test-plan.md` E2E-SKILL-MARKET-NET-BOUNDARY.

## 2026-09-17 — The dock question card is a composer plate (#360, D437)

- The asktool question card is mounted in the transparent composer dock
  (`Composer.tsx` renders it as a direct `.composer-stack` child, and the
  transcript mount is gone), yet it still painted the in-flow `--ds-tile` wash:
  a 3.5% ink mix with no shadow. On the light page that leaves a `#f7f7f7`
  panel with white option rows next to the composer plate below it, which is
  how #360 item 1 ("选择交互面板缺少背景色") reads. The dock rule's own comment
  already claimed the card "uses the same decision surface as Plan and Goal
  approval", while `.plan-approval-bar` in that exact slot paints
  `--ds-bg-composer` with `--ds-shadow-composer` (`04-ux/03-permission-ux.md`
  §9, `04-ux/08-component-spec.md` §11.5).
- `.composer-stack > .asktool-card` now paints that plate: `--ds-bg-composer`
  with `--ds-shadow-composer` (light `#ffffff`, dark
  `color-mix(in oklab, #212121 96%, transparent)` with the composer shadow).
- Its controls move to the plate's inlaid tier, the layer `.plan-approval-split`
  already uses on that same plate: `.asktool-option` and
  `.asktool-custom-input` drop `--ds-raised` and `--ds-raised-shadow` for
  `--ds-tile-deep`, and the hover/selected mix is rebased on `--ds-tile-deep`.
  Without that flip the rows would be white on white in the light palette,
  where `--ds-raised` and `--ds-bg-composer` are both `#ffffff`. The 15 px
  option mark keeps `--ds-tile-deep` — the sidebar checkbox's mark — which
  still reads against the inlaid row exactly as it does against the sidebar.
- Renderer only: no protocol, storage, host, permission, migration, or
  preference change, and no new default. Both layers are existing tokens in
  both palettes, so a contributed theme moves the plate and the rows with
  `--ds-bg-composer` / `--ds-tile-deep`. See
  `04-ux/11-asktool-question-card.md`, `04-ux/07-ui-design-system.md` §6.4, and
  E2E-078.

## 2026-09-17 — A git checkout is a Create project source (D438)

- The Create project dialog only collected a project name and local folders
  (ADR 0233), and the home switcher's Clone git project entry renders inside the
  hero of a project-bound session. A fresh installation therefore had to open an
  unrelated local folder before any repository could be cloned.
- The dialog now owns a source selector with two equal peers: This computer and
  Git repository. The git source keeps the one name field (seeded from the
  repository name until the user types), adds a repository URL field and one
  clone destination row, and parses URLs with the switcher's `parseGitCloneUrl`
  rules, so private, loopback, link-local, credential-bearing, and malformed
  remotes keep Create disabled (ADR 0247).
- Main exposes additive `project/cloneCheckout({ url, parentPath })`: it clones
  into the explicit parent folder and returns `{ path, name }` without touching
  the active workspace and without opening a picker. `project/clone` keeps its
  native-picker behavior for the home switcher.
- Project creation is unchanged: both sources call one project-slice helper,
  `project-group/create` still writes the only durable record, and a checkout
  becomes the primary root of the same logical group (ADR 0233).
- Renderer plus one narrow main-process capability: no protocol, schema, host
  RPC, permission, storage, or preference change. See ADR 0273,
  `03-runtime/01-ipc-protocol.md` §9, `04-ux/08-component-spec.md`, and E2E-258.

## 2026-09-16 — Draggable chat content width (D439)

- The centered conversation band, empty-home stack, and composer share one
  preferred max width, default 760px, persisted as
  `AppSettings.chatContentMaxWidth`. Dual edge handles (invisible at rest;
  a short primary-ink capsule on hover, slightly stronger while dragging)
  change that width together so the column stays centered. Drag floor is 560px.

- The live used width is `min(available pane minus 24px gutters, preferred)`,
  so a squeezed sidebar or work panel compresses the band without rewriting
  the preference. The collapsed-sidebar 640px ceiling is removed.
- Assistant, tool, and decision rows follow the band. User plates stay
  `min(82%, 600px)`. Renderer only. See ADR 0277, E2E-208, and
  E2E-CHAT-content-width-handles.

## 2026-09-17 — Session and project rows delete on the second click (D441)

- The sidebar's session item and both project menus (sidebar and Projects index)
  removed the row on the first click of Delete. Every other destructive row
  action — the settings provider rows, vendor accounts, and the capability
  tables — arms first and relabels the control, so the two most destructive
  actions were the only ones that fired on a single click.
- `hooks/use-armed-delete.ts` now owns that pattern for the whole renderer: one
  `ARMED_DELETE_MS` (3200ms) expiry and one `useArmedDelete()`. The capability
  pages keep importing it from `AgentCapabilityLayout`, which re-exports the
  shared hook instead of holding a second copy with a timeout of its own, so the
  pattern cannot drift between the settings rows and the two menus.
- A session item arms on `session.id`; both project menus arm on a
  `project:`-prefixed key, so a session and a project can never share an arm. An
  armed item carries `data-armed="true"`, a danger wash, and the label
  `nav.deleteTaskConfirm` / `project.deleteMenuConfirm` ("Delete?" / "确认删除？")
  in all eight catalogs. The menu stays open between the two clicks, and an
  outside press, Escape, or the expiry clears the arm without removing anything.
- Amends D431 for the idle case: a project whose turn is still live still opens
  `ProjectDeleteDialog`, which names those sessions and stops them before it
  deletes, and the host's 1008 / `CONFLICT` refusal is still mapped to
  `project.deleteRunningBlocked` on both paths. A project with no live turn is
  removed by the same store action the dialog used, with the same success toast,
  so its second click is the confirmation the user already gave.
- The number is D441 because D438 was already claimed twice — by the
  window-toggle merge (#360, D438 with the D439 rebind) and by the
  Git-checkout decision (ADR 0273), which this log flags to move to D440.
  This entry does not rewrite another decision's text.
- Renderer only: no protocol, storage, host, permission, or migration change,
  and no new default. The folder on disk is still never touched. See
  `04-ux/09-interaction-patterns.md`, D421, D431,
  `06-delivery/04-e2e-test-plan.md`
  E2E-PROJECT-delete-removes-project-and-owned-sessions, and
  `apps/desktop/test/two-step-delete.test.mjs`.

## 2026-09-16 — The sidebar list rhythm is 1px / 2px / 8px

- The sidebar's session lists had no rhythm to read. Rows and group headers sat
  flush inside a group (a 0 gap), two project groups sat 2px apart, and the only
  air was the 4px above a section label. Adjacent 28px rows painted rounded
  hover fills that touched, so two rows read as one block, a collapsed group sat
  as far from its neighbour as an expanded group with ten rows under it, and a
  section label was closer to the rows above it than to the rows it introduces.
- The lists now state one ladder: rows sit 1px apart, a project group header and
  a section label sit 2px above their first row, a sidebar section sits 8px
  below the one above it, and an expanded project group carries an 8px tail.
- That tail belongs to the expanded group itself, so the spacing is decided by
  the preceding group alone: an expanded group is followed by 8px whether the
  next group is expanded or collapsed, and a collapsed group by 1px either way.
  The scroller's own gap stays a uniform 1px and the difference lives in the
  group body's inset, which leaves with the rows. Collapsing a group therefore
  cannot fork the spacing on a neighbour's state, and cannot snap its own tail.
- The dated labels inside a project group are ordinary rows of that rhythm
  rather than a second level of groups: they keep no state, no disclosure, and
  no `aria-expanded`, and their own inset becomes a symmetric 4px instead of 6px
  above and 2px below, so a label no longer outweighs the 1px row gap it sits in.
- `space-0.25` (1px) joins the spacing scale as the hairline step for dense list
  rhythms; the settings rail already used 1px between its navigation items. The
  section-gap rule no longer claims the sidebar, which has its own rhythm.
- Two row budgets follow the pitch: the pinned body still shows eight rows
  (233px, was 224px) and the standalone Sessions body still shows five (146px,
  was 140px), because the 28px row grid no longer fits its own gaps inside the
  old numbers.
- Renderer only: no protocol, storage, host, permission, or migration change.
  See `04-ux/07-ui-design-system.md` §6.1 and §13, and
  `04-ux/08-component-spec.md` §6.2 and §6.6.

## 2026-09-16 — The sidebar project group folds as one grid row

- The rhythm above shipped with the group fold animating `max-height: 2000px →
  0` over the 300ms slow duration, plus a separate 200ms opacity fade and a
  padding transition. A `max-height` curve spends most of its length above the
  content, so the visible move was a short snap at the end, and the shorter
  opacity curve emptied the group roughly two thirds of the way through: the
  rows disappeared first and the empty box closed afterwards. Collapsing a
  project read as two separate animations.
- The group body is now a one-row grid whose row animates `1fr` → `0fr` over the
  200ms normal duration. Every frame is a real fraction of the group's measured
  height, so the fold is a single continuous motion, and `opacity` stays 1 for
  the whole fold — the rows leave by being clipped, not by fading.
- The body is three layers: the grid, a clip with `min-height: 0` and
  `overflow: hidden`, and the list that owns the 1px row gap and the fixed
  2px / 7px inset. The inset has to sit inside the clip, because vertical
  padding on the animating box holds a `0fr` row open and leaves the group's
  tail behind after its rows are gone.
- A folded group keeps its rows mounted inside the `0fr` row, so it is `inert`
  as well as `aria-hidden` and leaves the tab order. Under
  `prefers-reduced-motion: reduce` the fold keeps both endpoints and runs in a
  near-zero duration.
- The scroll budgets, the indent, the pinned and standalone lists, and the
  shared `.sidebar-session-group-body` flex column are unchanged; only the
  project body folds as a grid.
- Renderer only: no protocol, storage, host, permission, or migration change.
  See `04-ux/08-component-spec.md` §6.2 and
  `06-delivery/04-e2e-test-plan.md` E2E-LAYOUT-sidebar-project-group-fold.

## 2026-09-17 — Sidebar selection is distinct from workspace context

- Project headers and project, pinned and standalone conversation rows share
  one row-level hover surface, radius and transition. Project title buttons
  stay transparent; selected conversation paint takes precedence over hover.
- A project is a workspace/disclosure control, not a separate selected page.
  The current workspace keeps its dot and all existing workspace behavior but
  no persistent row fill, including when no conversation is selected. The
  renderer marks that context with `data-current-workspace`, not an `active`
  project class. Session selection remains chat-page-aware and follows the
  destination immediately while a switch is pending.
- Folding a selected conversation does not transfer selection to its project.
  Keyboard focus retains its outline, action buttons retain local feedback,
  window blur releases hover without clearing selection, and drop-target paint
  takes precedence over hover.
- Renderer presentation only: no persistence, workspace activation, permissions
  or protocol changes. See `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md` §9.1c and
  E2E-LAYOUT-sidebar-row-states in `06-delivery/04-e2e-test-plan.md`.

## 2026-09-17 — Settings shares sidebar material and restores layout without entrance

- Main and settings navigation now share `sidebar-surface`: the same opaque
  color/image fallback on Windows/Linux and the existing native vibrancy plus
  tint/sheen on macOS. Settings wrapper ancestry allows that native material
  through, while its content pane and content-column titlebar remain opaque.
  Only the inner settings content animates, not the navigation backing.
- Built-in settings rail colors no longer diverge from the sidebar. Legacy
  `--ds-settings-rail-bg` remains an optional shared fallback; a canonical
  `--ds-bg-sidebar` override wins. No theme or native-window API changes.
- Sidebar mounting no longer implies expansion. A dedicated transition hook
  distinguishes visible collapsed-state changes from route restoration. Only
  real collapse/expand changes animate; settings navigation cancels unfinished
  phases, and returning restores the retained width/state without replaying
  `sidebar-in`. Animation-end guards, scoped timeout cleanup, auto-restore and
  reduced motion remain supported. Boot presentation uses the existing splash
  reveal instead of a second sidebar width animation.
- No changes to item indentation, widths, workspace state, data or permissions.
  See `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md` and E2E-LAYOUT-sidebar-settings in
  `06-delivery/04-e2e-test-plan.md`.

## 2026-09-17 — A route surface stops holding a stacking context after its entrance

- The plugin install consent modal — and the plugin detail sheet with it — painted
  under the opaque 46px titlebar band, so the band was not covered by the modal's
  scrim and the band's controls stayed clickable. A route page is authored inside
  `.route-surface`, whose entrance animation carried
  `animation-fill-mode: both`: the fill kept the finished entrance "in effect"
  for as long as the page was mounted, and therefore kept the surface a stacking
  context, so an overlay rendered inside the page could not paint above the
  chrome.
- `.route-surface` and `.settings-content-enter` no longer carry `forwards` /
  `both` on their entrance (`apps/desktop/src/styles/chat-shell.css`). The
  entrance ends on the element's own state, so the fill was redundant; without it
  the surface stops holding a stacking context once the entrance finishes, and an
  overlay authored inside a route page paints above the titlebar band again. The
  keyframes stay opacity-only and the entrance still plays.
- The plugin detail sheet keeps reserving `--ds-toolbar-height` at its top
  (`apps/desktop/src/styles/plugins.css`), because on Windows/Linux the
  renderer-drawn window controls own that top-right corner at `z-index: 200` and
  stay above any overlay's z-index.
- The plugin overlays returned to `z-dialog` (40) from their off-scale `80` and
  `60` (`plugins.css`, and the release-notes overlay with them): once the route
  surface stopped trapping them they competed in the root stacking context, and
  at 80 they covered the leaf popups (60) and toasts (50) a dialog raises from
  inside itself — the install dialog's "copied" toast among them. A source test
  pins that relationship now.
- Renderer only: no IPC, storage, schema, protocol, or plugin-SDK change, and no
  new default. See `04-ux/07-ui-design-system.md` §9,
  `apps/desktop/test/settings-dialog-overlay.test.mjs`, and
  `06-delivery/04-e2e-test-plan.md` E2E-LAYOUT-three-column-width-priority (its
  four overlay assertions live in `scripts/e2e-three-column-layout.mjs`).
- Not done, and recorded as a follow-up: true modality — inertness, focus
  containment, shortcut stand-down — needs these overlays on the browser's top
  layer (`<dialog>.showModal()`). That is blocked until the popups, tooltips, and
  toasts they open, which are portaled to `document.body`, also move to the top
  layer, because top-layer content paints above them and makes them unusable; an
  attempt was withdrawn for exactly that reason.

## 2026-09-18 — Prompt enhancement ships a substantive rewrite with user-overridable templates (D447)

- The default enhancement prompt moves from one conservative sentence to a
  structured system prompt plus a templated user message: role, analysis,
  rewrite principles, an explicit do-not list, language-following rules that
  forbid language meta notes, a length brake (about twice the draft; no 800-character cap), and an output contract. The old
  `If the draft is already good, return it with at most minor polish` clause is
  removed: it made the action look inert on short drafts, which is the reported
  complaint.
- Two constraints the old prompt lacked are now explicit: code, commands, file
  paths, identifiers, API names, and other proper nouns must be reproduced
  exactly, and the answer must not open with a language meta note such as
  "The draft is in Chinese". Both are default-value decisions, not
  implementation details, because they change what every user receives.
- The user template becomes an `AppSettings` override
  (`promptEnhancementUserTemplate`) with its default in
  `packages/shared/src/prompt-enhancement.ts`; a blank override means "use the
  default", and editing the field back to the exact default text clears the
  override instead of freezing a copy. Storing the default text as a user value
  was rejected: a later improvement to the default would then never reach those
  users.
- The system prompt stays built in and is not user-editable. It carries rules
  the spec and E2E scenario assert, so a stored override could silently remove
  one; host-core drops such a value if an older build wrote it. Editing the
  system prompt remains a source change with a spec update.
- The user template carries `{{draft}}`. host-core rejects a non-blank user
  template without it, and each template must stay within
  `PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH`; main falls back to the default if an
  unusable value ever reaches the runtime. One matching pair of wrapping
  quotation marks is stripped from the model's answer.
- The settings surface is one row with a `Use a custom template` switch and the
  subagent rows' edit icon button, opening an editor sheet, rather than inline
  textareas or a row of labelled actions: the AI settings tab stays compact and
  the row reads as one control cluster. The switch, not the text, decides whether
  a stored template applies, so turning it off preserves the user's text. It is
  enabled only once a usable template exists and saving one turns it on, because
  an always-enabled switch would choose between two identical states before any
  template was written.
- `promptEnhancementProviderId` / `promptEnhancementModelId` let the rewrite run
  on a model other than the conversation's. An unresolvable pin falls back to
  the Composer's current model with a warning rather than failing the action.
- The enhancement model and reasoning level move to Settings -> Models, in a
  dedicated `Enhancement prompt` card below Defaults, whose model row is titled
  `Default model` like the Defaults card's row (the card heading separates them). Both are decisions about which model
  runs the rewrite, and the model page already owns the one model picker a user
  learns; the prompt card keeps only the prompt. The enhancement-model row reuses
  the default-model row's anchored menu rather than introducing a second picker.
- The enhancement reasoning row lists only the levels the selected model actually
  supports, resolved the same way a turn resolves them (binding `thinkingLevels`,
  then the live catalog, then the provider default), and is disabled when the
  model supports none. An earlier revision offered the full canonical ladder
  regardless of model, which is wrong for a model without reasoning. Switching
  model re-clamps and rewrites the stored level, so a persisted level is always
  runnable.
- The enhancement reasoning level becomes configurable and defaults to `off`; it
  never inherits the conversation's effort. A rewrite rarely benefits from
  reasoning, and reasoning is the slow path, so "follow the session" would
  silently opt every enhancement on a reasoning model into the slowest setting.
  The level is clamped by the resolved model's capabilities.
- One enhancement request is bounded by a 60-second ceiling: expiry aborts the
  in-flight call (best-effort) and races the promise so the renderer is released,
  then fails with `TIMEOUT` instead of retrying on the session model. The
  provider retry budget can already spend about a minute, the renderer has no
  cancel, and a hidden second attempt would double the wait. This is a behavior
  change for a slow provider: the action now fails visibly instead of hanging.
- No IPC method, process boundary, storage ownership, or security boundary
  changes; the existing `prompt/enhance` payload is unchanged. See
  `04-ux/12-prompt-enhancement.md` §3 and §5, ADR 0121, and
  `06-delivery/04-e2e-test-plan.md` E2E-259.

## 2026-09-19 — Restore resizable sidebar width with collapse-below-threshold (D459)

- Amend D408 / ADR 0238 and restore ADR 0141: the expanded sidebar is again a
  renderer-owned `240px..520px` column (default `275px`). The right-edge handle
  previews width from the pointer-down position, persists on release, and
  supports ArrowLeft/ArrowRight (16px), Home, and End. Escape, cancellation,
  lost capture, and unmount restore the press-time width.
- A pointer width below `160px` collapses the sidebar immediately as a user
  action. The preferred expanded width is not overwritten. Keyboard resize never
  collapses; `Cmd/Ctrl+B` remains the keyboard fold.
- The live maximum is the three-column remainder after MainChat's 450px floor
  and an occupying work panel's requested width, so a user-chosen sidebar width
  does not trip D408's yield. Work-panel growth and window shrink still collapse
  the expanded sidebar at that threshold.
- Renderer only: existing `pi.desktop.sidebarWidth` preference, no IPC or native
  window change. See ADR 0290 and E2E-168.

## 2026-09-19 — MCP catalogs are bounded by protocol guards, not truncated (D452)

- Amend D176 / ADR 0038: the per-server `tools/list` bound stops being a silent
  truncation at 64 tools and 8 pages. The client now follows pagination to the
  last page under Codex-parity protocol guards — 2048 tools, 100 pages, a cursor
  that repeats or is malformed, and 30s for the whole traversal — and a server
  that breaks one loses its handshake instead of contributing a prefix of its
  catalog.
- The cap was never the prompt's protection: MCP tools reach the model as
  deferred on-demand entries behind `ToolSearch`, and the prompt block that
  advertises them is capped independently, so a 300-tool server costs nothing
  until one of its tools is activated.
- `plugin.mcp.tools.truncated` is gone. A refusal is audited as
  `plugin.mcp.connect` / `mcp.connect` with the guard's error code and message,
  and reaches the user as the status message of a user-configured server.
- See ADR 0038 and E2E-024K; `apps/desktop/test/plugin-mcp.test.mjs` covers the
  whole catalog, each guard, and the old truncation as a failing baseline.

## 2026-09-19 — The Voice settings card is removed (ADR 0291)

- Settings → AI no longer carries a speech section: `VoiceSettingsCard` and
  `features/settings/voice-settings.tsx`, the AI destination's
  `settings.speechTitle` / `settings.speechTranscribe` / `settings.speechSynthesize`
  search keywords, the `.settings-speech-*` styles, the thirteen
  `settings.speech*` keys in all eight shipped locale catalogs, and the seven
  unreferenced `chat.transcribe*` / `chat.speak*` keys written for those
  withdrawn Composer controls are gone.
- The host capability stays: `speech/getStatus`, `speech/transcribe`,
  `speech/synthesize`, `AppSettings.speech` validation, the two built-in
  protocols, the `speech.adapter.register` plugin permission, and the renderer
  API bridge are unchanged. A binding is written by a caller through the host
  settings API, and plugins and IPC calls are its only consumers.
- Already withdrawn, and repaired here in the docs: ADR 0281 item 5's Composer
  transcription and draft-speech entry point — its mic and read-aloud controls
  were removed on 2026-09-18 (`344ef4ec2`, PR #555) — and the Composer speech
  controls `04-ux/08-component-spec.md` §2.5 described. The copy written for them
  is retired with them.
- Renderer only: no IPC channel, storage schema, host RPC, permission, or Rust
  change, and no stored binding is dropped. See ADR 0291,
  `04-ux/06-settings-ia.md`, `03-runtime/20-speech.md`, E2E-008e.

## 2026-09-19 — SSH bootstrap for remote hosts (D453)

- The desktop installs and pairs a `pi-host` on a machine the user already
  reaches over SSH using the system `ssh` client, so `~/.ssh/config`, the agent,
  and jump hosts apply unchanged and the app holds no SSH secret; `BatchMode=yes`
  makes a host that needs an interactive password or passphrase fail with a
  typed error instead of hanging behind an invisible prompt.
- The desktop resolves the bundle for the remote platform at its own version,
  holds the SHA-256 the release publishes, and refuses an unpublished target
  (`linux-x64` only today) before any download. The uploaded script downloads,
  verifies, and installs the bundle under the remote `$HOME`; no executable
  bytes cross the SSH channel.
- The script runs under `umask 077` and echoes `PI_HOST_READY` /
  `PI_HOST_PAIRING_TOKEN`, so the single-use pairing token exists only in a work
  file and on the SSH channel, never in a world-readable path or a URL
  (security §3.4). `PI_HOST_READY.version` must equal the desktop's; a mismatch
  is `HOST_VERSION_MISMATCH` (D375) and is checked before a forward exists.
- A paired host now stores an SSH descriptor (`metadata.transport = "ssh"`)
  instead of a URL, because the local forward port is not stable across
  launches; the tunnel manager re-establishes `ssh -N -L` on every launch and
  adopts the bootstrap's own live forward so pairing opens exactly one tunnel.
  The descriptor is re-validated on every registry read, and a malformed one
  degrades to "not an SSH host" rather than spawning `ssh` with garbage
  arguments.
- `pi-desktop/remoteHost/bootstrap` joins `list` / `pair` / `remove`, and the
  `connection/pair` exchange was factored into one `exchangePairingToken` used
  by the pasted-URL path and the bootstrap path alike.
- Not in this slice: the terminal work-panel client (Stage 5), the reverse tool
  relay (Stage 6), the resync watchdog, non-Linux and Windows remote targets,
  and provider configuration over the SSH channel — a freshly bootstrapped host
  still fails `turn/start` closed with `MODEL_NOT_CONFIGURED` until a provider is
  configured on it. See ADR 0292, `06-delivery/07-remote-control-rollout.md` §7,
  and `05-security/02-remote-control-security.md` §3.4.

## 2026-09-19 — SSH password authentication for the bootstrap (D454)

- ADR 0292 kept the app free of SSH secrets and made `BatchMode=yes` the
  enforcer, which is the right default but leaves a machine whose only
  credential is a password unreachable from the app — the user has to install a
  key from a terminal first, which is the detour the bootstrap exists to
  remove. A password may now be supplied *instead of* a key, per host, and it
  is opt-in: with no password the argv and every other behaviour are unchanged.
- The secret reaches the `ssh` client through OpenSSH's askpass helper
  (`remote/ssh-askpass.ts`): `SSH_ASKPASS` points at a generated `/bin/sh`
  script and `SSH_ASKPASS_REQUIRE=force` makes it apply without a terminal, so
  the password is never an `ssh` argument or an environment value. Its
  confidentiality rests on modes — a `0700` directory, a `0600` secret, a `0700`
  helper — and the material is deleted once no child can still be prompting
  (after an exec child closes, after a forward's port is up, or on `dispose`),
  so nothing lingers between operations.
- `BatchMode=yes` becomes `BatchMode=no` only for a password target, together
  with `NumberOfPasswordPrompts=1` and `PubkeyAuthentication=no`: the helper
  answers every prompt with the same secret, so a retry could only repeat a
  wrong password, and repeated failures are what trip a server's own lockout.
  Default identities are skipped so an encrypted local key cannot consume that
  single prompt as a passphrase; password mode in Settings replaces a key.
- The password is persisted encrypted through the same OS-keychain
  `EncryptionPort` the device token uses, as a new optional
  `encryptedSshSecret` in `remote-hosts.json`; the descriptor gains
  `auth: "password"` and nothing else, so a key descriptor keeps exactly its
  previous shape and the file's `version` stays `1`. A password that will not
  decrypt costs the secret, not the paired host, because the device token is
  independent of it.
- The renderer never sees it: `RemoteHostSummary` is unchanged and the secret
  travels beside `RemoteHostSshMetadata` (plaintext, persisted metadata) rather
  than inside it. `assertSshPassword` rejects a line break with
  `INVALID_ARGUMENT` before any remote command runs, because OpenSSH reads the
  helper's answer only up to the first break; Windows is refused with
  `HOST_BOOTSTRAP_FAILED` and a remedy, because its OpenSSH cannot execute a
  shell-script helper. A host recorded as password-authenticated with no usable
  secret is not opened at all, which surfaces as the host being offline.
- Settings gains an authentication mode on the SSH form with a masked password
  field and a reveal toggle, and the copy that promised no password was ever
  stored is replaced in all eight shipped locales. See ADR 0293,
  `05-security/02-remote-control-security.md` §3.4 and gate 21,
  `02-architecture/05-remote-agent-control.md` §5.2,
  E2E-REMOTE-HOST-ssh-password-authentication.

## 2026-09-20 — Project archive is a list + inspector (D455)

- Decision D455 revises D267's expanding rows for Settings → Project archive.
  The quiet intro and toolbar stay; the single expanding list becomes compact
  rows with a full-width inspector under the selected row (ADR 0294).
- Clicking a row selects it and keeps Settings open. Double-click, Enter, or
  the inspector Open action activates the project and returns to chat. Archive
  and close still keep the destination open (D133 / D267).
- Folders, chats (latest first, batches of eight), and the existing menu live
  in the inspector. Archived records stay grouped and visible.
- Presentation only: no IPC, storage, or host protocol change. See
  `04-ux/06-settings-ia.md` and E2E-038.

## 2026-09-20 — Prompt-enhancement model card moves to Settings → AI

- Amend ADR 0121 and the 2026-09-18 D447 placement: the Enhancement prompt card
  (default model + reasoning) leaves Settings → Models and sits on Settings → AI
  immediately below Prompt enhancement, so the template and the rewrite model for
  the same Composer action live on one destination. The card keeps its own title
  because the model picker still needs title / current value / control. Settings
  search indexes those rows on the AI tab. Presentation only: no IPC, storage, or
  host-protocol change. See `04-ux/06-settings-ia.md` and
  `04-ux/12-prompt-enhancement.md` §5.

## 2026-09-20 — Prompt enhancement is one Settings → AI card

- Amend the same-day two-card placement: the Enhancement prompt card is folded
  into Prompt enhancement on Settings → AI. The custom-template switch, default
  model, and reasoning rows share one heading. Settings search still indexes
  `promptEnhancementModelTitle` so "增强提示词" finds the AI tab. Presentation
  only: no IPC, storage, or host-protocol change.

## 2026-09-20 — Session thinking-parameter omission (D456)

- Composer, session storage, and host validation accept `thinkingLevel: omit`
  next to the seven canonical levels. Binding chips and catalog capability
  lists stay canonical; `omit` is a client selector, not a published level.
- Runtime clamping keeps `omit` on a reasoning model. Agent bookkeeping stays
  `off` and the parent stream uses the same low-level omit path as subagents,
  so adapters send no thinking field. Explicit `off` still disables thinking.
- The Composer reasoning menu prepends `omit` whenever the selected model
  exposes enabled canonical levels, and the chip renders the canonical string.
  Settings `defaultThinkingLevel` also accepts `omit` on a reasoning binding
  so new sessions can start without a thinking override.
  Schema v19 rebuilds `sessions` so the CHECK includes `omit`.
  See ADR 0295 and E2E-203a.

## 2026-09-19 — Drain poison outbox entries; accept steering into a delivery turn (D597)

- Decision D597 amends ADR 0041, ADR 0239, ADR active-turn-steering, and D444.
  A host append whose error message carries a `PERMISSION_DENIED:` prefix is a
  permanent, message-level rejection. The Electron outbox drops that row and
  keeps draining so one poison head cannot fill the 1024-entry cap. Substring
  matches such as `PLUGIN_PERMISSION_DENIED` still pause, as do other host
  failures.
- Steering into a claimed collaboration delivery turn is extra human input in
  that session. It is exempt from the delivery content/attachment contract, does
  not inherit the delivery's agent origin, and has any client-supplied
  `session_message` stripped. Steering that names another session is still
  `PERMISSION_DENIED`.
- See `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  E2E-SESSION-outbox-poison-does-not-drop-history.

## 2026-09-20 — Project archive reads as an inset grouped card list

- Revise D455's presentation only: the destination stays one column with the
  detail under the selected row and no side-by-side pane, but the index is now
  an inset grouped list in the iOS sense. Each row reads left to right as
  identity (color glyph, name, one status tag, shortened monospace path) and
  right to left as detail (session count, relative last-active time, disclosure
  indicator). Rows stay tiles separated by the row gap, never by rules.
- The selected row is the header of its own card, so the detail panel repeats no
  name, path, or status tag: it opens with an action bar (New task, Open while
  the project is not the live workspace, overflow menu), then the read-only
  folder and branch facts and the sessions count, then the chats. The overflow
  menu keeps its items, its ordering, and its two-step delete.
- Arrow-key selection walks the rendered order (section order with the active
  sort) instead of the index build order and moves real focus to the row it
  selected, and the handler yields to the open card so Enter inside the detail
  stays that control's own action. Row element ids are encoded, so two paths
  that differ only in separators can no longer collide. An empty index shows the
  pending indicator until the host listing settles instead of "no projects yet",
  and the expanded card and the disclosure indicator honor reduced motion.
- Clicking the row whose card is open closes it again, through one shared
  toggle. Selection and the open card are separate states, so the current row
  keeps its ring while its card is closed and the disclosure indicator turns
  down only while the card is really open. Moving the selection with the arrow
  keys always opens the row it landed on.
  Presentation only: no IPC, storage, host-protocol, or
  activation-semantics change. See `04-ux/06-settings-ia.md`,
  `04-ux/07-ui-design-system.md`, and ADR 0294.

## 2026-09-20 — Project archive opens closed and keeps no page-level prose

- The destination renders no description line: the toolbar is the first thing
  under the page title, the same shape as the agent capability and Import
  destinations. The `project.archiveSubtitle` key is retired from every catalog
  rather than left behind unused.
- Nothing is expanded until the user clicks a row. Selection and the open card
  were two states; they collapse into one, so a closed index highlights nothing,
  `aria-expanded` and the rotating disclosure indicator describe the open card
  only, and a row whose project leaves the list (a search that no longer matches
  it) closes with it. `resolveSelectedPath`, which always resolved a selection
  (the live workspace first, then the first row), is removed together with the
  auto-expansion it existed to serve.
- Presentation only: no IPC, storage, host-protocol, or activation-semantics
  change. Search still matches session titles and keeps the owning project in
  the index. See `04-ux/06-settings-ia.md`.

## 2026-09-20 — The menu root carries the reasoning slider (#417, D458)

- The Composer's Reasoning level selection lived only inside a vertical radio
  list one submenu deep. Issue #417 asked for a Codex-desktop-style slider
  while keeping the existing click-to-list interaction.
- The combined model × reasoning menu root now shows a native range input with
  one stop per enabled level plus a clickable tick label per stop, directly
  beneath the Reasoning level entry. Dragging the slider or clicking a tick
  commits the level immediately through the same `configureActiveSession`
  path and leaves the menu where it is, so quick adjustments never cost a
  submenu trip. The Reasoning level entry itself still opens the classic
  radio list, which keeps its radio semantics, trailing check,
  Up/Down/Enter/Left contract, and root-return behavior.
- The slider owns its arrow/Home/End/Enter keys while focused, so those keys
  adjust the level instead of driving menu navigation, while Escape still
  closes the menu. Dragging across several stops keeps only the last pending
  level; commits serialize latest-wins so an in-flight idle persist cannot
  land an intermediate stop, and a session or model change invalidates
  pending work. A local drag lead keeps the controlled input from snapping
  back while the store confirmation lands. Tick labels are clickable but not
  tab stops. A binding with a single enabled level hides the slider entirely.
- Level values remain untranslated canonical strings, including session
  `omit` (D456) when the binding exposes enabled canonical levels. The
  seven-level ladder, provider filtering, and clamping rules are unchanged.
  Renderer only: no protocol, storage, host, permission, or migration change.
  See `04-ux/08-component-spec.md`, `04-ux/07-ui-design-system.md`, and E2E-050.

## 2026-09-20 — A development build is its own installation (D599)

- A packaged PI-Desktop and a `pnpm dev` host no longer share the two
  directories that define an installation. A development build runs under
  `PI-Desktop Dev` in the OS application-data root — its own Electron
  `userData`, and with it the single-instance lock, renderer `localStorage`,
  the plugin panel partitions, and browser pane cookies — and reads
  `~/.pi-desktop-dev`. A packaged installation keeps `PI-Desktop` and
  `~/.pi-desktop` unchanged, so no existing profile is relocated.
- A shipped app that is already running therefore no longer refuses the lock a
  development launch needs, and the two never put a second host-core over one
  `pi.sqlite`, one persistence outbox, or one log tree. `PI_DESKTOP_DATA_DIR`
  still wins over either profile and is now made absolute before it reaches
  host-core as a child-process environment variable. Electron main publishes the
  resolved directory back to that variable so the plugin runtime reads one root
  instead of falling back to the shipped default.
  An explicit `--user-data-dir` still wins, because the E2E harnesses point a
  build at a throwaway profile with it.
- Decision D599 narrows D236 and amends ADR 0094: the lock keeps its
  installation scope, and a development build is now a second installation
  rather than an ambiguous second process. No IPC channel, host protocol,
  storage schema, or packaged-installation path changed. See
  `03-runtime/07-process-model.md`, `03-runtime/04-data-storage.md`, and
  `02-architecture/03-repo-structure.md`.

## 2026-09-20 — The app ships no fonts (D598)

- Decision D598 amends D232 / ADR 0083. The four bundled families (Geist,
  Inter, Noto Sans SC, LXGW WenKai), their `woff2` files, their OFL license
  texts, `styles/fonts.css`, and its `@import` are gone, together with
  `BUNDLED_FONTS`, the `BundledFont` type, `FontOption.license`, the picker's
  license badge, and the `settings.fontBundled` key in all eight catalogs.
- The Settings Font picker keeps its shape: System default persists the empty
  string, then the installed system families Electron main enumerates over
  `pi-desktop/app/systemFonts` using platform tooling only (deduplicated,
  filtered, sorted, cached 60 s). The `bundled` group is gone; a stored stack
  that matches no option still leads the list under Saved.
- Every generated stack appends the system-only CJK tier `"PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", sans-serif`, with no bundled family in
  front of it. A previously stored bundled stack (for example `"Geist",
  "PingFang SC", …`) is kept byte for byte, shows under Saved, and renders
  through that tier. No migration, protocol, or schema change.
- `out/renderer` emits no application font face any more; only KaTeX's `woff2`
  glyphs remain. See ADR 0298, `04-ux/06-settings-ia.md`,
  `04-ux/07-ui-design-system.md`, and E2E-126.

## 2026-09-20 — Stdio MCP spawn uses the login-shell PATH (D600, issue #571)

- Finder/Dock launches Electron with `/usr/bin:/bin:/usr/sbin:/sbin`. User MCP
  stdio spawn copies that PATH and uses `shell: false`, so a market-installed
  Fetch server (`uvx mcp-server-fetch`) failed with `spawn uvx ENOENT` even
  when `uvx` worked in a terminal. Same hole for `npx`.
- Electron main now probes the login shell the way host-core already does for
  Bash (ADR 0045): `$SHELL -lic 'printf %s "$PATH"'`, 5s-bounded, cached, last
  stdout line only. Well-known user bin dirs that exist (`/opt/homebrew/bin`,
  `~/.local/bin`, `~/.cargo/bin`, …) are merged in. Windows stays on the
  inherited PATH. Command names stay bare; arguments stay literal.
- A missing executable is reported as `command not found: <name>` instead of
  a raw `spawn uvx ENOENT`.
- See ADR 0045, `03-runtime/03-tools-and-permissions.md`, issue #571.
## 2026-09-20 — Settings explain themselves on demand (D601)

- Decision D601 is renderer-only. A settings row no longer carries a permanent
  second line of prose under its title: `SettingsRow.description` is a string
  that renders behind the question mark beside the title, and `SettingsCard`
  gains the same `description` for a card heading. `HelpIcon`
  (`components/ui.tsx`) is the single affordance — a real button, so a keyboard
  reaches the sentence a pointer hovers, and the sentence itself is its
  accessible name. `Field`'s `hint` moved to it as well.
- A row's live value is not an explanation and stays visible: the pinned
  default model travels through the new `SettingsRow.detail`, and
  `NetworkProxySection`'s local copy of the row skeleton is gone in favour of
  the shared one, so the retired line cannot return through a second renderer.
- The mark is a sibling of the element it explains wherever that element is a
  heading, because a nested button joins the heading's accessible name. A
  settings `Field` is the deliberate exception: its hint stays inside the
  `<label>`, so the field's accessible name carries the sentence too. Moving it
  out would cost click-to-focus on every field, which a longer name does not
  justify.
- No IPC channel, host protocol, storage schema, persisted setting, or i18n key
  changed: every sentence keeps its key and only its placement moved. See
  `04-ux/06-settings-ia.md` and `04-ux/07-ui-design-system.md`.

## 2026-09-20 — Crash dumps stay in the data directory (D602)

- Crashpad starts local-only (`uploadToServer: false`) before `ready`. Dumps
  live under `<data_dir>/crash-dumps`, not Electron's default `userData`
  crashDumps path, so a `PI_DESKTOP_DATA_DIR` profile does not share dumps
  with another installation. The marker `crash-dumps.json` records the newest
  mtime already reported.
- The next lock-holding launch writes one `diagnostics` line for dumps newer
  than that marker, classified by Crashpad's `ptype` annotation: `error` if
  any new dump is the browser/main process, `warn` for a recovered renderer,
  GPU, or utility crash. A scan failure is one `crashDumpReportFailed` warn
  and never blocks the first window.
- Host-core and sidecar crashes stay on the supervisor path and the `host` /
  `agent` log channels. Nothing is uploaded. See
  `03-runtime/07-process-model.md` §4, `03-runtime/09-logging-and-observability.md`,
  and `03-runtime/04-data-storage.md`.

## 2026-09-20 — The dock occludes transcript paint below Composer (D603, issue #728)

- The transcript scrollport fills the conversation pane while its content
  reserves the measured Composer height. Because the absolutely positioned dock
  was transparent, a row could keep painting below the floating shell and stay
  visible in its bottom gap or outside its rounded corners.
- `.composer-dock-docked` now paints the opaque `--ds-bg-primary` workspace
  surface across its full width. The Composer retains its existing translucent
  elevated token, radius, shadow, and measured scroll reserve; the backing band
  removes only transcript paint that has crossed the Composer boundary.
- Renderer CSS and the theme surface regression change only. There is no scroll
  state, protocol, persistence, theme schema, or permission change. See
  `04-ux/08-component-spec.md` and E2E-CHAT-opaque-floating-decision-and-retry-surfaces.

## 2026-09-21 — The context estimate is calibrated conservatively (D606)

- Every budget threshold reads one number, and that number is corrected against
  what requests actually cost. pi's estimator anchors on the last assistant
  usage and estimates the rest as `chars / 4`, which under-counts CJK text by
  roughly a factor of 2–4 and, with no anchor left, omits the system prompt and
  tool schemas entirely.
- The two errors are applied separately: the per-character bias as a
  scale-free ratio over the guessed tail, and an unanchored residual as a ratio
  only for observations taken at a comparable scale (0.5×–2×), otherwise as the
  observed overhead capped at 32,000 tokens. A 100k-scale sample therefore
  cannot be applied as a ratio to a 1M projection.
- The correction is asymmetric: upward applies once three observations exist;
  downward needs three agreeing samples, is capped at 15 % per step, and can
  never take the value below 85 % of the raw estimate, so a projection at
  1.18× the hard limit still compacts. A report outside 0.5×–3× of what the
  calibration predicted is a misreport, and two consecutive misreports freeze
  the downward direction. See `03-runtime/02-agent-runtime.md` §5.1.

## 2026-09-21 — A tool-call id is unique in every request (D608, issue #718)

- Anthropic-family endpoints, DeepSeek's included, reject a whole turn with
  `tool_use ids must be unique` when the request carries a call id twice, and
  the session cannot continue while that lasts. The transcript is an append-only
  snapshot stream that tolerates a retried append, so the same call can reach
  the assembled context twice: under one row id, which the host's keep-last read
  already collapses, or under two, which it cannot.
- The last view before the wire therefore keeps the first occurrence of each
  `toolCall` id and drops a later call or a later result for that id, so the
  call/result pair the provider validates stays well-formed. A request with no
  duplicates is returned unchanged (identity, not a copy). Nothing is rewritten
  on disk and no compaction or retention rule changes.
- A drop is reported once on the `agent` log channel with the session and the
  ids, so the next report of this names the writer instead of only the
  provider's sentence. See `03-runtime/02-agent-runtime.md` §5.
- The guard is deliberately the request boundary rather than the history
  rebuild: it also covers a duplicate that appears while the session runs, which
  a rebuild-time filter cannot see.

## 2026-09-21 — A plugin crash reports its exit code without copying raw output (D607, issue #747)

- The host-process crash path reported only the plugin id, so a report read
  `plugin host process exited: <id>` and carried nothing else — the reporter in
  issue #747 had exactly that sentence and no way to say more. The exit code it
  already had is now part of the message, the `failed` service state, the
  `plugin.crash` audit record and the `plugin` log channel; on Windows a hard
  fault (`0xC0000005` and friends, delivered as a negative signed int, printed
  alongside its unsigned hex form) and a plugin's own `process.exit(1)` are
  different bugs and this is the only field that tells them apart.
- Plugin stdout/stderr is not copied into the load error, crash audit record, or
  crash log payload because it may contain workspace data or secrets. Nothing
  new is persisted and no permission or API surface changes; the existing
  `plugin.stdio` audit stream is otherwise unchanged.
- See `07-plugins/05-plugin-lifecycle.md` §3.1.

## 2026-09-20 — The Create project name defaults to the primary folder (D609)

- The Create project dialog required a typed name before Create became
  available, so a local folder pick could not be confirmed without inventing a
  title; the git source already seeded the field from the repository name
  (D438, ADR 0273).
- The name field is now optional for both sources. It seeds from the picked
  source — the first selected folder's name for a local pick, the repository
  name for a git checkout — and stops following the source as soon as the user
  types their own name. Create is gated by the source alone (one folder, or a
  parsed URL plus a destination), and a field left empty falls back to the same
  derived name.
- Derived names are cut to `MAX_PROJECT_NAME_CHARS` (80) so the persisted
  sidebar preference and the name field accept them unchanged. Folder-name
  parsing moves to `apps/desktop/src/lib/project-name.ts` and is shared with the
  dialog's folder rows.
- Renderer only: no protocol, storage, host, permission, or migration change,
  and no new default. See `04-ux/08-component-spec.md`, ADR 0233, ADR 0273, and
  E2E-012a / E2E-256.
## 2026-09-21 — A stored model binding array is read entry by entry (D610, issue #784)

- `config_json.models` is the only place a provider's model list lives, and it has more than one writer: a settings save, a plugin declaration, and an external edit of the stored row. It was decoded as a single `Vec<ModelBinding>`, so one entry that no longer matched the schema discarded every sibling — after which the provider read back as the single legacy default model derived from `defaultModelId`, every other configured model gone, and nothing said about why. The report reproduced it by deleting one binding's `maxTokens`: 12 stored bindings read back as 1.
- `contextWindow` and `maxTokens` are therefore optional on the wire, and each entry of the array is decoded on its own. An absent key, or an explicit `0`, reads as zero and is seeded with the generic default (128,000 / 8,192) by the normalisation that already existed for the explicit zero — the same value a record carrying only `defaultModelId` is materialized with, and the same value a plugin manifest that declares no limits already produces. The two paths now agree instead of one rejecting what the other accepts.
- An entry that still fails to decode costs itself, not the array: the readable entries survive in their stored order, and the failure is reported on the host log with the provider id, the entry's index and the reason, so it is locatable rather than silent. An absent `models` key, an empty array, and an array whose every entry was unreadable all still read as the legacy binding, so a provider stays selectable whatever its stored shape; only the third is reported, because an empty array is a legal state and an absent one predates bindings.
- Nothing is rewritten on disk and the write path remains explicit: `providers.update` still persists exactly the bindings the client sends. Before accepting an explicit model-array replacement, the host checks the stored value and rejects it with `MODEL_BINDINGS_DEGRADED` when the value is degraded, so a partial settings view cannot erase unreadable entries; unrelated provider fields remain updatable. See `03-runtime/12-provider-config-schema.md` §2.

## 2026-09-21 — A hand-typed custom model id is seeded from the model library (D611)

- Adding a custom model by id gave every binding the generic 128,000 / 8,192
  seed and no thinking levels, even when the model library already published
  that id, so the user had to retype limits the app could have known.
- The settings picker now matches the typed id against models.dev through a new
  snapshot-only renderer channel, `providers.lookupModel`, and seeds the binding
  the way a picked model is seeded — published context window, max output
  tokens, and thinking levels — while the stored id stays exactly what the user
  typed. The row is written first with the generic seed and upgraded in place
  when the answer arrives, so a slow, failed, or unpublished lookup still leaves
  exactly one usable row, and an edit or delete made meanwhile is never
  overwritten.
- No provider network request, host call, schema, or persisted-data change; a
  miss behaves exactly as before. See `03-runtime/12-provider-config-schema.md`
  §2 and §9.

## 2026-09-21 — Adding a provider never takes over an app default (D612)

- The provider add flow wrote `defaultProviderId`/`defaultModelId`, and the
  image flow wrote `imageGeneration`, whether or not the app already had one, so
  configuring a second service silently moved the default away from the model
  the user was running.
- The add flow now follows the rule editing already followed: a stored default
  survives while it still resolves, and only an unresolvable one is replaced.
  For the model default that means the default provider row still exists and
  still offers the model — the same resolution the settings summary renders
  through — so an id left behind by a deleted provider is not a default and a
  newly added provider may fill what would otherwise render as unset. The image
  default uses the mirrored rule against its stored binding, and its candidate
  list still accumulates the new provider's image models, so nothing vanishes
  from the picker.
- Settings are written only when no default resolves; the explicit "make
  default" action, the edit path, and the fallback to the first remaining
  binding after removing the selected model are unchanged. Behaviour is pinned
  by `apps/desktop/test/default-model-display.test.mjs` and
  `apps/desktop/test/image-generation-default.test.mjs`, with
  `provider-model-config.test.mjs` asserting the add branch consults them.

## 2026-09-22 — The loop owns its context array (D620)

- A turn whose later iterations ran tools left `state.messages` holding two copies
  of every message those iterations appended, and the next turn's first request
  was assembled from that array. The duplicate of an assistant message that
  carried text plus a tool call survived the request guard (D608) as a text-only
  clone sitting between the call and the result answering it; pi-ai then closed
  the still-pending call with a synthesized "No result provided" output next to
  the real one, so one call id carried two outputs and the endpoint rejected the
  whole turn with `Duplicate tool output for call_id` (HTTP 400, not retriable).
  The array is reused, so every following turn failed the same way and `继续`
  could not recover the session.
- pi-ai's loop appends each streamed assistant message and each tool result to
  the context it was handed, while its own `message_end` listener appends the
  same message object to `state.messages`. `rebuiltAgentContext()` returned that
  live array, so both appends landed in one array; it now returns a copy, exactly
  like pi's own `createContextSnapshot()` does for `prompt()` and `continue()`.
  The delegate's turn boundary handed over the same live array
  (`subagent.ts` `prepareNextTurn`) and now copies too. The loop's view and
  `state.messages` carry the same messages in the same order at each message
  boundary, they are simply no longer the same array — which is what keeps the
  duplicates out of the next request.
- The request guard at `convertToLlm` (D608) now matches what the provider
  validates: call and result ids are compared by their wire-visible part, a
  result whose item half disagrees with its call is paired to the call's id, and
  an assistant message whose tool calls were all already claimed is dropped whole
  instead of being kept as the clone that separates a call from its result. The
  drop log line also states how many messages were removed. A message that
  replays one claimed call while carrying a new one is left in place with its new
  call, the only id sharing the guard accepts; no writer reaches that shape.
- No provider transport, host protocol, version, storage migration, transcript
  rewrite, or compaction/retention/budget rule changes.
  `03-runtime/02-agent-runtime.md` §5c and
  E2E-RUNTIME-loop-context-ownership record the contract and its coverage.
## 2026-09-21 — Bound Desktop trusted-extension lifecycle waits

- Apply the existing 30-second handler budget to notification, startup and
  shutdown handlers as well as result handlers; module loading and factory
  initialization each use the same budget. This changes previously unbounded
  waits, including event handlers waiting for a UI answer.
- Abort retires current waits; disposal rejects new dispatches and runs shutdown
  once. Late settlements cannot supply results to the retired dispatch. Existing
  fail-open error handling, result folding, plugin ownership and permissions
  remain unchanged. In-process code is not forcibly terminated.
- Deferred events remain registrable and now appear in existing diagnostics.
  See `07-plugins/16-trusted-extensions.md` §6 and
  `E2E-HOOKS-cancel-and-dispose`.
## 2026-09-22 — An unreadable command source refuses a slash submission (D613, issue #795)

- Composer send-time resolution read the merged command list and swallowed a
  failure as `null`, which the submit path could not tell apart from "no such
  command". `/compact` typed while that IPC read failed was therefore sent to the
  model as literal prompt text, and the model acted on it as an instruction.
- Resolution now answers with three outcomes instead of one nullable value:
  resolved (builtin/plugin/extension dispatch), unknown (templates, aliases, and
  id-less entries continue as prompt text), and unavailable. Unavailable refuses
  the submission, keeps the draft, and shows
  `chat.slashCommandSourceUnavailable`. The failed read leaves the TTL cache
  cold, so the next submit retries it; a warm cache still resolves through a
  source blip.
- The refusal is fail-closed on purpose: only the command source can say whether
  `/name` is a control command, so while it cannot be read a `name` that looks
  like plain text is refused rather than guessed. Templates and genuinely unknown
  aliases keep the old prompt path. Pinned by
  `apps/desktop/test/slash-command-source.test.mjs` and
  `03-runtime/01-ipc-protocol.md` §13c.

## 2026-09-22 — A manual compaction has its own transport deadline and a durable verdict (D614, issue #795)

- `agent.compact` is a blocking RPC that spends a whole model summary request
  inside the sidecar: pi serializes the conversation, streams the summary, and
  retries a transient failure. It ran under the flat 130s transport default, so a
  ~158s compaction on an 888KB context ended as `sidecar RPC timeout` while the
  sidecar kept working and persisted the checkpoint — the user was told the
  compaction failed, and the next turn proved it had succeeded.
- The deadline is now derived from the ceilings the sidecar actually enforces:
  one stream watchdog (180s) per attempt, `1 + 3` attempts, the 2s/4s/8s retry
  backoff, and transport slack — `AGENT_COMPACT_RPC_TIMEOUT_MS`, deliberately
  per-method rather than a wider global default.
- Either host path (Electron `agentCompact` IPC and `RuntimeService.compact`)
  also stops treating a transport timeout as the sidecar's verdict: it re-reads
  the durable `session.compaction` record and reports success when a new
  checkpoint landed, logs the mismatch, and rethrows the timeout otherwise. A
  verdict the sidecar reported itself is never reconciled. Pinned by
  `packages/host-runtime/src/runtime-service.test.ts`,
  `packages/shared/src/protocol.test.ts`,
  `apps/desktop/test/plugin-timeout-budgets.test.mjs`, and
  `03-runtime/01-ipc-protocol.md` §5.4.

## 2026-09-22 — An empty transcript read is retried and never cached (D615, issue #795)

- The renderer treated every durable `session.get` window as the truth, and
  cached it. A window that came back empty for a session with thousands of
  messages — the host answers such a read from a transcript file it may be
  rewriting — was stored as an empty snapshot, hover prefetch re-served it, and
  the pane stayed blank until the app restarted. Nothing distinguished a failed
  or stale read from an empty conversation, and no path retried one.
- A read is now judged against the session's own count: zero messages for a
  session the sidebar counts as having history triggers one more read, then keeps
  the snapshot the user already has, and otherwise reports
  `chat.sessionTranscriptEmpty`. The empty page is never written to the
  transcript cache, so a hover prefetch cannot poison every later open.
- This is a defense, not the host-side root cause: the transcript rewrite is the
  reporter's 0.15.1 storage layout, and the read side still answers "session
  exists, no messages" instead of reporting an unreadable transcript. See
  `04-ux/09-interaction-patterns.md` §Session isolation across tabs.

## 2026-09-22 — A renderer that never reaches its first state gets a bounded surface and a quit channel (D616)

- The renderer's startup had no timeout of its own: `bootstrap()` either
  publishes the initial state or nothing, so one read that never settled left the
  window on the boot surface with no menu, no data, and nothing to act on except
  force-quitting the process (issue #831). The renderer now watches its own wait.
  `STARTUP_SLOW_HINT_MS` (30s) adds logs, diagnostics, and quit to the boot
  surface without calling the boot a failure; `STARTUP_STALLED_MS` (180s) turns it
  into the recovery surface, which also offers a retry that re-runs `bootstrap()`.
- Both bounds sit above the main↔host RPC ceiling (`DEFAULT_RPC_TIMEOUT_MS`,
  130s), so a slow but successful boot is never read as a failure, and the
  watchdog never cancels the startup it watches: a boot that finishes replaces the
  surface with the shell. The recovery surface replaces the splash (exactly one
  boot surface is mounted), and the renderer-drawn window controls stay above it,
  so a frameless Windows/Linux window can always be closed.
- The renderer gains the quit channel `pi-desktop/app/quit` (`api.quitApp()`),
  whose handler calls `app.quit()` exactly like the Quit menu item, so the ordered
  shutdown, the confirmation dialog, and the close behavior stay the ones the app
  already has. See `03-runtime/07-process-model.md` §3 and E2E-076.

## 2026-09-22 — A failed compaction keeps the recent window (D617, issue #827)

- An automatic compaction whose summary request failed installed a
  retained-tail checkpoint that carried at most the latest user message, and a
  rebuild narrowed a stored checkpoint's tail the same way. A long turn
  therefore reached the next model request as one user sentence: the reported
  session lost roughly 168 messages (3 user / 34 assistant / 131 tool) between
  two checkpoints while the transcript on disk and the UI row stayed intact.
- The fallback now retains the real recent window — the newest contiguous
  messages of the compacted range, every role, bounded by the keep-recent
  target and by what the carried summary and the recovery notice leave — and
  marks it with `details.retainedTailShape`, so a rebuild replays it. A
  checkpoint without the marker (every successful checkpoint, and every record
  written before it existed) still normalizes to the latest user message. An
  `active_turn` fallback also keeps the active task's user message when the
  window cannot hold it, the fallback drops the assistant messages pi drops
  anyway and any tool result whose call is not in the window, and
  `details.failureReason` records `no_new_history` / `summary_budget` /
  `summary_provider` / `checkpoint_oversized` instead of provider error text.
- A summary prompt that is still too large after the single reduced pass is no
  longer skipped: the range is split into contiguous chunks that each fit, at
  most 16 requests, each carrying the previous chunk's summary, and the
  checkpoint reports the summed usage of the requests that produced it. Only an
  empty range, or one past that request bound, still falls back on budget
  grounds. See ADR 0302, `03-runtime/02-agent-runtime.md`, ADR 0049, ADR 0282.

## 2026-09-20 — A copied formula is its TeX source (D619, issue #414)

Math boundaries remain parseable after copying: touching inline fences get
one separator, and every prose dollar in the copied text is escaped, together
with backslash runs that would otherwise escape a fence.
Annotation whitespace is preserved; widened multiline inline math uses a
literal `<span>` wrapper to prevent a flow opener when pasted at column zero.
TeX newlines are not flattened because they can terminate `%` comments.
The wrapper is Markdown source in `text/plain`, not a `text/html` payload;
compatibility with external editors that disallow inline HTML is not promised.
Regression coverage checks both copy entry points and Markdown round trips
for adjacent formulas, prose dollars on either side, formatting wrappers,
line/block boundaries, padding, and multiline math including TeX comments.
Display math containing `- x`, `+ x`, `* x`, `> x`, or internal blank lines
must remain a single math node after copying. The shared remark grammar
keeps unclosed math in the streaming tail until its fence closes; subsequent
prose and its source offsets remain intact. A footnote whose definition
follows its reference — adjacently or streamed in later — renders as a real
reference and note section rather than a literal `[^1]`, which is what block
splitting costs when a slice is parsed without the rest of the message.
CRLF, ordinary lists, quotes, GFM tables, fenced code and the sources that
must keep splitting are covered by `markdown-blocks.test.mjs`.


- KaTeX paints one formula twice — a MathML tree for assistive technology and a
  visual tree of positioned spans — and both are real text in the document. The
  platform's own copy therefore wrote a formula out as its glyphs, twice over,
  and never as the source the answer was written in.
- A copy whose selection covers rendered math now reads the TeX back out of the
  MathML `annotation`: `$…$` inline, `$$…$$` on its own lines. Those are the
  delimiters `lib/latex-math.ts` normalizes `\(…\)` and `\[…\]` to before
  `remark-math` runs, so a pasted formula renders as the one it came from. A cut
  that lands inside a formula grows to the whole formula, because half a TeX
  expression is not one and a cut between the two trees would take the source
  from one and the glyphs from the other.
- Each delimiter run is widened past any run inside the formula, the way a code
  span's fence is, because `$\$5 + x$` closes at the escaped dollar and pastes
  back as prose. Inline stays the narrow run otherwise, and not for the reason
  it first looks like: a single-line `$$…$$` never opens a display block, since
  math flow forbids `$` in the meta after its opening fence. It stays narrow
  because an inline formula's TeX can carry a newline — only the `\(…\)` path
  has its newlines flattened by the normalization — and a `$$` run would then
  land at the start of a line with the rest of the formula behind it, which is a
  flow opening and swallows the paragraph.
- Display math is not always a block here. `normalizeLatexMathDelimiters`
  rewrites `\[ … \]` in place — the rewrite is length-preserving — so the math
  node stays inline and `remarkLatexBracketDisplay` promotes it, leaving KaTeX
  to paint `.katex-display` inside the sentence's own paragraph. The reduction
  puts its paragraph slot there unchanged; a `p` nested in a `p` is invalid as
  markup and harmless here, because the clone is only ever read through the
  text serializer, which treats the nested block as one boundary. One newline
  above `$$` is enough for `remark-math` to open the display block, so the
  formula pastes back as the display formula it came from. Both `\[ … \]`
  shapes are pinned by E2E-CHAT-copy-formula-as-tex.
- A table cell is the one place the block slot had to be measured rather than
  reasoned about, and the measurement is recorded because the reasoning points
  the wrong way. `remarkLatexBracketDisplay` promotes a `\[ … \]` node wherever
  it sits, cells included, so `.katex-display` really does land inside a `<td>`
  — and the table serializer joins cells with tabs, which makes it look as
  though the `$$` fence there would be closed by a tab and swallow the rest of
  the row (`a\tb\n$$\nE = mc^2\n$$\t2` is one math node whose value runs to
  the end of the line). Chromium writes no such string: a block box is a block
  boundary inside a cell too, so the row breaks around it, the fence closes on
  its own line, and the neighbouring cell arrives on one of its own. The slot
  is not inventing that boundary either — the platform's own reading of the
  same row has no tab in it, because `.katex-display` breaks the row for it as
  well — so keeping the display form here is the parity the rest of this
  decision rests on rather than an exception to it. Narrowing to the inline run
  in a cell was considered and rejected: it would pay display math to repair a
  shape the serializer does not produce, and it would put a tab back that the
  platform itself does not write. E2E-CHAT-copy-formula-as-tex asserts both
  halves, so a Chromium that started tab-joining a cell holding a block would
  fail there rather than in a user's clipboard.
- Only the formulas are rewritten. Everything else in the selection — prose,
  lists, tables, code blocks — is serialized by the platform itself: the
  reduced clone is selected and read back through `Selection.toString()`, the
  serializer a copy actually runs. A hand-written walk of the tree could only
  approximate those whitespace rules, and everywhere it fell short it would
  silently rewrite content the platform already got right: source line wrapping
  put back into a paragraph, blank lines between list items, a code block's own
  blank lines collapsed.
- The serializer has to be the copy's own, not a near neighbour. `innerText`
  reads almost identically and has no notion of `user-select`, so it writes out
  the chrome `base.css` marks inert — a code block's language rail reaching the
  clipboard as a stray `js` line. Restating that rule inside the reduction
  would be the hand-written walk this decision rejects; running the platform's
  own serializer makes the parity exact instead of approximate. The clone is
  read inside the element the selection came from rather than parked on `body`,
  so the cascade deciding that reading is the live one; restating the selection
  contract on the clone instead (an inline `user-select: text`) inverts it,
  because the shell is unselectable by default and document-like surfaces opt
  back in — chrome that is inert only by inheritance would arrive in the
  clipboard.
- Every other selection is left alone: a selection with no formula in it is the
  platform's business. There is no second test of whether the copy "belongs to"
  the selection, because Chromium derives the event target from the selection
  itself, so a non-collapsed selection always raises its copy inside itself;
  a target check only rejects ranges built with `selectNodeContents`, the
  transcript's own Select text among them. A copy raised in the composer cannot
  carry a stale transcript selection either — a frame holds one selection, so
  focusing a field collapses it, and a collapsed selection is already declined.
- One clipboard flavour, `text/plain`. Taking the copy over drops the
  platform's `text/html` as well, and none is written back. The reduced clone
  is the app's own markup: serializing it would carry the chrome `base.css`
  marks `user-select: none` — a code block's `js` rail and its copy button —
  that the text reading drops, plus `data-source-*` bookkeeping and a display
  slot nested in a paragraph, which is a second and worse reading of one
  selection. Writing the rendering back instead is not an option either:
  KaTeX's stylesheet is the only thing that hides the MathML tree, and no
  stylesheet travels on the clipboard, so a rich paste target would show every
  formula twice — the very duplication this decision removes. Leaving the
  flavour out settles both: a rich paste target falls back to the plain text,
  which is the source. The cost is that a selection holding a formula pastes
  into a rich target without the tag-level formatting the platform's own
  `text/html` would have carried; the source is what the copy is for.
- One document `copy` listener, installed and removed by the shell
  (`hooks/use-copy-tex.ts`), because `Markdown` renders no wrapper of its own —
  answers, a work-panel file preview and a plugin readme reach the same
  formulas through different parents — and because a copy is a document
  gesture. The transcript's right-click Copy reads the same selection through
  the same module, so the two entry points cannot put two readings of one
  selection on the clipboard.
- Splitting a message into independently parsed blocks, which predates D619 and
  which D619 moved onto the rendering grammar, is only sound for a slice that
  needs no other slice's parse context. A link or footnote definition is
  exactly the counterexample: it resolves across the whole message, and a
  footnote also numbers, reuses and back-links across it, so a reference parsed
  without its definition survives as the literal `[^1]` and the note is
  dropped. A message declaring a definition anywhere therefore renders
  undivided. Injecting definitions into every slice was rejected: it renumbers
  footnotes per slice and aims the back-links at the wrong reference. The
  accepted cost is that such a message loses per-block memoization while it
  streams, which is the cost the renderer carried before it split blocks at all
  and which its rarity in chat answers keeps bounded.
- D619 adds no surface, no store state, and no action-row item: it is the OS
  clipboard that ADR 0268 already rested the removal of quotes on, made honest.
  Renderer only — no IPC channel, host protocol, storage schema, permission,
  Plugin SDK, or i18n key changed. See `04-ux/08-component-spec.md` §8.7 and
  E2E-CHAT-copy-formula-as-tex.
## 2026-09-22 — pi's file-op collector is fed the names it reads (D618, issue #827)

- A checkpoint's `readFiles` / `modifiedFiles`, and the `<read-files>` section a
  summary appends, come from pi's own `extractFileOpsFromMessage`, which switches
  on the lowercase names `read` / `write` / `edit` — the names pi's tools carry.
  PI-Desktop registers `Read` / `Write` / `Edit`, so the collector matched
  nothing and every checkpoint reported an empty file list; issue #827 turned
  this up while reading a compaction report.
- The conversion stays on our side of the boundary. `withPiFileOpToolNames`
  copies the entries handed to pi's `prepareCompaction` with exactly those three
  names respelled; no stored byte changes — a transcript, a checkpoint and a
  rebuilt context keep our names — and the input array comes back untouched when
  no such call is present, so the common path allocates nothing.
- Only those three are converted. pi's collector reads nothing else, so `Grep`,
  `Glob`, `Bash`, plugin and MCP names keep the spelling we register, and the
  summarized text changes only where pi consumes the name.

## 2026-09-22 — Provider header values fold fullwidth input instead of failing the turn (D621)

- A custom provider header value holding a fullwidth character — `０` (U+FF10)
  is what an IME or a fullwidth-formatted page gives for `0` — reached
  `Headers.set` and made undici throw `TypeError: Cannot convert argument to a
  ByteString because the character at index N has a value of X which is greater
  than 255`. The request never left, the text named no field the user could fix,
  and rows created before custom headers shipped could not show it: the same
  configuration looked healthy on an older build.
- Header values now fold the fullwidth block (U+FF01–U+FF5E) and the ideographic
  space (U+3000) onto ASCII, then trim, then require HTAB, printable ASCII or the
  Latin-1 supplement. A full NFKC pass is deliberately not used: it rewrites
  halfwidth katakana into U+30A2 plus combining marks, which still cannot travel.
  Host persistence refuses what remains with `HEADERS_INVALID` naming the
  character and its index; the runtime drops that row instead of throwing, the
  same way it already drops CR/LF and reserved keys.
- The fold runs on read as well as on write, so a value stored before the rule
  existed starts working after an upgrade rather than failing until the user
  retypes it. Provider API keys fold on both sides too — a key is signed into
  `Authorization` or `x-api-key`, where a fullwidth character can never be
  correct — but a key is never refused at save, because some endpoints still
  take it in a query parameter.
- The Advanced header editor says next to the rows when a value will be folded
  and when it will be refused, so the outcome does not arrive as a surprise
  error. One rule, two engines: `packages/shared/src/header-value.ts` and its
  Rust mirror in `crates/host-core/src/providers/validation.rs`. See
  `03-runtime/12-provider-config-schema.md`, ADR 0178, E2E-005G.
- The three boundaries where the rule runs fail differently on purpose, and the
  difference is the point: the editor's save refuses an unusable row and names
  the character, because a user is there to fix it; a stored map folds and drops
  on read; and a sync bundle folds and drops before it is deserialized into a
  write input, so a row a peer on an older build (or a pre-rule backup) still
  carries cannot fail a whole revision. Without that third boundary the stricter
  write turned one stale row into a permanently stuck sync — the read path would
  have hidden it while the write path aborted on it.
- Provider API keys fold on both sides too — a key is signed into `Authorization`
  or `x-api-key`, where a fullwidth character can never be correct — but a key is
  never refused at save, because some auth kinds do not put the key in a header
  (a query parameter, a SigV4 signature). A key that is still not Latin-1 keeps
  failing at request time; refusing it would block a save this writer cannot
  judge.

## 2026-09-22 — Catalog aliases enrich metadata without changing model identity (D622)

- Keep `modelIdsMatch` strict for configured bindings: exact IDs, full path
  suffixes, known vendor `-`/`.` prefixes and one-sided `@region` aliases;
  distinct regions, arbitrary proxy prefixes and thinking/endpoint suffixes do
  not merge bindings. PR #870 was closed because the frozen spec promised only
  exact IDs/vendor prefixes, without a recorded decision to widen lookup.
- For models.dev metadata only, `catalogModelIdsMatch` also accepts a complete
  bare leaf through a full route (e.g. `proxy/` or `custom/`) without known-vendor
  conflict; two distinct full routes do not match solely by leaf. It also strips
  trailing `thinking`/`think`/`agent`/`latest` tokens separated by `-` or `:`.
  No arbitrary dash proxy prefix or effort `low`/`high`/`max` stripping.
  Indexed candidate keys still require a matcher hit; a known provider/API
  scopes matches to its own catalog. No suffix alone grants reasoning:
  unmatched free-form IDs stay generic unknown, while published capabilities
  and explicit binding overrides retain their existing precedence. See
  `03-runtime/13-model-catalog-and-selection.md` §11.3.
