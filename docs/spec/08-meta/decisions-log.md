# Decisions Log

> Baseline delta: `0.3.0` → `0.4.22`
> Date: `2026-10-08`
> Status: Accepted for implementation

This log freezes previously open questions into concrete decisions.

Entries backed by an ADR carry a one-sentence decision and point at the ADR,
which holds the context and rationale. Entries without an ADR keep their full
text here.

## A. High-priority architecture decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D001 | Electron ↔ Rust transport | **Rust sidecar + stdio JSON-RPC (NDJSON)** | Simple isolation, debuggable, replaceable later |
| D002 | SQLite ownership | **Rust host-core owns SQLite exclusively** | Single writer, clearer privilege boundary |
| D003 | Default mode | **Agent** | Product is an agent desktop, not pure chat |
| D004 | Former restricted profile | *(superseded by D189)* **The former Chat read-only profile is removed; persisted Chat values migrate to Plan.** | The product now has one Agent with a planning state and a separate approval boundary |
| D005 | Permission timeout *(amended by D636 / ADR 0310)* | **Local permission approvals have no automatic deadline; explicit decision or cancellation is required.** | D636 keeps explicit cancellation and tool budgets. See ADR 0310. |
| D006 | `allow-session` scope | **By `toolName`** | Simple UX; workspace sandbox still enforces path safety |
| D007 | `~/.pi` compatibility | **No auto-import in MVP** | Keep config ownership clean in `~/.pi-desktop` |
| D008 | Node runtime packaging | **Dev uses system Node; release runs the bundled sidecar on the Electron binary via `ELECTRON_RUN_AS_NODE=1` (no separate Node shipped)** | Unblock M1–M4; resolved at M5, see 03-runtime/07-process-model §6 |
| D009 | Plugin runtime isolation | **Target = separate process; M4 may use host-managed sandboxed runtime** | Ship plugin foundation pragmatically without weakening API gateway |
| D010 | First release platform | **macOS arm64 only** | Focus acceptance and packaging |
| D373 | Remote Agent Control host boundary | *(amended by D374 and D375)* **Remote control runs through a logical Agent Host owning sessions, turns, cursors, approvals, and a Gateway owning identity and routing.** | Remote needs its own boundary, not IPC. See ADR 0205. |
| D374 | Remote Agent Control v1 target amendments | **Amend D373: `RACP-WS` is the only normative binding, and typebox in `packages/shared` is the single contract source.** | Draft review found narrower vocabulary and per-token deltas. See ADR 0205. |
| D447 | Headless runtime boundary | **Amend ADR 0205 (ADR 0284): the Electron-free runtime layer lives in `packages/host-runtime` with transports, supervisor, turn lifecycle, and D299 persistence.** | `pi-host` must run the desktop's lifecycle invariants. See ADR 0205, ADR 0284. |
| D448 | RACP-WS transport and device pairing | **Amend ADR 0205 (ADR 0285): `packages/racp` holds both `RACP-WS` ends, header-profile device and pairing tokens, and the extended contract.** | Needs a bindable server and a desktop client. See ADR 0205, ADR 0285. |
| D451 | Review opens only on explicit user action | **A tool result never opens, activates, or resizes the work panel; Review needs explicit user action.** | Silent side panels compete with the user's reading. See ADR 0043. |
| D452 | Plan and goal artifacts open in the bundled file view | **The approval card's artifact opener uses the bundled `pi.file-manager` view, falling back to a host file tab.** | Plans landed where users do not browse files. See ADR 0043, ADR 0241. |
| D459 | Restore resizable sidebar width with collapse-below-threshold | **Amend D408 and restore ADR 0141: the sidebar is again a resizable `240px..520px` column defaulting to `275px`.** | Long labels need reclaimable width. See ADR 0238, ADR 0290. |
| D457 | Signed macOS DMG is a two-icon install | *(amended by D634)* **Amend D406: DMGs ship only `PI-Desktop.app` and the Applications link; ZIPs ship only the app.** | Signed DMGs no longer need first-launch guidance. See ADR 0232, ADR 0296, ADR 0309. |
| D634 | Remove bundled macOS first-launch guidance | **Amend D457: no macOS DMG or ZIP ships a quarantine-clearing helper, opening note, or first-launch script.** | Signed releases removed the need for the workaround. See ADR 0296, ADR 0309. |
| D635 | Work-area-capped 800×560 window minimum | **Supersede the 1040×700 minimum in D156: Electron enforces an 800×560 minimum capped to the work area.** | A fixed minimum exceeded 150%-scaled Windows work areas. See ADR 0029, ADR 0238. |
| D636 | Local permission approvals have no automatic deadline | **Amend D005: a local permission-gated `tools.execute` stays pending until the user decides, cancels, or the process exits.** | Missed requests must not become automatic denials. See ADR 0011, ADR 0310. |
| D637 | Remove the Windows frameless resize rim | **Disable the Windows thick frame while keeping native frameless edge resizing and the D635 minimum contract.** | The thick frame paints an unwanted rim. See ADR 0317, ADR 0325. |
| D638 | Publish native Linux arm64 artifacts | **Amend D126, D285, and D603: releases publish native Linux arm64 AppImage, deb, and rpm packages.** | arm64 devices could not run the x64 artifact. See ADR 0022, ADR 0318. |
| D639 | models.dev owns published chat-model metadata | **Supersede D136 / D266 and ADR `pi-ai-core-0991-authority` for chat metadata: the bundled and explicitly refreshed models.dev catalog supplies published chat-model limits, modalities, reasoning metadata, names, and prices. Prefer the selected official publisher; when it has no record, accept another publisher only for a safe, unambiguous match, otherwise keep generic metadata. The checked-in preset identities are the priority set; do not assert an unsupported fixed count of 39. Live endpoint/OAuth discovery still owns selectable IDs. Pi remains responsible for OAuth, wire identity, transport and typed non-chat operations, but never supplies sibling chat limits, reasoning or prices. Explicit user binding overrides remain authoritative. No credentials are sent to models.dev; no host schema/protocol or persistence change. See ADR `models-dev-catalog-authority` and E2E-162 / E2E-MODEL-catalog-window-correction-reaches-saved-bindings.** | A Pi sibling default assigned a 272,000-token window to GPT models whose selected models.dev records publish 1,050,000 tokens, changing the Settings display and runtime context budget. |
| D640 | User MCP tools keep the normal approval path | **`mcp_<serverId>_<tool>` calls are `medium` risk in host-core: under `ask` and `accept-edits` each call shows the approval card ("MCP server tool requires approval"), allow-once and allow-session keep their usual scope (one call / that exact tool name in that session), `auto` runs without a card, and Plan/Goal still deny. Annotations or risk values the MCP server declares about its own tools are ignored and never lower the path. Dispatch, read-only-mode handling and the `mcp_` namespace are unchanged; no host protocol or persistence change. See ADR `mcp-tool-approval-risk` and E2E-MCP-tool-requires-approval.** | MCP tools were auto-allowed as `low` risk, so a configured server could write files, call networks or run commands without any prompt under `ask`. Configuring a server is consent to launch it, not to every action its opaque tools take. |
| D641 | Custom endpoint API style precedence | **A custom endpoint uses the saved provider-row `apiStyle` ahead of a model catalog's adapter API. Named and OAuth providers can continue to use a model-level wire API pin where their published configuration requires a different transport. This keeps a user's explicit endpoint choice stable without removing model-specific routing such as OpenCode Go Responses models. No persisted format or protocol change. See E2E-005E and issue #1313.** | A publisher's adapter default must not silently redirect a custom gateway whose user-selected API format is different. |
| D642 | Cloud sync is a public Experimental destination *(amended by D643)* | **Remove the developer-mode and packaged-build gates from the Settings `sync` destination: its rail row, page, and settings-search hits exist for every user in every build, and a saved `sync` tab no longer falls back to General. Remote Hosts keeps both gates and its own badge. The destination keeps its Experimental badge on the rail row and page title; sync behavior, protocol, host schema, and persisted data are unchanged. See `04-ux/06-settings-ia.md` and E2E-CONFIG-SYNC-webdav-portable-configuration.** | Encrypted WebDAV backup is the app's only multi-device configuration path, and a developer-mode gate left it undiscoverable for the users who need it. |
| D643 | Cloud sync ships without an Experimental badge *(amended by D649 and D655)* | **Amend D642: the Settings `sync` destination drops `experimentalBadgeKey`, and `settings.configSync.experimental` is removed from every bundled locale. Cloud sync stays available to every user in every build. Remote Hosts keeps its own badge and both gates. Sync behavior, protocol, host schema, and persisted data are unchanged. See `04-ux/06-settings-ia.md` and E2E-CONFIG-SYNC-webdav-portable-configuration.** | Cloud sync is the app's shipped multi-device path, so an Experimental label no longer described it and only made the destination look unfinished. |
| D644 | Portable instruction files have no size cap | **Remove the 32 KiB per-file cap Host enforced on portable instruction files. Global and project instruction content is bounded only by the same portable-entity payload bound every other domain already has, checked when a revision is uploaded and when a remote one is validated. UTF-8 validation, symlink rejection, scope selection, mapping, and approval rules are unchanged. See `03-runtime/22-config-sync.md` §2.** | A 33 KiB project `AGENTS.md` failed the entire capture with `CONFIG_SYNC_LIMIT_EXCEEDED: instruction file is too large`, which the Settings page could only show as a generic backup-size error. |
| D450 | Signed macOS GitHub Releases | **Amend D078: tag releases Developer ID-sign, notarize, staple, and verify macOS DMG and ZIP before upload.** | Production DMGs must open without a Gatekeeper warning. See ADR 0022, ADR 0289. |

| D648 | Skill Market pins an acceptable address for mixed direct DNS answers | **Amend ADR 0272: on direct routes Skill Market pins one acceptable DNS answer instead of letting Chromium choose.** | Rejected answers must never be dialed. See ADR 0272, ADR 0321. |
| D649 | Cloud backup stays closed to users *(amended by D655)* | **Amend D642 / D643: the Settings `sync` destination carries `developmentOnly: true` again, so a packaged build omits its rail row, page, and settings-search hits and falls back to General, while development builds keep it. Developer mode stays irrelevant to the destination and it still carries no Experimental badge. Sync behavior, protocol, host schema, and persisted data are unchanged; dropping the flag reopens it for packaged builds. See `04-ux/06-settings-ia.md` and E2E-CONFIG-SYNC-webdav-portable-configuration.** | The encrypted WebDAV backup is not ready to be offered to packaged-build users yet, so it stays implemented but out of the way until it opens. |
| D650 | Plugin providers appear in Add Service | **Amend ADR 0259: plugin `provider.register` rows appear in Add Service with an optional category and description.** | Community providers were undiscoverable through Add Service. See ADR 0259, ADR 0322. |
| D651 | Transcript tool rows never auto-open | **Amend the leaf auto-open provision of the turn-process / thinking-display decisions and ADR `turn-process-and-thinking-display`: a tool-call, hosted-search or plan row keeps its payload collapsed in both display modes and only an explicit user action opens it, including the literal final item of the last activity group. Whole-process and ordinary-group defaults, failed/denied behavior, retained per-item choices, and the thinking row's own leaf default are unchanged. Renderer-only; no host protocol, persistence, permission or plugin contract change. See `04-ux/08-component-spec.md` §9.1/§9.2/§9.5/§9.6, `04-ux/09-interaction-patterns.md` §4.2, and E2E-040.** | A payload that opened itself under the newest call pulled attention away from the answer the user was waiting for and made one turn look different depending on how it ended; leaving every payload to the user keeps one predictable row. |
| D652 | Make session title generation a standalone plugin *(amended by D654)* | **Supersede ADR 0186: remove built-in title completion, keep the D654 fallback, and add the `session.autoTitle` plugin capability.** | Title generation belongs to an optional plugin. See ADR 0323. |
| D653 | Make Composer prompt enhancement an optional plugin | **Supersede ADR 0121: remove host-owned prompt enhancement and add the permission-gated `composer.transform` plugin contribution.** | Enhancement belongs to a separately installed plugin. See ADR 0324. |
| D654 | Keep the deterministic first-prompt session title in the core | **Amend D652: a still-placeholder title derives a 48-character fallback from the first prompt through `session/deriveTitle`.** | Untouched sessions kept showing a placeholder. See ADR 0323. |
| D655 | Cloud sync opens in packaged builds as Experimental | **Amend D649: remove the packaged-build visibility gate from Settings `sync` and restore its `Experimental` badge on the rail row and page title. Cloud sync and Remote Hosts are both available in packaged and development builds with Experimental badges. The S3 sync behavior, protocol, Host schema, and persisted data are unchanged. See `04-ux/06-settings-ia.md`, `03-runtime/22-config-sync.md`, and E2E-CONFIG-SYNC-s3-portable-configuration.** | The existing encrypted backup is useful to packaged-build users; the Experimental badge communicates its current maturity without keeping the feature hidden. |
| D656 | Quarantine appends the host keeps refusing instead of stalling the outbox | **Amend ADR 0041: an unclassifiable append is quarantined to a bounded dead-letter file and the flush continues.** | One refused append blocked every session's writes. See ADR 0041. |
| D657 | Let the embedded Browser open local files outside the workspace | **Amend ADR 0170: the embedded Browser may load any existing local file given an absolute path or `file:` URL.** | Users inspect local HTML outside a project. See ADR 0170, ADR 0328. |
| D659 | Reopen archived projects in the sidebar | **Amend D093: successful explicit project activation clears and persists the renderer-local archived flag.** | Reopening hid the project behind its archived flag. See ADR 0294. |
| D661 | Segmented turn process and independent thinking preference *(amended by D668)* | **Supersede the `Detailed` / `Compact` display-mode behavior and the single whole-process disclosure recorded by D633 / D651 and the `turn-process-and-thinking-display` ADR: a turn renders as chronological collapsible process segments, Bash and run aliases stay outside every folded container (the turn-level process disclosure and any ordinary activity group) and remain visible even when every group is collapsed, and process/group folding defaults are independent of the thinking preference. The preference is the optional boolean `AppSettings.showThinking`; absent or non-boolean values fall back to the legacy `thinkingDisplayMode` field (`compact` hides, `detailed`/unknown/absent shows), which is retained only for persisted-settings compatibility. `showThinking` joins the portable application fields so it synchronizes like the legacy field; no other host protocol, persistence schema, permission, or plugin contract change. See the amended ADR, `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`, and E2E-CHAT-turn-process-and-thinking-display.** | One flat container left long tool/search runs hard to scan and forced reasoning visibility and process folding into the same two-valued switch; an independent boolean plus always-visible Bash rows keeps shell-heavy turns readable without hiding the answer. |
| D662 | Open scoped HTML files in the work-panel Browser from plugins | **Add `pi.fs.openInBrowser(pathFromRoot)` under `fs.read`, opening validated scoped HTML files in the work-panel Browser.** | File Manager needs preview without `browser.cdp`. See ADR 0330. |

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
| D664 | Sidebar running activity defaults | **When unset, the master and Count badge resolve on while Activity rail resolves off. Explicit saved values remain authoritative. The master continues gating both affordances; turning it off does not rewrite either child preference. No schema or migration change.** |


## C. Provider & model coverage decisions (0.3.4)

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D023 | Provider coverage goal | **Universal market coverage** (not a tiny fixed vendor list) | Globalization + real coding workflows |
| D024 | Coverage strategy | **pi-ai native providers + first-class OpenAI-compatible + custom providers** | Maximum reach without rewriting every SDK |
| D308 | Zhipu / Z.AI named endpoint presets | **Amend D024: the add-provider Service select offers four named OpenAI-compatible Zhipu and Z.AI endpoints with locked URLs.** | Named presets avoid wrong URL and vendor mismatches. See ADR 0116, ADR 0155. |
| D389 | DeepSeek reasoning_content replay on aggregators | **Amend D024: Completions requests for DeepSeek-family models set `requiresReasoningContentOnAssistantMessages: true` (and, off `deepseek.com`, `supportsReasoningEffort: false`; amended by D672) when the row `vendorKey`, base URL, model id, or catalog `family` identifies DeepSeek. Do not change `thinkingFormat` for that match. pi-ai still auto-detects official `deepseek.com` URLs.** | DeepSeek thinking mode 400s if any replayed assistant message omits `reasoning_content` or if a relay receives the unsupported generic `reasoning_effort` field. PI-Desktop stores a UUID as `model.provider`, so SiliconFlow, Volcengine, and custom gateways never match pi-ai's `provider === "deepseek"` check. See E2E-005E. |
| D424 | DeepSeek reasoning across compaction | **Amend D389: restore thinkingSignature on history rebuild, retain recent reasoning in the checkpoint, and replay a placeholder for third-party DeepSeek.** | Empty reasoning echoes 400 after compaction. See ADR 0136. |
| D309 | Add-provider common path is Service + key | **Amend D308: add-provider starts with Service only, then the key; Name and API format stay in Advanced.** | Known services should not look like generic gateways. See ADR 0116, ADR 0155, ADR 0156. |
| D310 | Custom API format stays beside the key; Service lists top models.dev vendors | **Amend D309: Custom endpoint shows API format beside the key, and Service lists published models.dev vendor endpoints.** | Gateways need the format beside the key. See ADR 0155, ADR 0156. |
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
| D390 | Host-owned regenerate truncate | **Amend D199, D258, and D307: `agent/prompt` truncates through `session.truncateFrom` under the host lock, so the kept transcript never crosses JSON-RPC.** | Large sessions timed out and killed host stdin. See ADR 0216. |
| D391 | Host stdout sender must not outlive serve | **Amend D390: the Alt+Space hook keeps only a weak stdout sender, so host-core exits after stdin EOF.** | A strong sender kept host-core a zombie. See ADR 0216, ADR 0217. |
| D392 | Effective image-input overrides across Composer and transport | **Amend D243: a binding's explicit `supportsImages` override wins over the published record for Composer and transport alike.** | Badges and transport disagreed on one endpoint. See ADR 0101, ADR 0218. |
| D393 | User-invoked Skills in the composer | **Amend D123: active Skills appear in a composer `Skills` group as `/skill:<id>` while the Skill tool keeps body loading.** | Known workflows become discoverable without moving bodies. See ADR 0024, ADR 0219. |
| D394 | Windows work-panel chrome keeps one resource action cluster | **Amend D154: the work-panel header keeps one compact resource switcher; the viewport-fixed toggle remains the only collapse control.** | Duplicate close affordances crowded narrow panels. See ADR 0195, ADR 0220. |
| D396 | Renderer and plugin-panel scrollbars share one compact contract | **Amend D300: every renderer scroll container uses one 6px, trackless, transparent-at-rest scrollbar with the same hover, focus-within, scroll-reveal, and dragged-thumb states. Remove the sidebar-specific width and opacity override. The plugin-panel preload applies the same contract and 300ms reveal mark to docked and detached plugin documents, including the bundled Files view. External pages loaded inside the Browser guest remain page-owned. Presentation-only; no protocol, storage, host runtime, or external-page behavior change. See E2E-157.** | Windows' classic scrollbar made the right-side work-panel Files view visibly heavier than the conversation, while the sidebar retained a second scrollbar treatment. |
| D-LOCAL-message-quotes | Message quotes and renderer-owned side chats | *(retired by ADR 0268 on 2026-09-16)* **Amend D209 and D301: messages gain a Quote action that prefills a quoted draft, and side chats fork without activating.** *(amended by D-LOCAL-selection-overlay)* | Reuse needs no change to the visible conversation. See ADR message-quotes-and-side-chats, ADR 0268. |
| D-LOCAL-response-annotations | Response annotations as prompt attachments | *(retired by ADR 0268 on 2026-09-16)* **Amend D-LOCAL-message-quotes: assistant selections attach as numbered prompt annotations instead of editing the composer draft.** | Quoting copied model words into the user's prompt. See ADR response-annotations, ADR 0268. |
| D398 | Context usage display preference | **Amend D347: `AppSettings.contextUsageDisplay` selects remaining or used for the inspector's leading figure, defaulting to remaining.** | Users reason either way; colours stay on remaining. See ADR 0184, ADR 0222. |
| D399 | Project group manual ordering | *(amended by D402)* **Amend D093: retained project groups expose a visible-on-hover/focus grip. Native drag/drop and ArrowUp/ArrowDown on that grip write contiguous normalized-path `order` values and set `projectSort` to `manual` in renderer-local sidebar preferences. Archived and pinned priority remains ahead of manual order; project activation, host workspace identity, session ordering, and on-disk directories are unchanged.** | Users with several active repositories need a stable working order independent of recent activity or alphabetical names, while the existing path-keyed and host-owned project model remains untouched. |
| D400 | Restore deferred tools from effective session context | **Amend D185: deferred activations are rebuilt from effective successful `ToolSearch` and deferred-tool results before each prompt.** | Activations outlived their absence from the provider schema. See ADR 0048, ADR 0225. |
| D402 | Long-press project title to reorder | *(amended by D403)* **Amend D399: a 400ms still press on the project title arms pointer reorder; ArrowUp/ArrowDown is the keyboard path.** | A grip cost a column beside the title. See ADR 0227, ADR 0228. |
| D403 | Press-and-move project title reorder | **Amend D402: mouse and pen reorder by pressing the title and moving 8px; touch never starts a reorder.** | A long press is slower than desktop lists. See ADR 0228, ADR 0229. |
| D404 | Skill ships with the Agent core tool set | **Amend D174: `Skill` joins the Agent-mode core tool set, leaving the deferred catalog and on-demand list.** | Deferral cost a round trip before any call. See ADR 0048, ADR 0230. |
| D405 | Ideographic comma opens the slash menu | **Amend D123: a `、` committed first in an empty draft is rewritten to `/` before trigger detection.** | Chinese IME users needed no input-method switch. See ADR 0024, ADR 0231. |
| D406 | Keep macOS DMG opening guidance text-only | *(amended by D457 and D634)* **Amend D371: macOS DMG and ZIP packages ship no opening-help note or executable helper.** | Signed builds do not need the Terminal fallback. See ADR 0204, ADR 0232, ADR 0296. |
| D407 | Restore archived projects after session import | **An import that adds a project-bound session clears that project's renderer archived presentation state.** | Imports materialized sessions the sidebar still hid. See ADR 0236. |
| D408 | Prioritize MainChat in the three-column shell | **MainChat keeps a hard 450px minimum; the work panel is capped by the live budget and the sidebar yields.** | Preview reserves traffic lights per D433. See ADR 0033, ADR 0238. |
| D409 | Host-owned session collaboration messages | *(amended by D446)* **Amend ADR 0237: host-core owns a durable session-collaboration ledger keyed by message and Session ids.** | Polling hid durable outcomes and sender identity. See ADR 0237, ADR 0239. |
| D410 | Independent session discovery and navigable collaboration projections | **Amend ADR 0239: add bounded `session/collaboration/list` discovery and navigable creator and created-session projection links.** | Valid targets stayed undiscoverable outside plugin-created sessions. See ADR 0239, ADR 0240. |
| D446 | Silent completion notices | **Amend D409 and D193: one Host-ledger completion notice may settle silently, spent once and revoked by user steering.** | Retrying a verified silence reported failure for success. See ADR 0239. |
| D447 | Stage Manager bounds watchdog is macOS-only | **The permanent 1.5s `boundsWatchdog` in `bootstrap/window.ts` runs on macOS alone; every other platform clears the interval on its first tick. Its two inputs are macOS-only (the `/tmp/pi-window-bounds` CG helper, and a "window smaller than 500x400" test the 1040x700 minimum window size makes unreachable), so elsewhere it could never recover anything and only called `window.setAlwaysOnTop(false)` forever. On Linux/X11 that repeats a `_NET_WM_STATE` removal, and Mutter answers it by raising the window (`meta_window_unmake_above` calls `meta_window_raise` unconditionally), so the app yanked itself back to the top of the stack about 1.5s after the user focused another window even though `_NET_WM_STATE` never carried `_NET_WM_STATE_ABOVE`. macOS Stage Manager recovery is unchanged. See D039, D053, D083 and US-UI-19.** | A window that re-raises itself over whatever the user just focused is not usable, and the interval had no purpose off macOS; the fix removes the message instead of teaching each platform to tolerate it. |
| D413 | Skill market public-HTTPS catalog fetch | **Skill Market discovers SKILL.md catalogs in Electron main under a shared public-HTTPS policy; the renderer never fetches.** | Discovery needs main-process egress without a host allowlist. See ADR 0243. |
| D421 | Native Pi session continuation | **Amend D007: Pi v3 sessions are discovered as projections and continued natively against canonical JSONL while SQLite stays authoritative.** | A flattened copy loses the tree and visibility. See ADR 0254. |
| D412 | Delta-only coalesced streaming updates | **Amend the local `message_update` contract: streaming frames carry deltas coalesced every 16ms, while start and end stay full snapshots.** | Per-token snapshots cost O(n²) bytes per turn. See ADR 0242. |
| D416 | Git clone accepts only syntactically public hosts | **`parseGitCloneUrl` reuses `isPublicHostname`, rejecting loopback, private, CGNAT, link-local, ULA, and `.local` remotes before clone.** | Clone accepted literals the market fetchers already reject. See ADR 0247. |
| D417 | Plugin runtime theme APIs + sidebar image token | **Add `pi.app.setTheme` and `pi.themes.upsert`/`remove`/`list` under `ui.theme`, splitting the sidebar paint token.** | Plugins could not apply or live-edit themes. See ADR 0260. |
| D420 | Structured, bounded, and redacted process logs | **Amend ADR 0046: logs get stable events and correlation fields, one record per tool call, redacted and capped at 8KiB.** | Rows were redundant and free-form details leaked. See ADR 0046, ADR 0212. |
| D422 | Host turn-end event for plugins | **`session:turnEnded` broadcasts once per started turn with `{ sessionId, turnId, reason }` after durable teardown, without ack or replay.** | Idle timers fire mid-turn; identity settles it once. See ADR 0252. |
| D423 | Remove the subagent turn limit | **Amend D328: `maxTurns` leaves every surface; a delegate ends only on completion, `TaskStop`, user Stop, or parent failure.** | The parent cannot see work it would cap. See ADR 0253. |


| D244 | Compact context usage summary | **Amend D103 and D184: the context inspector keeps its aggregate signal as a short summary, dropping per-tool rows and meters.** *(amended by D347)* | Drill-down chrome made a routine check tall. See ADR 0047, ADR 0103. |
| D347 | Composer-docked context usage inspector | **Amend D103 and D244: the compact inspector moves into the composer toolbar and mirrors the newest usage-bearing assistant turn.** | The inspector scrolled out of reach under answers. See ADR 0103, ADR 0184. |
| D355 | Last-request occupancy in the context inspector | **Amend D244 and D347: capacity figures come from the newest usage-bearing message, not the tool-loop sum.** | Tool-loop sums inflated cache reads beside small windows. See ADR 0193. |
| D356 | Optional subagent thinking override | **Amend ADR 0062: subagent frontmatter accepts `thinkingLevel: omit`, keeping bookkeeping `off` while synthesizing no thinking override.** | Users needed inherit, off, and provider default. See ADR 0144, ADR 0194. |
| D348 | macOS sidebar source-list vibrancy | **Amend D304: the main window uses Electron `vibrancy: "sidebar"` instead of `under-window`. `nativeTheme.themeSource` follows the app theme (`system` / `light` / `dark` / plugin base) process-wide. Vibrancy re-applies only when `themeSource` changes; a missing plugin theme falls back to `system`.** | macOS 26 Liquid Glass made `under-window` a light plate that the 40% tint could not keep dark, including when app and OS appearances were both dark. See `04-ux/08-component-spec.md` §1.7 and US-UI-74 / E2E-076. |
| D243 | Model-aware image attachment transport | **Amend D197: Electron main resolves vision from the model record or binding override and sends eligible images as transient blocks.** | A path replaced image content for vision models. See ADR 0059, ADR 0101. |
| D245 | OpenCode-style bounded provider 429 retry | **Amend D186 and D233: `PROVIDER_RATE_LIMITED` gets five silent abortable retries sharing one counter across setup and stream.** | One retry exposed transient 429s too early. See ADR 0091. |
| D237 | Vendor-account (OAuth) login for providers | **A provider row may authenticate with a vendor subscription; Electron main owns OAuth login and resolves short-lived tokens per request.** | Subscribers needed no separate API credit. See ADR 0095. |

| D238 | Flat Settings directory and marketplace context ownership | **Settings renders one flat searchable directory in the fixed order, and the marketplace source selector moves into Extensions.** | The rail repeated navigation and duplicated a label. See ADR 0096. |

| D239 | Place global defaults under AI | **Global behavior defaults — operating mode, command shell, Enter-to-send — move under AI, leaving eight Settings destinations unchanged.** | They change agent behavior, not appearance. See ADR 0097. |
| D240 | Independent vendor OAuth accounts and settings ownership | **Amend D237: every OAuth login creates a fresh row-scoped account, and vendor bindings resolve by exact `providerId` or fail closed.** | One vendor-global row let accounts overwrite each other. See ADR 0095, ADR 0098. |
| D339 | Per-provider User-Agent override | *(superseded by D341)* **Each provider row could store an optional `config_json.userAgent` applied to outbound HTTP, max 256 bytes.** | Gateways and subscriptions inspect the User-Agent header. See ADR 0176. |
| D341 | Per-provider custom HTTP headers | **Amend D339: each provider row stores optional `config_json.headers` as last-writer headers on outbound HTTP, migrating `userAgent`.** | Users needed arbitrary non-secret headers, not only User-Agent. See ADR 0176, ADR 0178. |
| D242 | Builtin subagents inherit the parent permission mode | **Builtin subagents keep `permission: inherit`; only definitions with explicit non-inherit scopes override the parent session.** | `fixer` overrode an `auto` parent with `accept-edits`. See ADR 0100. |
| D241 | Titled Settings navigation clusters | **Keep the eight-destination Settings directory flat and searchable, but render four non-interactive localized group headings — Personal / 个人 (Basics, AI, Shortcuts), Agent / 智能体 (Instructions, Model configuration), Workspace / 工作区 (Import, Project archive), and About / 关于 (Info). Headings use whitespace for separation and no divider lines. Empty groups disappear with filtered search. This supersedes only D238's prohibition on group headings; destination order, IDs, search ownership, and marketplace placement remain unchanged.** | The flat rows became visually dense without scan landmarks. Muted headings restore grouping while preserving one-level navigation and the existing destination ownership. |
| D442 | Marketplace download requests carry a device identifier | **Amend D238: the official channel resolves installs and updates through `POST /api/v1/download/resolve` with a stable `deviceId`.** | Counting and rate limits need one stable identity. See ADR 0276. |

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
| D455 | Project archive is a list + inspector | **Revise D267: Project archive is a one-column list plus inspector; a click selects and double-click or Enter activates.** | Inline expansion made a long index unscannable. See ADR 0294. |
| D456 | Session thinking-parameter omission | **Amend ADR 0194: session `thinkingLevel` accepts `omit` in addition to the seven canonical levels, widening the schema v19 CHECK.** | `off` still sends a disable; `omit` sends nothing. See ADR 0144, ADR 0295. |
| D458 | Composer reasoning slider on the menu root | **Amend the combined model × reasoning menu: when more than one level is listed, a native range slider with one labeled stop per level sits under the Reasoning level entry. Slider and tick commits persist the last pending level through `configureActiveSession` without leaving the root; the entry still opens the classic radio list. Tick labels are not tab stops. The slider shows a rail with one track dot per stop and a visible label under each stop; the dots row and labels row are full-width n-column grids and the range input overlays the rail inset by half a column minus the thumb radius, so the dot, thumb and label share one column center for every stop count. The selected stop uses the accent token, the rest muted. Renderer only. See issue #417, `04-ux/08-component-spec.md`, and E2E-050.** | Switching a level required a submenu trip; a Codex-style slider keeps the radio list while making quick adjustments one drag. |

## E. M5 hardening decisions (0.4.0)

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D078 | macOS signing lanes | *(amended by D450 / ADR 0289)* **Static configuration embeds no certificate identity; official releases require Developer ID signing and notarization from Actions secrets.** | Contributors package unsigned; published artifacts must satisfy Gatekeeper. See ADR 0022, ADR 0289. |
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
| D138 | Session-scoped inline permission requests | **Tool approval is an inline PermissionCard owned by its originating `sessionId`, never a global dialog. Different sessions retain independent pending requests without automatic deadlines; background message/tool/permission events update only scoped state and never activate, cover, or focus another conversation. Resolution and cleanup match both session and request identity. This supersedes only D100's permission-dialog overlay/hide clause; palette, search, settings, and other blocking surfaces retain their existing browser hide behavior.** | Concurrent agents must not steal the active workflow or overwrite each other's approval requests; the existing protocol already carries the required session/request identity. |
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
| D163 | Native width reservation for the fixed work panel | *(width range superseded by D167)* **Open panel keeps one committed `364..720` width through idempotent `window/setWorkPanelReservation`, superseding the D156 clamping clauses.** | A docked tool should not take chat width. See ADR 0029, ADR 0032. |
| D167 | Slimmer default work-panel width | **Amend D163: the docked panel opens at 280px, clamps to `244..720px`, and double-click restores 280px.** | The panel opened wider than review content needs. See ADR 0122. |
| D255 | Restore native reservation while the work panel is visible | **Keep the panel in flow, but request its committed width natively before showing it and zero it before unmounting.** | Collapsing left the window wider than chat needed. See ADR 0033, ADR 0122. |
| D256 | Native taskbar minimize for Windows/Linux window controls | **Amend D216 and D252: minimize uses the native taskbar transition; close keeps D230's hide-or-exit.** | Minimize was using the close-to-tray hide. See ADR 0078, ADR 0090, ADR 0117. |
| D258 | Transcript layout index, one window coordinate space, and identity truncation | **Refine ADR 0120: host-core keeps a transcript layout, serving a window by seeking and classifying lines with one depth-aware scan.** | Full scans made long sessions open slowly. See ADR 0120, ADR 0127. |
| D259 | Bounded shared budget for transient provider failures | **Amend D245: non-429 transient provider failures share one bounded budget of four retries covering network, timeout, stream, and retryable errors.** | A gateway 502 became a terminal error card. See ADR 0050, ADR 0091. |
| D164 | Dual-locale in-app product changelog | **Amend D120: product what's-new notes are a dual EN/zh-CN catalog attached to the existing update IPC as plain text.** | Bilingual highlights need no second network surface. See ADR 0022. |
| D357 | Viewport-fixed work panel toggle | **Amend D128: AppShell owns one viewport-fixed toggle on every non-Settings route as the sole panel-level collapse control.** | The shortcut-only entry left the panel undiscoverable. See ADR 0068, ADR 0195. |

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
| D261 | The mounted transcript is a window, not the loaded history | **Refine D258: the mounted transcript is a trailing window of 15 rows, then 60, grown 40 at a time.** | Every paged row stayed mounted and memory grew. See ADR 0120, ADR 0137. |
| D317 | Live/durable transcript merge keeps chronological order | **Amend D261: `mergeLiveSessionMessages` stitches the durable page chronologically, keeping older live rows before it and the tail after.** *(amended by D324)* | The page-prefix merge hid the just-sent prompt. See ADR 0120, ADR 0137. |
| D324 | Idle session switch keeps a not-yet-flushed completed tail | **Amend D317: idle session switch keeps a completed tail the durable page lacks until every live id is present.** | Idle revalidation dropped replies already on screen. See ADR 0137. |
| D327 | Completed replies survive process restart | **Amend D299: the finished `message_end` snapshot is checkpointed before the outbox append, and recovery skips completed leftovers.** | Replies sat in the outbox across a quit. See ADR 0041, ADR 0153. |
| D444 | Cross-session message id collision remaps; outbox UNIQUE is not a pause | **Amend ADR 0041 and D327: a cross-session id remaps to `{sessionId}:{id}`, and an outbox UNIQUE conflict acks idempotently.** | Tool call ids are not globally unique. See ADR 0041. |
| D597 | Drain poison outbox entries; accept steering into a delivery turn | **Amend D444: a `PERMISSION_DENIED:` append is dropped while draining, and steering enters a matching delivery turn.** | A poison head stalled the outbox at 1024. See ADR 0041, ADR 0239. |
| D328 | Parent-judged subagent lifetime | **Amend ADR 0089: no idle watchdogs; only `TaskStop` or user Stop aborts a delegate, and `maxTurns` stays.** | Parents treated wait expiry as permission to finish. See ADR 0119, ADR 0166. |
| D352 | Parent fatal error aborts leftover delegates | **Amend D328: a terminal parent error aborts leftover delegates, emits `agent_end`, and leaves `isRunning` free for Continue.** | A delegate kept the sidecar busy after failure. See ADR 0166, ADR 0189. |
| D354 | Label both macOS release architectures | **Amend D353: both macOS lanes use target-specific patterns, publishing arm64 and x64 DMG and ZIP asset names.** | arm64 assets did not name their architecture. See ADR 0145. |
| D353 | Disambiguate Intel macOS release artifacts | **Amend D285: the macOS x64 lane publishes `-Intel` asset names, leaving the arm64 lane's generic names.** | Users could not tell the Intel download apart. See ADR 0145. |
| D329 | Agent-chosen Bash timeout | **Amend D190: Bash defaults to 60 seconds and accepts `timeout` to 21,600, reading larger values as milliseconds.** | A 300-second ceiling killed legitimate builds. See ADR 0054. |
| D331 | Host-owned completed-turn token history | **Amend D103: parent `message.usage` stays pi-ai Usage for that assistant message. Subagent spend accumulates on the durable turn only. Electron sums parent `message_end` usages plus `turn_end.subagentUsage` into `session.endTurn.usage`. `stats.getTokenUsageHistory` rolls up completed turns over a bounded local-calendar window with filled `day` / ISO `week` / `month` buckets. Additive IPC/RPC and `idx_turns_ended_at`; no protocol or schema version bump. No currency pricing. The user-facing dashboard is plugin `pi.token-insights` (D335).** | The turns table was already the usage rollup, but Electron never sent `usage`, and merging subagent tokens into message chips would lie to the context inspector. |
| D335 | Plugin-owned token usage dashboard | **Amend D331: Settings has no Usage destination; token history belongs to the `pi.token-insights` marketplace plugin over host data.** | Settings duplicated a weaker plugin heatmap. See ADR 0171, ADR 0173. |
| D326 | Withdraw A2A and Peer coordination | **Withdraw A2A: broker, `a2a.*` RPC, mailbox and Peer tools, and A2A tables go; delegates coordinate only through parent `Task*` reports.** | The channels had no product need beside `Task*`. See ADR 0165. |
| D318 | Restore a missing sessions row from its transcript / outbox | **Amend ADR 0041 and D119: a transcript without its sessions row is restored at boot and append.** | A lost row stalled a long session's outbox. See ADR 0041. |
| D262 | Spill large composer text pastes into session scratch | **Composer pastes above `largePasteThreshold` go through the session paste bridge into session scratch as a generated `@` token.** | Huge native pastes overwhelm and resist editing. See ADR 0131. |
| D265 | One delegation reads as a card, like a fan-out | **Amend D201: every `Task` call renders as a full-width delegation card, including a lone delegation, with singular-aware headers.** *(amended by D319)* | The common single case lost outcome and runtime. See ADR 0062. |
| D319 | A delegation card is only the Task fan-out | **Amend D265: only consecutive `Task` starts form the card; parent thinking, tools, and lifecycle rows stay outside it.** | Parent work painted itself onto the subagent tile. See ADR 0062. |
| D320 | Sent file references stay chips and open on click | **Amend D209: sent `@path` tokens stay chips, opening workspace HTML in the panel browser and other files natively.** | Serialized paths undid the compact composer node. See ADR 0070, ADR 0163. |
| D322 | Relative transcript paths preview and open | **Amend the chat/markdown file-link resolver: unprefixed relative paths stay workspace-rooted; `./` and `../` resolve against the workspace root in chat and against the viewed file's directory when previewing a markdown document. `.` / `..` normalize in place; a walk that leaves the workspace stays inert. Assistant markdown linkifies bare file tokens (known extension) in addition to inline code, links, and images. The linkify pass is a unified attacher that returns a transformer; it is never the transformer itself, so freeze does not invoke it with a missing tree. No host-protocol, IPC, or storage schema change.** | Agents write workspace-relative paths in prose and markdown files use `./` / `../` links; those were either not clickable or resolved as if they lived at the workspace root, so preview/open failed. Passing the transformer to `remarkPlugins` made unified call it at freeze with `tree === undefined`, crashing session open on `tree.type`. |
| D323 | Live parent turns stay transparent | **Amends D101 / D297 in the renderer: a streaming assistant turn does not sit on a `--ds-tile` and does not reserve a 14px inset or left rail. Thinking, workspace tools, and answer fragments stay on the page background like a completed turn. The tile remains only on the delegation card (D319) and the nested `.subagent-run`. Renderer only: no IPC, storage, host-protocol, or runtime change.** | D297 replaced the streaming rail with a whole-turn tile so the tint would not reflow. That boxed ordinary answers the same way as a subagent card. D101 already required transparent assistant prose; D319 already assigned the tile to the Task group. |
| D268 | A lifecycle row is a subagent row | **Refine D265: lifecycle rows stay compact tool rows outside counts but read as subagent rows summarized from the returned roster.** | They rendered as bare UUID tool calls. See ADR 0062, ADR 0089. |
| D263 | A cross-display drag is user intent, not an OS adjustment | **Amend D255: `os-adjusted` keeps ADR 0122, while a `user-moved` cross-display drag takes the new position as base bounds.** | Windows jumped on release and stale bounds persisted. See ADR 0122, ADR 0132. |
| D269 | History continuation keeps the conversation outline reachable | **Amend D108: the conversation outline keeps a dotted earlier-history continuation and advances while the top boundary stays visible.** | Scroll-only triggers stranded history behind short tails. See ADR 0130. |
| D270 | One model picker for both credential kinds | **Refines D237 / D240 in the renderer: the model picker is one shared renderer component rendered by both the AI service dialog and the vendor account dialog. A vendor account therefore gets the same discovered model list, the same `ModelBinding` shape, the same per-model context-window and max-output editing, the same thinking-level controls, and the same explicit binding persistence. Only the left pane heading differs between the two dialogs. The thinking-level catalog-gating clauses are superseded by D283. Renderer only: no IPC, storage, host-protocol, or provider-config schema change is implied, and no ADR is required.** | The two surfaces were copies of one picker, and the copy silently lost the advanced controls, so a vendor-account binding could not edit the same model settings as an AI service. One component makes the guarantee structural instead of a convention two files had to remember. |
| D271 | An expanded delegate run scrolls in place | **Refine D201: a delegate's nested rows scroll in a bounded `min(420px, 48dvh)` area, and `fields` tables cap at 260px.** | Expanding one delegation moved the reading position. See ADR 0062. |
| D302 | An expanded delegate run follows its latest output | **Refines D271 / D071 in the renderer: the bounded `.subagent-run-rows` scroller uses the parent transcript's pinned-follow contract independently. Expanding pins to the newest row; content growth follows the bottom while pinned; the first real upward gesture (wheel / trackpad / touch / scrollbar / keyboard) pauses follow and shows a nested jump-to-latest control; layout clamps and programmatic `scrollTo` never release follow. Native overflow anchoring is disabled on the nested scroller. The jump control overlays a relative wrapper around `.subagent-run-rows`, never on `.subagent-run`, so the collapse rail stays unclipped. Presentation only: no IPC, storage, host-protocol, or runtime change, and no ADR is required.** | D271 capped the nested run so it would not grow the transcript, but left that scroller without stick-to-bottom. A live delegate's new thinking, tool, and answer rows therefore appended below the viewport of an expanded card, and the user had to scroll by hand to see progress (issue #37). |
| D272 | Quitting stops plugins as a shutdown, not as a crash | **Refines spec 07 §3.1 in the main process: `before-quit` calls `PluginRuntime.disposeAll()` instead of `disposeWatchers()`. It marks every loaded plugin as disposing and cancels its pending restarts before anything else, disposes watchers, then stops services and runs `onUnload` in parallel — 1.5s per plugin, 3s for the whole sequence, after which the children are killed. `onPluginCrash` no longer sends its own toast, since the runtime already raised one on that path. Main process only: no IPC, storage, host-protocol, or manifest change, and no ADR is required.** | Quit left the plugin children to be killed by the process teardown, and an unmarked exit is indistinguishable from a crash: `handleChildExit`'s `disposing` guard never applied, so every quit logged `PLUGIN_CRASHED` per plugin at `exitCode: 0`, toasted "stopped unexpectedly" twice, and scheduled restarts into a closing app. 613 of 633 crash reports in one local log were this, which is what made the real crashes hard to see. |
| D273 | A model's habitual argument name is accepted, not corrected | **Refines spec 03 §4 in the agent runtime: `Read`/`Write`/`Edit`/`BrowserPreview` accept `file_path` beside `path`, and `Glob`/`Grep` accept `query` beside `pattern`. Both spellings are optional in the schema so either validates; the runtime folds the alias onto the canonical name before the write lock, the host call, and the transcript, requires exactly one of the pair, and lets the canonical name win when both arrive. `Bash.timeout` widens its schema maximum to 3600000 so a millisecond value validates, and the runtime reads a value of at least 1000 as milliseconds, clamped to the honoured 300-second ceiling, while 301 to 999 stays an out-of-range seconds value. Runtime only: no IPC, storage, or host-protocol change, and host-core's schemas are unchanged.** | Argument names are pretraining habits, not instructions a schema can correct. 852 of 1679 failed tool calls in one local month were a parameter-name miss, 724 of them `Read` sent with `file_path`, which alone was 87% of `Read`'s failures and put its error rate at 11%. Another 69 were a `timeout` in milliseconds. Each cost a turn on an error the model could not see itself making. |
| D274 | Retry an unchanged edited prompt | **Amends D137 in the renderer: confirming a valid user-prompt edit always dispatches the existing edit-resend/Regenerate path, even when the trimmed text matches the original. The inline controls are localized Retry and Cancel actions; Retry retains the existing revision archive, identity-based truncation, slash-command expansion, and attachment behavior. Renderer and i18n only: no IPC, storage, host-protocol, or runtime contract change.** | Treating an unchanged confirmation as a no-op made the “Edit and resend” action appear broken (issue #23), while the old Send label suggested a new ordinary prompt rather than replaying the selected turn. |
| D275 | Preserve the active task boundary across context compaction | **Amend D203: checkpoints record `details.retainedTailMode`, retaining the latest user message only inside an active turn.** | Retained prompts made a new task look continued. See ADR 0064. |
| D278 | Subagent model selection | **Task.model overrides definition pin; only models with `availableForSubagents` appear in the delegation catalog; on-demand RPC resolves models not pre-resolved at launch** | The parent agent needs per-task model choice without exposing the full provider configuration. An opt-in flag keeps the delegation catalog bounded and intentional, and on-demand resolution avoids stale bindings for models added after sidecar launch. See §3/02 §5f, §3/11 §7, and E2E-166. |
| D365 | Named quiet intervals on the live activity row | **Amend D338: `AgentActivity` adds `preparing`, `compacting`, and `recovering`, and `waiting-subagents` carries a live running snapshot.** | Quiet intervals looked like a stuck generic wait. See ADR 0175, ADR 0198. |
| D599 | A development build is its own installation | **Narrow D236: a development build uses `PI-Desktop Dev` userData and `~/.pi-desktop-dev`, leaving packaged installs where they are.** | `pnpm dev` quit on a locked packaged profile. See ADR 0094. |
| D602 | Crash dumps stay in the data directory | **Electron's Crashpad reporter starts local-only (`uploadToServer: false`) before `ready`. Dumps live under `<data_dir>/crash-dumps`, not the default Electron `userData` crashDumps path, so a `PI_DESKTOP_DATA_DIR` profile does not share dumps. The next lock-holding launch writes one `diagnostics` line for dumps newer than `crash-dumps.json`, classified by Crashpad `ptype`: `error` if any new dump is the browser/main process, `warn` for recovered renderer/GPU/utility crashes. Host-core and sidecar crashes stay on the supervisor path. No upload, no IPC, no schema change.** | A crash left a minidump nobody read. Crashpad also records recovered renderer crashes, so a next-launch `error` that said the previous run died was a lie; and dumps outside the data directory escaped `PI_DESKTOP_DATA_DIR` isolation. |
| D619 | A copied formula is its TeX source | **A copy covering rendered math writes `text/plain` TeX from the MathML annotation, in the delimiters `lib/latex-math.ts` normalizes.** | Formulas pasted as glyphs could not be reused. See ADR 0268. |
| D620 | pi-ai built-in API-key services are named presets | **Fifteen pi-ai API-key services become named endpoint presets at published hosts; eight built-ins stay recorded exceptions.** | A hand-maintained catalog drifted from pi-ai's provider list. See ADR 0307. |
| D668 | One process disclosure per turn, with three transcript display modes | **Amend D661 / the `turn-process-and-thinking-display` ADR. A turn renders exactly one top-level process disclosure holding every pre-answer row; the answer stays outside it. `AppSettings.transcriptDisplayMode` selects the layout: `flat` renders no nested activity groups, `command-first` renders `Bash`/run rows as standalone rows beside activity groups, and `fully-folded` (the default for absent or invalid values) keeps commands inside their groups and lets only ordinary assistant progress text split them. The mode is read while rendering, so switching repaints immediately - the projection cache is keyed by messages and compactions only. The disclosure header reports failed / stopped / running / finished with precedence in that order and never echoes the current item, and the disclosure shares one left edge with the levels it reveals. `transcriptDisplayMode` joins the portable application fields; `keepCommandsExpanded` is deprecated, retained only for persisted-settings compatibility, and no longer exposed or read for rendering. No host protocol, persistence schema, permission, or plugin contract change. See the amended ADR, `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`, and E2E-CHAT-turn-process-and-thinking-display.** | Chronological segmentation split one turn into several sibling disclosures above the answer, and the boolean command-folding preference could only express two layouts; a three-mode setting covers flat, command-first, and the released grouped view without changing what a tool received or stored. |
| D669 | `@` queries search past a truncated file index | **Amend D124: while the 8000-entry `fs/index` snapshot is truncated, a non-empty `@` query is also searched over the root's full listing through the read-only Electron channel `pi-desktop/fs/search` once typing pauses, and its best 50 rows merge with the local matches. A complete index never searches. Remote sessions keep their snapshot. No host RPC, storage, or schema change.** | The shallowest-8000-entry index left a script several folders down matching no query at all, even though the truncation note invited the reader to refine it (issue #1781). |
| D671 | Inline generative UI visualizations | **Amend D114: local sessions get a host-owned `visualizations/<sessionId>/` root for HTML fragments rendered inline through a sandboxed `pi-genui://` iframe.** | Interactive explanations need an embedded page. See ADR gen-ui-inline-visualization. |
| D674 | Per-turn changed-files summary under a finished reply | **A completed reply whose turn recorded workspace review changes renders one read-only `TurnChangesCard` below its answer and above `entryExtra`, built only from that turn's message-owned `details.review` records (no new capture, IPC, or persistence). The card starts collapsed, keeping its counts visible in a full-width disclosure button; click or Enter/Space reveals or hides its file list and Review link. Choices remain turn-scoped in the existing transcript disclosure state. Rows merge edits per path (`D` if the turn ends by deleting, else `A` if any edit created the file, else `M`; counts summed; rolled-back files stay listed and struck through). When expanded, up to four files use relaxed rows, more use dense rows, and rows past 12 fold into `+N more`. Clicking a row opens Review on that file's recorded changes; the per-call review rows and the Review tab are unchanged.** | Issue #1891, design 10 (adaptive density): the per-call review rows answer "what did this call change", and Review answers it for the whole session, but nothing answered "what did this turn change" without counting rows. |
| D675 | Inline images are admitted by pixel size as well as bytes | **Amend D361: an image whose PNG/JPEG/GIF/WebP header reports a longest edge above `MAX_INLINE_IMAGE_EDGE_PX` (8000) is never inlined. Host Read refuses it with `TOOL_FAILED`; prompt attachments and restored history take the existing `@path` fallback; and the runtime's last provider view replaces any such image block (user or tool result) with a text notice naming its size. The probe reads headers only (no decoder); unknown dimensions keep the byte-only rule. No protocol, schema, or persisted-format change.** | Issue #1913: a 1.89 MB, 780 x 14182 full-page screenshot passed every byte check, the provider rejected it with a non-retriable 400, and replay made every later request in that session fail. Dropping is deterministic for the same bytes, so the request prefix and prompt caching stay stable; resampling would need an image decoder and is deferred. |
| D676 | A completed turn the reader followed ends at its prompt | **Amend the stream-completion rule: when a turn completes while the transcript is visible and still following the stream, the renderer scrolls that turn's newest user message to 16px below the titlebar band the transcript reserves at its top (smooth unless reduced motion), releases follow mode, and shows jump-to-latest. Nothing moves when the prompt is already in view, the reply failed or was aborted, the pane is hidden or in a reading window, a disclosure position is held, or a new run starts before the move. Renderer only; no setting, IPC, or persistence change.** | Issue #1889: after a long reply the reader sat at its last line and had to scroll back up to find where it began. |
| D677 | DeepSeek reasoning replay uses one field per row and never covers real reasoning | **Amend ADR 0256: the fill pass uses one reasoning field from the newest real reasoning row, filling only empty rows.** | The placeholder overwrote a live row's real reasoning. See ADR 0256. |
| D678 | Radial context menu rebuilt and moved to General | **The opt-in transcript radial menu gets at-rest icon-and-label sectors (the hover-only hub label is gone), one filled highlight for the active sector with no focus rectangle, a recessed hub carrying the click-point dot, a 248 px disc with hairline separators and the composer shadow, and shared motion tokens for hover and reveal. A right-press started while the ring is open runs the sector it is released on; releasing in the hub dismisses without running; the release trailing the opening right-click is inert. The settings card moves from the AI tab to General after Sidebar and the settings-search index follows. Action vocabulary, per-direction defaults, `AppSettings.radialMenu`, persistence, and IPC are unchanged.** | The icon-only ring could not be read without hovering every sector, the sector fill and button background painted two highlights over one target, and the ring's switch sat in the AI tab although the surface is a transcript-interaction preference. |


## M0. Model catalog decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D266 | Use models.dev as the primary model catalog | **Historical: Electron main owned a models.dev catalog fetch with the pinned `pi-ai` catalog as fallback, superseded for chat metadata by D639 / ADR `models-dev-catalog-authority`.** | Broader catalog coverage from the main process. See ADR models-dev-catalog-authority. |

## M. Agent runtime decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D114 | Per-session scratch directory for agent temp files | **Each session gets `<data_dir>/scratch/<sessionId>/` as a second containment root for `Read`/`Write`/`Edit` (absolute paths only; relative paths stay workspace-bound). The path is advertised in the system prompt and as `PI_SCRATCH_DIR` in Bash. Scratch writes auto-allow without a permission card and are excluded from the artifacts table. Scratch is created lazily, deleted with the session, and swept at startup (orphans, >7 days stale). Glob/Grep/BrowserPreview remain workspace-only. Plan does not expose Write/Edit; Plan Bash can still mutate scratch under its resolved permission mode.** | Temp/intermediate files (one-off scripts, downloaded data, drafts) were dirtying the user's project and git status; a host-owned root with identical lexical + symlink defenses keeps the sandbox model intact while giving the model a legitimate place for scratch work |
| D115 | Permission modes: global default + per-session override | *(composer presentation superseded by D132; checkpoint Plan clause superseded by D189)* **A permission mode governs high-risk tool approval: `ask` (confirm everything, default), `accept-edits` (auto-allow Write/Edit, confirm Bash/plugins), `auto` (auto-allow all). Global default lives in settings `defaultPermissionMode`; each session stores `permission_mode` (schema v5, default `inherit`) which overrides it when not inherit. Resolution: session override → global default → ask, enforced solely in host-core `tools.execute`. Plan retains the selector; its Write/Edit/plugin hard deny outranks every mode, while Bash follows the selected mode.** | Confirming every Write/Edit made long agent runs high-friction, but a single global toggle is too coarse — trusted scratch sessions and risky repo sessions need different postures; keeping enforcement host-side preserves the security boundary |
| D132 | Composer permission menu shows effective modes only | **The agent-mode composer chip and menu expose only `ask`, `accept-edits`, and `auto`, with the effective mode selected directly and no global-default/inherit entry or provenance label. Choosing an item stores that explicit session override. Existing `inherit` persistence and resolution from D115 remain unchanged until the user chooses a mode. This supersedes only D115's composer-presentation clause.** | The inherited entry repeated a selectable mode and exposed storage provenance instead of the permission posture the user is choosing; presenting the three effective modes makes the control direct without changing host enforcement |
| D116 | Provider failures as assistant messages | **Every provider/model turn failure is attached to a durable `role=assistant`, `status=error` transcript message through optional `UiMessage.error`. The message shows a localized summary and stable code, keeps redacted provider detail behind an accessible disclosure, and offers context-appropriate Retry or Settings actions. Message-bound failures never use toast/global banner presentation and never re-enter later model context.** | Errors belong to the failed turn; preserving them in the transcript makes the response diagnosable after session switches/restarts without contaminating the next model request or exposing credentials |
| D127 | Context-preserving reseed + transport retry | **Reseeding a recreated pi runtime from the persisted transcript restores tool call/result pairs (from tool rows' `toolCallId`/`toolArgs`/`toolResult`) in addition to user/assistant text and thinking. Interrupted tool rows restore as errored results; orphaned tool rows get a synthesized call-only assistant carrier so pairs stay adjacent and well-formed. Failed assistant turns stay transcript-only. Separately, request setup uses one bounded pi-ai retry for transient transport/provider failures; post-response stream recovery is defined by D186.** | Text-only reseed collapsed a session's context after any runtime recreation (regenerate/edit, config change, restart): the model lost every tool result it had gathered and — seeing its own history answer without visible tool use — stopped calling tools, degrading agent sessions into bare chat. The incident trigger was a single un-retried provider timeout that forced the user into regenerate. D127 corrects the initially duplicated D120 identifier; D120 remains the earlier application-update decision frozen by baseline 0.4.6. |
| D136 | pi-ai owns known-model metadata | **Historical: `pi-ai` supplied known-model metadata, superseding D102 and D096/D107's provider overrides, then D639 / ADR `models-dev-catalog-authority` replaced it for chat metadata.** | Pi sibling defaults misstated model context windows. See ADR models-dev-catalog-authority. |
| D183 | Segmented tool and model latency logs *(superseded by D385 / ADR 0212; UI clause superseded by D184)* | **Tool and model latency is logged in segments through host `tool timing` lines, per-stage audit fields, and greppable `[timing]` sidecar lines.** | Stage timing makes slow runs diagnosable without reproduction. See ADR 0212. |
| D158 | Turn-boundary context checkpoint compaction *(soft-boundary, model-tool, and visibility clauses superseded by D200; the model tool and visibility restored in Codex's shape by D203)* | **PI-Desktop owns context estimation: after every `turn_end` it enforces model-aware budgets, writes durable checkpoints beside the untouched visible transcript, and retries once after a provider overflow.** | End-of-run-only protection cannot guard long tool loops. See ADR 0030. |
| D185 | Lazy per-turn tool activation *(the always-active `CompactContext` clause is void under D200, and holds again for `new_context` under D203; activation restoration amended by D400 / ADR 0225)* | **Each new prompt sends only the mode core tools and `ToolSearch`; catalog tools activate by name or capability and the active set resets per turn.** | Full schemas made first requests disproportionately large. See ADR 0225. |
| D200 | Imperceptible background context compaction *(background pre-computation, incremental trigger, silence, and no-model-tool clauses superseded by D203)* | **Compaction becomes silent host-owned background work: a graded trigger pre-computes a checkpoint while the provider is idle and installs it at the next boundary if valid.** | Compaction was correct but intrusive. See ADR 0061, ADR 0049. |
| D201 | Bounded subagents behind a `Task` tool | **Agent mode exposes `Task` for bounded delegation over at most 16 global subagent definitions, keeping delegate reports out of the parent context.** | Bounded delegation preserves parent ownership of context. See ADR 0062, ADR 0112. |
| D202 | Managed global subagent definitions | *(Page-shape clause superseded by D257 / ADR 0126; the global-only data boundary stands)* **host-core scans global Markdown subagents under `~/.agents/subagents`, stores enablement in app state, and exposes them only through Settings > Agent > Subagents.** | Global-only scanning avoids a second project precedence model. See ADR 0063, ADR 0112. |
| D203 | Codex-parity context compaction | **Compaction now follows Codex: synchronous at the hard limit or on `new_context`, keeping recent user messages, with a transcript divider row and a toast.** | Earlier work cited Codex while doing the opposite. See ADR 0064. |
| D186 | Bounded provider stream recovery and diagnostics *(429 budget amended by D245)* | **Provider setup gets one bounded retry, a transient stream failure replays once with the failed assistant removed, and `Edit` mismatches get one fresh read.** | Unbounded recovery burned context and turns. See ADR 0050, ADR 0091. |

| D187 | Resource-isolated host RPC stdio | **host-core serves stdin and stdout on dedicated named OS threads instead of Tokio's blocking pool, preserving NDJSON framing and bounded admission.** | Thread exhaustion turned resource pressure into host crashes. See ADR 0051. |
| D191 | Agent-only mode; Chat renamed to read-only | *(superseded by D188/D189: the mode selector returned as `Agent | Plan`, and `chat` migrates to `plan`)* **`agent` is the only exposed session mode; the former `chat` profile becomes a host-enforced read-only surface with no UI, and legacy rows migrate.** | An unreachable mode switch is a footgun. See ADR 0055. |
| D369 | Effective subagent thinking metadata | *(amended by D395)* **Subagent results and lifecycle snapshots carry the effective `modelId` and `thinkingLevel`, and delegation surfaces show the raw canonical non-`off` level.** | Cards need the level actually sent. See ADR 0202, ADR 0221. |

| D395 | Canonical thinking-level values in the UI | **Amend D369 / ADR 0202: composer, model configuration, and delegation surfaces render canonical thinking-level values directly instead of translating them, and the locale entries are removed.** | Levels are protocol values, not locale strings. See ADR 0221, ADR 0202. |
| D445 | Compaction summary retries and is right-sized before retained-tail recovery | **Amend ADR 0049 / D203: the summary request retries a bounded policy, is sized by the serialized prompt, and tries one reduced input before falling back.** | Six of ten checkpoints were a 112-token notice. See ADR 0282, ADR 0049. |

## N. Notification decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D117 | Durable task notification inbox | **Rust host-core exclusively owns a schema-v6 `notifications` table and atomically inserts one structured `task.completed` / `task.failed` row when `session.endTurn` moves a running turn to completed/error only if Electron reports that result was not already visible. Renderer supplies the current chat session through an allowlisted viewing-context IPC and a matching prompt-dispatch snapshot; Main suppresses insertion only when its window is visible/focused and that session matches, while unknown, background, hidden, or unfocused state fails safe to notification. `turn_id UNIQUE` prevents duplicates, abort is silent, session deletion cascades, and only the newest 200 rows remain. The titlebar bell exposes exact unread count, All/Unread, row mark-read/session activation, mark-all-read, and clear with complete keyboard/accessibility behavior. Protocol v4 adds singular `notification.list/markRead/markAllRead/clear`; `session.endTurn` returns an inserted record, Electron emits renderer `notification.changed`, and only while the main window is unfocused it also shows a native system notification whose click restores/focuses the window and emits `notification.activated`. Persisted rows contain structured kind/session/turn/error data plus the session-name snapshot, never localized notification title/body prose. The task inbox has no permission, scheduled-reminder, preference, cloud-notification, or plugin-notification source; plugin-native notifications are the separate D213 surface. D113's profile footer remains unchanged.** | Notifications should recover task outcomes the user did not see, not duplicate a result already visible in the current chat. A bounded host-owned inbox keeps background/unfocused outcomes durable and navigable without violating SQLite ownership, duplicating events, or turning every terminal event into notification history. |

## O. Desktop shell decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D118 | Platform application menu and window chrome | **macOS installs a conventional system application menu and keeps hidden-inset traffic lights. Windows/Linux use the shared 46px frameless shell with localized File/Edit/View/Window/Help menus and renderer-drawn minimize/maximize-or-restore/close controls. Both menu surfaces route renderer-owned actions through a fixed `AppMenuCommand` allowlist; renderer menus route native editing/window actions through a separate fixed allowlist. Target packaging builds the local release host before Electron packaging. This adds platform-ready shell behavior but does not reverse D010: Windows/Linux release qualification remains post-MVP.** | A default Electron menu leaves macOS shell commands incomplete, while a frameless Windows/Linux window otherwise loses both application menus and window controls. Shared allowlists keep behavior consistent without exposing an arbitrary privileged command bridge. |
| D120 | Application update delivery | *(amended by D364 / D603 / D628)* **Electron Main owns the fixed GitHub Releases feed, polling, typed update state, and install lifecycle, downloading in-app only where the platform supports installation.** | Installation stays outside the sandboxed renderer. See ADR 0022. |
| D628 | User-selectable application update behavior | **Amend D120: a persisted per-install `updatePreference` selects automatic in-app updates or manual notify-only, defaulting by installer format.** | Control with safe no-install defaults. See ADR 0022. |
| D313 | Main-owned GitHub issue feedback | **GitHub issue forms are the only intake path; Settings → Info opens a Main-built prefilled bug report, and the renderer cannot supply the URL.** | Reports without version or steps cannot be triaged. See ADR 0157. |
| D330 | Main-owned `openExternal` protocol allowlist | **Every `shell.openExternal` call parses its URL and admits only `http`, `https`, and `mailto` hrefs, throwing `DISALLOWED_EXTERNAL_URL` otherwise.** | Unvalidated links can launch OS protocol handlers. See ADR 0109, ADR 0168. |
| D332 | Classified plugin file preview and live workspace events | **Amend ADR 0104 / 0105 / 0109 / 0111: add `fs.readPreview`, broadcast panel events to docked views, and deliver workspace changes to panels and plugins.** | `fs.readText` cannot preview images or cap binaries. See ADR 0104. |
| D334 | Contained in-chat image display | **`fs/read`, `fs/reveal`, and `fs/open` share one contained resolver, and a renderer-only `fs/readImageDataUrl` returns bounded image data or a failure tag.** | History attachments are unreadable extension-less data-root blobs. See ADR 0172. |
| D336 | Host-owned plugin completions and session context | **Amend D019: granted plugins may read the in-flight tool session's model-facing transcript and run one-shot completions through host-owned APIs that never expose credentials.** | Second opinions need models and context, not secrets. See ADR 0174. |
| D340 | User-configurable outbound proxy | **Settings → General → Network offers System, Direct, or Custom proxy, applied to Chromium, the agent sidecar, and marketplace fetches from one persisted setting.** | Node fetch ignored the OS proxy. See ADR 0177. |
| D342 | Import model configuration from local agent stores | **Amend D007: Settings never auto-imports, but an explicit Model configuration card scans five local agent stores and copies chosen provider drafts.** *(amended by D645 / ADR 0319: model import moved to Models and Settings has no session-import UI)* | Users retyped endpoints and keys they already had. See ADR 0179, ADR 0188, ADR 0319. |
| D351 | Preserve distinct credentials during model configuration import | **Amend D342 / ADR 0179: an imported provider matches only when normalized endpoint, API style, and credential all agree, so same-endpoint accounts stay separate rows.** | Endpoint-only idempotence dropped all but one account. See ADR 0188. |
| D344 | Main-owned picker capabilities | **Amend D197 / D334: native file and image pickers hand back a short-lived sender-bound token, never absolute paths, and the directory option is removed.** | Renderer-supplied paths were a file exfiltration primitive. See ADR 0181. |
| D314 | Shipped locale registry and language picker | **Amend D073: `@pi-desktop/i18n` owns the shipped locale registry, and Settings → General language becomes a searchable picker that includes Auto.** | Preview cards cannot scale past two languages. See ADR 0160, ADR 0182. |

| D345 | Traditional Chinese shell locale | **Amend D314 / ADR 0160: ship a complete `zh-TW` shell and changelog catalog, resolved by `zh-Hant`, `zh-HK`, and `zh-MO` as well.** | Traditional users need their own terminology and notes. See ADR 0182. |
| D346 | P0 international shell locales | **Amend D314: ship complete `de`, `es`, and `fr` shell catalogs with native names, resolving each regional variant to its base locale.** | Highest-value missing P0 coverage; the registry already scales. See ADR 0160, ADR 0183. |
| D349 | Korean shell locale | **Amend D314: ship a complete `ko` shell and changelog catalog with native name 한국어, resolving `ko` and `ko-*` to it.** | Korean needs a distinct complete shell language. See ADR 0183, ADR 0185. |
| D605 | Brazilian Portuguese (pt-BR) shell locale | **Amend D314: ship a complete `pt-BR` shell and changelog catalog named Português (Brasil), resolving `pt_BR` and regional `pt-*` to it.** | Brazilian users need a matching complete shell language. See ADR 0306, ADR 0160. |
| D350 | Focus-aware native task notifications | **Amend D117 / ADR 0107: `notification/showNative` carries `kind` as `task` or `interactive`, and task banners stay suppressed while the main window is focused.** | Two notification kinds need different focus rules. See ADR 0187. |
| D358 | Show provider retry causes in the active-turn status | **Amend ADR 0175: `AgentActivity.retrying` may carry bounded redacted error details, revealed on hover or focus without creating transcript error rows.** | Users need the retry cause in place. See ADR 0196. |
| D359 | Summarize first-turn session titles with a main-owned one-shot *(superseded by D652)* | **Historical: the core once applied a first-prompt fallback, then ran `session/summarizeTitle` from Electron after `agent_end`. D652 removes both automatic title paths and moves optional generation to a standalone plugin.** | A truncated first prompt was a poor sidebar label, but title generation must not block the turn or expose credentials to the renderer. |
| D361 | Inline image transport uses a 10 MB app-side bound | **Amend ADR 0101 / D197: `MAX_INLINE_IMAGE_BYTES` is 10,000,000, shared by Electron main and the sidecar, and larger images fall back to `@path`.** | MiniMax accepts at most 10 MB per image. See ADR 0101. |
| D316 | Searchable theme picker | **Amend ADR 0160: the theme setting becomes a searchable picker pinning System, Light, and Dark above plugin themes, replacing the card grid.** | Plugin themes outgrew the card grid. See ADR 0161, ADR 0160. |
| D121 | Branded macOS development host | **`pnpm dev` on macOS launches electron-vite through a fingerprinted, ad-hoc-signed PI-Desktop copy of the installed Electron host bundle under `.cache/electron-dev/`. The generated bundle changes only development host metadata, executable name, bundle identifier, and the ICNS resource; it never mutates `node_modules`. Windows/Linux keep the stock development executable, while packaged lanes remain electron-builder-owned.** | AppKit ignores runtime app-name/menu overrides for the top-level application identity and takes the native menu name and About icon from the host bundle; a branded development host is required for parity with packaged PI-Desktop. |
| D129 | Menu-free Windows/Linux window chrome | **The application menu is macOS-only; Windows and Linux keep the frameless 46px titlebar with renderer-drawn controls and no in-window menu bar.** | An in-window menu duplicates macOS chrome needlessly. See ADR 0021. |
| D130 | Sidebar-footer notification entry | **The durable notification Bell moves from the main titlebar to the separate `32px` action at the right of the expanded sidebar footer, replacing D113's Help shortcut. Its unread badge and complete D117 inbox behavior remain unchanged; the popover opens above and to the right of the footer, and no duplicate Bell remains in the main titlebar. This supersedes only the entry-location clauses of D113 and D117.** | Notification history belongs with the persistent local profile controls and the footer position keeps the main titlebar quiet while preserving a compact, familiar status entry. |
| D141 | Canonical Windows native application identity | *(amended by D443)* **Electron Main sets the product name before readiness and registers `com.pi-desktop.app` as the Windows process AppUserModelID before creating any window. That ID is the existing electron-builder/NSIS application ID; Windows packaging explicitly retains `PI-Desktop` for the executable and Start menu shortcut. Native notification attribution, notification settings, taskbar grouping, installed shortcuts, and packaged executable identity must expose `PI-Desktop`, not the stock Electron host. D121 remains unchanged: Windows development may use the stock Electron executable while its OS-facing runtime identity uses the canonical AUMID.** | `app.setName` changes Electron's internal name but not the Windows identity used by notifications and shell integration. One stable ID across runtime and packaging prevents both the observed notification-source leak and adjacent shell-brand drift without changing the published NSIS upgrade identity. |
| D204 | Empty home task-entry surface | *(supersedes D111's non-docked home-composer clause and its contextual quick-action clauses; starter-grid amendment in D205 is superseded by D206)* **The empty chat home keeps the hero and optional first-run checklist in the scroller, with the composer as a bottom-reserved sibling that never covers content.** | The direct composer stays the primary action. See ADR 0066. |
| D205 | ChatGPT-inspired empty-home guidance | *(superseded by D206)* **The empty chat home adds a compact four-card developer starter grid between the hero and optional checklist: Explore a codebase, Build a feature, Fix a bug, and Review a change. Each localized card only prefills and focuses the bottom composer; it never sends a prompt or creates a turn. The bottom-reserved composer and single scrollable home flow from D204 remain unchanged.** | The previous hero-only middle left too much unused space and offered no starting cues. ChatGPT's clear empty-state hierarchy improves first-task discoverability while developer-specific prompts keep the surface purposeful rather than promotional. |
| D206 | Remove empty-home developer starter cards | **The empty chat home does not render developer starter cards, starter glyphs, or a contextual quick-action row. It keeps the restrained hero, short supporting line, optional onboarding checklist, and D204's bottom-reserved composer; task entry starts directly in the composer. This supersedes D205 without changing D204's scroll and bottom-reservation layout.** | Review confirmed that the direct composer is the preferred task-entry surface and that the cards add an unnecessary decision layer to the empty home. |
| D208 | Recoverable native-tool path contracts | **Keep the deferred Glob/Grep boundary but make contracts explicit: Read refuses directories, Grep accepts one file or a directory, and path errors carry structured recovery arguments.** | Sessions showed repeated path mistakes and false failures. See ADR 0069. |
| D216 | Cross-platform tray-resident minimize | *(Windows taskbar clause amended by D252 / ADR 0117; explicit Windows/Linux action clauses amended by D256 / ADR 0123)* **Electron Main owns one tray icon everywhere; explicit minimize hides the window while background work continues and native Windows taskbar minimize stays ordinary.** | Background work must survive a hidden window. See ADR 0078, ADR 0117, ADR 0123. |
| D218 | Host-owned cross-platform plugin panel chrome | **Plugin panels adopt the main window's 46px platform chrome, rendered by the sandboxed preload in a closed Shadow DOM through a private sender-validated control channel.** | Default frames looked detached and varied by platform. See ADR 0081. |
| D234 | Plugin-owned panel surface with a host window-control capsule | **Plugin panels are frameless everywhere, and the preload renders only a transparent 46px band with one three-button window-control capsule while the plugin owns the rest.** | The host titlebar consumed the plugin's visual hierarchy. See ADR 0092, ADR 0081, ADR 0082. |
| D235 | Strict 46px plugin drag band with a minimal capsule | **Plugin panels reserve exactly 46px as a transparent host drag band on every platform, holding one minimal page-adaptive capsule and no host title.** | Frameless panels need a drag band, not chrome. See ADR 0092. |
| D343 | Custom global UI type scale | **Appearance adds cup presets and a percentage slider persisted as `AppSettings.fontScale`, scaling every `--text-*` token and shared icon through one root multiplier.** | One multiplier scales the whole frozen type ramp. See ADR 0180. |
| D232 | Custom global UI font | *(amended by D598)* **Appearance gains a searchable font picker over bundled and installed families, persisted as `AppSettings.fontFamily` and applied by overriding `--font-sans` without a reload.** | Renderer preferences should not widen host RPC. See ADR 0083. |
| D598 | The app ships no fonts | **Amend D232 / ADR 0083: remove every bundled family and its licensing surface, keeping the picker on installed system families plus a system CJK fallback tier.** | Bundled faces duplicated OS coverage at 15.7 MiB. See ADR 0298. |
| D230 | User-configurable close behavior with close-to-tray | **Windows and Linux close behavior is asked once and persisted as tray or quit, with a Settings toggle that cannot restore prompting.** | Close quit outright where minimize had hidden. See ADR 0090, ADR 0078. |
| D363 | Explicit quit confirms before shutdown | **Amend D230 / D216: Cmd+Q, the application-menu Quit item, and the tray Quit item show one themed in-app confirmation (Cancel / Quit), restoring a tray-hidden main window first and using a native fallback when the renderer is unavailable. Cancel leaves the app running and allows a later quit to prompt again. Confirm runs the ordered `before-quit` shutdown. A window-close path that already chose Quit in the D230 dialog sets `quitConfirmed` and does not ask again. Boot, supervision, and capture probes skip the dialog, and so does the quit an in-app update performs: `autoUpdater.quitAndInstall()` spawns the platform installer before `app.quit()`, and that installer aborts once the app outlives its wait window, so the update restart must reach the ordered shutdown without a prompt. Additive lifecycle-dialog IPC only; no storage or host-protocol change. See E2E-204.** | An explicit quit tears down host-core, the sidecar, and in-flight work; a one-step confirm prevents an accidental Cmd+Q or tray Quit from doing that, without re-prompting a user who already chose Quit on the close-behavior dialog. |
| D252 | Windows taskbar preserves native minimize/restore | *(Explicit renderer/menu minimize clauses superseded by D256 / ADR 0123)* **Amend D216 / ADR 0078: a taskbar toggle on Windows completes the native minimize instead of hiding, while explicit minimize actions still hide to the tray.** | Hiding on taskbar toggle removed the taskbar entry. See ADR 0117, ADR 0123. |
| D236 | One desktop instance per data directory | **Electron main takes the single-instance lock at startup for default data directories; a second launch quits, and the running instance restores its window instead.** | Two shells shared one single-writer database (D002). See ADR 0094. |
| D367 | Host-owned plugin session import and ownership API | **`pi.session` gains import, list, read, rename, and delete over host-generated ids scoped to `(pluginId, source, externalId)`, backed by new schema columns.** | Plugins need durable session ownership boundaries. See ADR 0200. |
| D368 | Explicit plugin project ids and host-owned session refresh | **Plugins create or reuse projects by path without activating the workspace, and Electron main emits a session-changed event after plugin imports, renames, or deletes.** | Plugin writes need a host-owned renderer refresh path. See ADR 0201. |
| D680 | Plugin session scope: `.all` grants and message-level writes | **`pi.session` gains `session.read.all`, `session.update.all`, and `session.delete.all` grants plus message-level writes, enforced per scope with audits.** | Ownership-only scope could not express reading user sessions. See ADR 0340, ADR 0200. |
| D370 | Local MCP control plane for desktop operations | *(amended by D372)* **An opt-in loopback MCP server inside Electron Main authenticates with a bearer token and delegates to the same registered IPC handlers, requiring confirmation for dangerous operations.** | External agents need control without duplicating permission logic. See ADR 0203. |
| D372 | Tightened local MCP control-plane boundary | **Amend D370 / ADR 0203: the first catalog is the project, session, Agent, and workspace flow plus reviewed reads, with stripped secrets, asserted loopback, and bounded results.** | The first catalog exposed secret writes without confirmation. See ADR 0203. |
| D377 | Plugin desktop control requires native user consent | **A `dangerous` `pi.desktop.invoke` operation needs the plugin's `confirm` flag and the user's answer to a host-owned native dialog showing a bounded preview.** | Caller-set confirmation let plugins act with no human. See ADR 0208. |

## P. Transcript storage decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D119 | Transcript file store; SQLite index-only | **Schema v7: message content moves out of SQLite into per-session JSONL files under `~/.pi-desktop/sessions/` — `<id>.jsonl` (a session-header line, then one canonical block-array message line per message, RFC3339 stamps) plus an append-only `<id>.revisions.jsonl` for regenerate branches. `messages` drops `content_json`/`meta_json` and becomes a pure index (ordering, promoted filter columns, extracted `text` feeding FTS); `message_revisions` swaps `messages_json` for `message_count`, with `is_active` tracked in the DB only. Writes are file-first then index transaction; reads skip unknown/torn lines and dedupe repeated message ids keep-last; full rewrites are temp-file + atomic rename; session files are deleted only with their session and never age/orphan-swept. Opening a pre-v7 database archives it as `pi.sqlite.v6.bak` and bootstraps fresh — an explicit breaking reset, with all v1–v6 migration code removed. RPC wire format is unchanged, so Electron/renderer/importers need no changes.** | The database grew without bound carrying tool args/results and thinking payloads; codex/claude-code-style per-session files keep transcripts human-readable, greppable, and portable while SQLite stays a small, fast index (list, search, badges). A dev-phase breaking reset was chosen over migration machinery. |
| D122 | Independent conversation session fork | **Protocol v5 adds host-owned `session.fork`, copying the active transcript into a new independent session with remapped ids and inherited configuration, without runtime or lineage state.** | Host-owned snapshot keeps persistence consistent across forks. See ADR 0023. |
| D134 | Assistant response fork and reversible edit | *(edit clause superseded by D137)* **The completed-assistant toolbar exposes Copy, Fork, Edit, and Regenerate but no Delete. Fork calls the existing host-owned `session.fork` with optional `throughMessageId`, producing an independent session whose canonical transcript ends at that response. Edit uses the same isolated child, replaces only the selected assistant text there, and stores original/edited tails as a two-entry D109 revision family so the existing pager can restore either. Both require an idle source, remap message/tool-call ids, and never share the source session id, runtime, transcript, revisions, or provider cache state.** | Response-level divergence and correction should remain reversible without mutating the source or letting an edited history reuse cached runtime state built from different assistant content. |
| D199 | Regenerate branch archived under the host RPC lock | **`session.saveActiveRevision` reads, archives the branch, and stamps revision counters in one host call under the state lock, after draining the outbox.** | Async index writes lost the turn's final message. See ADR 0060, ADR 0041. |

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
| D684 | One settings destination owns one subject | **Amend D143 / D166 / D678: the Settings rail is fifteen single-subject destinations in four clusters, retiring `general` and `ai` into Appearance, Conversation, Behavior, and System.** | Two destinations had become mixed landing places. See ADR 0345. |
| D685 | Composer model picker: text rail and segmented reasoning | **Amend D458: the reasoning control in the combined Composer model menu is a segmented track with a raised pill under the selected level, placed in the menu footer, instead of a rail with track dots. The native range input, its column geometry, latest-wins commits and keyboard ownership are unchanged. The model list uses a text-only source rail with one sliding marker; Escape clears a typed search before closing the menu. Renderer only. See `04-ux/08-component-spec.md` and E2E-050.** | The dot rail and colored source tiles read heavy next to compact model rows; a segmented pill and a text rail match the rest of the menu chrome. |

## R. Decision rules going forward

- Architecture-boundary changes require a new ADR
- Implementation defaults can be updated in this log + related specs
- Any reversal of D001–D010 requires explicit baseline bump

## S. Composer input decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D123 | Composer slash commands, three sources | **Typing `/` opens one command menu for pi prompt templates, builtin palette commands, and plugin commands, expanding templates in Electron main before persistence.** | Keeps pi argument semantics and template assets. See ADR 0024. |
| D124 | `@` file references are plain-text light references | **`@` opens a fuzzy workspace file menu and inserts a canonical `@rel/path` plain-text reference that the model follows with Read.** | Matches pi CLI semantics without context inflation. See ADR 0019. |
| D125 | Composer autocomplete interaction and IME contract | **One menu component anchored above the composer, full composer width, focus always stays in the textarea. Keys while open: ↑/↓ cycle with wraparound, Enter/Tab accept, Escape closes only the menu (takes precedence over the composer's clear/blur Escape), typing filters live; Enter never sends while an item is highlighted, and an empty result list counts as closed. The menu closes on outside mousedown, blur, deleting past the trigger character, or session switch. All key handling and trigger detection sit behind the IME guard (`isComposing || keyCode === 229` plus composition start/end tracking): during composition nothing triggers, updates, or intercepts, and state is re-evaluated on compositionend.** | First explicit IME rule in the spec — zh-CN Enter-to-send plus candidate confirmation must never fight the menu; uniform insert-then-dispatch keeps two-Enter flows fast and predictable. |
| D632 | Composer input history recall with ArrowUp/ArrowDown | **Amend D125 / D209 / D301: the accepted submissions of one conversation — a normal or steering prompt and a dispatched slash, extension, or mode command — are recorded newest-first in renderer-local `localStorage` (`pi.desktop.composerInputHistory`, one bounded bucket per conversation held newest-written-first, 100 entries per conversation, 20 conversations, consecutive duplicates collapsed) with the draft text and its file-reference snapshot, and recalling shows only that conversation's prompts. With the autocomplete menu closed and the draft empty (no text and no references), ArrowUp loads the newest entry and further ArrowUp walks older entries to the oldest; ArrowDown walks newer entries and past the newest returns to the empty draft. While browsing, both keys keep driving history even for a multi-line entry; any user input event, a submission, or a draft-key (session) change ends browsing, after which arrows are native again. IME composition and an open autocomplete menu keep priority over history. Because an entry is always recalled in the conversation that sent it, its file and image references are restored with its text, and no cross-conversation notice or i18n string exists. The caret moves to the end of the recalled text; the empty home composer (no conversation) recalls nothing, and a prompt sent from home is recorded in the conversation that submission materialized. Storage is best-effort: a missing, blocked, or corrupted store reads as empty and never breaks sending. No protocol, host, storage-schema, permission, theme, or packaging change. See `04-ux/09-interaction-patterns.md` and E2E-COMPOSER-input-history-recall.** | Retyping or re-copying a previous instruction is the most repeated composer action, and the app already keeps renderer-local MRU history for the plugin launcher (D219). Scoping the history to the conversation keeps a recalled draft's context intact and makes attachment restoration unconditional, because attachments live in that conversation's own scratch directory. |
| D633 | Completed turn-process disclosures fold by default | **Amend ADR turn-process-and-thinking-display: Detailed opens the whole process while a turn runs, and untouched details start folded once it settles.** | The completed process stayed open by default. See ADR turn-process-and-thinking-display. |
| D197 | Composer clipboard files become session-scratch references | **When the composer clipboard contains one or more OS files/images, the renderer intercepts the file paste, transfers bounded bytes plus name/MIME metadata through the Electron-only `pi-desktop/composer/pasteFiles` channel, and includes the durable session id. Electron main verifies the session, sanitizes names, and writes unique files below `<data_dir>/scratch/<sessionId>/pasted/`; D209 amends the draft presentation while preserving each returned absolute path as the quoted-or-unquoted `@` reference sent to the agent. Text-only paste remains native. A home composer creates or reuses a durable session first. Clipboard bytes never enter the prompt, workspace, or artifact store, and session deletion removes the pasted files with the scratch root.** | Fixes the broken file/image paste path without dirtying the project or inventing provider-specific binary prompt plumbing; it reuses the existing scratch containment and lifecycle contract. |
| D209 | Composer file references separate compact display from canonical prompt paths | **Completed file and pasted references become session-scoped chips showing only the leaf name, serialized to canonical paths just before submit, with unanswered-send undo intact.** *(amended by D362: chips are inline sentinel-backed elements in the contenteditable draft)* | Chips keep the prompt readable; paths stay exact. See ADR 0070. |
| D362 | Accepted `@` files insert the same inline chip as paste | **Amend D209 / D125 in the renderer: accepting a completed workspace file from the `@` menu (Enter, Tab, or click) replaces the trigger token with one private-use sentinel in the draft and stores that token on the reference, the same path clipboard paste already uses. The chip paints at the caret; that confirmation never sends. Directories still insert `@dir/` as text. Token-less references are not a visible draft surface. Workspace-relative chips still drop on project switch; absolute scratch/paste paths stay. No IPC, storage, host-protocol, or schema change.** | After chips moved inline, file accept still stripped `@query` and stored a token-less reference that no longer painted, so Enter made the file vanish. |
| D333 | Work-panel browser is the bundled `pi.browser` plugin | **The work-panel Browser and agent CDP ship as the bundled `pi.browser` plugin, while the guest view and debugger stay host-owned behind gated APIs and an allowlist.** | The browser should be optional like Files. See ADR 0170. |
| D211 | Global plugin launcher | **A customizable global shortcut opens one prewarmed frameless launcher listing enabled panel plugins, with pinyin-aware matching and a Windows low-level hook fallback.** | Panel plugins need a keyboard-first entry while unfocused. See ADR 0072, ADR 0076, ADR 0080. |
| D212 | Running composers stage next-turn configuration and stopped turns preserve throughput | **During a running turn the composer queues the next prompt while the in-flight runtime stays pinned, and stopped answers record measured or estimated throughput.** | Staging must not mutate running configuration. See ADR 0073. |
| D215 | Windows-reserved global shortcut fallback | **On Windows, host-core installs a narrow low-level hook for the reserved `Alt+Space` default and emits only that binding's event.** | The shell reserved the shipped launcher chord. See ADR 0076. |
| D217 | Early plugin launcher warm-up | **Electron begins building the retained launcher window as soon as it is ready, sharing one in-flight promise so early shortcuts join that load.** | Overlapping startup removes first-invocation stutter. See ADR 0080. |
| D219 | Plugin launcher most-recently-used history | **The launcher renderer records each successfully opened plugin id with a timestamp in renderer-local `localStorage` (key `pi.desktop.pluginLaunchHistory`, capped at 24) and presents an empty query in most-recently-used order. A typed query ranks search relevance first and uses recency only as a tiebreaker, so unused plugins sort after the recent ones by name. Corrupted or unavailable storage degrades to the existing name order without breaking launching. This refines D211's presentation without changing IPC, host RPC, permissions, protocol v9, or storage schema v11.** | Keyboard-first launcher users reopen the same plugins repeatedly; remembering the last-used order keeps the most frequent target one Enter away while relevance stays authoritative once the user types. |
| D221 | Renderer output size controls | *(bundled CJK clause superseded by D598)* **The renderer build minifies explicitly, drops legacy font sources, and imports 192px brand marks refining D079/D094, with tests asserting all three.** | Output fell from 31 MiB to 24 MiB. See ADR 0083. |
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
| D660 | Composer file menu rows always show the full relative path | **Amend the `@` file-completion row presentation of D124 (specs `04-ux/08-component-spec.md` §11.8, `04-ux/09-interaction-patterns.md` §8a.1, E2E-102a): every row renders the leaf name — directories keep the trailing `/` — followed by the entry's complete workspace-relative path in a de-emphasized mono span that carries the raw `entry.path` without a trailing slash. The span takes the row's remaining width and ellipsizes before the leaf name can, and no row overflows the menu. The tooltip keeps the complete relative path and the accessible name becomes the path alone, because the visible row already includes the leaf name. D209/D362 chip rendering, completion, insertion, and serialization are unchanged; no earlier decision owned the old leaf-only row wording, so no entry is marked amended.** | Duplicate leaf names in different directories were indistinguishable until hover, and the relative location — often the actual intent of an `@` reference — was invisible in the persistent row. |


## T. Release delivery decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D126 | Three-platform release delivery (lifts D010) | *(amended by D364 / D603)* **Tag builds publish every artifact the matrix produces to the GitHub Release: macOS dmg/zip (arm64), Windows NSIS x64, Linux AppImage + deb (x64), each with blockmaps and the platform's `latest*.yml` electron-updater feed. Publishing the feeds activates D120's in-app update lanes for Windows NSIS and Linux AppImage; macOS stays in notify-and-link mode until a signed channel is qualified. The NSIS artifact name is pinned space-free (`PI-Desktop-Setup-${version}.${ext}`) because GitHub asset URLs mangle spaces. D010's macOS-only scope is lifted per the baseline-bump rule (baseline `0.4.7`); the release pipeline itself was qualified end-to-end on v0.1.1-rc.1/v0.1.1.** | The pipeline builds and validates all three platforms on every tag anyway; keeping installers as expiring Actions artifacts (90-day retention) withheld them from users without adding safety. Publishing the update feeds is the point of shipping: platforms with in-app lanes update silently, and future platform regressions surface through real installs instead of unused artifacts. |
| D364 | Windows portable exe without installer | *(superseded by D603)* **Amend D120 / D126 / ADR 0022: tag builds also publish a Windows portable executable that keeps notify-and-link updates and the existing data directory.** | Some environments whitelist only a single executable. See ADR 0197. |
| D603 | Windows portable delivery uses a normal ZIP | *(amended by D628)* **Amend D364 / ADR 0197: the portable target becomes a user-extracted ZIP kept out of `latest.yml`, launched directly as `PI-Desktop.exe` with notify-and-link updates.** | The self-extracting wrapper triggered administrator prompts. See ADR 0197. |
| D260 | Release documentation is a version surface | **A stable version bump must update every version-bearing surface before the tag: the shipped-locale in-app changelog and its test list, every workspace `package.json` including `docs/package.json` (a third workspace root `scripts/release.mjs` previously skipped), the Cargo workspace version and `host-core` lockfile entry, `APP_VERSION`, and the `<major>.<minor>.x` release line stated in `README.md` and `README.zh-CN.md`. `scripts/check-release-docs.mjs` verifies all of them; `scripts/release.mjs` runs it after bumping and refuses to commit or tag while any surface disagrees, with `--skip-docs-check` reserved for deliberate non-release bumps. Extends D164.** | The in-app changelog gate alone left published documentation behind: the READMEs still advertised the `0.5.x` line at `0.10.8`, and `docs/package.json` sat at `0.5.8`. A tag is irreversible, so the check runs before the tag exists rather than as review etiquette. |
| D371 | Explicit unsigned macOS first-launch helper | *(amended by D406, D443, and D634)* **Every macOS distribution no longer ships the executable `PI-Desktop-macOS-open.command` helper, so quarantine guidance lives only in the documentation.** | Quarantine blocked unsigned builds with misleading errors. See ADR 0204, ADR 0309. |
| D443 | Canonical application ID and macOS codesign identifier | **Amend D141 / D371 / ADR 0204: the application ID is `net.aiuo.pi-desktop`, with a `.dev` variant for development, and no adhoc signing of the unsigned pack.** | The owner domain binds the application identity. See ADR 0278, ADR 0204. |

## V. Extension activation decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D192 | Activation scope shared by every extension kind | **Plugins, MCP servers, and skills each carry `enabled` plus a global or project scope, matched case-insensitively and enforced at catalog assembly and dispatch.** | One boolean made every extension global. See ADR 0056. |
| D193 | User-owned MCP servers need no plugin | **MCP servers live as one JSON file per id under `.agents` roots, with enablement and project overrides kept in app-local state.** | Servers are configuration, not plugin packages. See ADR 0112. |
| D194 | User-owned skills are Markdown documents in `.agents` roots | **host-core scans `.agents/skills` roots for Markdown documents or `<skill>/SKILL.md`, exposing them through level-aware list calls with enablement kept outside the file.** | Skills stay portable documents; activation stays app-local. See ADR 0112. |
| D257 | Capability pages are one workbench that can author | **Refine D193 / D194 and supersede D202's shape: Skills, MCP, and Subagents render one toolbar over one panel and can create, edit, and delete.** | Pages listed capabilities without managing them. See ADR 0126. |

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

- Native window edges resize only the Electron shell, so work-panel open,
  collapse, close, and divider commits leave the outer bounds untouched.
- The divider uses anchored pointer deltas, a frame-coalesced preview,
  cancellation rollback, and a wider hit area; responsive clamping no longer
  overwrites the persisted preferred width.
- The renderer-to-Main `window/resizeBy` channel, programmatic resize
  attribution, and panel-specific window-state offset are removed.
- Decision D156. See ADR 0029.

## 2026-07-28 — Single assistant toolbar per user turn

- Provider-level assistant messages separated by tool calls remain canonical
  transcript records for model reseeding, persistence, and fork boundaries.
- The chat transcript composes every assistant/thinking/tool record after one
  user message and before the next into one visual assistant turn, preserving
  order while exposing one aggregate meta row and one Copy/Fork/Retry toolbar.
- Copy joins all contentful assistant fragments; Fork and Retry target the last
  contentful assistant record. Decision D157.

## 2026-07-28 — Turn-boundary context checkpoint compaction

- PI-Desktop evaluates context after every `turn_end`, before the next provider
  request, with a transient soft reminder and a deterministic hard checkpoint
  guard.
- Durable checkpoint records rebuild model context without deleting or hiding
  visible transcript messages, and an exact provider overflow receives one
  compacted retry.
- pi-agent-core primitives are reused; OpenCode DCP stays an AGPL-3.0
  behavioral reference only, neither linked nor copied.
- Decision D158. See ADR 0030.

## 2026-07-28 — Sidebar typography aligned with the global body scale

- Expanded-sidebar session titles return to `--text-base` (14px), matching the
  app body and primary sidebar chrome; project/group titles and empty-state copy
  return to the adjacent `--text-md` (13px) tier.
- Section labels and secondary metadata remain at `--text-sm` (12px), and the
  existing compact row pitch, truncation, and sidebar dimensions are unchanged.
- Decision D159; supersedes D155 and restores D144's primary-list hierarchy.

## 2026-07-28 — Icon-free composer prompt row

- Home and thread-docked composer prompt rows render no leading brand icon, so
  draft text and placeholder ink align with the input gutter.
- The canonical logo stays in the home hero, sidebar, native application
  identity, startup splash, and About surfaces, while session-creation controls
  keep their message-plus icon.
- Decision D160. See ADR 0031.

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

- The docked panel keeps its committed `364..720px` width while open, and
  native edges resize MainChat only.
- Open, collapse, final close, and divider commit set one idempotent
  native-width target; chat stays stable when the work area reserves the full
  width and absorbs only the unavoidable shortfall otherwise.
- Maximized and fullscreen geometry waits for normal state, persisted base
  bounds exclude the reservation width and x shift, and background artifacts
  cannot change the visible target.
- Decision D163; ADR 0033 later superseded its window-expansion portion and
  the contrary parts of D156 and ADR 0029.

See ADR 0032 and ADR 0033.

## 2026-07-29 — Dual-locale in-app product changelog

- EN and zh-CN product highlights ship in `packages/shared` and attach to
  `UpdateState.releaseNotes` from Electron Main when an update is discovered.
- The update banner and Settings → Info surface a compact What's new list in
  the active product locale, with no new feed or IPC domain.
- Release tagging requires both locale catalogs to be updated before the tag
  build.
- Decision D164; extends D120. See ADR 0022.

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
  batch inside the checkpoint copy instead of failing repeatedly at the same
  transcript boundary.
- The retained copy keeps every call and result envelope, distributes text
  budget fairly with explicit head and tail truncation markers, omits duplicate
  provider-irrelevant details, and leaves original transcript rows complete.
- Decision D158; it amends ADR 0030's blocking policy for an indivisible batch.

See ADR 0030.

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

- The docked work panel opens at 280px instead of 420px, and its fixed clamp
  becomes `244..720px`.
- `WORK_PANEL_DEFAULT_WIDTH`, `WORK_PANEL_MIN_WIDTH` (renderer and Electron
  Main), and the `.work-panel` CSS floor stay in sync, and divider double-click
  restores the new default.
- D154's 364px floor was sized for a 44px activity rail beside 320px of content;
  the rail became a header switcher, so the floor scales with the default.
  Persisted wider widths remain valid and the 720px maximum is unchanged.
- Decision D167, superseding the D154/D163 width clamp and ADR 0033 §4.

See ADR 0033.

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

- `contributes.skills` is activated: the runtime reads each declared skill file
  at prompt time for plugins granted `agent.prompt.inject`, through the gated
  `fs` containment guard, and renders a `# Plugin skills` section capped at
  16 KiB total and 8 KiB per skill, with its own budget rather than ADR 0037's
  32 KiB instruction chain, ordered after built-in skills and before project
  instructions. Runtime reuse keys on a skills digest, so enabling, revoking, or
  editing retires the idle runtime. Closes roadmap gap R2.
- Plugin authoring ships as `@pi-desktop/plugin-devkit`, owning `scaffold` /
  `check` / `pack` over one implementation shared by the `pi-plugin` CLI, the
  `PluginScaffold` / `PluginCheck` / `PluginPack` agent tools, and the plugins
  page's New plugin from template action; `pack` writes store-only (method 0)
  `.piplug` entries because `extract_zip_bytes` accepts nothing else. Closes
  roadmap gap R3's template and `check`/`pack` items.
- A bundled plugin was rejected as the delivery vehicle because a plugin cannot
  produce a `.piplug` and scaffolding would need high-risk `fs.write.workspace`.
  The built-in `plugin-development` skill activates only for plugin workspaces,
  and development plugins hot reload on a debounced save, capped at 16, with a
  reload never allowed to widen the approved permission set. Closes roadmap gap
  R3's hot-reload item.
- Decision D171; D174 later replaced the prompt-injection half with a skills
  catalog plus a `Skill` tool, leaving the devkit, hot-reload, and
  workspace-gate clauses standing. See ADR 0039.

## 2026-07-31 — Creating a plugin from a template opens the folder

- Creating a plugin from a template also opens the chosen folder as the active
  project (`workspace.set`), not just as a loaded development plugin, because
  development needs the sources inside the workspace the agent, the file panel,
  and the built-in `plugin-development` skill all read.
- Activation runs in the renderer through the existing `activateProject` action
  rather than the template IPC handler, so project state, the sidebar project
  list, and the navigation intent guard keep their single owner.
- The success toast distinguishes the two outcomes, and Load local plugin
  deliberately keeps its behavior because running someone else's plugin is not a
  reason to switch the user's project.
- Decision D172; no ADR — this completes the flow ADR 0039 describes.

See ADR 0039.
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

- Decision D393 / ADR 0219 adds active built-in, plugin, and user Skills as the final group of the composer `/` menu; selection inserts `/skill:<id>` while keeping the original id for send-time resolution.
- Electron main revalidates the current project scope and asks the model to call the local `Skill` tool, while D174's model-invoked catalog and body-loading security contract stand.
- The typed command remains the transcript chip, and no host protocol or durable schema changes.
See ADR 0219.

## 2026-09-11 — Windows work-panel chrome keeps one resource action cluster (D394)

- Decision D394 amends D154 / D357 / ADR 0195: the open work-panel header keeps one compact resource switcher, and resource close stays on the existing unified context-menu rows so a second `X` does not sit beside the Windows native close control.
- The viewport-fixed panel toggle remains the sole panel-level collapse control, subagent detail uses a back chevron, and Windows/Linux native controls stay fixed at the window edge.
- Renderer-only: no panel state, window geometry, IPC, protocol, or storage change.
See ADR 0220.

## 2026-09-11 — Canonical thinking-level values in the UI (D395)

- Decision D395 / ADR 0221 amends D369 / ADR 0202: Composer, model configuration, and delegation surfaces render `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` directly, because translating them made one provider setting vary with the application locale.
- Those values leave every locale catalog, while effective metadata, clamping, provider requests, protocol, and storage are unchanged.
See ADR 0221.

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

- Native file-system drops into the Composer prevent the browser default, use one accent outline around the complete shell without changing its layout, and turn regular files into removable leaf-name chips through the bounded session-scratch paste bridge.
- The preload resolves each dropped `File` with Electron's `webUtils.getPathForFile`, and a folder's complete native path enters the caret as literal `@<path>/` text with mixed item order, surrounding draft, focus, and caret preserved; folders are never read, traversed, or copied.
- Decision D397 amends ADR 0101's previous drag/drop scope, and no host RPC, protocol, workspace, or durable-schema change is added.
See ADR 0222.

## 2026-09-11 — Message quotes and renderer-owned side chats (D-LOCAL-message-quotes)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- Every user message and assistant turn gains a Quote action that inserts a `> `-prefixed Markdown blockquote plus a `chat.quoteSource` attribution line into the active session's composer draft, using the live selection when it lies inside the clicked row and the message's own text otherwise, capped at 2000 characters, and never sending.
- Open side chat forks the anchored message through the existing `session.fork` without activating the child, registers it as a renderer-owned side chat of the parent, and opens one `sidechat` tab streaming through the shared background-transcript reducer with Add to main chat, Open as a conversation, Send/Stop, and the permission card.
- Closing that tab or promoting the child to a conversation removes the registration and its projection; the durable child stays an ordinary session, and no protocol, storage-schema, IPC channel, or permission changes.
See ADR message-quotes-and-side-chats.

## 2026-09-11 — Context usage display preference (D398)

- Decision D398 amends D347 / ADR 0184: `AppSettings.contextUsageDisplay` (`"remaining"` or `"used"`, defaulting to and falling back on `"remaining"`) selects whether the trigger ring arc, percentage, token label, popover heading, tooltip, and `aria-label` lead with remaining or used capacity.
- `"used"` fills the ring by `usedRatio` and shows the used-capacity pair, while the warning and critical thresholds stay computed from remaining capacity.
- Settings → AI → Defaults gains the Remaining / Used segmented control after Link open destination and before Enter-to-send.
See ADR 0223.

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

- Decision D400 amends D185 / ADR 0048: a new prompt or mode switch clears the in-memory deferred activation set, then restores successful activation evidence from the effective session context, with `ToolSearch` rows contributing `addedToolNames` and successful deferred-tool rows their own tool name.
- Restoration keeps only names still in the current mode's deferred catalog; failed, interrupted, and missing-result placeholder rows are ignored, and assistant or user prose is never read as activation evidence.
- Host permissions, workspace containment, and audit behavior are unchanged.
See ADR 0225.

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

- `contributes.mcpServers` declares `{ id, label?, transport }` with exactly one transport's fields — `stdio` taking `command` / `args` / `env` under `mcp.server.local`, `http` taking `url` / `headers` under `mcp.server.remote` — and the main process speaks protocol `2025-06-18` as NDJSON over stdio or streamable HTTP/SSE with lazy connect and teardown on unload.
- Discovered tools register as `plugin_<pluginIdSafe>_<serverId>_<toolName>` in the existing plugin tool map, inheriting the audit trail, timeout, and disable switch, and they stay `risk: "medium"` because a third party's schema cannot be trusted to declare its own risk.
- `env` and `headers` resolve only from plugin settings via `{ "setting": "<key>" }`, the host environment is never passed through (D018), and `url` must be `https` unless the host is loopback.
- Decision D176 ships both transports, because a hosted endpoint is common enough that stdio-only would push plugins into a worse local shim.
See ADR 0038.

## 2026-07-31 — Resident plugin services and their restart policy

- Decision D177: `contributes.services` declares up to four `{ id, label?, autoRestart? }` entries behind `background.service`; the broker runs `start` after `onLoad` and `stop` before `onUnload` inside the plugin's own `utilityProcess`, so a service never outlives its plugin.
- A crash takes the service down with the process and the supervisor restarts the whole plugin with 1s/2s/4s/8s/16s backoff capped at 30s, five attempts, and a 60s healthy reset, while `autoRestart: false` opts out and the last attempt leaves the plugin visibly `failed`.
- Per-service state and restart count are read over `plugin/services`, rendered as chips, and audited as `plugin.service.*`; manual enable or disable outranks the supervisor by cancelling the timer and clearing the counter.
See ADR 0040.

## 2026-07-31 — Inter-plugin message bus routes declared topics only

- Decision D178: `pi.bus.publish` / `subscribe` require both the permission and a matching `contributes.bus` entry, so a granted permission alone routes nothing and the manifest stays a complete description of what a plugin says and hears.
- Topics are dot-separated segments with `*` for one segment and trailing-only `**`; the broker excludes the publisher, delivers fire-and-forget over a one-way `{ t: "event" }` frame that also makes `pi.events.on` / `off` real, and caps payloads at 64KB, 16 subscriptions, and 100 publishes per rolling 10s.
- A payload conveys data and never capability, so a topic is public within the app.
See ADR 0040.

## 2026-08-02 — Bash tool inherits the user's login-shell PATH

- Decision D181: on Unix the first Bash call probes `$SHELL` (fallback `/bin/zsh` → `/bin/bash` → `/bin/sh`) with `-lic 'printf %s "$PATH"'`, bounded to 5s, cached per process, discarding stderr and keeping only the last stdout line, then injects that PATH into every Bash child.
- `bash -lc` still re-runs the bash profile at startup; agent commands remain POSIX bash, the resolved binary is unchanged, and Windows keeps `bash -c` with the host environment.
- This fixes Finder and Dock launches that could not see nvm, pnpm, or Homebrew tooling initialized in `~/.zshrc` / `~/.zprofile`.
See ADR 0045.

## 2026-08-02 — Route process logs into category files

- Decision D182: the `app`, `host`, and `agent` channels stay local NDJSON but each becomes a directory of focused `<category>.log` files, and every record carries a `category`.
- Host and agent stderr is classified into the same categories with timing lines isolated in `timing.log`, buffered by line, decoded as UTF-8, and stripped of ANSI before persistence; unknown child output goes to `runtime.log`.
- Rotation stays 5 MB with two rotated files per category file, byte lengths count UTF-8, rotation and disk failures stay best effort, and existing flat log files are not deleted during migration.
See ADR 0046.

## 2026-08-02 — Context usage inspector

- Replace the oversized context ring with a compact Codex-style trigger combining a remaining-capacity ring, `Context` label, and percentage, opening a non-modal panel *(superseded by D225: the trigger is click-toggled)* with the context window, exact provider input/output/cache/reasoning usage, aggregate generation speed in `tokens/s`, and each unique tool type in first-seen order.
- Tool rows aggregate repeated calls with call count, argument and result tokens, estimated footprint, share bar, and known duration, using pi-agent-core's four-characters-per-token heuristic while provider-reported usage stays authoritative and the rows stay labelled as estimates.
- The panel renders at document body level as a fixed, collision-aware viewport overlay that follows scroll and resize, and its window total comes from the same `pi-ai` model record the agent sidecar receives, with provider metadata and the 128K default as fallbacks.
- `UiMessage.responseDurationMs`, `UiMessage.toolUsage`, and the optional `toolUsage` field on `tool_end` are additive, so older persisted messages and peers remain readable.
See ADR 0047.

## 2026-08-02 — Lazy per-turn tool activation

- The sidecar keeps a complete local registry but sends only the mode's core tools and local `ToolSearch` on a new prompt (`CompactContext` was always active here until D200 removed it, and D203 restored it as `new_context`).
- Agent follows pi's coding-agent core (`Read`/`Bash`/`Edit`/`Write`) while Chat keeps (`Read`/`Glob`/`Grep`); Agent-mode `Glob`/`Grep`, `BrowserPreview`, plugin tools, `Skill`, and plugin-development helpers ship as bounded catalog entries instead of full parameter schemas.
- An exact-name or capability search activates at most four matches for the next turn, `addedToolNames` lets providers with native deferred search serialize those definitions at the load point, and activation resets before the next prompt.
- Host permissions, workspace and scratch containment, timeouts, and audit behavior are unchanged, and persisted results keep their activation markers.
See ADR 0048.

## 2026-08-04 — Bound provider stream recovery and diagnostics

- Provider request setup has one bounded pi-ai retry: a transient stream, network, or timeout failure after streaming begins gets one same-turn retry with a short abortable backoff, the failed assistant leaves model context, and the visible assistant id is reused.
- `terminated` and equivalent incomplete stream messages map to `STREAM_FAILED`, while a second failure stays terminal and carries bounded phase, timing, provider status/code, and retry-attempt diagnostics.
- Mutation recovery is finite: one unique local `Edit`, else a `Write` rewrite, then one fresh read or regeneration after a mismatch, with a second same-path `Edit` failure or a failed shell patch emitting the terminating hint.
See ADR 0050.

## 2026-08-04 — Recover automatic compaction failures with a retained tail

- Automatic threshold and provider-overflow compaction failures now attempt a deterministic, aggressively bounded retained-tail checkpoint before the turn ends, keeping the previous summary when available and the visible transcript untouched, with host persistence and the hard-budget recheck still mandatory.
- The summary input is preflighted against the model window so an obviously oversized request goes straight to the bounded path instead of a provider rejection or timeout.
- The lifecycle event marks the recovery `fallback: "retained_tail"` so the renderer keeps the run active with a warning, while manual `/compact` stays fail-fast.
- Decision D158 amends ADR 0030 and adds ADR 0049.
See ADR 0049.

## 2026-08-04 — Resource-isolated host RPC stdio

- Decision D187: host-core no longer uses Tokio's stdio adapters for its NDJSON control pipe: one named OS thread reads stdin and one named thread serializes stdout, keeping per-message framing and retrying interrupted or transient `EAGAIN`/`EWOULDBLOCK` errors.
- That closes the process-exit path where Tokio's blocking pool panicked after the OS refused another worker thread (errno 35 on macOS); a control thread that cannot start is a startup error rather than an unhandled panic.
- The login-shell PATH probe also uses `thread::Builder` and falls back to the inherited PATH.
See ADR 0051.

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
| D604 | Trust the network endpoints the user enters themselves | **Amend ADR 0243 / 0245 / 0247: user-typed URLs reach private, link-local, and `.local` hosts over plain `http` under one `networkPolicy.mode` (`relaxed` by default); third-party content stays public-only.** | Typed endpoints were a user decision. See ADR 0304. |

## 2026-08-05 — Agent-only mode

- `agent` is the only session mode: the former `chat` profile becomes `read-only`, still hard-denying Write/Edit/Bash in host-core but no longer selectable, displayable, or commandable in the UI.
- The gate is negative everywhere (`mode != "agent"` → read-only surface), `chat` normalizes to `read-only` on every host write path, `*_DISABLED_IN_CHAT` becomes `*_DISABLED_IN_READ_ONLY`, and database open rewrites stored `chat` values inside schema v7.
- Decision D191 is superseded by D189; the mode concept it removed returned as Plan (D188/D189, ADR 0052/0053), and the entry stays because the `read-only` normalization and the `chat` fix-up shipped.
See ADR 0055.

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

- Plugins, user MCP servers, and user skills share one activation shape — `enabled` plus `{ mode: "global" | "projects", projects: [] }` — so switching something off keeps the narrowed project list and the `off` / `projects` / `global` control is derived rather than stored.
- Matching is case- and trailing-separator-insensitive, a scoped path covers its subdirectories, and scope is checked when the per-turn catalog is built and again at dispatch, because a visible tool is one the model will try to call; themes stay unscoped.
- Adding an MCP server is a paste through `parseMcpImport`, a failed handshake stays failed until the user edits it or presses Test, and a user skill is one `SKILL.md` under D174's untouched contract with the description above the body.
- Four tabs rather than one merged list, because plugin rows, MCP rows, and skill rows need a connection light, a byte counter, and a permissions matrix that one list would hide.
See ADR 0053.

## 2026-08-05 — Permission-gated external paths and portable native search

- Explicit `path` arguments for `Read`, `Glob`, `Grep`, `Write`, and `Edit` are classified against the durable workspace and scratch roots before the risk matrix: `ask` and `accept-edits` emit the permission card with the path preview, `auto` executes, and denial, timeout, or cancellation return `TOOL_DENIED` without touching the path.
- The approved resolver re-canonicalizes the deepest existing ancestor at execution time so `..` and symlink escapes cannot skip the boundary, and the outside location is never promoted to a workspace root.
- The sidecar exposes the host's bounded search controls with the canonical `filesWithMatches` spelling and normalizes provider aliases, preferring native tools and portable workspace-relative paths over shell search.
- Decision D195 changes the host/runtime boundary.
See ADR 0057.

## 2026-08-05 — Extensions page density and theme-readable actions

- The Extensions destination drops the four-card numeric overview band while Installed, MCP, Skills, and Marketplace stay separate tabs, with tab counts, installed state-group counts, and the pending-update alert carrying the actionable state.
- Shared primary and secondary buttons use semantic accent, surface, text, and border tokens: primary actions invert the theme surface, and secondary actions keep an opaque elevated surface and a visible border in both themes.
- Decision D196 amends the presentation portion of D169 without touching plugin, MCP, skill, marketplace, permission, or runtime contracts.
See ADR 0058.

## 2026-08-05 — Clipboard files become session-scratch references

- The composer distinguishes native text paste from a clipboard payload carrying files or images, sending bytes to Electron main only once the renderer holds a durable session id and creating or reusing one on a home composer.
- Main validates the session and writes bounded, uniquely named files under `<data_dir>/scratch/<sessionId>/pasted/`, and the draft receives ordinary `@absolute/path` references with quoting for whitespace.
- Decision D197 and ADR 0059 define the new renderer/main boundary, keeping pasted material out of binary prompt content and off the project.
See ADR 0059.

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

- Turn completion used to archive the regenerate branch from Electron main with `session.get` plus `session.replaceMessages`, so a snapshot could predate the turn's final message — assistant and tool rows reach SQLite through the persistence outbox (ADR 0041) — and the rewrite then deleted it along with every row's `turn_id`.
- `session.saveActiveRevision` now performs the read, the archive, and the user-root stamp in one host call under the state lock, re-reading the transcript at write time so a line appended meanwhile survives; main drains the outbox first and skips the archive with a warning otherwise.
- Decision D199 and ADR 0060 define this: `session.replaceMessages` carries each surviving message's `turn_id` across a rewrite and is documented as safe only for a caller that owns the whole transcript for the duration.
See ADR 0060.

## 2026-08-06 — Context compaction becomes imperceptible

- Compaction is host-driven and silent: the `CompactContext` tool, the `<context_management>` soft-boundary nudge, and the host no-confirmation allowlist entry are gone, so a long session never spends a model turn asking to be compacted and never grows a transcript row.
- `contextBudget()` keeps D158's hard limit and headroom, derives the retained-tail target from the model window instead of settings, and adds a 70% background limit that also requires growth since the newest checkpoint's baseline.
- Generation and installation are separate: a checkpoint builds only in provider-idle windows and installs at the next turn boundary when its base, anchor, and budget still hold, and a failed background build is discarded with no event, no persistence, and no ADR 0049 fallback.
- `compaction_start`/`compaction_end` gain optional `phase` and `status { generation, summaryTokens }` inside protocol v9, a successful automatic compaction notifies nobody, and Settings exposes no compaction controls.
See ADR 0061.

## 2026-08-06 — Context compaction is rebuilt to match Codex

- Compaction is inline again: background pre-computation, its 70% limit, the increment-scoped trigger, and the three idle call sites are deleted, and `prepareNextTurn()` compacts when the context crosses `hardLimit` or the model called `new_context`, matching Codex's `should_roll_over`.
- A checkpoint carries the summary plus recent user messages, unfiltered so no message leaves model context uncovered, retained newest-first to 20,000 tokens with the crossing message truncated rather than dropped and assistant messages taking their tool calls so no orphaned call reaches a provider.
- Both Codex families ship — the summary path and a `fresh_window` rollover with a fixed marker — behind an internal switch (`PI_DESKTOP_COMPACTION_STRATEGY`) absent from settings and i18n, because no user can judge that trade-off from a settings row.
- `new_context` is parameterless, sits on the no-confirmation allowlist, and is never assignable to a subagent; two budget reminders ride the turn's system prompt, `compaction_end` carries `mark`, and every successful compaction raises one warning toast, while decision D203 / ADR 0064 amend D200 / ADR 0061 and restore D158 / ADR 0030's visibility property.
See ADR 0064.

## 2026-08-06 — Bounded subagents behind a `Task` tool

- A session delegates one self-contained piece of work to a subagent and receives a single written report: four inline builtins (`explorer`, `code-reviewer`, `test-runner`, `fixer`) plus enabled global documents under `~/.agents/subagents/*.md`, re-read on every launch, capped at 16, with malformed documents degraded to launch diagnostics.
- A definition declares its own `tools` from a fixed list and is read-only when it declares none; a delegate never inherits mutation rights, cannot reach plugin, skill, mode, or meta tools, has no `Task` tool of its own, and may pin `model: <provider>/<model>` resolved once per launch, with an unresolvable pin failing the call instead of falling back.
- `Task` is offered in Agent mode only: an all-`Task` batch runs concurrently, capped at 4 slots with each delegate at its own `maxTurns` (default 24, maximum 80), and same-path `Write`/`Edit` calls serialize through a `PathMutex`.
- The parent gains only the bounded 12k-character report, while delegate rows persist with `parentToolCallId` / `agentName`, nest one level inside their `Task` row, stay out of the turn stream and minimap, and share one per-session permission queue.
See ADR 0062.

## 2026-08-07 — Empty home uses direct bottom task entry

- Empty chat home uses a direct bottom composer and keeps the hero and optional onboarding content in one scrollable region.
- The composer is a bottom-reserved sibling of that region, so it stays visible while checklist content scrolls independently on short windows.
- Decision D204 and ADR 0066 define the layout.
See ADR 0066.

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

- `Cmd/Ctrl + J` is a customizable renderer shortcut named `openWorkPanel` that reveals the active session's retained work-panel context at the committed width without creating a resource tab. *(Open-only clause amended by D221: the shortcut also collapses the visible panel.)*
- No active session and the Settings page are no-op contexts, and the context menu remains the place to create Review, Terminal, Browser, or Files.
- Decision D207 supersedes D128's no-global-shortcut clause and amends D142's no-launcher presentation; artifact-driven resource creation, session ownership, background-event isolation, collapse behavior, and width persistence are unchanged.
See ADR 0068.

## 2026-08-10 — Native path mistakes recover without false turn failure

- Read is file-only, Glob is directory-only, and Grep accepts a file or directory, with directory Read errors carrying structured Glob recovery args.
- Recovered tool errors stay visible on their own rows but no longer turn the containing processing group into a terminal failure surface.
- D185's deferred Agent search tools are unchanged; decision D208 and ADR 0069 define the compatible tool and transcript contracts.
See ADR 0069.

## 2026-08-10 — Composer file references use compact draft chips

- Completed workspace-file selections and pasted session-scratch files become renderer-owned, session-scoped references, and the composer shows only removable leaf-name chips with full paths available to tooltips and assistive technology.
- Immediately before the existing submit dispatcher, references serialize after the visible text with the unchanged quoted-or-unquoted `@path` grammar; reference-only sends, slash templates, and mode aliases keep their behavior, and a failed send retains text and references.
- An accepted send keeps only an in-memory, session/turn-scoped copy of its pre-serialization draft for unanswered smart Stop to restore; once reply content begins, abort preserves the partial transcript and restores nothing.
- Decision D209 and ADR 0070 amend the draft-presentation clauses of D124 / ADR 0024 and D197 / ADR 0059, leaving clipboard bytes, scratch containment, cleanup, host RPC, storage, and provider payloads unchanged.
See ADR 0070.

## 2026-08-11 — Global corners use an Apple-inspired shape hierarchy

- Fixed radii follow a regular 4/6/8/10/12/14/16/18/20/24px ladder, with rounded rectangles for compact and medium desktop controls and pill or circle tokens reserved for semantic capsules, equal-width icon controls, switches, tracks, avatars, and dots.
- Nested surfaces use Apple's concentricity rule when their corners align — outer radius equals inner radius plus the inset between edges — and structural full-width shell panels stay square.
- The composer keeps its 20px visible radius through the shared scale, while experimental `corner-shape` waits because Electron 37's Chromium 138 does not support it.
- Decision D210 amends D072's pixel-preserving ladder without changing its token-only enforcement.
See ADR 0071.

## 2026-08-11 — Global plugin launcher and uninterrupted next-turn preparation

- Option+Space on macOS and Alt+Space on Windows/Linux opens a centered, frameless plugin launcher that searches launchable panels by Chinese name, full pinyin, pinyin initials, normalized name/id, and description, then opens the highlighted result through the existing panel host.
- During an active answer the draft and the mode, thinking, and permission choices stay editable for the next turn while Send stays disabled, and the renderer flushes only the newest full choice once the host reports idle.
- A user-stopped partial response keeps its elapsed duration and exact provider output when present, falling back to a visibly approximate output count so throughput survives persistence and reload.
- Decisions D211/D212 and ADRs 0072/0073 define the native-window, IPC, in-flight configuration, and transcript metadata contracts.
See ADR 0072 and ADR 0073.

## 2026-08-12 — Plugins can request and send native notifications

- `pi.ui.notify` stays an in-app toast, and plugins with the existing `notify` permission gain `getNotificationPermission`, `requestNotificationPermission`, and `showNativeNotification`.
- Native notification objects stay owned by Electron main, which returns a best-effort `granted` / `denied` / `unknown` / `unsupported` state because Electron has no cross-platform read-only query, and native plugin notifications create no durable inbox rows or session activation events.
- Decision D213 and ADR 0074 define the public API and its separation from D117's application-owned task notification contract.
See ADR 0074.

## 2026-08-12 — Development plugins get an explicit permission-ceiling reload

- Automatic development-plugin reloads still reject manifest permission additions, preserving the no-silent-widening boundary.
- The Plugins page offers Reload for `source: "dev"` rows: `plugin/reload` resolves the registered folder, reloads it through the existing Electron runtime, and re-arms the watcher with the current declared permissions as the new ceiling.
- Decision D214 and ADR 0075 define this additive renderer/main IPC surface, with host RPC and storage schema versions unchanged.
See ADR 0075.

## 2026-08-12 — Windows reserves the plugin launcher chord

- Windows' `Alt+Space` system-menu reservation can make Electron's global shortcut registration fail while the application is unfocused, so host-core owns a narrow low-level keyboard hook for the default binding, consumes the chord, and emits `keyboard.shortcut`.
- Electron toggles the existing launcher window, custom bindings keep the normal Electron global shortcut path, and protocol version 9 and storage schema 11 stay unchanged.
See ADR 0076.

## 2026-08-13 — Plugin launcher renderer warms during startup

- Electron starts creating and loading the retained plugin launcher as soon as it is ready, before backend and plugin boot complete, while keeping the window hidden.
- Shortcut delivery during warm-up joins the same in-flight creation promise, a failed warm-up stays retryable, each visible invocation still refreshes the plugin catalog, and macOS reveals the panel through one normal activation path without a focus steal.
- Decision D217 and ADR 0080 supersede only D211 / ADR 0072's first-use lazy creation clause, leaving IPC, host RPC, protocol v9, and storage schema v11 unchanged.
See ADR 0080.

## 2026-08-12 — Approval cards focus on the artifact and remember the mode

- Plan/Goal approval cards show only the title, the host-created artifact opener and path, Reject, and Approve, dropping the submitted question, status, deadline, and inline warnings.
- The selected Ask / Accept edits / Auto mode is remembered in renderer-local device preferences as the next default with Ask as the fallback, and title-derived artifact filenames preserve Unicode alphanumerics so localized titles stay recognizable.
- Decision D215 and ADR 0076 amend D189 / ADR 0053; the host's internal deadline remains a fail-closed boundary without being exposed, and protocol and storage versions are unchanged.
See ADR 0076.

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

- New Task resolves the current project or Temporary group by its most recent non-archived session, reusing an empty latest session or creating, refreshing, and selecting one before the first prompt.
- The renderer serializes same-group New Task requests so rapid clicks cannot race multiple empty inserts, and an older empty row is deliberately left alone when a newer non-empty session is the latest.
- `SessionSummary.messageCount`, derived by host-core from `sessions.last_seq`, replaces title heuristics as the empty predicate, so empty rows stay visible and title localization stays presentation.
- Decision D252 supersedes D220 and ADR 0084: the startup home stays an unpersisted renderer draft while explicit New Task is eager and durable, with `messageCount` additive inside protocol v9 and storage schema v11 unchanged.
See ADR 0113.

## 2026-08-14 — The work panel shortcut toggles instead of only opening

- `Cmd/Ctrl + J` (`openWorkPanel`) now collapses the visible work panel as well as revealing a closed one, through the same store action as the header collapse control, retaining tabs, active resource, Browser resource, and committed width.
- The shortcut id stays `openWorkPanel` so existing keybinding overrides keep working, and only the Settings → Shortcuts label changes to describe toggling.
- Decision D221 amends D207 and reverses ADR 0068's rejected toggle alternative while D128's and D142's remaining clauses stand; protocol v9, host RPC, IPC channels, and storage schema v11 are unchanged.
See ADR 0085.

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

- The launcher asked Electron for `visibleOnFullScreen` without `skipTransformProcessType`, so Electron transformed the whole process into a UI element and PI-Desktop vanished from the Dock and Cmd+Tab — ADR 0080's warm-up made it happen on every launch; the launcher now passes `skipTransformProcessType: true`, and `app.dock.hide()` / `app.setActivationPolicy` stay forbidden in Main.
- The launcher keeps `canJoinAllSpaces` and `FullScreenAuxiliary` but gives up overlaying another application's fullscreen Space, which macOS reserves for accessory apps, so invoking it from there activates PI-Desktop.
- macOS activation also restores the shell from `did-become-active` for a booted, non-quitting app with no visible window, so Cmd+Tab and App Exposé resurface a tray-hidden window (D216 / ADR 0078) while launcher and plugin-panel activations leave the main window alone.
- Decision D223 constrains ADR 0072's launcher window and completes D216's restore paths, with ADR 0080's warm-up and latency budget intact.
See ADR 0086.

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

- The inspector trigger no longer opens on `pointerenter` or focus: a click or `Enter`/`Space` toggles the panel, and the 140ms hover-grace close timer is deleted, so reading, scrolling, and selecting text outlast a wandering pointer.
- Dismissal is explicit — a second activation, a capture-phase pointerdown outside trigger and panel, or `Escape` returning focus — and scrolling the trigger out of view still closes it, as does the body-level collision-aware placement from ADR 0047 §6.
- The panel becomes `role="dialog"` with the localized `Context` label and `aria-haspopup="dialog"` on the trigger, so keyboard users keep a stable panel instead of one that vanished on blur.
- Decision D225 amends D184 / ADR 0047 and is renderer-only.
See ADR 0047.

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

- A mid-stream HTTP 429 becomes retryable `PROVIDER_RATE_LIMITED` and joins `STREAM_FAILED`, `NETWORK_ERROR`, and `TIMEOUT` in the runtime's same-turn bounded replay path: one 750 ms abortable backoff, the failed assistant removed from model context, and one replay in the same visible bubble.
- The budget stays one same-turn retry per prompt, so a second 429 is terminal with the normal assistant error and lifecycle `error` event carrying `retryAttempt: 1` and `providerStatus: 429`.
- Request-setup 429s were already covered by pi-ai's bounded retry that honors `Retry-After` up to 8 seconds, so this closes the post-stream gap where that wrapper cannot act.
- Decision D233 refines D186 and is runtime-only.
See ADR 0091.

## 2026-08-15 — A stopped mutation loop says so

- D186's repeat guard counted every same-path `Edit` failure alike, so `EDIT_TAG_MISMATCH`, `EDIT_TAG_UNKNOWN`, and `EDIT_LINES_UNSEEN` — each of which already hands back the live tag or the withheld content — now get one free attempt per path, every other code counts on its first occurrence, and a landed write clears that path's history.
- The guard still stops the loop by terminating the tool batch, which pi-agent-core reads as "no more work"; the runtime now finalizes the assistant row with retriable `MUTATION_RETRY_BUDGET_EXHAUSTED` and emits the matching error event, recording the turn as `error` rather than `completed`.
- Decision D228 refines D186 and is runtime-only.
See ADR 0089.

## 2026-08-15 — A file permission carries a range, and a delete is recoverable

- A permission now says whether a plugin may touch files at all while `manifest.fs` says which ones per mode with globs relative to the mode's root: `fs.read` may ask for the whole tree, but `fs.write` and `fs.delete` are refused a whole-tree pattern at validation time.
- Every `pi.fs.*` call passes four gates in a fixed order — declared ∩ granted, `realpath` containment on both sides, the credential deny-list plus the host's data directory, then the declared scope — with native deny/allow-once/allow-session consent outside it, and a host with no consent service refuses.
- Deletion is bounded rather than scoped alone: `own: true` removes what the plugin wrote itself through a path+mtime ledger invalidated by a user edit, anything else needs a declared scope, and removal goes through `shell.trashItem`, stays non-recursive, and is braked at 50 per rolling minute.
- `root: "userSelected"` trades standing power for reach through a memory-only directory handle, pre-scope names still install but are downgraded on load with the marketplace preflight and `pi-plugin check` naming the downgrade, and decision D229 continues ADR 0008 D009 by adding the manifest `fs` section and the `pi.fs.remove` / `pi.fs.requestDirectory` APIs.
See ADR 0088.

## 2026-08-16 — Proactive background subagent delegation

- `Task` stops blocking: it starts a delegate in the background and returns a `delegationId`, while new Agent-mode core tools `TaskWait`, `TaskList`, and `TaskStop` drive convergence, and the runtime's per-session registry stops delegates left running at run end, parent abort, or dispose.
- The system prompt gains a `## Delegation` section with positive triggers and convergence rules, `explorer` is rewritten in the omo-slim style, and a write-capable `fixer` (`maxTurns: 40`) ships.
- Definitions may declare `permission: inherit | ask | accept-edits | auto`, resolved by host-core per `tools.execute` call under the contract modes' hard deny and the external-path gate, and a project definition's declaration is dropped at parse time; `TaskWait` defaults to 600 seconds, clamps to 900, and the per-session running cap becomes 10.
- Decision D231 amends D201 / ADR 0062 and touches the sidecar, host-core permission resolution, the builtin definitions, the system prompt, and the renderer's tool presentation mapping.
See ADR 0089.

## 2026-08-17 — Plugin panels leave the visible surface to plugins

- Plugin panel windows are frameless on macOS, Windows, and Linux: the preload reserves the same transparent 46px safe area on every platform and draws only a fixed top-right capsule with minimize, maximize/restore, and close.
- The host no longer renders the manifest title or a development safe-area reminder, so authors own the title, toolbar, background, and other visible panel UI, using `--pi-plugin-titlebar-height` and `-webkit-app-region: drag`.
- Decision D234 amends D218 / ADR 0081 and D232 / ADR 0082, leaving the sender-validated control channel, closed Shadow DOM, localized labels, theme-adaptive capsule, `window.pluginBridge`, protocol v9, and storage schema unchanged.
See ADR 0092.

## 2026-08-17 — Plugin panels keep a strict 46px drag band

- Plugin panels reserve exactly 46px for a transparent host drag band on every platform, offsetting normal-flow content by that value and leaving clicks in the band unavailable outside the capsule.
- The host renders no panel title: development panels show a localized, non-interactive drag-only reminder, production panels keep it hidden, and the minimal capsule stays fixed top-right inside the band.
- Decision D235 amends D234 / ADR 0092, keeping the page-adaptive capsule's closed Shadow DOM, localized labels, focus and reduced-motion behavior, private control channel, `window.pluginBridge`, protocol v9, and storage schema.
See ADR 0093.

## 2026-08-18 — One desktop instance per data directory

- Electron main takes the single-instance lock before it touches the data directory, so a duplicate launch quits before creating a window, a tray, a child process, or a log line.
- The running instance restores and focuses its main window through the tray's Show path, so a window closed or hidden into the tray comes back instead of a second shell appearing beside it.
- Decision D236 protects D002's single SQLite writer and the singletons around it, with the lock scoped to the installation so separate `PI_DESKTOP_DATA_DIR` runs still start.
See ADR 0094.

## 2026-08-18 — Vendor-account (OAuth) login

- A provider row can be authenticated by a vendor subscription: the seven pi-ai OAuth vendors ship at once because the card list derives from `models.getProviders().filter(p => p.auth.oauth)`, with `registerBunOAuthFlows()` running once at startup for the dynamic import electron-vite cannot bundle.
- Credentials live beside (never instead of) the row's API key under `secret:provider:<id>:oauth`; `has_secret` widens to either credential, and `has_oauth` plus a non-secret `oauthAccountLabel` are new while `auth_kind` gains `oauth` inside unchanged protocol v9 and schema v10.
- Electron main owns login and logout, serializes `modify` per provider, and renders browser-callback, device-code, select, and paste-a-code steps through one `providersOauth*` stream, while the sidecar gets only a short-lived `ModelAuth` from `provider.resolveAuth`, checked against the binding table, and never a refresh token.
- Model discovery, the connection test, and `apiStyle` follow the account, Settings → Model configuration gains a Vendor accounts section, and decision D237 extends D028/D031 across host-core, main, the provider binding, and the settings UI.
See ADR 0095.

## 2026-08-18 — Independent vendor OAuth accounts

- D240 amends D237 / ADR 0095: the provider row id is the OAuth account identity, so every login creates a new row even for an existing `vendorKey`, and each row owns its own pi-ai collection, credential store, refresh chain, and `secret:provider:<id>:oauth` ref.
- Settings gains one owner per concept: Vendor accounts renders and removes OAuth rows, AI services renders API-key and custom rows, and removing an account clears or repairs a default pointing at the deleted id.
- The sidecar binds exact OAuth provider ids while main resolves auth by id, and subagent vendor or name aliases are accepted only when unique.
See ADR 0098.

## 2026-08-18 — Builtin subagents inherit the parent permission mode

- The builtin `fixer` no longer declares `permission: accept-edits`; like the other builtins it defaults to `permission: inherit` and uses the parent session's effective permission mode.
- In `auto`, builtin delegate calls therefore auto-allow the same in-root, high-risk, and explicit external-path operations as the parent, while `ask` and `accept-edits` keep their approval boundaries and explicit non-`inherit` scopes remain intentional overrides.
- Decision D242 amends D231 / ADR 0089; host-core's external-path gate and containment checks are untouched, because this removes an accidental builtin override rather than weakening the boundary.
See ADR 0100.

## 2026-08-18 — Model-aware image attachment transport

- Clipboard images stay compact structured composer references instead of base64 or visible `@path` text: main validates the source against the session roots and stores bytes under `<data>/attachments/<sha256>`, and the durable user message keeps only ref, kind, name, MIME type, and size.
- The exact pi-ai model record owns visual capability — `input.includes("image")` earns transient image blocks, unknown or non-vision models and images above the 10 MB inline bound fall back to a scratch or project path, and only an explicit `supportsImages` override can promote an unknown model.
- Decision D243 amends the image portion of D197 / ADR 0059, and D392 / ADR 0218 amends its capability-resolution rule, moving no provider logic into the renderer and putting no binary data into host persistence.
See ADR 0101.

## 2026-09-11 — Effective image-input overrides across Composer and transport (D392)

- Advanced model settings persist `supportsImages` per provider/model binding as three states: `null` or absent follows the published model record, while `true` or `false` explicitly enables or disables image input for that endpoint.
- Composer model rows, attachment status, and main-process transport all use the same effective binding capability; the published `ModelInfo` is not mutated and unknown or custom models stay conservative without an override.
- Decision D392 amends D243 / ADR 0101.
See ADR 0218.

## 2026-08-19 — models.dev first replaces Pi as the primary model catalog (historical)

- D266 amends D136 / ADR 0027: Electron main loads the public `https://models.dev/api.json` catalog with a bounded timeout and matches provider records by vendor key or normalized API URL, and Settings, Composer, and runtime metadata use the matching record first.
- Display names, context and output limits, input modalities, reasoning options, tool-call flags, and prices map onto the existing model surfaces, with no credentials in the request and a `catalogSource` marker separating models.dev from the pi-ai fallback in renderer metadata.
- D639 later removed the Pi sibling chat-metadata fallback; the historical decision stays here to preserve the record of the migration.
See ADR 0133.

## 2026-10-02 — models.dev is the chat model metadata authority

- D639 supersedes the Pi 0.99.1 metadata decision and the Pi sibling fallback: the bundled models.dev snapshot supplies chat context and output limits plus capabilities, the selected official publisher wins, safe unambiguous third-party records follow, and missing or conflicting records stay generic.
- Live endpoint and OAuth responses still determine selectable IDs, Pi remains the OAuth and transport adapter for typed non-chat operations, explicit user binding values stay pinned, and no provider secret reaches models.dev.
See ADR `models-dev-catalog-authority`.

## 2026-08-19 — The work panel becomes a plugin extension point

- Decision D246 lets a plugin declare work panel surfaces with `contributes.views` (id, plain or localized title, icon token, HTML entry, order) behind the new low-risk `ui.view` permission, independent of `ui.panel`, and each view renders as a main-process `WebContentsView` positioned from a renderer-measured rect, the mechanism the preview browser has used since D100.
- Views reuse the plugin's isolation wholesale — the same sandboxed preload, `persist:pi-plugin-<id>` partition, and `net.domains` egress filter, shared as functions so the two placements cannot drift — because an `<iframe>` cannot get its own partition; icons are tokens from a host-owned closed list, and permission, scope, and entry existence are re-checked on open.
- Decision D247 moves Review, Terminal, and Files out of the host onto that same channel as bundled first-party plugins, leaving Browser as the only built-in tool and giving the API a first-party consumer, with new `pi.review.*` and `pi.terminal.*` APIs and `terminal.pty` accepted deliberately as a critical permission.
See ADR 0104 and ADR 0105.

## 2026-08-18 — Compact context usage summary

- The inspector keeps its click and keyboard trigger, remaining percentage, used/window counts, turn total, completed-turn speed, exact provider values, aggregate tool summary, checkpoint summary, body-level portal, placement, outside dismissal, and Escape focus return.
- The default panel becomes a short summary: turn and speed values unboxed, provider and tool usage as compact inline rows, and the per-tool rows, share bars, source badges, estimate paragraph, and used-capacity meter removed, with `~` still signalling an estimate.
- Decision D244 amends D103 / D184 / ADR 0047, leaving protocol, storage, runtime accounting, and model metadata unchanged.
See ADR 0103.

## 2026-08-19 — OpenCode-style bounded provider 429 retry

- HTTP 429 is handled by one runtime-owned policy across request setup and stream recovery, with five retries after the initial request shared across phases and pi-ai's nested retry wrapper disabled.
- Retries stay silent and abortable: `retry-after-ms`, `retry-after` seconds, and HTTP-date values take precedence over a 2-second exponential fallback with positive 25% jitter and a 30-second cap, and failed status and headers are captured from fetch because pi-ai's response callback does not expose setup failures.
- Main sessions and builtin subagents reuse the visible assistant row and suppress intermediate events; exhaustion emits one terminal `PROVIDER_RATE_LIMITED` with `retryAttempt: 5`, aborting during the wait starts no later request, and auth, model-selection, malformed-request, and context failures stay terminal.
- Decision D245 amends D186 and D233; other transient failures kept one retry each until D258 gave them a shared budget.
See ADR 0091.

## 2026-08-19 — Files ships as the first bundled plugin

- Decision D248 implements D247's first step: browsing the project is the bundled `pi.files` plugin, reached through `contributes.views` like any third-party one, so the host tool list no longer carries a Files entry while Review and Terminal stay built in.
- Bundled plugins carry `source: "builtin"`, and host-core reconciles its registry against `PI_DESKTOP_BUILTIN_PLUGINS_DIR` on every launch, refreshing version and contributions while the user-owned enabled and scope state carries across; they can be disabled but never uninstalled.
- Only the tool migrated: a `file:<path>` tab stays a host-owned transcript artifact, exactly like Review's artifacts.
- Writing the plugin proved D247's premise, since a flat 500-capped `fs.glob` cannot back a lazy tree, so `pi.fs.list` was added under `fs.read` with the same declared scope, deny-list, protected paths, and heavy-directory skips.
See ADR 0105.

## 2026-08-19 — The builtin command surface is reduced to five core entries

- Decision D250 freezes the first-party registry at `builtin.session.new`, `builtin.agent.compact`, and the three `builtin.mode.*` entries, whose only builtin composer aliases are `/new`, `/compact`, `/agent-mode`, `/plan-mode`, and `/goal-mode`.
- Session deletion, abort, project, settings, plugin, log, rename, palette, reload-window, and DevTools entries leave the registry and renderer dispatch, along with the legacy `newChat`, `openProject`, and `openSettings` aliases, while dedicated UI workflows and plugin commands are unaffected.
- Mode aliases keep the one-shot `/mode <prompt>` behavior, and former aliases are no longer supported builtin contracts.
See ADR 0106.

## 2026-08-19 — The panel's built-in interactive terminal is removed

- Decision D251 supersedes D249 and the terminal clauses of ADR 0019/0105: the work panel no longer owns an interactive shell, and users take interactive shell work to an external terminal.
- Browser stays the host-built tool, Files stays a bundled plugin, Review and `file:<path>` stay artifact surfaces, and contributed plugin views remain available beside them.
- Agent Bash stays non-interactive and transcript-owned with its command, output, status, copy behavior, and terminal icon; only terminal-specific PTY UI, IPC, types, dependencies, packaging, and tests are deleted, the desktop protocol version does not change, and no plugin PTY permission or bundled replacement is introduced.
See ADR 0108.

## 2026-08-24 — Windows taskbar minimize keeps the taskbar entry

- Decision D252 amends D216 / ADR 0078 for the native Windows taskbar path: clicking the focused window's taskbar button completes the ordinary native minimize and keeps the taskbar entry, clicking it again restores and focuses the window, and clicking it while the window is merely covered still brings it to the front.
- Explicit renderer and menu minimize actions stay tray-resident, as do the macOS and Linux native paths, with the tray, background processes, bounds, IPC, and storage unchanged.
See ADR 0117.

## 2026-08-24 — Renderer-owned queued prompts and graceful Send now

- Decision D253 adds a per-session, renderer-local FIFO queue for prompts sent while an agent is running; it holds the visible prompt and its draft snapshot, supports independent removal, survives session switches, and is deliberately not persisted or replayed after restart.
- The composer has one submit slot: an active run with a non-empty draft renders Send and appends to the queue, an empty draft renders Stop, and after the owning session's `agent_end` the renderer drains one item through the existing `agent/prompt` path.
- Send now promotes one item and calls additive `pi-desktop/agent/stop`, setting pi-agent-core's one-shot `finishTurn` so the current response and tool batch complete before the prioritized prompt starts, while immediate abort keeps its behavior and never clears the queue.
- This changes renderer state ownership and adds one public IPC channel without changing host-core protocol v9, storage schema v11, or the one-running-turn constraint.
See ADR 0118.

## 2026-08-24 — Subagents use event-driven idle and duration timeouts

- Decision D254 replaces the default subagent turn cap with a 600-second idle watchdog and a 21,600-second total-duration ceiling; the idle timer resets on turn, message, and tool lifecycle events and pauses during tool execution, while the duration timer includes it. (Amended by D260: the idle default is 300 seconds and every agent event resets the timer.)
- A timeout returns `timed_out` with `SUBAGENT_IDLE_TIMEOUT` or `SUBAGENT_DURATION_TIMEOUT`, keeping the latest partial output where available, while fatal provider errors, parent aborts, and explicit `maxTurns` are unchanged.
- `maxTurns` becomes optional, with `none`, `0`, and omission meaning unlimited and explicit values capped at 80; definitions may override the watchdogs through `idle-timeout` and `max-duration` within documented bounds, invalid values warn and fall back to defaults. (Amended by D260: each builtin declares an explicit backstop rather than running unlimited.)
- Builtin `explorer` gains `Bash` while `code-reviewer` stays read-only, and shared status types, runtime timing, delegation topology, i18n, and E2E coverage expose the new timeout outcome.
See ADR 0119.

## 2026-08-25 — Collapsing the work panel restores the base window bounds

- Decision D255 supersedes ADR 0033: the renderer still lays the work panel out as an in-flow flex column, but requests a native reservation equal to the committed panel width before presenting it, and exit keeps the panel mounted until the zero-width reservation succeeds, so the window returns to its chat-only bounds instead of letting MainChat consume the released column.
- The target-state reservation planner, constrained-display behavior, Browser measured-bounds sync, Main-owned native edge resize, and session-scoped panel state are unchanged.
See ADR 0122.

## 2026-08-25 — Window controls use native taskbar minimize

- Decision D256 amends D216 / D252 for Windows and Linux renderer and native-menu minimize: the custom top-right button now uses the native OS minimize transition so the taskbar entry stays available for restore, and close-to-tray remains governed only by the remembered close behavior.
- macOS native minimize stays tray-resident, and the tray, close preference, IPC shape, host protocol, and background lifecycle are otherwise unchanged.
See ADR 0123.

## 2026-08-27 — Agent capability pages become one workbench

- Decision D257 refines D193 / D194 and supersedes D202's page-shape clause for Settings > Agent > Skills / MCP / Subagents: each page is one toolbar — segmented level filter with counts, one search field, project picker, primary actions — above one panel divided by level group headers.
- All three pages create, edit, and delete through host calls that predate the change, per-row busy replaces page-wide locking, skeletons are first-paint only, and enablement flips optimistically with a revert on host rejection.
- `skills.reveal` now carries `level` and `projectPath` so a project skill with no global counterpart resolves, while still accepting a bare id.
- Renderer-only apart from that payload widening: no host-core change, no new RPC, no storage or schema change, and every capability-state, precedence, and `.agents` path rule from D193 / D194 / D202 stands.
See ADR 0126.

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

- Decision D259 amends D186 / D245 and ADR 0050 / ADR 0091: non-429 transient failures share one budget of four retries after the initial attempt across request setup and stream delivery, so an upstream gateway 502/503/504 recovers before headers or mid-stream and only the failed request is replayed.
- The budget admits `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and retryable `PROVIDER_ERROR`, honoring `retry-after-ms`, `retry-after` seconds, then HTTP-date before a deterministic 1s/2s/4s/8s schedule capped at 8 seconds, with captured headers kept for every status that can state a delay.
- The main session, builtin subagents, and one-shot composer enhancement share one policy, the 429 five-retry budget stays separate, exhaustion records `retryAttempt: 4`, and authentication, model-selection, malformed-request, and context failures remain terminal.
See ADR 0128.

## 2026-08-27 — The subagent idle watchdog bounds silence, not slowness

- Decision D260 amends D254: every agent event, a single streamed token arriving as `message_update` included, re-arms the idle timer, so a delegate that keeps producing output is never idle-terminated however slow its turn, and the pause across tool execution is unchanged.
- Because the window measures dead air rather than work, the default idle timeout drops from 600 to 300 seconds, sized from the measured 174-second p99.9 wait and kept below the 600-second `TaskWait` default so a genuinely stuck delegate settles as `timed_out` within one wait.
- `TaskWait` expiry now reports "Still running after Ns" and states that this is not a failure and the delegates keep working, and the builtins gain turn backstops — `explorer` 60, `code-reviewer` 50, `test-runner` 40, `fixer` 80 — so a non-converging delegate ends as `truncated` with its partial report.
See ADR 0129.

## 2026-08-27 — The mounted transcript is a window, not the loaded history (D261)

- Decision D261 refines ADR 0120 / D258 in the renderer: those bounded what crossed IPC and what locating a page costs, but the renderer still mounted every paged-in row and kept it mounted for the session's life.
- The mounted history becomes a trailing window of 15 rows in the first commit after a switch, a 60-row steady state, grown 40 at a time; reaching the top grows a partial window and fetches an older page only once it covers all loaded history.
- `content-visibility: auto` skipped layout and paint but retained React trees, Markdown ASTs, and Shiki tokens — the wrong resource on a low-memory Windows machine — so windowing bounds retained memory and per-frame reconciliation at once, using the same pre-paint scroll anchor as a fetched page and clamping per session.
- The minimap is built from mounted entries and resolves a click by finding the marker's node, so no dash points nowhere, at the cost of find-in-page reaching only mounted rows.
See ADR 0130.

## 2026-08-28 — Large text pastes become session-scratch references (D262)

- Text-only pastes at or below the persisted `largePasteThreshold` (default 600 characters, valid from 1 through 1,000,000) stay native textarea input.
- Larger text travels as exact UTF-8 `text/plain` bytes through the existing paste bridge into `<data_dir>/scratch/<sessionId>/pasted/`, and the composer inserts a generated `@<temporary-name> ` token at the original caret and selection while keeping the canonical path mapping in the draft, cached and unanswered smart-Stop snapshots included.
- Dispatch resolves that token in place exactly once, never appending a basename, duplicating an attachment, or writing into the workspace, while clipboard file and image chips and scratch cleanup are unchanged.
- The setting is additive app-settings JSON, normalized to the default for older settings without a database migration.
See ADR 0131.

## 2026-08-28 — A cross-display drag is user intent, not an OS adjustment (D263)

- Decision D263 amends D255 / ADR 0122 in Main: the reservation reconcile read every display change as one `displayChanged` boolean and reused the remembered base bounds, which is right for an OS re-fit and wrong for a window the user dragged to another display.
- Reported as issue #18 and reproducible from 0.10.0, the jump came from wiring that reconcile to each native `move`, so it ran mid-drag from the origin display's base bounds and the target work area clamped the result.
- The boolean becomes a `DisplayTransition` of `none`, `os-adjusted`, or `user-moved`: `os-adjusted` preserves ADR 0122 verbatim, while `user-moved` derives base bounds from where the window now is, keeps the size even on a smaller display, and lets the reservation absorb the shortfall.
- Attribution keys off an unaccounted native `move` stream that defers reconciliation until it goes quiet, a `user-moved` transition advances the remembered display key and persists it, and a forced Stage Manager recovery clears the pending attribution.
See ADR 0132.

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

- Decision D271 refines D201 / D268 / ADR 0062 in the renderer: opening one delegation node inlined the delegate's entire run, so a delegate that made forty tool calls added forty rows at once.
- Three unbounded surfaces were involved — `.subagent-run` had no height limit, `.tool-fields` lacked the 260px cap its siblings carried, and D268 routed the joined `TaskWait` reports into an uncapped `note`.
- The scroll sits on a new inner `.subagent-run-rows` wrapper rather than the run, because the collapse rail is absolutely positioned outside the run's padding box and an `overflow` there would clip it; the heading stays outside the scroll area so attribution cannot scroll away.
- The scroll area is a labelled, focusable `role="group"` so keyboard users can reach it.
See ADR 0062.

## 2026-08-29 — A lifecycle row is a subagent row (D268)

- Decision D268 refines D201 / D265 / ADR 0062 and ADR 0089 in the renderer: D265 made every `Task` a delegation card but left `TaskWait`/`TaskList`/`TaskStop` as generic tool rows, which is where a settled outcome actually appears.
- The defects were narrow — a bare UUID summary, pretty-printed `delegations[]` JSON, and a label reading "Delegated" — and the fix reads the roster the runtime already returns.
- `details.delegations[]` and `details.stopped[]` supply agent name, status, and registry timestamps, so the row summarizes by agent name with repeats counted, badges a rolled-up status from `chat.subagentStatus.*`, and renders a named field table led by the joined reports.
- A lifecycle row stays out of the topology and the subagent counts, the runtime's `delegationId` contract is untouched, and nothing but presentation moves.
See ADR 0062.

## 2026-08-28 — One delegation reads as a card, like a fan-out (D265)

- Decision D265 amends D201 / ADR 0062 in the renderer: that decision reserved the delegation card for two or more `Task` calls in one activity group, so the common single case lost the outcome, the recorded runtime, and the delegate's step count.
- Every `Task` call in an activity group now renders as a delegation card with a root node, a connector, and one node per delegate; the aggregate header, live-open-once rule, node disclosures, and print-the-report-once rule carry over unchanged.
- The aggregate header is count-aware: English gains `_one` forms and Chinese lets its single plural category carry every count, dropping the marker that made a one-node card read "1 个 Subagents".
- The card is still derived on live and reload from persisted `parentToolCallId` / `agentName` attribution, so no IPC, storage, host-protocol, or delegation-runtime change follows.
See ADR 0062.

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

- Decision D269 amends D108 / D261 / ADR 0130 in the renderer: D261 fed the minimap the mounted entries, which was right about dashes but left the outline silent about the history it hid, and D108 then removed the rail when the mounted tail had fewer than two markers.
- A bounded tail can be one tool-heavy turn below a viewport and a fetched page can land outside the window, neither necessarily changing `scrollTop`, while the only escalation trigger was a native scroll event.
- The outline now stays while earlier history exists — `hiddenAbove > 0` or `hasMoreBefore` — with one dotted earlier-history continuation at its top that runs the same grow-then-fetch path, disables and labels itself while loading, and never claims a message preview.
- Progress also rides the transcript's existing top loading row: while it stays inside the near-top band after an underfilled tail, a withheld page, or a window transition, escalation continues, and once no earlier history remains D108's two-marker-plus-overflow rule applies again.
See ADR 0130.

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

- Decision D274 amends D137 in the renderer: confirming a valid user-prompt edit always dispatches the existing edit-resend/Regenerate path, even when the trimmed text is identical to the original.
- The inline controls read Retry and Cancel in the active locale; Retry keeps the revision archive, identity-based truncation, slash-command expansion, and attachment behavior, while Cancel and Escape leave the prompt untouched.
- Renderer and i18n only, with no IPC, storage, host-protocol, or runtime contract change.
See ADR 0135.

## 2026-08-31 — Preserve the active task boundary across context compaction (D275)

- Decision D275 amends D203 / ADR 0064 in the agent runtime: checkpoints persist an opaque `details.retainedTailMode` boundary.
- While a provider must continue an active tool turn, the checkpoint retains only the latest user message within the existing 20,000-token limit; at a completed turn boundary, before a new prompt, or for manual compaction it retains no naked historical user messages, because the summary is authoritative.
- Legacy checkpoints without the mode normalize to their latest user message, and the visible transcript, host-owned storage, and protocol shape are unchanged.
See ADR 0136.

## 2026-08-31 — A visited session keeps its own mounted pane (D276)

- Decision D276 amends D162 and ADR 0130 clauses 4–5: the chat surface mounts one pane per recently visited session, bounded to three, so switching is a visibility swap instead of re-pointing one transcript at different data.
- A warm switch reveals the destination pane with its own scroll position on the first frame; a cold switch keeps the current pane fully legible under the thin progress track with the composer inert, and the opacity dim is gone.
- First activation settles at the newest turn, a revisit restores that pane's offset, and hidden panes keep their layout box, stay inert, and perform no follow scrolling, pagination, or measurement.
- Renderer only: no IPC, storage, host-protocol, or runtime contract change.
See ADR 0137.

## 2026-08-31 — Concurrent subagents may message each other directly (D277)

- Decision D277 extends D201 / ADR 0062 / ADR 0089 without amending them: one opt-in tool, `Peer(action=...)`, gives concurrent delegates a session-scoped mailbox with `send`, `inbox`, and `wait` operations, the three that ADR 0140 folded from the original `PeerSend` / `PeerInbox` / `PeerWait`.
- It exists because the parent writes every brief before any delegate starts, the path lock prevents a torn write but not a stale premise, and relaying notes through a parent blocked in `TaskWait` would spend the context delegation exists to protect.
- Opt-in and default-off: no builtin declares `Peer`, addressing is by agent name with the sender bound at spawn, the tool is built per delegate and stays out of the session catalog, a definition declaring only `Peer` is refused at `Task` time, and messages stay in-process with no `permissionScope`, host-core call, or tool budget.
- Bounds are 2,000 characters, 64 inbox messages with loss reported, 60 sends per run, and a 120-second wait below the 300-second idle watchdog, with destructive draining; peer traffic never enters the parent's context, no cross-session, parent, nested, or durable channel exists, and no `AgentEventEnvelope` field is added.
See ADR 0138 and ADR 0140.

## 2026-09-01 — Subagent model selection (D278)

- Decision D278 extends D201 / ADR 0062 / ADR 0089: `Task` gains an optional `model` (`"provider/modelId"`) that overrides the definition's frontmatter pin, resolving Task.model → definition pin → session model, while `ModelBinding.availableForSubagents` (default false) opts a binding into the delegation catalog injected into the parent's prompt.
- A model that is unconfigured or not opted in returns a tool error listing the available models, an exact repeat of the session model counts as inheritance, and models not pre-resolved at launch resolve on demand through `provider.resolveSubagentModel`.
- Per the 2026-09-13 clarification, `subagentProviders` may hold definition-only pins and is not an override allowlist: additive `subagentModelKeys` carries opt-in, defaults empty, joins runtime reuse, authorized on-demand results use a separate cache, and only unique provider ids match.
- Per the 2026-09-15 clarification for issue #386, the opt-in gates every entry point that picks a delegated model, so a spawn naming a non-opted `modelKey` is refused with `PERMISSION_DENIED` before a worker exists, while `models.list` reports a flag only Electron main treats as authoritative.
See ADR `subagent-model-opt-in`.

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

- The expanded sidebar owns a persisted preferred width clamped to `240..520px` with a `275px` default, previewed by a right-edge renderer handle from the pointer-down position, reflowing MainChat continuously, and saved only on pointer release.
- The handle is a vertical ARIA separator: Left and Right adjust by 16px, Home and End select the bounds, keyboard changes commit immediately, and Escape, pointer cancellation, lost ownership, or unmount rolls a gesture back to its starting width.
- Collapse stays independent of the preferred expanded width, and no IPC, native-window bounds, work-panel reservation, or project/session order contract changes.
- D408 later pinned the live shell at 275px and hid the handle, and D459 / ADR 0290 restores the resizable handle and adds collapse below 160px.
See ADR 0141.

## 2026-09-01 — Non-loopback HTTP MCP endpoints are supported (D281)

- User-owned and plugin-declared MCP servers accept absolute `http://` and `https://` URLs, trusted LAN addresses included, while unsupported schemes and malformed URLs stay invalid.
- The user MCP editor warns about unencrypted non-loopback HTTP, and plugin-declared endpoints still need `mcp.server.remote` plus a host covered by `manifest.net.domains`.
- The client disables automatic redirects, limits the chain to five hops, accepts only HTTP(S) targets, and re-checks plugin egress for every hop, blocking a redirect to an undeclared host before the next request.
- Marketplace catalog and package download rules are unchanged, so non-loopback HTTP package downloads are still refused.
See ADR 0142.

## 2026-09-01 — User-renamable task titles (D282)

- A task name is session metadata editable from the Sidebar session overflow/right-click menu or the Project archive task row, both opening one localized modal with focus management, Escape/Cancel dismissal, and a 1–80 code-point bound.
- The existing `session.rename` IPC/RPC path trims and validates at the host boundary, returning `INVALID_PARAMS` for blank or overlong values, and a successful rename updates only `sessions.title`.
- `updated_at`, transcript data, message count, project binding, empty-session state, and historical notification title snapshots are untouched, while a custom title still suppresses first-prompt generation and projects consistently after save and restart.
See ADR 0143.

## 2026-09-01 — User-configurable thinking-level overrides (D283)

- `ModelInfo` remains the raw models.dev record: an existing `ModelBinding` no longer overwrites published reasoning fields or capability tags, so a catalogued reasoning model stays visible as such.
- Settings always renders the seven canonical levels, published levels seed new known-model bindings, and unknown or catalogued non-reasoning models show the same choices unselected but explicitly enableable for a compatible endpoint.
- The exact binding owns effective thinking capability, its explicit levels survive save time and are used unchanged by Composer, main, and the sidecar, and empty or `off`-only bindings resolve to `off` with no automatic reasoning inference.
See ADR 0144.

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

- D285 extends D126 and ADR 0145: tag builds use `macos-15` for arm64 and `macos-15-intel` for Intel x64 beside the existing Windows x64 and Linux x64 lanes.
- The static macOS targets expose DMG and ZIP without a fixed architecture, each native runner passes the matching electron-builder flag and builds the Rust sidecar locally, and the workflow rejects a runner architecture that does not match its matrix entry.
- macOS updater feeds are renamed per architecture before upload and merged into one `latest-mac.yml` during publication, and macOS stays notify-and-link until a signed in-app channel is qualified.
See ADR 0145.

## 2026-09-02 — Work panel outer and inner resize ownership (D286)

- With the work panel open, the outer native right edge and right corners resize the panel target (`244..720px`) while preserving base conversation width, previewed and committed through an Electron-local event; left and other native edges keep resizing the base chat.
- The inner renderer divider resizes the base conversation width through the bounded `window/setWorkPanelChatWidth` channel (`1040..10000px`) with the panel reservation unchanged, serializing pointer updates and restoring the press-time target on cancellation.
- This is an Electron-local behavior change and the host protocol stays v9.
See ADR 0146.

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

- Application shortcut overrides have three states: an absent property uses the platform default, a valid portable binding string customizes it, and explicit JSON `null` means `Unbound` and dispatches nothing, with invalid strings keeping the safe default fallback.
- Settings exposes Disable separately from Restore default with a localized Unbound state, unbound actions stay out of conflict detection but remain editable, and the shared state drives renderer matching, macOS menu accelerators, and the global plugin launcher.
- Unbinding `openPluginLauncher` unregisters any prior global shortcut, disables the Windows host hook, and removes the focused-window fallback, while configurable native-role menu items become role-less so Electron cannot restore a default accelerator.
See ADR 0148.

## 2026-09-04 — Calm running status motion in the transcript (D290)

- The high-contrast text shimmer in the Working indicator and live activity labels is replaced by static readable text plus compact markers: three staggered dots before streaming and one small pulse on active labels, while tool spinners and the assistant streaming rail keep their feedback.
- The pulse is compositor-friendly, capped at a one-second loop, and disabled under `prefers-reduced-motion`, leaving the status visible as static text and dots.
- No protocol, storage, or runtime behavior changes.
See ADR 0149.

## 2026-09-04 — Replace the empty-home mascot sprite with a calm inline agent mark (D291)

- The randomized raster pose atlas in the empty-home hero is replaced by a 100px inline SVG: a compact neutral agent, a thin orbit, and one signal point, with the core breathing slowly and the eyes blinking occasionally.
- The mark is deterministic and decorative; hover changes neither cadence nor geometry, and reduced motion freezes its CSS animation at the same size, placement, and semantic colors.
- No protocol, storage, or runtime behavior changes.
See ADR 0150.

## 2026-09-04 — Keep the work panel inside the fixed application window (D292)

- The work panel remains an in-flow right column: opening and collapsing animates flex allocation inside the existing client area instead of expanding or shrinking the native window.
- The renderer-owned inner divider adjusts the persisted `244..720px` panel width, while native window edges resize only the application window and never rewrite the panel preference; Escape, cancellation, and lost pointer capture restore the press-time width.
- `window/setWorkPanelReservation` is retained for compatibility but normalizes every valid request to `{ requested: 0, reserved: 0 }`, and the native Browser view still follows the renderer-measured panel rectangle.
See ADR 0151.

## 2026-09-04 — Play an eight-frame waving mascot on empty home (D293)

- The empty-home inline SVG agent mark is replaced by a processed eight-frame GIF in the same 100px slot, holding the idle frame briefly before the wave, with hover changing neither cadence nor geometry.
- Reduced motion swaps the GIF for the still first-frame PNG through CSS, and the mark stays decorative with no random selection, JavaScript timer, or hover state.
- No protocol, storage, or runtime behavior changes.
See ADR 0152.

## 2026-09-04 — Theme-specific empty-home mascot GIFs (D294)

- The single empty-home mascot GIF is replaced by dedicated light and dark eight-frame assets plus matching still PNGs, with CSS following `document.documentElement[data-theme]` and anything other than `light` taking the dark pair.
- Reduced motion still swaps to the active theme's first-frame PNG, and playback, hover, and the decorative role are unchanged.
- No protocol, storage, or runtime behavior changes.
See ADR 0152.

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
  behavior changes. Refines the Installed-tab clause of D169 and §3.4 of the UI
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

- Streaming replies are checkpointed to `sessions/<id>.inflight.json` every 1.5 s, so a quit, crash, or restart no longer loses text already watched.
- The file is transient: a final row, a clean turn end, or the boot sweep removes it or lands a leftover as `aborted`.
- Quit flushes and waits 2 s, and renderer Stop settles in memory instead of rewriting the transcript.

See ADR 0153, E2E-171.

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

- New Task awaited four host calls before leaving the old transcript, so the click felt stuck.
- Creating a session now clears the previous conversation on the first frame and inserts the durable row from the `session.create` summary, and keystrokes typed during create move onto it.
- Decision D305 amends D252 / ADR 0113 timing only.

See ADR 0154, E2E-011a / E2E-011d / E2E-011g.

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

- Four Zhipu URLs required guesswork, so the dialog now offers named presets for China and international API plus GLM Coding Plan, filling the name and locking the Base URL.
- Rows stay `openai_compatible` + `chat_completions`, and a matching URL or `vendorKey` sets `thinkingFormat: "zai"` and `zaiToolStream: true` because the stored id is a UUID.
- Decision D308 amends D024.

See ADR 0155, E2E-005D.

## 2026-09-05 — Add-provider common path is Service + key (D309)

- The form stacked five fields even though named endpoints know their name, URL, and format, so it now starts with Service and shows only Service, API key, and a host summary.
- Custom endpoint adds Name and Base URL, and OpenCode Go moves into the Service select. Decision D309 amends D308.

See ADR 0156, E2E-005 / E2E-005B.

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

- Language was three hard-coded cards; locales now ship from `@pi-desktop/i18n` (`en`, `zh-CN`, `tr`) with endonyms, and Auto still follows `app.getLocale()`.
- Language becomes a searchable picker while Theme keeps its cards, and plugin labels stay `en` + `zh-CN`. Decision D314 amends D073.

See ADR 0160, E2E-091.

## 2026-09-05 — Grep prefers a system `rg` when installed (D315)

- Grep stays the model-facing tool but uses a user-installed `rg` when one is on the process or login PATH.
- The result shape, budget, ordering, and ignore rules stay host-defined; `rg` runs with argv and null stdin, falling back to the in-process searcher. Decision D315 amends ADR 0057 / D195.

See ADR 0057, E2E-147.

## 2026-09-05 — Searchable theme picker (D316)

- Theme was three cards with plugin themes wrapped into the same grid, and now uses the Language picker's searchable form: System, Light, and Dark pinned above plugin themes.
- `AppSettings.theme` and the unavailable-plugin fallback to `system` are unchanged. Decision D316 amends ADR 0160.

See ADR 0161, E2E-091.

## 2026-09-05 — A2A addressing spans sessions on the same host (D318)

- Decision D318 amends ADR 0147: the same-host A2A broker keeps capability-token auth and durable tasks but lifts same-context-only discovery and send, so delegates in different open sessions coordinate.
- Peer ids become registry-unique, `a2a.task.event` / `a2a.push` carry `recipientContextId`, and task access follows membership; parents still cannot call `A2A`, and nothing nests.

See ADR 0162, E2E-165c.

## 2026-09-05 — Live/durable transcript merge keeps chronological order (D317)

- Revalidation used the bounded durable page as prefix and appended live rows after it, so a long session hid the just-sent prompt under old history.
- `mergeLiveSessionMessages` now stitches chronologically and prefers the durable copy on overlap. Decision D317 amends ADR 0120 / D261 / ADR 0137.

See ADR 0120 / ADR 0137, E2E-177.

## 2026-09-05 — Restore a missing sessions row from its transcript / outbox (D318)

- A vanished `sessions` row made `session.appendMessage` fail and froze the outbox, hiding hundreds of turns behind a reset transcript.
- Boot now restores every live JSONL whose row is missing, the append restores or inserts a stub, and delete drops outbox entries. Decision D318 amends ADR 0041 / D119.

See ADR 0041, E2E-178.

## 2026-09-05 — Parent agents collaborate across conversations (D321)

- Decision D321 amends ADR 0147 / ADR 0162: Agent-mode runtimes register a `kind: "parent"` A2A card for their lifetime and expose `A2A` as a core parent tool.
- Discovery and send are kind-scoped, and an idle session prepends inbound parent events to the next prompt instead of starting a turn.

See ADR 0164, E2E-165d.

## 2026-09-05 — Sent file references stay chips and open on click (D320)

- Chips serialized to full `@path` text in the bubble, so a placed node became a long path and scratch files were not clickable.
- The transcript now renders leaf-name chips, opening workspace HTML in the side browser and other allowed files through `pi-desktop/fs/open`. Decision D320 amends D209 / ADR 0070.

See ADR 0163, E2E-180.

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

- An idle switch reloaded the durable page and dropped assistant and tool rows still only in the renderer.
- `selectSession` now merges live rows for an idle session until the durable page holds every live id. Decision D324 amends D317 / ADR 0137.

See ADR 0137, E2E-183.

## 2026-09-05 — Parent A2A is always in the Agent catalog (D325)

- D321 registered the parent only after a successful broker mint, so a failed register left no `A2A` tool, and `ToolSearch` never lists core tools.
- Agent mode now puts `A2A` in the core catalog at construction and mints on first use. Decision D325 amends ADR 0164 / D321.

See ADR 0164, E2E-165d.

## 2026-09-05 — Withdraw A2A and Peer coordination (D326)

- The `Peer` mailbox (D277 / ADR 0138 / ADR 0140) and the host-core A2A stack (ADR 0147 / ADR 0162 / ADR 0164 / D318 / D321 / D325) are withdrawn.
- `A2A` and `Peer` are no longer tools or `ToolSearch` results; handshake moves 10→11, and storage 12→13 drops the A2A tables. Decision D326 is ADR 0165, superseding ADR 0147, ADR 0162, and ADR 0164.

See ADR 0165, E2E-165.

## 2026-09-06 — Completed replies survive process restart (D327)

- Closing the app after a turn reloaded only prompts, because assistant rows still waited in the outbox that D324 kept only in memory.
- `message_end` now checkpoints the snapshot before that append, and the handshake awaits the drain. Decision D327 amends D299 / ADR 0153 / ADR 0041.

See ADR 0153 / ADR 0041, E2E-171, E2E-184.

## 2026-09-06 — Parent-judged subagent lifetime (D328)

- The parent aborted unfinished delegates on `TaskWait` expiry, model close, and `agent_end`, with idle and duration watchdogs as a second kill.
- Decision D328 amends ADR 0089 / ADR 0119 / ADR 0129: no timers, no abort on parent idle, reports in the same turn, and only `TaskStop` or user Stop aborts.

See ADR 0166, E2E-155.

## 2026-09-06 — Agent-chosen Bash timeout (D329)

- The 300-second ceiling killed long builds and rejected explicit `timeout: 600` / `1800`; the 60-second default stands.
- Decision D329 amends D190 / D273 / ADR 0054: honour 1–21,600 seconds and read larger values as milliseconds.

See ADR 0167, E2E-115.

## 2026-09-06 — Main-owned openExternal allowlist (D330)

- Chat markdown, plugin panels, the launcher, OAuth, and the preview could hand any URL to `shell.openExternal`, reaching OS handlers for `file:`, `javascript:`, or custom schemes.
- Main now opens only http(s) with a hostname and `mailto:` with an address, throwing otherwise. Decision D330 amends ADR 0109.

See ADR 0168, E2E-185.

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

- The Files plugin could not preview images, lost its Open action, and missed project, theme, and locale events while docked.
- `fs.readPreview` now classifies one file as text, image, binary, or tooLarge under the existing `fs.read` gate, and `workspace:changed` reaches docked panels. Decision D332 is ADR 0169.

See ADR 0169, E2E-153.

## 2026-09-06 — Work-panel browser is the bundled `pi.browser` plugin (D333)

- The Browser launcher, chrome, and agent CDP were a host-built row, while Files had proved a bundled plugin can own a first-party surface.
- Bundled `pi.browser` now owns chrome and the `Browser` tool, with the guest view and debugger host-owned behind `pi.browser.*` gated by `browser.cdp` and raw CDP allowlisted. Decision D333 amends ADR 0019 / 0104 / 0105 / 0108.

See ADR 0170, E2E-008b.

## 2026-09-07 — Contained in-chat image display (D334)

- Images are extension-less `attachments/<sha256>` blobs the renderer origin cannot load, so history showed a chip instead of the picture.
- `fs/read`, `fs/reveal`, and `fs/open` now share `resolveOpenablePath`, and `fs/readImageDataUrl` returns a bounded data URL. Decision D334 is ADR 0172.

See ADR 0172, E2E-187.

## 2026-09-07 — Host-owned plugin completions and session context (D336)

- Plugins could register tools but not list models, read the LLM context, or spend the user's quota on a side call.
- `pi.models.list`, `pi.session.getLlmContext`, and `pi.agent.complete` are host APIs with credentials kept in main, and context binds to the in-flight session (D019 amended). Decision D336 is ADR 0174.

See ADR 0174, E2E-188 / E2E-189.

## 2026-09-07 — OpenCode Go session routing headers (D337)

- OpenCode Go rejects requests without `x-opencode-session`, which pi-ai 0.85 never emits.
- Decision D337 amends ADR 0116: agent-runtime sends that header, `x-opencode-client: pi-desktop`, and a PI-Desktop `User-Agent` to OpenCode Go and `opencode.ai` hosts, keyed by the durable conversation id.

See ADR 0116, E2E-005D.

## 2026-09-07 — Explain quiet active turns with live agent activity status (D338)

- A provider wait, retry backoff, or delegated-work wait explained nothing, so users could only infer activity from Stop.
- The `status` event now carries a runtime-owned `AgentActivity` phase (`starting`, `waiting-model`, `retrying`, `waiting-subagents`) rendered as one compact localized row. Decision D338 is ADR 0175.

See ADR 0175, E2E-008c / E2E-094.

## 2026-09-07 — Per-provider User-Agent override (D339)

- Every adapter stamps a different User-Agent, Codex overwrites it, and the schema listed `headers` without storing them.
- Decision D339 lets a service row store optional `config_json.userAgent` as the last-writer header on its own outbound HTTP, Advanced UI only and included in `matches()`.

See ADR 0176, E2E-005G.

## 2026-09-08 — Per-provider custom HTTP headers (D341)

- ADR 0176 left the schema `headers` map unimplemented behind a sparse single-field editor.
- Decision D341 stores optional `config_json.headers` as last-writer on the row's HTTP, migrates a leftover `userAgent` into `headers["User-Agent"]`, and rejects reserved auth and hop-by-hop keys.

See ADR 0178, E2E-005G.

## 2026-09-08 — User-configurable outbound proxy (D340)

- Four HTTP stacks each ignored the OS proxy, so no product setting could route model calls, downloads, updates, or the browser.
- Settings → General → Network adds System / Direct / Custom shared by Chromium, `net.fetch`, sidecar undici, and marketplace curl, and workspace Bash inherits no credentials. Decision D340 is ADR 0177.

See ADR 0177, E2E-190.

## 2026-09-08 — Main-owned picker capabilities (D344)

- The picker returned absolute paths the renderer could replay, and advertised folders the importer rejected.
- Picker IPC now keeps chosen paths in main behind a short-lived, sender-bound one-shot token, and import accepts only that token. Decision D344 is ADR 0181.

See ADR 0181, E2E-102h.

## 2026-09-08 — Custom global UI type scale (D343)

- The `--text-*` ramp is a frozen relative set, and window zoom would leave two type sizes in one window.
- Appearance adds Tall / Grande / Venti / Trenta presets and an 80%–150% slider persisted as `AppSettings.fontScale`, setting `--font-scale` for text and icons. Decision D343 is ADR 0180.

See ADR 0180, E2E-193.

## 2026-09-08 — P0 international shell locales (D346)

- Decision D346 ships German, Spanish, and French shell catalogs with native names, regional base-locale resolution, and matching changelogs.
- `AppSettings.language` gains `de`, `es`, and `fr` without a protocol, schema, or IPC version change.

See ADR 0183, E2E-091.

## 2026-09-08 — Composer-docked context usage inspector (D347)

- The inspector hung under the newest assistant turn and scrolled out of reach, so its single entry moves beside the model picker rather than duplicating the numbers.
- Decision D347 docks it in the composer toolbar, mirroring the last usage-bearing turn, with no inner section rules (D297).

See ADR 0184, E2E-060d.

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

## 2026-09-08 — Session title summaries and focus-aware native task notifications (historical title decision superseded by D652; D350 remains active)

- The first prompt showed a 48-character fallback, and after one turn Electron ran a main-owned `session/summarizeTitle` one-shot that the renderer persisted through `session.rename`; D652 / ADR 0323 removed that and made titles an optional plugin.
- Task alerts are suppressed while the window is visible and focused, interactive prompts keep exact-visible-session suppression, and durable insertion stays D117's visibility decision.

See ADR 0186 / ADR 0187, E2E-021a / E2E-065.

## 2026-09-08 — Preserve distinct credentials during model configuration import (D351)

- CC Switch can hold several named profiles at one gateway, and endpoint-only matching skipped the ones with different keys.
- Import equivalence now includes the credential, so those profiles become independent providers while unchanged ones stay idempotently skipped, and keys stay behind the host secret boundary. Decision D351 amends D342 and ADR 0179 as ADR 0188.

See ADR 0188, E2E-209.

## 2026-09-08 — Parent fatal error aborts leftover delegates (D352)

- D328 kept delegates alive after parent idle, yet a terminal parent 429 closed the durable turn while a subagent on another model stayed `isRunning`.
- Decision D352 amends D328 / ADR 0166: parent idle is unchanged, a terminal parent error aborts leftovers, skips the resume prompt, and keeps the failed card.

See ADR 0189, E2E-155.

## 2026-09-09 — Disambiguate Intel macOS release artifacts (D353)

- Version-only installer names made the Intel download easy to confuse with the arm64 one.
- Decision D353 amends D285 / ADR 0145: the x64 lane publishes `-Intel.dmg` and `-Intel-mac.zip` with its feed keeping those URLs and checksums, while arm64 keeps the generic names.

See ADR 0145, E2E-092.

## 2026-09-09 — Label both macOS release architectures (D354)

- D353 used `-Intel` only for x64 and left arm64 generic, so the name still did not identify its architecture.
- Decision D354 amends D353 / ADR 0145: both lanes publish `-arm64` or `-x64` DMG and ZIP suffixes, with the per-architecture feeds keeping the URLs.

See ADR 0145, E2E-092.

## 2026-09-09 — Last-request occupancy in the context inspector (D355)

- The inspector mixed last-message occupancy with a visual-turn sum, so cache read plus turn total could exceed the window after a tool loop.
- Decision D355 amends D103 / D184 / D244 / D347 / ADR 0047 / ADR 0103 / ADR 0184: every count and cache figure reads the last usage-bearing assistant message, with `reasoningTokens` never added again because `output` already contains it.

See ADR 0193, E2E-060d.

## 2026-09-09 — Optional subagent thinking override and readable selected levels (D356)

- The subagent editor now offers inherit-session, do-not-send (`thinkingLevel: omit`), and the seven canonical levels.
- `omit` keeps bookkeeping at `off` but uses the low-level provider stream, and selected thinking chips get an accent/inverted state. Decision D356 is ADR 0194.

See ADR 0194, E2E-203.

## 2026-09-09 — Viewport-fixed work panel toggle (D357)

- Decision D357 amends D128 / D207 / D221 and ADR 0068 / ADR 0085: AppShell owns one viewport-fixed toggle at the top-right of every non-Settings route, the pointer equivalent of `Cmd/Ctrl + J`.
- It is the sole panel-level collapse control, the header keeps resource close only, and no IPC or native menu command is added.

See ADR 0195, E2E-056 / E2E-070.

## 2026-09-09 — Windows portable exe without installer (D364)

- Installer-only Windows releases blocked environments that whitelist a single executable.
- Decision D364 amends D120 / D126 / ADR 0022: the x64 lane adds `PI-Desktop-Portable-<version>.exe` with notify-and-link updates and no `latest.yml`, keeping the existing data directory and user execution level.

See ADR 0197, E2E-211.

## 2026-09-22 — Trust the network endpoints the user enters themselves (D604)

- An endpoint the user typed themselves may resolve to loopback or private ranges, and plain `http` there is usable.
- One switch decides it: `settings.networkPolicy.mode`, `relaxed` by default otherwise `strict`, replacing the per-surface acknowledgements and migrating a stored `allowInsecureUserEndpoints: false`.
- Third-party content keeps the public-only policy, cloud metadata and reserved addresses stay refused, and the proxy bypass list gains the private ranges.

See ADR 0304.

## 2026-09-22 — Windows portable delivery uses a normal ZIP (D603)

- Decision D603 amends D364 / ADR 0022 / ADR 0197: the x64 lane publishes a `PI-Desktop-Portable-<version>.zip` stamped `piDistribution = "zip"` and writes no `latest.yml`.
- Users extract and run `PI-Desktop.exe`, keeping notify-and-link updates while the updater still recognizes `PORTABLE_EXECUTABLE_FILE`.

See ADR 0197, E2E-211.

## 2026-09-09 — Name every quiet interval on the live activity row (D365)

- ADR 0175 named only three phases, so compaction, silent-turn recovery, the post-tool gap, and `starting` still looked like a stuck generic wait.
- Decision D365 amends D338 / ADR 0175: `AgentActivity` adds `preparing`, `compacting`, and `recovering`, and `waiting-subagents` carries a live child snapshot without restoring a capsule.

> D366 is unassigned. It was first used for the plugin session import decision,
> which was renumbered to D367 / ADR 0200 while syncing with `main`, and then
> for a docs-deploy-only-from-releases decision (with ADR 0199) that was
> reverted on 2026-09-09. Both D366 and ADR 0199 stay retired; do not reuse
> them. D376 is likewise unassigned: `main` renumbered the remote-control
> amendment it briefly carried to D374 and assigned D375 to the rollout
> sequence, so D376 stays retired too.

See ADR 0198, E2E-008c / E2E-094.

## 2026-09-09 — Host-owned plugin session import and ownership API (D367)

- External-history plugins need durable import and ownership, and the in-flight context read plus core `session.import` are not safe boundaries.
- Decision D367 / ADR 0200 adds `pi.session` import, batch, list, get, messages, rename, and delete behind `contributes.sessionSources`, with host-generated ids and `(pluginId, source, externalId)` scoping; schema v14 adds `session_import_origins`.

See ADR 0200, E2E-214/E2E-215.

## 2026-09-09 — Explicit plugin project ids and host-owned session refresh (D368)

- Plugins needed explicit project membership without changing the user's active workspace, plus a host-owned refresh path.
- Decision D368 / ADR 0201 adds `pi.project.create({ path })`, accepts an existing `projectId` in imports, and emits `pi-desktop/session/event/changed` after writes so the renderer can refresh.

See ADR 0201, E2E-216.

## 2026-09-09 — Effective subagent thinking metadata (D369)

- Cards need the level actually passed to each child, not one re-derived after the model clamps it.
- Decision D369 / ADR 0202 adds effective `modelId` and `thinkingLevel` to `Task`, `SubagentRunResult`, and lifecycle snapshots, shown as the raw non-`off` level; D395 / ADR 0221 removes canonical translation.

See ADR 0202, E2E-219.

## 2026-09-09 — Explicit unsigned macOS first-launch helper (D371; amended by D406)

- An unsigned build can still be blocked by quarantine with a misleading damaged-app message, and the old `xattr -cr` note was terminal-only and too broad.
- Decision D371 / ADR 0204 ships `PI-Desktop-macOS-open.command` in a visible DMG first-launch row, which verifies `com.pi-desktop.app` and clears only `com.apple.quarantine`, never using `sudo`.

See ADR 0204, E2E-196b.

## 2026-09-09 — Local MCP control plane for desktop operations (D370)

- An external Agent needs to drive the desktop while the deferred remote Gateway boundary stays unchanged.
- Decision D370 / ADR 0203 adds an opt-in loopback Streamable HTTP MCP server in main with a bearer token, Origin checks, a mode-restricted manifest, and the same IPC handlers the renderer uses.

See ADR 0203, E2E-220.

## 2026-09-10 — Tighten the local MCP control-plane boundary (D372)

- D370's catalog still exposed native pickers, secret-write paths, and an unconfirmed `session/configure`, and read session reads as mutations.
- Decision D372 amends ADR 0203 by narrowing the v1 catalog, stripping secret-shaped arguments, negotiating protocol versions, and bounding results.

See ADR 0203, E2E-220.

## 2026-09-10 — Remote Agent Control uses a dedicated Host boundary (D373)

- Remote control must not expose Electron IPC, `host.proxy`, or the host-core stdio boundary.
- Decision D373 / ADR 0205 defines a logical Agent Host owning sessions, turns, cursors, approvals, and recovery, with a Gateway owning identity and the Host connecting outbound; RACP v1 keeps one operation model across WebSocket, HTTP/SSE, and gRPC.

See ADR 0205, E2E-221 through E2E-230.

## 2026-09-10 — Amend the remote Agent Control target before implementation (D374)

- Review found the remote approvals narrower than the local vocabulary, pending permissions held as connection state, and three bindings beyond v1.
- Decision D374 amends ADR 0205: `RACP-WS` is normative with HTTP as the browser profile, typebox is the single contract source, and `packages/agent-host` is the first deliverable.
- Cursors become `{ epoch, sequence }`, the turn queue moves into the Host, approvals keep the full vocabulary under a default `ask` ceiling, and deployment is single-tenant.

See ADR 0205, E2E-221 through E2E-230.

## 2026-09-10 — Sequence remote control around recorded demand (D375)

- Issues #176 and #140 ask for remote project operation over SSH and #100 for chat notifications, while no one asked for a browser client.
- Decision D375 amends ADR 0205 again: R2 is the SSH-tunnel remote Host with a checksummed `pi-host` bundle, port forward, and unchanged renderer, gaining the remote-host profile and tool relay, and R3 becomes outbound messaging with webhook first.

See ADR 0205, E2E-231 / E2E-232.

## 2026-09-10 — Remote control stays user-local: no first-party identity (D385)

- The maintainer requires that no client authenticate through a service the project operates.
- Decision D385 amends ADR 0205 a third time and withdraws D375 item 10: the only credential is a Host-issued device token, any Gateway is user-hosted, and OIDC federation is out of scope.

See ADR 0205.

## 2026-09-10 — Persist the Host-owned turn queue in host-core (D386)

- D375 left the Host owning queued prompts, so persistence needs host-core's SQLite and a store that never starts work by itself.
- Decision D386 / ADR 0213 adds schema v15 `turn_queue` with `queuePush`, `queueList`, `queueRemove`, and `queuePrioritize`: idempotent, capped at eight, and drained only after a terminal event.

See ADR 0213.

## 2026-09-10 — Trusted extensions run in the Agent sidecar (D387)

- Plugins are sandboxed outside the agent, leaving no surface for in-process tools, per-turn hooks, and commands with session context.
- Decision D387 / ADR 0214 adopts the `pi-coding-agent` `ExtensionAPI` in the sidecar, disabled until enabled per entry, with D007 intact and unsupported members inert rather than throwing.

See ADR 0214, E2E-241 to E2E-245.

## 2026-09-10 — Extend provider retries and show bounded progress (D378)

- The retry budgets surfaced short outages too early, and the active row showed only a retry number with no wait or bound.
- Decision D378 amends D245 / D259 and ADR 0091 / ADR 0128: ten retries per error class, nested retries off, an 8-second cap, and a countdown with the attempt bound.

See ADR 0206, E2E-096 / E2E-149.

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

- Two counted failures ended a prompt while the model was still applying a distinct recovery hint.
- Decision D379 amends D186 and ADR 0087 / ADR 0207: three counted failures per prompt, then `terminate: true` with `MUTATION_RETRY_BUDGET_EXHAUSTED`, which also covers shell patch commands.

See ADR 0207, E2E-140 / E2E-141.

## 2026-09-10 — Plugin desktop control requires native user consent (D377)

- A plugin holding `desktop.control` could run `dangerous` operations with no human in the loop, and the review also found redirect escapes and uncontained plugin paths.
- Decision D377 (ADR 0208) requires the plugin's `confirm: true` and then the user's answer to a host-owned native dialog naming only the operation, with `PERMISSION_DENIED` on refusal; the MCP contract (D372) is unchanged and the fetch, path, denylist, and unknown-session holes are closed.

See ADR 0208, E2E-234 through E2E-238.

## 2026-09-10 — PowerShell 7 as a selectable Windows command shell (D381)

- PowerShell 7 installs beside the in-box 5.1, so no catalog entry could run `Bash` under `pwsh.exe` (issue #151).
- Decision D381 (ADR 0209) adds the `windows-pwsh` id, amending ADR 0054 §1: it resolves `%ProgramFiles%\\PowerShell\\7\\pwsh.exe` then PATH, and is never selected implicitly.

See ADR 0209, E2E-112.

## 2026-09-10 — A settled subagent reads back why it failed (D382)

- A failed delegate showed only a capsule and elapsed time, because the roster error had no reader.
- Decision D382 collects `error: { code, message }` from the lifecycle rows and closes the dock with an error card that never appears on a completed run.

See ADR 0089, E2E-198.

## 2026-09-10 — A delegate can declare its own output limit (D383)

- Definitions could bound turns but not response length without raising `maxTokens` for every caller of the model.
- Decision D383 (ADR 0210) lets a definition declare `maxTokens` under the `maxTurns` spellings with a 200000 ceiling, stored in frontmatter and shown in the Advanced disclosure.

See ADR 0210, E2E-119 / E2E-155.

## 2026-09-10 — Plan-safe plugin actions and summon-window shortcut (D384)

*(the summon-window half is superseded by D438, which replaced the pair, and by
D439, which moved the toggle off the macOS close-window chord; the plan-safe
plugin-action opt-in below stays)*

- Plan and Goal modes could not invoke plugin tools at all, even read-only actions like fetching a URL through the bundled Browser plugin.
- Decision D384 amends ADR 0052 / ADR 0053 with a per-action `planSafeActions` opt-in that the runtime, host, and desktop runner all enforce; the bundled Browser plugin declares four read-only actions, and the catalog also gained `summonWindow` beside `closeWindow`.

See ADR 0211, E2E-PLAN-005.

## 2026-09-17 — One window toggle replaces the summon/close pair (#360, D438)

- Issue #360 item 3 asks for one key, so D438 supersedes exactly the summon/close half of D384, skips D435 and D437 claimed elsewhere, and leaves the plan-safe opt-in intact.
- The catalog ships `toggleWindow`, whose action hides a visible window or shows it without reaching the close-behaviour prompt, and `migrateKeybindingOverrides` folds retired `closeWindow` / `summonWindow` values in both processes; D439 later moved the default off `Mod+W`.

See ADR 0211 (amended), E2E-072.

## 2026-09-17 — The window toggle avoids the macOS close-window chord (#360, D439)

- A process-wide accelerator cannot default to `Mod+W`, because macOS owns that chord in every other application.
- Decision D439 puts `toggleWindow` on `Alt+Shift+W`, refuses `Mod+W` to plugins, and drops a stored value that only repeats a superseded default while real rebinds and explicit unbinds survive.
- The numbering skips D435 and D437: this log still carries two D438 entries, and the later Git-checkout one needs to move to D440, which this entry does not rewrite.

See ADR 0211 (amended again), E2E-072.

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

- D387 shipped its own registry, settings tab, and enablement store, while the maintainer wants one surface where a pi extension is installed, enabled, and scoped like a plugin.
- Decision D388 / ADR 0215 amends D387: modules are `contributes.agentExtensions` gated by the high-risk `agent.extension`, and the standalone registry, store, Settings destination, and its channels are removed.

See ADR 0215, E2E-241 to E2E-245.

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

- Retry, regenerate, and edit-resend shipped a whole transcript over one NDJSON line, exceeding the 64 MiB stdin cap and racing the 130 s deadline on an 80 MB session (issue #211).
- `session.truncateFrom` now cuts, aborts the leftover turn, and archives the discarded branch inside one host call, and an oversized control-pipe line answers `LIMIT_EXCEEDED` instead of killing the reader. Decision D390 is recorded as ADR 0216.

See ADR 0216, E2E-246.

## 2026-09-11 — Host stdout sender must not outlive serve

- ADR 0216 was not enough on Windows: the Alt+Space hook held a strong stdout sender, so the writer never stopped after stdin ended and Electron timed out.
- The hook now holds a weak sender, serve waits at most 5 s, and Electron rejects request lines over 64 MiB. Decision D391 is recorded as ADR 0217.

See ADR 0217, E2E-247.

## 2026-09-11 — Selection overlay for quotes (D-LOCAL-selection-overlay)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- A non-empty selection inside one transcript row floated one overlay above it, clamped into its clipping ancestors and following the thread as it scrolled.
- It offered Add to chat under D-LOCAL-message-quotes's quote contract, Ask in side chat, and Copy, and every action shared one DOM-based excerpt recovery for formulas, code fences, and table rows.

See ADR message-quotes-and-side-chats, E2E-CHAT-selection-markdown.

## 2026-09-11 — Response annotations as prompt attachments (D-LOCAL-response-annotations)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- Selecting text in an assistant turn attached a numbered annotation as renderer-owned session state, never persisted or sent alone.
- A send composed a `# Response annotations:` block and consumed it, leaving the draft, optimistic row, and edit seed clean, so D209's smart Stop and D301's draft retention were untouched.
- Later amendments added a comment editor and the floating index, while D-LOCAL-message-quotes's draft quote still covered user quotes.

See ADR response-annotations, E2E-CHAT-annotation-attachments.

## 2026-09-11 — Right panel uses a tab strip and data-driven add menu (D399)

- Issue #229 replaces the resource menu with a scrollable header tab strip using ARIA tab semantics, plus a fixed `+` trigger that only scrolls its own group.
- The menu has one Tools & panels group fed by `contributes.views` and shared with the New launcher, and the viewport-fixed toggle stays the sole collapse control. Decision D399 is ADR 0224.

See ADR 0224, E2E-056.

## 2026-09-11 — Reserve chat width for composer controls (D401)

- MainPane keeps a 515px minimum when the sidebar or work panel resizes, and the composer toolbar stays on one non-shrinking row with ellipsized mode and permission labels.
- Decision D401 is ADR 0226, and D408 supersedes that floor with a 450px MainChat minimum.

See ADR 0226, E2E-168.

## 2026-09-11 — Long-press the project title to reorder (D402)

- Retained project groups lost their reorder grip: a 400 ms still press on the title arms a pointer reorder, and travel beyond 8px before that cancels it so a click still selects.
- Release inserts before or after the target from the pointer's midpoint, and arrow keys stay the keyboard path.
- Decision D402 amends D399 / D093 / ADR 0227. See ADR 0228, E2E-253.

## 2026-09-11 — Press-and-move project title reorder (D403)

- Mouse and pen reorder by pressing the title and moving 8px, while a click with no movement still selects, and touch never starts a reorder so the list scrolls.
- An accent insertion line shows before or after the target. Decision D403 amends D402 / D093 / ADR 0228. See ADR 0229, E2E-253.

## 2026-09-11 — Skill ships with the Agent core tool set (D404)

- `Skill` joins the Agent-mode core set, so its schema is present on the first provider request whenever the catalog is non-empty and it never appears under on-demand tools.
- Registration is unchanged: no catalog means no tool, Plan and Goal still omit it, and `ToolSearch` stays lazy. Decision D404 amends D174 / D185 / ADR 0048 / ADR 0219.

See ADR 0230, E2E-254.

## 2026-09-11 — Ideographic comma opens the slash menu (D405)

- A `、` committed as the first character of an empty draft is rewritten to `/` before trigger detection, so a Chinese IME reaches the slash menu without switching.
- Only that position is rewritten; later `、` stays punctuation and the `@` menu is unaffected. Decision D405 amends D123 / D139 / ADR 0024.

See ADR 0231, E2E-255.

## 2026-09-12 — Keep macOS DMG opening guidance text-only (D406)

- macOS DMGs now expose only `PI-Desktop-macOS-opening-help.txt`, labelled `If app won't open, read this.txt`, and no longer ship the executable helper.
- ZIP packages keep both, since the note carries the narrow Terminal fallback trusted unsigned builds need. Decision D406 amends D371 / ADR 0204.

See ADR 0232, E2E-196b.

## 2026-09-12 — Restore archived projects after session import (D407)

- An import that adds a new project-bound session now clears the renderer's archived presentation state for that normalized path during the import refresh (issue #250).
- Pathless sessions, skipped imports, and ordinary refreshes preserve archive state, and the host model and contracts stay unchanged.

See ADR 0236, E2E-257.

## 2026-09-13 — Prioritize MainChat in the three-column shell (D408)

- The in-flow shell gives MainChat a hard 450px minimum, caps the panel by the live budget, and yields the expanded sidebar at the threshold while its exit animation still counts.
- A manual reopen spends panel width first and otherwise targets 460px, and closing the panel restores only a sidebar the layout collapsed. Decision D408 records issue #267.

See ADR 0238, E2E-LAYOUT-three-column-width-priority.

## 2026-09-13 — Host-owned session collaboration messages (D409)

- Host-core now owns a durable ledger for plugin-mediated messages between real Session IDs, binding each delivery to its target turn and deriving the result from that turn's terminal state.
- The gateway authenticates the source from the active tool invocation, provenance is immutable across regeneration, and completion callbacks are durable and at-most-once.
- Decision D409 amends ADR 0237, ADR 0165, and ADR 0213.

See ADR 0239, E2E-PLUGIN-session-orchestrator-real-workers.

## 2026-09-13 — Independent session discovery and navigable collaboration projections (D410)

- The plugin gateway exposes a bounded `session/collaboration/list` over non-deleted Agent sessions without project paths, credentials, transcripts, or previews.
- Sidebar summaries carry readable provider and model labels plus bounded creator and created-session references, rendered as focusable navigation that opens through the existing selection path.
- Decision D410 amends ADR 0239.

See ADR 0240, E2E-SESSION-independent-top-level-communication.

## 2026-09-12 — Steer the active turn with Alt+Enter

- Normal Send stays a Host-owned follow-up, while Alt+Enter submits to the current durable turn under a required expected turn id.
- It reuses pi-agent-core steering at the next model-request boundary, keeps started tools and configuration, and rejects Stop or ended targets instead of redirecting the input.

### Unified transcript reading and complete search navigation

[ADR transcript-reading-ownership](/adr/transcript-reading-ownership) amends [ADR session-content-search](/adr/session-content-search) with one renderer reading view shared by MainChat and the subagent dock, keeping live caches canonical and rejecting interrupted pages.

See ADR active-turn-steering, E2E-AGENT-alt-enter-steers-active-turn.

## 2026-09-13 — Harden session collaboration navigation and delivery

- Collaboration references carry `available`, so a deleted session renders as text, opening it reports a visible error, and a delivery record survives its sender's deletion.
- The six `session/collaboration/*` operations are first-party-plugin-only and excluded from the MCP-visible catalog, amending the "same reviewed operation catalog" claim of ADR 0203 / D370.
- Settlement now asserts the `queued` to `running` claim, and Electron no longer drops one recorded before a restart.

### Global sidebar conversation pins (issue #306)

[ADR global-sidebar-pins](/adr/global-sidebar-pins) amends ADR 0016 so pins occupy one global section above standalone and project history, with archive visibility and sorting still applying.

See ADR 0239, ADR 0240, E2E-SESSION-hover-card-model-and-links.

## 2026-09-13 — Vendor the file view as an updatable plugin (issue #304)

- The work panel's file view is now a vendored copy of the third-party `pi.file-manager` release, shipped from `apps/desktop/resources/plugins/` with its own `UPSTREAM.md`.
- Bundled means default and non-removable, not frozen: a marketplace update survives the next launch, a strictly newer shipped build still wins, and `uninstall` refuses by shipped ID rather than row source.
- Editing writes stay inside the plugin's own jail, and the host gateway cannot mediate or declare a whole-tree write.

See ADR 0241 (supersedes ADR 0105), ADR 0104, E2E-153.

## 2026-09-14 — Delta-only coalesced streaming updates (D412)

- Append-only `message_update` frames now carry `stream: "delta"` and only the new chunk, while retry replacements still send a full snapshot.
- A 16 ms coalescer concatenates pending deltas and flushes before tool, terminal, retry, and error events, and checkpoints reconstruct the snapshot from the same deltas.
- Protocol stays v11. See ADR 0242, E2E-STREAM-long-turn-keeps-realtime.

## 2026-09-13 — Skill market public-HTTPS catalog fetch (D413)

- Skill Market search and fetch run in Electron main while the renderer CSP still forbids the network, installing through the existing `skills.create`.
- The shared syntactic classifier plus a main-side DNS and per-redirect re-check guard the boundary, and previews over 128 KiB are not written. See ADR 0243.

## 2026-09-14 — Harden the MCP market public-network boundary (D414)

- Market source and catalog endpoints accept credentials-free public HTTPS only, rejecting loopback, private, CGNAT, link-local, multicast, reserved, documentation, benchmark, ULA, and site-local ranges.
- Main resolves each hostname just before the request and pins the public address to the socket, following at most five checked redirects, with bounded responses and caches.
- Manual user-owned MCP configuration keeps ADR 0142's local and LAN policy. See ADR 0245, E2E-MCP-MARKET-*.

## 2026-09-14 — Opt-in subagent inheritance of the parent tool catalog (D415)

- A subagent definition may declare `tools: inherit`, alone or with assignable extras, while builtins stay on today's whitelist.
- At spawn the runtime unions the live catalog minus Task*, mode switches, `asktool`, `new_context`, and `ToolSearch`, and children cannot mutate parent runtime state.

### Tray session shortcuts (issue #293)

[ADR tray-session-shortcuts](/adr/tray-session-shortcuts) amends the D216 native tray menu with Running, Unread, and Pinned groups bounded to nine rows in priority order.

See ADR 0246, E2E-SUBAGENT-inherit-parent-tools.

## 2026-09-14 — Preserve local annotation and side-chat contracts across upstream integration

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

- Local ADRs took semantic names (`message-quotes-and-side-chats`, `response-annotations`, `floating-annotation-index`) because local 0223–0225 collided with upstream, and local D398–D400 references use `D-LOCAL-*` with E2E-249–259 as `E2E-CHAT-*`.
- Upstream transcript, composer, store, delta, work-panel, and Alt+Enter modules stay canonical, with quote and side-chat surfaces as renderer-owned additions at those seams.

See ADR response-annotations, E2E-CHAT-annotation-ack-and-steering.

## 2026-09-14 — Native Pi session continuation (D421)

- Native Pi v3 sessions are discovered as source-discriminated projections and continued through the coding-agent SDK against their original JSONL.
- Host-core stays authoritative for Desktop storage, and exact version, cwd, and lease checks make uncertain ownership fail closed. Decision D421 is ADR 0254.

See ADR 0254, E2E-SESSION-native-pi-*.

## 2026-09-14 — Git clone accepts only syntactically public hosts (D416)

- Home Clone still accepts https/http/ssh and `git@host:path` remotes without embedded passwords or `file:` URLs, and classifies hosts with the shared `isPublicHostname`.
- Private and loopback literals fail in the parser, while Git's own DNS and SSH stay unchanged with no Main pin. See ADR 0247.

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

- `contributes.themes[].assets` declares package-relative images and fonts under a whitelist and 4 MB budget, rewritten to `plugin-asset://` and served through a privileged host scheme, with every existing refusal intact and `ui.theme` unchanged.
- `contributes.windowAppearance.backgroundColor` applies off macOS under the new `ui.window.appearance` grant and is re-derived rather than stored, and built-in themes read one shared table so both paths cannot drift.

See ADR 0248, E2E-024J.

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

- Every record now carries a stable dot-separated `event` with top-level correlation fields, and one tool call emits one completion or failure record.
- Central logging redacts credential formats, sensitive keys, and local paths, bounds values, and caps `data` at 8 KiB, keeping result summaries instead of raw arguments or output. See ADR 0250.

## 2026-09-15 — Deleting a project removes its owned sessions (D421)

- `projects.remove({ path })` removes the durable project row, its sessions, their files, and project memory, never the folder on disk, and answers `removed: false` for an unknown path.
- Deletion also clears the renderer-local recent record and refuses a multi-folder group root or a project with a running turn (1008 / `CONFLICT`), and it stays out of `CONTROL_OPERATION_SPECS`.

See ADR 0251, E2E-PROJECT-delete-removes-project-and-owned-sessions.

## 2026-09-13 — Host turn-end event for plugins (D422)

- `session:turnEnded` reaches plugin processes and views with `{ sessionId, turnId, reason }`, once per turn actually started, announced at the end of teardown.
- The finalizer requires an explicit `turnId` and keys by `(sessionId, turnId)`, so a repeat settles nothing; the event has no permission, ack, or replay guarantee. Decision D422 is ADR 0252.

See ADR 0252.

## 2026-09-15 — Remove the subagent turn limit (D423)

- `maxTurns` was the last definition-level kill switch, and a parent that cannot see the delegate's work cannot size it.
- Decision D423 removes the field from the definition, parser, records, registry, built-ins, presets, and editor, and drops the `truncated` status; an existing document keeps loading with the key ignored like any unknown key.
- No protocol, schema, or storage change. See ADR 0253, E2E-155.

## 2026-09-15 — Theme assets are absolute paths (D422)

- Package-relative assets forced a copy inside the package, which a watched development plugin reloaded, closing its own panel.
- `normalizeThemeAssetPath` now accepts absolute paths only, and `pi.themes.upsert` registers assets for as long as the plugin stays loaded while the whitelist, budget, and revocation are unchanged.

See ADR 0255.

## 2026-09-15 — DeepSeek reasoning across compaction (D424)

- OpenCode and third-party DeepSeek relays reject empty `reasoning_*` echoes after compaction drops thinking, while official `deepseek.com` accepts them.
- Decision D424 amends D389 / ADR 0136: retained thinking is replayed after the summary, and non-official rows set `requiresNonEmptyReasoningReplay` so the patch fills a documented placeholder.

See ADR 0256, E2E-005E.

## 2026-09-15 — Plugin real-time capabilities (D425)

- Plugins gain host-mediated background audio capture and playback, system-wide accelerators, and real-time connections, exchanging typed frames instead of device handles or sockets.
- `keyboard.globalShortcut` and `net.websocket` ship here and refuse conflicts rather than taking a chord over, while the two audio permissions answer a coded `UNSUPPORTED` until the device service lands.

See ADR 0257, E2E-PLUGIN-global-shortcut-owns-only-its-own-command.

## 2026-09-15 — Trusted extension custom agents (D426)

- A trusted extension may register bounded model metadata plus a `stream` or `complete` callback and own its endpoint and authentication, with the sidecar exposing a redacted registry and routing idle `setModel` through the host-owned `session.configure`.
- The host never receives or persists plugin transport credentials, and `registerProvider` remains a compatibility alias. Decision D426 is ADR 0258.

See ADR 0258.

## 2026-09-15 — Plugin-declared providers are Host-owned rows (D427)

- `contributes.providers` entries become Host-owned provider rows (`providers.owner_plugin_id`, schema v17), re-read on every load and authoritative for their fields, behind the high-risk `provider.register` permission.
- Dropping an entry deletes the row and both credential references, and `providers.update` / `providers.delete` refuse with `PROVIDER_OWNED_BY_PLUGIN`; D647 amends the OAuth exclusion with `provider.oauth`.

See ADR 0259, ADR 0320.

## 2026-09-15 — Side chats materialize on first Send (#421)

*(Retired by ADR 0268 on 2026-09-16: the feature and its surfaces were removed, and these IDs stay retired and must not be reused. The record is kept for history.)*

Side-chat opening and selection quote prefill were renderer-only drafts: the first nonempty Send created the anchored child, deduplicating concurrent submissions and keeping failed drafts, while closing an unsent draft created no history.

See ADR 0268, [message quotes and side chats](../../adr/message-quotes-and-side-chats.md), E2E-CHAT-side-chat-fork.

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

- "Send now" promotes an entry to `MAX(priority) + 1` in its session (schema v18), so promotions keep click order above the waiting queue, and promoting twice is `CONFLICT`.
- The row gains move up, move down, and edit through `session.queueReorder`, editing returns the captured draft, and a promoted row stays locked until delivery.
- A promoted block ships as adjacent user messages, and a settled turn closes the queue so "Send now, then Stop" cannot stall it.

See ADR 0265, E2E-QUEUE-promote-orders-delivery-by-click.

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

- The menus refused Delete project with a transient warning and returned before `ProjectDeleteDialog` mounted, so a project with one live task could not be deleted at all (#360).
- Both menus now always open the dialog with the live running ids, and confirming aborts exactly those sessions before `deleteProject`; the host 1008 / `CONFLICT` guard and the `project.deleteRunningBlocked` fallback are unchanged.

See ADR 0251, D421, E2E-PROJECT-delete-running-sessions-are-named-and-stopped.

## 2026-09-16 — Plugin `workspace` fs roots follow the calling session (D432)

- Every `workspace`-rooted `pi.fs.*` call resolved the window-global workspace, so a tool invoked from another session read the wrong project, or failed for all sessions when none was visible (D093 never reached plugins).
- `plugin-runtime.ts` now resolves the invoking session's project through `getWorkspacePathForSession`, while panel calls keep the visible workspace and the permission, containment, and consent gates are unchanged.

See ADR 0266, E2E-PLUGIN-fs-root-follows-the-calling-session.

## 2026-09-16 — Quotes, annotations, and side chats are removed (ADR 0268)

- Quote, the selection overlay, response annotations, and renderer-owned side chats are removed everywhere, while Copy, Edit, Delete, Fork, Retry, Regenerate, drafts, and chips stay.
- Sends no longer compose a `# Response annotations:` block, so a stored prompt shows exactly as it was stored in the transcript, edit seed, and queue preview.
- `D-LOCAL-message-quotes`, `D-LOCAL-selection-overlay`, `D-LOCAL-response-annotations`, `D-native-sidechat-stream`, and the `E2E-CHAT-*` scenarios stay retired and never reusable, with no protocol, schema, or IPC change.

See ADR 0268.

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

- Builtins were read-only rows, so one delegate could not be turned off: copying and disabling left the shipped definition in the catalog, because disabled user documents are filtered out before the loader merges.
- Every Built-in row now carries the switch, stored in `subagent-builtins.json` and exposed through `agents.disabledBuiltins` / `agents.setBuiltinEnabled`, and a switched-off builtin keeps a dimmed row.

See ADR 0270, E2E-SUBAGENT-settings-lists-builtin-defaults.

## 2026-09-17 — Judge a public-network address on the route the request will dial (D436)

- The market guard classified hosts with a local resolver while `net.fetch` dials through Chromium's proxy stack (ADR 0177), so a TUN or fake-IP resolver made every source look blocked (issue #419).
- Each hop now asks `Session.resolveProxy`: a `proxied` route tolerates only benchmark placeholders, while `direct` and `unknown` stay strict, and the MCP market keeps its pinned guard on direct hops.
- Refusals carry the route. See ADR 0272, ADR 0245, E2E-SKILL-MARKET-NET-BOUNDARY.

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

- The Create project dialog collected only a name and folders (ADR 0233), so a fresh installation had to open an unrelated folder before cloning.
- It now offers two equal sources, This computer and Git repository, parsing URLs with the switcher's rules so private, loopback, or credential-bearing remotes keep Create disabled (ADR 0247).
- Main adds `project/cloneCheckout({ url, parentPath })` without touching the active workspace, and both sources still write one project group.

See ADR 0273, E2E-258.

## 2026-09-16 — Draggable chat content width (D439)

- The conversation band, empty-home stack, and composer share one preferred max width, default 760px and persisted as `AppSettings.chatContentMaxWidth`, changed together by dual edge handles with a 560px drag floor.
- Used width stays `min(pane minus 24px gutters, preferred)`, so a squeezed panel compresses the band without rewriting the preference, and the collapsed-sidebar ceiling is gone.

See ADR 0277, E2E-208.

## 2026-09-17 — Session and project rows delete on the second click (D441)

- **Amended 2026-10-09**: project menus now always open `ProjectDeleteDialog` and Close becomes Archive, so only the dialog's confirm deletes while session deletion keeps its two-click arm.
- `hooks/use-armed-delete.ts` owns one 3200 ms arm keyed on `session.id` or a `project:` prefix, cleared by an outside press, Escape, or expiry, and a live-turn project still routes through the dialog.
- The number is D441 because D438 was claimed twice — by the window-toggle merge (#360, with the D439 rebind) and the Git checkout that moves to D440.

See ADR 0273, D421, D431, E2E-PROJECT-delete-removes-project-and-owned-sessions.

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

- D447 replaces the one-sentence enhancement prompt with a built-in structured
  system prompt and a user-owned template carrying `{{draft}}`.
- The template override lives in `AppSettings`; a blank value or the exact
  default text clears it, so later default improvements still reach users.
- The rewrite runs on its own provider, model, and reasoning level (default
  `off`), clamped and 60s-bounded; `prompt/enhance` is unchanged.

See ADR 0121.

## 2026-09-19 — Restore resizable sidebar width with collapse-below-threshold (D459)

- D459 amends D408 / ADR 0238 and restores ADR 0141: the expanded sidebar is
  again a renderer-owned `240px..520px` column (default `275px`) with a
  previewing right-edge handle and keyboard resize.
- A pointer width below `160px` collapses it without overwriting the preferred
  width; Escape, cancellation, lost capture, and unmount restore the press-time
  width.
- The live maximum is the three-column remainder, so a chosen width does not
  trip D408's yield; renderer only.

See ADR 0290.

## 2026-09-19 — MCP catalogs are bounded by protocol guards, not truncated (D452)

- D452 amends D176: the per-server `tools/list` bound stops truncating silently
  at 64 tools and 8 pages.
- Pagination is followed to the last page under Codex-parity guards (2048 tools,
  100 pages, a repeated cursor, 30s), and a server breaking one loses its
  handshake.
- `plugin.mcp.tools.truncated` is gone; the refusal is audited and reaches the
  user as the server's status message.

See ADR 0038.

## 2026-09-19 — The Voice settings card is removed (ADR 0291)

- Settings → AI no longer carries a speech section: the Voice card, its search
  keywords, styles, catalog keys, and the withdrawn Composer speech copy are
  gone.
- The host capability stays: `speech/*` methods, `AppSettings.speech` validation,
  both built-in protocols, and `speech.adapter.register`.
- This repairs the docs for the Composer entry point ADR 0281 item 5 described;
  no stored binding or IPC, schema, or permission changes.

See ADR 0291.

## 2026-09-19 — SSH bootstrap for remote hosts (D453)

- D453 installs and pairs a `pi-host` over the system `ssh` client, so config,
  agent, and jump hosts apply unchanged and the app holds no SSH secret.
- The bundle is resolved at the desktop's version and its published SHA-256
  verified, so no executable bytes cross the channel.
- The script runs under `umask 077`, the token stays in a work file, a mismatch is
  `HOST_VERSION_MISMATCH` (D375), and a paired host stores a descriptor.

See ADR 0292.

## 2026-09-19 — SSH password authentication for the bootstrap (D454)

- D454 lets a password replace a key per host, opt-in: with no password the argv
  and every other behaviour are unchanged.
- The secret reaches `ssh` through OpenSSH's askpass helper, never as an argument
  or environment value, and its material is deleted once no child can prompt.
- `BatchMode=no` with one password prompt applies only to such a target; the
  secret is stored encrypted through the OS keychain and never reaches the
  renderer.

See ADR 0293.

## 2026-09-20 — Project archive is a list + inspector (D455)

- D455 revises D267's expanding rows: the archive keeps its intro and toolbar,
  and the list becomes compact rows with a full-width inspector under the
  selection.
- Clicking selects and keeps Settings open; double-click, Enter, or Open
  activates the project and returns to chat, while archive and close keep the
  destination open (D133).
- Folders, batched chats, and the menu live in the inspector; presentation only.

See ADR 0294.

## 2026-09-20 — Prompt-enhancement model card moves to Settings → AI

- This amends ADR 0121 and the 2026-09-18 D447 placement: the Enhancement prompt
  card moves from Settings → Models to Settings → AI below Prompt enhancement.
- The card keeps a title because the picker needs heading, value, and control,
  and Settings search indexes those rows on the AI tab.
- Presentation only: no IPC, storage, or host-protocol change.

See ADR 0121.

## 2026-09-20 — Prompt enhancement is one Settings → AI card

- Amend the same-day two-card placement: the Enhancement prompt card is folded
  into Prompt enhancement on Settings → AI. The custom-template switch, default
  model, and reasoning rows share one heading. Settings search still indexes
  `promptEnhancementModelTitle` so "增强提示词" finds the AI tab. Presentation
  only: no IPC, storage, or host-protocol change.

## 2026-09-20 — Session thinking-parameter omission (D456)

- D456 accepts `thinkingLevel: omit` beside the seven canonical levels in the
  Composer, session storage, and host validation.
- The parent stream takes the subagent omit path so adapters send no thinking
  field; explicit `off` still disables thinking.
- The Composer menu prepends `omit` when the model exposes canonical levels, and
  schema v19 rebuilds `sessions` so the CHECK allows it.

See ADR 0295.

## 2026-09-19 — Drain poison outbox entries; accept steering into a delivery turn (D597)

- D597 amends ADR 0041, ADR 0239, ADR active-turn-steering, and D444: a
  `PERMISSION_DENIED:` prefixed append is permanent, so the outbox drops the row
  and keeps draining.
- Substring matches such as `PLUGIN_PERMISSION_DENIED` and other host failures
  still pause, so one poison head cannot fill the cap.
- Steering into a claimed delivery turn is exempt from the delivery contract and
  has client `session_message` stripped.

See ADR 0041.

## 2026-09-20 — Project archive reads as an inset grouped card list

- This revises D455's presentation only: the index becomes an inset grouped card
  list, identity left and detail right, tiles separated by the row gap.
- The selected row is its own card header, so the detail repeats no name, path,
  or status tag, and one shared toggle closes it.
- Arrow keys walk the rendered order and move focus; no IPC, storage, or
  activation change.

See ADR 0294.

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

- D599 narrows D236: a development build runs under `PI-Desktop Dev` and reads
  `~/.pi-desktop-dev`, while a packaged installation keeps its two directories.
- The two never share one single-instance lock, `pi.sqlite`, outbox, or log tree;
  `PI_DESKTOP_DATA_DIR` still wins and is made absolute.
- No IPC channel, host protocol, storage schema, or packaged path changed.

See ADR 0094.

## 2026-09-20 — The app ships no fonts (D598)

- D598 amends D232 / ADR 0083: the four bundled families, their `woff2` files
  and licences, `styles/fonts.css`, the license badge, and the bundled picker
  group are gone.
- The Font picker keeps its shape: System default persists the empty string, and
  installed families come from Electron main.
- Generated stacks append the system-only CJK tier, a stored bundled stack
  survives under Saved, and no migration is required.

See ADR 0298.

## 2026-09-20 — Stdio MCP spawn uses the login-shell PATH (D600, issue #571)

- D600 fixes launches that inherit a minimal PATH, which left `uvx` and `npx`
  failing as `spawn … ENOENT` while a terminal worked.
- Electron main probes the login shell the way host-core already does for Bash
  (ADR 0045), 5s-bounded and cached, and merges the user bin directories that
  exist.
- Windows stays on the inherited PATH, and a missing executable reads
  `command not found: <name>`.

See ADR 0045.

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

- D609 makes the Create project name optional for both sources, seeding it from
  the first folder or the repository name (D438 / ADR 0273) and stopping once
  the user types.
- Create is gated by the source alone and an empty field falls back to the
  derived name, cut to `MAX_PROJECT_NAME_CHARS` (80) for stored preferences.
- Renderer only: no protocol, storage, host, permission, or migration change.

See ADR 0233.

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

- D617 keeps the real recent window when an automatic compaction's summary
  fails: the newest contiguous messages, every role, bounded by the keep-recent
  target.
- The checkpoint marks it with `details.retainedTailShape`, so a rebuild replays
  it, while an unmarked checkpoint normalizes to the latest user message.
- A prompt still too large after one reduced pass is split into at most 16
  contiguous chunks, each carrying the previous summary (ADR 0049, ADR 0282).

See ADR 0302.

## 2026-09-20 — A copied formula is its TeX source (D619, issue #414)

- D619 makes a copy covering rendered math read the TeX back from the MathML
  `annotation`, as `$…$` inline or `$$…$$` on its own lines, delimiters widened
  past inner runs.
- Only formulas are rewritten; the rest is read back through
  `Selection.toString()`, since a hand-written walk would rewrite whitespace the
  platform gets right.
- One clipboard flavour, `text/plain`, so a rich target cannot show every
  formula twice; D619 rests on the clipboard ADR 0268 already relied on.

See ADR 0268.

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

- D621 folds the fullwidth block and the ideographic space onto ASCII, then
  requires HTAB, printable ASCII, or the Latin-1 supplement; NFKC is rejected.
- The fold runs on read as well as write, so an older stored value starts
  working; keys fold on both sides without being refused at save.
- The editor refuses and names the character, a stored map folds and drops, and
  a sync bundle folds first.

See ADR 0178.

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

## 2026-09-23 — Compact before the hard request budget (D623, issue #970)

- D623 starts automatic session and subagent compaction at 90% of the derived
  `hardLimit`, inline at the next request boundary.
- New prompts join the preflight estimate and tool results are measured before
  the follow-up request; `hardLimit` stays the boundary that never reaches the
  provider.
- The runtime stays inline-only, with no background summary, setting, or
  protocol change.

See ADR 0064.

## 2026-09-24 — Windows stdio MCP resolves official Node and fnm npx (D624, issue #789)

- D624 amends D176 and D600: `spawn` without a shell starts neither `npx` nor its
  `.cmd` shim, so Electron main resolves bare command names first.
- An official PATH `node.exe` wins, then fnm, nvm-windows, and Volta;
  `npx-cli.js` runs through `node` and other `.cmd` files through `cmd.exe`.
- Secrets still do not cross (D018) and names stay bare.

See ADR 0038.

## 2026-09-24 — The transcript occludes itself instead of the dock painting a band (D624, issue #728)

- The opaque `--ds-bg-primary` band added for issue #728 kept transcript rows
  from showing below the Composer, but it also covered whatever a contributed
  theme had drawn on the conversation pane. A theme that fills `.main-pane` or
  `.thread-scroll` (the theme studio's `main` / `thread` regions) got a
  hard-edged rectangle of the built-in workspace colour across the bottom of the
  chat. No theme region could reach that band: the only lever was
  `--ds-bg-primary` itself, which every other primary surface follows.
- `.composer-dock-docked` now paints nothing, and `.thread-scroll` masks its own
  content out with `linear-gradient(to bottom, #000 calc(100% -
  var(--composer-dock-height) - 16px), transparent calc(100% -
  var(--composer-dock-height) + 2px))`. The gradient resolves against the
  scrollport's own box, so it stays anchored to the pane while rows move through
  it. `- 16px` is exactly the trailing reserve `.thread-content` adds below the
  measured Composer height, so a transcript pinned to its end keeps its last row
  fully opaque and only the rows crossing the boundary fade.
- The mask belongs on the scroller rather than on `.thread-wrap`: the minimap
  rail, the jump-to-latest button, the settle veil, and the navigation status
  are `.thread-wrap` children that must stay fully painted. The dock's own
  stacked plates (`.asktool-card`, `.plan-approval-bar`, queued prompts, the
  shell) were already opaque and are siblings of `.thread-wrap`, so they are
  unaffected. The scrollport's last 18px of scrollbar now fades instead of being
  covered by the band.
- Renderer CSS and the theme surface regression change only. The theme surface
  probe pins the dock to fully transparent and asserts the mask tracks
  `--composer-dock-height`. There is no scroll state, protocol, persistence,
  theme schema, or permission change. See `04-ux/08-component-spec.md` and
  E2E-CHAT-opaque-floating-decision-and-retry-surfaces.

## 2026-09-25 — Model settings unify around one AI service list and a chosen-models summary (D625)

- D625 collapses model settings into one AI service list: API-key,
  plugin-declared, and vendor-subscription rows share it, and a row itself opens
  its editor.
- Adding starts on a searchable chooser whose custom endpoint comes last, then a
  two-view form with credential rows in `ProviderConnectionFields` (D310).
- Dialogs open on a chosen-models summary, a new service preselects recommended
  tool-capable models, and the D297 tone is kept.

See ADR 0098.

## 2026-09-25 — The custom endpoint leads the API-key group (D626)

- The service chooser listed its API-key tiles in the shared preset order and
  put the custom endpoint after all of them, so reaching one's own address
  meant scrolling past every named host first. The custom endpoint now leads
  the group instead: it is the one choice that needs nothing found before it,
  and the group still reads as "connect with an API key". The groups keep
  their order (subscriptions above API-key services), and the keyboard walk
  still enters the grid at its first tile.
- Covered by the updated `apps/desktop/test/service-chooser.test.mjs` and the
  `scripts/e2e/provider-api-style.tsx` probe, which now asserts that the first
  `[data-service-id]` tile is `custom` rather than the last.

## 2026-09-25 — Model settings open on the two panes, and the fallback list is complete (D627)

- Editing a service or a vendor account used to land on a chosen-models summary
  (`ChosenModelsSummary`) with the real picker one click away, so reaching a
  per-model control cost two decisions before it cost any work. Both dialogs now
  render the two panes (`ModelSelectionPanes`) straight away — the service's own
  list on the left, the models this credential will run on the right — and the
  summary plus its Manage models / Collapse pair are gone, along with the
  `autoPicked` hint that only the summary could show. Preselection is unchanged
  (`recommended-models.ts`, `useRecommendedModelSelection`); the panel simply
  states it where the picks are. A recommended model is a starting point, never
  the only thing on screen.
- The catalog stand-in for a service that publishes no model list is now the
  provider's published set as a whole (`modelsForProvider({ includeNonChat: true })`
  from the settings handler), so embedding, speech, image and reranking
  endpoints a key can call appear next to the chat models instead of silently
  missing. The default stays text-only, because session and agent paths ask for
  what they can actually run, and automatic preselection still filters to
  tool-capable chat models.
- Covered by the updated `apps/desktop/test/provider-form-layout.test.mjs`
  (both dialogs render the panes with no summary to fold),
  `apps/desktop/test/settings-general.test.mjs`,
  `apps/desktop/test/service-chooser.test.mjs` and the new
  `apps/desktop/test/provider-model-list-scope.test.mjs` (the default list is
  text-only, `includeNonChat` adds the hidden endpoints without dropping or
  duplicating an id), plus the `scripts/e2e/provider-api-style.tsx` and
  `scripts/e2e/image-generation-ui.tsx` probes, which no longer click Manage
  models.
## 2026-09-26 — User-selectable application update behavior (D628)

- Settings → Info now stores Automatic / Manual per installation. Supported
  installer builds default to Automatic; Windows ZIP/portable packages and
  packages without an automatic-install lane default to Manual. Choosing Manual
  disables automatic download and install-on-quit but keeps scheduled checks.
- Manual mode announces an available version once. Host settings remember the
  last reminded version across restarts; the renderer also suppresses a second
  banner after route remount. The Settings row remains available for checking
  status and opening the fixed Releases page.
- Windows ZIP/portable users may explicitly opt into Automatic only after a
  warning that the NSIS installer can replace the extracted copy. No database
  migration or host protocol version change is required.
- Covered by `apps/desktop/test/update-preference.test.mjs`, the updated
  `apps/desktop/test/auto-update.test.mjs`, and E2E-UPDATE-preference-and-once-only-reminder.

## 2026-09-26 — Bound aggregate image history without an arbitrary message cutoff (D629)

- D629 keeps the 10 MB per-image ceiling and adds a 30 MB aggregate budget per
  runtime rebuild, considering eligible refs newest-first.
- Images inside the budget stay provider blocks; older attachments fall back to
  a safe `@path`, and the current prompt row is excluded.
- The sidecar reads only admitted files, and durable host messages stay
  metadata-only.

See ADR 0101.

## 2026-09-27 — Routed model metadata uses conservative last-segment matching (D630, PR #1047)

- Supersede D622's broad catalog aliases for runtime enrichment. Compare only
  the case-insensitive final `/` segment, so a routed or gateway wire ID can
  reach a catalog row without treating arbitrary thinking, release-date,
  deployment-marker, or vendor-dash suffixes as model identity.
- When a leaf has multiple catalog candidates, select a unique official/source
  provider only when its provider family agrees with an explicit model source;
  otherwise borrow metadata only when all candidates expose identical
  capabilities and thinking metadata. If neither rule proves identity, leave
  the row unmatched. A known provider may still borrow the exact ID from other
  publishers; unknown providers do not use unanchored consensus or marker
  fallback.
- Composer keeps the complete configured wire ID on model rows. Unmatched
  models expose the canonical thinking ladder for manual opt-in, but start a
  new draft/session at `off` unless an explicit binding default exists. An
  empty binding level array is the generic unknown-model seed, not an explicit
  disable; a non-empty binding override remains authoritative. Known catalog
  matches retain the D303 binding-default/highest-enabled behavior.
- The change is metadata/UI projection only: it does not rewrite persisted wire
  IDs, provider identity, or host capability ownership. See
  `03-runtime/13-model-catalog-and-selection.md` §11.3 and
  `04-ux/08-component-spec.md` §11.

## 2026-09-27 — Agent workspace search is available from turn one (D631)

- D631 amends D185, D208, and ADR 0069's Agent activation boundary: `Glob` and
  `Grep` join `Read`, `Bash`, `Edit`, and `Write` in the first Agent request.
- Routine workspace discovery therefore no longer needs a `ToolSearch` round
  trip, while `BrowserPreview`, plugin tools, and plugin-development helpers stay
  deferred.
- ToolSearch, successful-activation restoration, host permissions, and the
  Plan/Goal tool sets are unchanged, as are the ADR 0048 and ADR 0230
  amendments.

See ADR 0069.

## 2026-09-27 — Composer recalls its own conversation's submissions with ArrowUp/ArrowDown (D632)

- The composer had no way to reuse what was just sent: repeating or tweaking an
  instruction meant retyping it or copying it back out of the transcript, even
  though a terminal, a shell history, and this app's own plugin launcher (D219)
  all keep recent input one keystroke away.
- The history belongs to the conversation. Recalling shows only the prompts
  accepted in the conversation on screen, so a draft never appears with another
  conversation's context and a deleted conversation's prompts cannot surface in a
  live one. Store shape: one renderer-local `localStorage` key
  (`pi.desktop.composerInputHistory`) holding bounded buckets newest-written
  first, 100 entries per conversation and 20 conversations, with consecutive
  duplicates collapsed. No schema, host, or IPC change.
- Scoping by conversation also settles attachments. Picked, pasted, and dropped
  files are copied into the sending session's scratch directory, and the image
  input loader accepts them only under the current project, the current session
  scratch, or `data_dir/attachments`; a recalled entry therefore always belongs
  to the session whose scratch root holds its files, so its chips and previews
  come back with its text and no "attachments were left behind" notice is
  needed. (An earlier shape of this change kept one global history and stripped
  attachments on a cross-session recall, which is why that notice and its i18n
  string existed; both are gone.)
- Recording happens only on an accepted submission. The four accept paths — a
  normal or steering prompt, a dispatched extension command, a dispatched
  builtin or palette command, and a mode command with a body — record the
  submitted draft under the submitting conversation; a blocked slash source, an
  unconfigured model, an empty draft, and a rejected send do not. A rejected send
  restores its draft exactly as before and leaves history untouched. The empty
  home composer has no session, so it recalls nothing. On acceptance,
  `sendPrompt` passes the actual target session ID to history recording; it is
  not inferred by rereading global `activeSessionId` after the asynchronous send.
  Thus a Home-first send that finishes after navigation remains in the session
  that the submission materialized.
- ArrowUp starts browsing only from an empty draft (no text and no references),
  which is what keeps the feature out of the way of a multi-line draft where the
  same key has to move the caret. Once browsing, ↑/↓ keep driving history —
  including through a recalled multi-line entry — until a user edit, a
  submission, or a conversation change (the draft key) ends browsing. IME
  composition and an open autocomplete menu are checked first, so ↑/↓ still cycle
  menu items and a confirming Enter during composition still commits text rather
  than sending it (D125).
- Storage is best-effort, matching `plugin-launcher-history.ts`: an unreadable
  store, malformed JSON, a row that fails validation, a payload in the earlier
  array shape, or a throwing `setItem` degrades to no history instead of failing
  a send.
- `composer-input-history.test.mjs` covers storage, per-conversation navigation,
  and the `sendPrompt` callback retaining the materialized session across a
  selection change. `pnpm test:e2e:composer-paste` mounts the production input,
  draft, history, and submit hooks in an Electron renderer; it checks keyboard
  navigation, session isolation, a rendered file chip, the delayed Home-send
  switch, and restoration from a second Electron process using the same test
  profile (E2E-COMPOSER-input-history-recall).

## 2026-09-27 — Completed turn-process disclosures fold by default (D633)

- D633 keeps Detailed mode opening the whole-process disclosure while a turn is
  active, and defaults untouched process details to closed once the turn settles.
- Explicit user choices remain authoritative, and search reveals plus actionable
  or error surfaces outside the process are unchanged.
- Renderer presentation only: no transcript, persistence, provider-thinking, or
  host behavior changes.

See ADR turn-process-and-thinking-display.

## 2026-09-27 — Remove bundled macOS first-launch guidance (D634)

- D634 amends D457 / ADR 0296 and supersedes ADR 0232 and ADR 0204 for macOS
  distribution: the DMG stays a two-icon install and the ZIP holds the app at
  its root.
- Neither ships an opening note or a quarantine-clearing helper, including for
  unsigned debug builds.
- Signing, notarization, stapling, and updater lanes are unchanged.

See ADR 0309.

## 2026-09-29 — Work-area-capped 800×560 window minimum (D635)

- D635 makes the window minimum 800×560 DIP and caps it to the display work
  area wherever Main sets it.
- The chat width accepts `800..10000px` from one shared floor, and the
  three-column budget still caps a docked panel so MainChat keeps 450px.
- This supersedes the 1040×700 minimum of D156 and D447 (and the matching
  ADR 0029 / ADR 0238 clauses) and ADR 0146's range; saved panel widths are not
  rewritten.

See ADR 0029.

## 2026-09-29 — Local permission approvals remain pending until resolved (D636)

- D636 amends D005 / ADR 0011: a permission-gated `tools.execute` request has
  no deadline,
  so host-core keeps it pending and the renderer keeps the inline card.
- Allow once, allow for session, deny, cancellation, and shutdown remain the
  settlement paths; no transport timer is installed.
- The request carries no `timeoutMs` and snapshots expose no `expiresAt`;
  command, plugin, Plan/Goal, and RACP budgets are unchanged.

See ADR 0310.

## 2026-09-29 — Remove the Windows frameless resize rim (D637)

- D637 disables Electron's thick frame on the Windows main window, removing the
  native rim while its frameless edge and corner hit test remain.
- The window defaults to the 12 DIP `--radius-md` native shape, a themed size may
  pick 0 to 24 DIP, and no resize path or geometry IPC is added.
- macOS, Linux, work-panel resize ownership, and D635's minimum stay in force.

See ADR 0317.

## 2026-10-01 — Publish native Linux arm64 artifacts (D638)

- D638 publishes Linux arm64 AppImage, deb, and rpm packages beside the x64 ones,
  each lane on a native Ubuntu 22.04 runner packing the sidecar it built.
- Targets stop pinning `arch`, so each lane passes its own flag, verifies
  `uname -m`, and names the AppImage by architecture, renaming the x64 asset.
- Each feed is named after its architecture, and `linux-arm64` joins
  `PUBLISHED_TARGETS` so an arm64 desktop can bootstrap a matching host (D375).

See ADR 0318.

## 2026-10-03 — User MCP tools keep the normal approval path (D640)

- D640 moves `mcp_` tools from `low` to `medium` risk in
  `PermissionManager`. Under `ask` and `accept-edits` every call shows the
  approval card with the reason "MCP server tool requires approval"; `auto`
  runs it without a card, and Plan/Goal deny it even with a session grant.
- Allow-session covers only the exact `mcp_<serverId>_<tool>` name in that
  session, not the server's other tools. Risk annotations the server declares
  about its own tools are not trusted and never lower the path.
- Dispatch over `plugins.execute`, read-only-mode handling and the `mcp_`
  namespace are unchanged. See ADR `mcp-tool-approval-risk` and
  E2E-MCP-tool-requires-approval.

## 2026-10-04 — Cloud sync is a public Experimental destination (D642)

- D642 removes the developer-mode and packaged-build gates from the Settings
  `sync` destination: its rail row, page, and settings-search hits are
  available to every user in every build, and a saved `sync` tab no longer
  falls back to General. Remote Hosts keeps both gates.
- The destination kept its Experimental badge on the rail row and page title
  at that time (amended by D643 and D649).
- Covered by `apps/desktop/test/settings-developer-only-destinations.test.mjs`
  and the Cloud sync probe in `pnpm test:e2e:settings-scroll`. See
  `04-ux/06-settings-ia.md` and E2E-CONFIG-SYNC-webdav-portable-configuration.

## 2026-10-04 — Cloud sync ships without an Experimental badge (D643)

- D643 amends D642: the Settings `sync` destination drops its
  `experimentalBadgeKey`, and `settings.configSync.experimental` is removed
  from every bundled locale. Cloud sync stays available to every user in
  every build (amended by D649).
- Remote Hosts keeps its own badge and both gates. Sync behavior, protocol,
  host schema, and persisted data are unchanged.
- Covered by the badge assertions in
  `apps/desktop/test/settings-developer-only-destinations.test.mjs` and
  `apps/desktop/test/config-sync-settings.test.mjs`, plus the Cloud sync probe
  in `pnpm test:e2e:settings-scroll`.

## 2026-10-04 — Instruction files sync without an instruction-specific byte cap (D644)

- D644 removes the 32 KiB per-file cap Host enforced on portable instruction
  files. A project `AGENTS.md` larger than that cap failed the whole capture
  with `CONFIG_SYNC_LIMIT_EXCEEDED: instruction file is too large`, which the
  settings page could only report as a generic backup-size error.
- Instruction content is now bounded only by the shared portable-entity payload
  bound Host checks when it uploads a revision and when it validates a remote
  one. UTF-8 validation, symlink rejection, scope selection, mapping, and
  approval rules are unchanged, and the agent-runtime prompt chain keeps its
  own read-side budget.
- Covered by
  `config_sync::domains::tests::captures_project_instruction_files_beyond_the_former_size_cap`
  and
  `config_sync::domains::tests::writes_imported_instruction_files_beyond_the_former_size_cap`
  in `crates/host-core/src/config_sync/domains.rs`.
## 2026-10-04 — External imports live with their Settings destination (D645)

- D645 removes the standalone Settings `import` destination: model
  configuration, external skills, and external MCP scans open inline from their
  own pages.
- Capability imports follow the selected global or project level, and project
  scans bind to the selected project.
- Settings no longer scans core sessions; plugins keep their import API, and no
  IPC, permission, protocol, or persistence contract changes.

See ADR 0319.

## 2026-10-04 — The empty home names the open project before its first session (D646)

- D646 fixes the empty home after opening a project. The hero title only named
  a project when a session on screen carried that project's path, so creating
  a project, or opening one whose sessions are all archived or unselected,
  left the generic "What can I help you build?" title and hid which project a
  task started there would join.
- The hero now falls back to the active workspace when no session is on
  screen. A session still decides when there is one, so a temporary session
  keeps its own copy and no project switcher, and with no project open the
  generic title stands. Session state, IPC, persistence, and the switcher's
  actions are unchanged.
- Covered by `apps/desktop/test/home-project-name.test.mjs`, which renders the
  real surface against the real store. See `04-ux/01-ui-ia.md`,
  `04-ux/08-component-spec.md`, and E2E-256.

## 2026-10-06 — Plugin providers can own OAuth sign-in through a scoped callback (D647)

- D647 amends ADR 0259: a plugin provider may declare `authKind: "oauth"` with
  `provider.register`, the `provider.oauth` grant, and an `onProviderOAuth`
  callback.
- The Host owns the login UI, encrypted storage, refresh serialization, and the
  auth resolver; the callback reads only its own credential.
- The runtime receives only an access token and the renderer none; sign-out
  clears the credential without deleting the declared row.

See ADR 0320.

## 2026-10-06 — Skill Market pins an acceptable address for mixed direct DNS answers (D648)

- D648 pins an acceptable address when a direct answer mixes acceptable and
  rejected ones, preferring a public third-party address with the `benchmark`
  opt-in as the only alternative.
- ULA-only results stay blocked, and proxied or unreadable routes keep the
  ADR 0272 policy.
- The pinned request preserves the hostname for SNI and `Host`, and every
  redirect is checked and pinned again.

See ADR 0321.

## 2026-10-07 — Cloud backup stays closed to users (D649)

- D649 amends D642 / D643: the Settings `sync` destination is
  development-build-only again. A packaged build omits its rail row, page, and
  settings-search hits, and a saved `sync` tab returns to General; development
  builds keep the destination, and developer mode still plays no part.
- The destination still carries no Experimental badge, and sync behavior,
  protocol, host schema, and persisted data are unchanged. Removing
  `developmentOnly: true` from the destination entry reopens it for packaged
  builds.
- Covered by `apps/desktop/test/settings-developer-only-destinations.test.mjs`
  and `apps/desktop/test/config-sync-settings.test.mjs`; the Cloud sync probe in
  `pnpm test:e2e:settings-scroll` runs a development build. See
  `04-ux/06-settings-ia.md` and E2E-CONFIG-SYNC-webdav-portable-configuration.

## 2026-10-08 — Plugin providers appear in Add Service (D650)

- ADR 0322 adds provider category and optional short-description metadata to a
  Host-rendered Add Service projection for unconfigured plugin API-key providers.
- Tiles show the name with its introduction on hover or focus, and there is no
  per-plugin cap.
- An empty model list discovers endpoint models after a key is saved; the key
  uses the existing secret path, and OAuth and no-auth declarations do not
  appear.

See ADR 0322.

## 2026-10-08 — Make session title generation a standalone plugin (D652)

- D652 makes title generation a standalone plugin: the core keeps only the
  deterministic first-prompt fallback (D654) and runs no completion.
- The `session.autoTitle` permission exposes bounded first-turn text and a
  compare-and-set update, and schema v23 tracks title ownership.
- The plugin owns its template, model, and thinking level, and manual rename wins
  any concurrent update.

See ADR 0323.

## 2026-10-08 — Transcript tool rows never auto-open (D651)

- D651 amends the leaf auto-open provision introduced with the turn-process
  disclosure: in both Detailed and Compact a tool-call, hosted-search or plan row
  keeps its payload collapsed until the user opens it, wherever it sits in the
  activity group. Whole-process and ordinary-group defaults, failed and denied
  behavior, per-item retained choices, and the thinking row's own leaf default are
  unchanged.
- Covered by `apps/desktop/test/interaction-performance.test.mjs`,
  `apps/desktop/test/thinking-ui.test.mjs`, and
  `apps/desktop/test/transcript-summary.test.mjs`; the unit test for the removed
  leaf-ownership helper is retired. See `04-ux/08-component-spec.md`
  §9.1/§9.2/§9.5, `04-ux/09-interaction-patterns.md` §4.2, ADR
  `turn-process-and-thinking-display`, and E2E-040.

## 2026-10-08 — Keep the deterministic first-prompt session title (D654)

- D654 restores the immediate label a new session used to get: the renderer
  collapses whitespace and caps the request at 48 characters.
- host-core writes it only for a recognized placeholder with the `default`
  source and keeps that source, so the plugin can still upgrade it.
- Placeholder recognition now covers every shipped locale, and a remote session
  derives on its own Host.

See ADR 0323.

## 2026-10-21 — Cloud sync opens in packaged builds as Experimental (D655)

- D655 amends D649: Settings → Cloud sync is available in packaged and
  development builds, with the Experimental badge on its navigation row and
  page title. Settings search includes the destination in both build types.
- Remote Hosts remains available in all builds and keeps its existing
  Experimental badges. Cloud sync behavior, protocol, Host schema, and
  persisted data are unchanged.
- Covered by `settings-developer-only-destinations.test.mjs`,
  `config-sync-settings.test.mjs`, and the packaged Settings acceptance
  scenario in E2E-CONFIG-SYNC-s3-portable-configuration. See
  `04-ux/06-settings-ia.md` and `03-runtime/22-config-sync.md`.

## 2026-10-11 — Quarantine appends the host keeps refusing (D656)

- D656 amends ADR 0041, D318, D444, and D597: an unclassifiable host failure
  retries on a bounded backoff and, after five consecutive failures, is
  quarantined.
- The append keeps its payload, session id, timestamp, and host error in a
  dead-letter file, is never replayed, and the flush keeps draining.
- The backoff compares the Host generation, `session.delete` drops quarantined
  appends with the queued ones, and only the newest 256 are retained.

See ADR 0041.

## 2026-10-13 — Open local files in the embedded Browser (D657)

- D657 amends ADR 0170: absolute paths and `file:` URLs may open any existing
  regular local file, and local pages may follow links to other local files.
- Relative paths stay workspace-rooted, and an HTTP(S) page cannot leave the
  workspace through a file link.
- `pi.browser.navigate` follows the same policy under `browser.cdp`, while
  `BrowserPreview` and the sidecar keep workspace-rooted validation.

See ADR 0328.

## 2026-10-13 — Session identity on endpoints the adapters leave anonymous (D658)

- Agent-runtime stamps a per-session identity onto requests bound for an endpoint
  the user pointed at themselves — a provider row whose base URL host is not a
  published vendor host — on the `openai-completions`, `anthropic-messages`,
  and `openai-responses` wire APIs. On Completions and Anthropic, the built model gains
  `compat.sendSessionAffinityHeaders` with
  `sessionAffinityFormat: "openai"`, so the adapter writes `x-session-affinity`
  and `x-client-request-id` beside `session_id`, and a Chat Completions payload
  that carries no `prompt_cache_key` gains the session id as one, clamped to the
  adapter's 64-character limit. A row's own `compat` still wins, and the key is
  added on a copy after every other payload hook.
- A custom Responses row keeps its existing `session_id`, `x-client-request-id`,
  and cache key, and also gets the stable `x-session-affinity` alias so reverse
  proxies that discard underscore headers can route the session.
- Identity reaches session turns, subagent turns, context-compaction summaries,
  and plugin one-shots handed a session id. A published vendor host (matched by
  host against `NAMED_ENDPOINT_PRESETS`), the OpenCode path's own
  `x-opencode-session`, and the Responses adapters' existing behavior on
  published vendor hosts keep their current request bytes, so no vendor's
  published caching semantics move; a caller with no session id gains no body
  key or `x-session-affinity` header.
- Covered by `packages/agent-runtime/src/session-affinity.test.ts` and
  E2E-PROVIDER-custom-endpoint-session-identity. See issue #1634,
  `03-runtime/02-agent-runtime.md` §6.3, and
  `03-runtime/11-provider-model-system.md`.

## 2026-10-14 — Composer file menu rows always show the full relative path (D660)

- D660 amends the `@` row contract: each row keeps the leaf name then the
  complete workspace-relative path in a de-emphasized mono span.
- The span takes the remaining width and ellipsizes before the leaf name can, so
  a short leaf never truncates and no row overflows.
- The tooltip keeps the full path and the accessible name becomes the path
  alone; reference chips (D209/D362, ADR 0024 / ADR 0070) and serialization are
  unchanged.

See ADR 0024.

## 2026-10-16 — Segmented turn process and independent thinking preference (D661)

- D661 supersedes the `Detailed` / `Compact` display-mode behavior and the single
  whole-process disclosure recorded by D633 / D651 and the
  `turn-process-and-thinking-display` ADR. A turn now renders as chronological
  collapsible process segments; the trailing answer, assistant errors, stopped
  trailing text, and pending action surfaces stay outside them.
- Bash and run aliases render as standalone rows outside every folded container —
  neither the turn-level process disclosure nor an ordinary activity group — and
  stay visible even when every group is collapsed. Adjacent Bash rows remain
  separate, and a Bash row's detail stays closed until the user opens it.
- Group folding defaults are unified and independent of the thinking preference:
  the active group opens and closes on completion only if untouched, other
  completed groups start closed, and an untouched active group with a recorded
  failed or denied tool stays open through later recovery.
- The preference is the optional boolean `AppSettings.showThinking`. When false,
  the live thinking indicator stays visible while completed thinking rows and
  excerpts are hidden and empty thinking-only containers are omitted; the stored
  reasoning is retained. Absent or non-boolean values fall back to the legacy
  `thinkingDisplayMode` field (`compact` hides, `detailed`/unknown/absent shows),
  which is retained only for persisted-settings compatibility and is no longer
  exposed in the UI.
- `showThinking` joins the portable application fields so it synchronizes like the
  legacy field; no other host protocol, persistence schema, permission, or plugin
  contract change. Covered by `apps/desktop/test/thinking-visibility.test.mjs` and
  the i18n catalog tests. See the amended ADR, `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`, and
  E2E-CHAT-turn-process-and-thinking-display.

## 2026-10-16 — Open scoped HTML files in the work-panel Browser from plugins (D662)

- D662 adds `pi.fs.openInBrowser(pathFromRoot)` under `fs.read`: Main applies the
  plugin's ordinary read gates and accepts existing HTML files only.
- Each call is audited, and Main then sends a dedicated event so the renderer
  opens the file in a Browser tab for the active local session.
- The Browser plugin must be enabled, and the action grants no CDP and exposes no
  controls.

See ADR 0330.

## 2026-10-17 — Composer mode control opens a menu instead of cycling (D663)

- The Composer-left Agent/Plan/Goal trigger keeps naming only the committed
  mode, at a fixed 96px that now includes its caret; clicking it opens one menu
  whose three rows are radio menu items with the committed mode checked.
  Choosing a row closes the menu and configures the active session.
- Cycling was replaced because reaching a specific mode took repeated clicks
  and never showed the alternatives. A row of three always-visible segmented
  options was implemented and dropped: it needed roughly 70px more toolbar
  width per extra state and crowded the approval control beside it.
- The approval chip keeps its existing fixed-width menu, and opening either
  menu closes the other. `nextMode` is removed. Covered by
  `apps/desktop/test/composer-mode-menu.test.mjs`,
  `apps/desktop/test/composer-chip-descenders.test.mjs`, and the composer
  slots and thinking contracts. See `04-ux/08-component-spec.md` §11 and
  US-UI-73.

## 2026-10-18 — Default sidebar running activity to the count badge (D664)

- When the three optional sidebar activity settings are absent, the master and
  Count badge resolve on while Activity rail resolves off. Explicitly saved
  values remain authoritative, and the master still gates both affordances
  without rewriting either child preference.
- The count keeps live work discoverable without making the animated rail a
  default. Settings reads apply these defaults through renderer API
  normalization; no persisted schema or migration change is required. See
  `04-ux/01-ui-ia.md`, `04-ux/06-settings-ia.md`, and E2E-266.

## 2026-10-16 — macOS paints an opaque native window surface (D665)

- D665 supersedes D348's macOS vibrancy over a transparent backing, where
  WindowServer recomposited every dirty frame and held an idle window near 40%
  GPU.
- macOS now paints the opaque background the other platforms use, keeping the
  `hiddenInset` titlebar and the renderer's sidebar tint.
- `window.setBackgroundColor` no longer returns early on darwin, so a granted
  theme background applies, and bounded idle animations stay in force (ADR 0248,
  ADR 0260).

See ADR 0332.

## 2026-10-20 — macOS translucency is a window setting (D666, amended by D667)

- D666 amends D665: macOS paints an opaque surface by default, and
  `AppSettings.macosWindowTranslucency` opts back into the vibrancy material.
- `macosWindowSurfaceOptions` is the single surface declaration, and
  `mainWindowBackgroundOptions("darwin", color)` keeps the opaque result.
- Electron fixes `transparent` at creation, so the preference is read before
  `new BrowserWindow` and the row shows a restart hint instead of mutating.

See ADR 0332.

## 2026-10-20 — macOS translucency stays the default (D667)

- D667 amends D665 and D666: the macOS window ships **translucent** again, with
  the `sidebar` material and a transparent backing, and the setting becomes the
  opt-out.
- Absent and `true` mean the material, only `false` paints the opaque surface,
  and the store defaults to translucent.
- A translucent window owns its pixels, so `applyMainWindowBackground` skips it;
  no migration is needed, and an explicit `false` keeps a chosen opaque surface.

See ADR 0332.

## 2026-10-21 — One process disclosure per turn, with three transcript display modes (D668)

- D668 amends D661 / the `turn-process-and-thinking-display` ADR: a turn now
  renders exactly one top-level process disclosure containing every pre-answer
  row. No run row is a sibling of that disclosure; the trailing answer, assistant
  errors, stopped trailing text, and pending action surfaces stay outside it.
- `AppSettings.transcriptDisplayMode` selects the layout. `flat` renders no
  nested activity groups and lists rows in transcript order. `command-first`
  keeps the groups but lifts `Bash`/run rows into standalone rows, with a normal
  progress message or a command ending a group. `fully-folded`, the default for
  absent or invalid values, keeps run rows inside their groups and lets only
  ordinary assistant progress text split them. The mode is read while rendering,
  so switching repaints immediately.
- With `showThinking` on, Thinking rows default expanded in `flat` and
  `command-first`; `fully-folded` keeps the released exception where only the
  last active row opens while it is live. With the preference off, no completed
  reasoning row renders and only a live whole-run TextShimmer `Thinking`
  indicator remains while reasoning streams.
- `keepCommandsExpanded` is deprecated and retained only for persisted-settings
  compatibility; it is no longer exposed or read for rendering. The disclosure
  header, left edge, and pane-owned disclosure memory are unchanged.
- Covered by `apps/desktop/test/turn-process.test.mjs`,
  `apps/desktop/test/transcript-display-modes-ui.test.mjs`,
  `apps/desktop/test/transcript-display-mode-settings.test.mjs`, and
  `apps/desktop/test/settings-roundtrip.test.mjs`. See the amended ADR,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, and
  E2E-CHAT-turn-process-and-thinking-display.

## 2026-10-19 — `@` queries search past a truncated file index (D669)

- The `fs/index` snapshot keeps the shallowest 8000 entries, and the menu
  fuzzy-filtered only that snapshot. In a large tree — a Unity project, where
  every asset has a `.meta` sibling — scripts several folders deep were never
  in it, so no query could reach them even though the truncation footnote
  invited refining the query (issue #1781).
- While the snapshot is truncated, a non-empty query is now also sent to
  `fs/search` after a 150 ms typing pause. Main ranks it with the renderer's
  scorer over the listing it already built for the index (`git ls-files`), or
  over a deeper ignore-set walk (at most 200,000 entries or two seconds) when
  the index came from the walk, and returns the best 50 rows. The menu merges
  them with its local matches; an answer for an earlier query is dropped.
- A complete index never searches, so small projects behave as before. The
  footnote stays while the list may be incomplete. Remote sessions keep their
  snapshot because the remote file protocol has no search operation. Bundling
  a native lister (ripgrep, bfs) was not needed: git already lists the whole
  repository, and searching 60,000 paths takes a few milliseconds.
- Covered by `packages/host-runtime/src/fs-index.test.ts` and
  `apps/desktop/test/composer-deep-file-search-user-path.test.mjs`. See
  `03-runtime/01-ipc-protocol.md` §13c, `04-ux/08-component-spec.md` §11.8,
  and E2E-COMPOSER-deep-file-mentions.

## 2026-10-22 — Keep small activity groups and reasoning visible after settlement (D670)

- D670 amends D661 / D668 and ADR `turn-process-and-thinking-display`: an
  ordinary activity group stays open while active; after completion, groups with
  at most four visible items remain open, larger ordinary groups start closed,
  and Task topology groups remain open. The whole-turn process still closes on
  completion by default.
- With `showThinking` on, all visible Thinking rows default expanded in Flat,
  Commands first, and Fully folded. Tool, search, and run-row payloads remain
  collapsed until the user opens them. Explicit disclosure choices remain
  authoritative; there is no protocol or persistence change.
- Issue #1806 reproduced the group and reasoning collapse at turn settlement.
  `pnpm test:e2e:transcript` covers active-to-completed groups, reasoning rows,
  and closed payloads. See `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, and
  E2E-CHAT-turn-process-and-thinking-display.

## 2026-10-22 — Inline generative UI visualizations (D671)

- Models explain dynamic systems, tunable parameters, and spatial relations
  better with a small interactive page than with prose or Mermaid, but the
  transcript renders Markdown only.
- Local sessions get `<data_dir>/visualizations/<sessionId>/`, a second
  contained root next to scratch (D114). Write/Edit accept only `.html`
  fragments there, without a permission prompt; the directory is removed with
  its session and orphan directories are swept at startup, never by age.
  Remote-workspace and contract sessions get neither the root nor the skill.
- A standalone `::visualize{"path":"…","title":"…"}` line outside code blocks
  becomes an inline card once the turn completes. Main serves the fragment
  through `pi-genui://session/<sessionId>/<file>` inside a host shell with a
  strict CSP (no network, no frames, no forms) and a sandboxed iframe
  (`allow-scripts` only); the URL is derived from the path suffix, so data-dir
  relocation does not break old references. Cards always load from the
  owning session; forks copy the fragments they reference. Theme and height
  travel by `postMessage`. WebRTC ICE is not blocked by Chromium yet and is a
  documented residual risk.
- The shell embeds a stylesheet and tooltip/tab runtime adapted from ZCode's
  Apache-2.0 visualize kit, plus offline D3 7.9.0 and Floating UI served from
  `pi-genui://assets` (pinned CDN URLs are rewritten; any other remote URL is
  blocked). The skill is a condensed adaptation of ZCode's.
- v1 has no widget state, follow-up messages, CDN access, icons, or tweak
  panel.
  See ADR `gen-ui-inline-visualization`, `03-runtime/03-tools-and-permissions.md`
  §4b.1, `03-runtime/04-data-storage.md`, and E2E-GENUI-inline-visualization-card.

## 2026-10-23 — Official DeepSeek endpoints send reasoning_effort again (D672)

- D672 amends D389: only DeepSeek-family rows whose base URL is not
  `deepseek.com` set `supportsReasoningEffort: false`. Official rows leave the
  flag to pi-ai, which sends `reasoning_effort` next to
  `thinking: {type: "enabled"}`.
- DeepSeek documents `reasoning_effort` (low / high / max) for Chat
  Completions. With the flag forced off, official requests carried only the
  thinking toggle, so low, high, and max produced the same request (#1821).
  The #1664 report concerned relays, which keep the suppression by default.
  Verified against `api.deepseek.com`: low, high, and max arrive as sent and
  the endpoint still returns 200 for `thinking: {type: "enabled"}` alone.
- The per-model `supportsReasoningEffort` override from D671 / #1846 still wins
  in both directions, and relays that reject the field keep the suppression.
- No persisted format or protocol change. Covered by
  `packages/shared/src/provider-presets.test.ts`, the captured-request test in
  `packages/agent-runtime/src/provider-binding.test.ts`, and the official-wire
  cases in `packages/agent-runtime/src/provider-reasoning-effort.test.ts`. See
  `03-runtime/11-provider-model-system.md` and E2E-005E.

## 2026-10-24 — Automatic transcript folding is deterministic (D673)

- D673 amends the turn-process disclosure policy: every ordinary group of a turn
  stays open while that turn is active, instead of folding as soon as it stops
  owning the live segment. After the turn settles, groups with at most four
  visible items, Task topology groups, and groups that still render a Thinking
  row stay open; larger groups of plain tool rows start closed. Visible
  reasoning is reader-requested content, so `Show thinking` is no longer
  undermined by folding the group around it.
- Disclosure ownership is split in two. An explicit header/rail choice belongs to
  its own level and never pins an ancestor; a press, focus or selection is a
  transient reading hold that defers an automatic close until the reader leaves.
  Previously a pointer press or a nested toggle recorded the enclosing levels'
  current state as permanent choices, which disabled automatic folding for the
  rest of the pane's life and could pin a level closed. Search reveals still keep
  their revealed ancestor path open.
- The activity-group issue counter is one inline non-wrapping chip
  (`activity-issue-count`), replacing the unstyled `turn-process-error` span that
  wrapped its icon and localized count onto separate lines in narrow bands. The
  top-level turn header still carries no issue count.
- No persisted format or protocol change. Covered by
  `apps/desktop/test/activity-group-folding.test.mjs` and the automatic-folding
  scenario inside `pnpm test:e2e:transcript`. See ADR
  `turn-process-and-thinking-display`, `04-ux/08-component-spec.md` §9,
  `04-ux/09-interaction-patterns.md` §4.2, and
  E2E-CHAT-turn-process-and-thinking-display.

## 2026-10-28 — Per-turn changed-files summary (D674)

- D674 adds a read-only `TurnChangesCard` under every completed reply whose
  turn recorded at least one workspace review change (issue #1891, design 10).
  It mounts with the reply plugin slots, so it never appears while streaming or
  after a failed turn, and `entryExtra` blocks stay beneath it.
- The card reads only the turn's message-owned `details.review` records through
  `reviewChangeFromMessage`; no capture, IPC, persistence, or host-core change.
  Rows merge edits per path: `D` when the turn ends by deleting the file, else
  `A` when any edit created it, else `M`; counts add up; a file whose every edit
  was rolled back stays listed and struck through.
- Adaptive density: up to four files use relaxed 25px rows; more switch to dense
  21px rows with a directory count; rows past 12 fold into `+N more` with a link
  to Review. The card is one `--ds-tile` surface with no border (D297).
- Clicking a row opens the originating session's Review tab, scrolls to that
  file's first recorded change, and expands it, through a transient renderer
  focus request (`lib/review-focus-request.ts`) rather than app-store state.
  The per-call review rows and the Review tab otherwise keep their behavior.
- Covered by `apps/desktop/test/turn-changes-card.test.mjs`. See
  `04-ux/08-component-spec.md` §4.4 and E2E-CHAT-turn-changed-files-summary.

## 2026-10-28 — Pixel-size image admission (D675)

- D675 adds a header-only pixel-size probe (`packages/shared/src/image-dimensions.ts`,
  mirrored in `crates/host-core/src/tools/image_dimensions.rs`) for PNG, JPEG,
  GIF, and WebP. An image whose longest edge exceeds 8000 px is not inlined
  (issue #1913).
- Host Read refuses such a file with `TOOL_FAILED` and a message naming its
  size, so it never enters history. Prompt attachments and restored history
  keep the image ref and send the existing `@path` fallback instead of bytes.
- `convertToLlm` replaces any remaining oversized image block (older sessions,
  plugin or MCP results) with `[Image omitted: WxH px exceeds the 8000 px
  longest-edge limit for model input.]`, which recovers a session that already
  fails every request. The same bytes always produce the same notice, so
  prompt caching is unaffected.
- Images whose dimensions cannot be read keep the previous byte-only rule.
  Resampling an oversized image instead of dropping it needs a decoder and is
  not part of this change.
- Covered by `packages/shared/src/image-dimensions.test.ts`,
  `packages/agent-runtime/src/image-admission.test.ts`,
  `packages/agent-runtime/src/attachment-history.test.ts`,
  `apps/desktop/test/prompt-inline-attachments.test.mjs`, and host-core
  `tools::image_dimensions` / `read_refuses_images_past_the_pixel_limit` tests.

## 2026-10-28 — Completed turns end at their prompt (D676)

- D676 replaces "stream completion keeps a following reader at the bottom":
  when a followed turn completes, its prompt scrolls to the top of the
  viewport and jump-to-latest appears (issue #1889). A reader who scrolled
  away keeps their position.
- The move waits for the reply's final status, runs one frame after the
  settled reply lays out, and is skipped for failed or aborted turns, a prompt
  already in view, a hidden pane or reading window, a held disclosure
  position, and a queued follow-up that starts first.
- Logic lives in `apps/desktop/src/lib/turn-completion-scroll.ts` and the
  `useTurnCompletionScroll` hook beside `useTranscriptScroll`. Covered by
  `apps/desktop/test/turn-completion-scroll.test.mjs` and
  `pnpm test:e2e:transcript-turn-completion`
  (E2E-CHAT-completed-turn-scrolls-to-prompt).

## 2026-10-28 — One DeepSeek reasoning field per replayed row (D677)

- D677 amends ADR 0256 decision 3: the pi-ai fill pass picks the reasoning field
  of the newest assistant row with real reasoning, then normalizes every row to
  it.
- Real reasoning under another field moves there and the others are removed, so
  a row never carries two, which relays reject.
- The placeholder fills only rows with no reasoning, and
  `withoutReasoningReplayPlaceholder` drops a leading echo from rebuilt history
  and the thinking panel.

See ADR 0256.

## 2026-10-29 — Radial context menu rebuilt and moved to General (D678)

- D678 reworks the opt-in transcript radial menu. Every sector shows its
  action's icon and label at rest, so the ring reads without hovering; the
  active sector fills as a single highlight (no button background, no focus
  rectangle); the hub is a recessed well with the click-point dot; the disc
  shrinks from 320 to 248 px with hairline separators and the composer shadow;
  and hover and reveal motion follow the shared motion tokens.
- The standard marking gesture joins click and keyboard: a right-press that
  starts while the ring is open runs the sector it is released on, releasing
  in the hub dismisses without running, and the release trailing the
  right-click that opened the ring is inert.
- The settings card moves from the AI tab to General (after Sidebar) with its
  settings-search index; the action vocabulary, per-direction defaults,
  `AppSettings.radialMenu` shape, persistence, and IPC are unchanged.
- Covered by `apps/desktop/test/radial-menu.test.mjs`, the Chromium component
  check `pnpm test:e2e:radial-menu`, and capture scenes `pi-radial` /
  `pi-radial-dark`. See `04-ux/09-interaction-patterns.md` §1.11 and
  E2E-CHAT-radial-background-menu.

## 2026-11-03 — User-supplied startup animation (D679)

- D679 lets a user own the boot surface: a video in `<dataDir>/startup/` replaces
  the splash, plays to its last frame, then fades under opaque black over 1000ms.
- Discovery is filesystem-only and creates nothing, ranked `webm` > `mp4` >
  `m4v` > `mov`, served over `pi-startup://animation` so no path reaches the
  renderer.
- Three bounds (2s, 15s, the 180s watchdog) keep it recoverable, and
  `AppSettings.startupAnimation` holds `enabled` and `skipWhenReady`.

See ADR 0338.

## 2026-10-20 — Plugin session scope: `.all` grants and message-level writes (D680)

- D680 opens `pi.session` beyond the ADR 0200 boundary with `session.read.all`,
  `session.update.all`, and `session.delete.all`, additions rather than a
  widening.
- Main resolves the scope from granted permissions, host-core enforces it and
  treats an absent `scope` as `own`, and message-level writes exist for the first
  time.
- A rewrite is refused with `TURN_RUNNING` while a turn owns the session,
  `rename` claims the manual title source, and every call audits its scope.

See ADR 0340.

## 2026-11-04 — Computer use is a host-owned capability behind a scope grant (D681)

- D681 accepts bounded native application control as a contract, not an
  implementation: a `computer.*` host-core domain behind one high-risk tool,
  `Computer`.
- Authority is one user-minted grant naming a window or application, with
  revision, budget, expiry, input policy, and capture mode; the model cannot
  widen it.
- Identity is accessibility-first, with coordinates only against a captured
  `basis`, and **the agent's cursor is drawn, not stolen**.

See ADR 0342.

## 2026-11-05 — Computer use grants the whole desktop automatically (D682)

- D682 amends ADR 0342 §4 and §6: the picker is removed, a `Grant` carries
  `scope`, and the `Computer` handler mints a `desktop` grant on a first call.
- A desktop grant binds one window at a time, and every rebind moves the
  revision, so older `uid`s and `basis` values stop validating.
- A closed window falls back to the frontmost usable window, runs default to
  `autonomous-in-scope`, and Stop ends it with `COMPUTER_STOPPED_BY_USER`.

See ADR 0344.

## 2026-11-05 — The accessibility window is joined by window id, not geometry (D683)

- D683 records a device finding and the private symbol that fixes it. The first
  real-device run of computer use (macOS 15, Stage Manager active) refused every
  window except the one on stage: `window_matches` joined the `CGWindowList`
  entry to its `AXUIElement` by geometry, and the window server reports an
  off-stage window at its Stage Manager *thumbnail* frame while accessibility
  reports the real one — measured as `37,607 121x137` against
  `219,44 1568x1125` for the same window. Geometry is therefore not an identity
  on this platform, and the capability was unusable in practice.
- The join is now the window id from `_AXUIElementGetWindow`, which is the same
  number `CGWindowList` supplies. It is undocumented, has existed since 10.5,
  and is what every window manager on the platform uses. It is resolved through
  `dlsym` rather than linked, so a release that drops it degrades to the
  geometry match instead of failing to launch; a readable id that disagrees is
  definitive and refuses. No new crate, and the rest of the FFI surface is
  unchanged.
- A grant now carries accessibility's window frame rather than the window
  server's, because element bounds, the coordinate clamp, the `basis`, the drawn
  cursor, and the capture crop are all in that frame. `measure` keeps taking
  identity (`appKey`, title) from `CGWindowList` and falls back to its geometry
  when the window cannot be opened.
- Two smaller consequences of the same run: the automatic grant now prefers a
  window whose tree can actually be opened (`Desktop::can_open`, a one-node
  probe), because the window server lists Stage Manager surfaces in front of
  the user's windows and binding one wastes a turn; and a failed read no longer
  leaves the grant on the window it could not read (`policy::inspect_bound`
  restores the previous binding and keeps the revision bump).
- The probe itself is `scripts/e2e-computer-use-device.mjs`, opt-in behind
  `PI_DESKTOP_COMPUTER_USE_DEVICE=1` because it reads the operator's screen and
  can type into one of their windows. Window titles are withheld unless
  `--titles` is passed. Re-run it after a macOS upgrade: if `_AXUIElementGetWindow`
  ever disappears, this is the check that notices.
- Covered by `computer::tests::an_automatic_grant_skips_a_window_whose_tree_cannot_be_opened`
  and `a_window_that_cannot_be_read_does_not_become_the_bound_one`; the join
  itself is platform code and is covered only by the device probe. See
  `docs/implementation/computer-use-evidence.md` for what the run proved and
  what it did not.

## 2026-11-05 — One settings destination owns one subject (D684)

- Two Settings destinations had stopped being subjects and become landing
  places. General carried theme, language and type next to the outbound proxy,
  the application data directory, sleep blockers and the window's close button.
  The AI destination's **Defaults** card had grown to thirteen rows: the default
  operating mode and the command shell sat between the transcript display mode,
  the thinking toggles, the context ring's leading figure, Enter-to-send and the
  paste threshold. Those are three subjects — how it looks, how a transcript
  reads, what a run does — in two pages.
- The rule now is one destination per subject, and the split follows it rather
  than reordering cards: **Appearance** (Interface, Sidebar, Radial context
  menu, Startup), **Conversation** (Display, Input & links), **Behavior**
  (Session defaults, Execution, Computer use), **System** (Network, Storage,
  Power, and on Windows/Linux Close behavior). Fifteen destinations in the four
  existing clusters; Subagents takes the `Sparkles` glyph the retired AI
  destination released, so no two rows share an icon.
- Permission mode moved in with the default operating mode and the command
  shell instead of keeping a card of its own. They are one question asked three
  ways — what a new conversation starts with — and a one-row card was part of
  what made the old page read as a pile.
- Nothing about the settings themselves changed: no persisted field, IPC
  message, host protocol or storage schema. A profile written before the split
  reads back identically; only the page that renders each row is different.
  `general` and `ai` resolve to Appearance and Behavior
  (`resolveSettingsTab`), so a stored selection, a native menu, a capture scene
  or an older deep link cannot open a blank pane, and neither id appears in the
  rail or in settings search.
- Two presentation rules were added because the IA alone does not make a page
  legible. A destination may declare one subtitle line under its title, and a
  card may carry one visible caption line under its heading — the first visible
  explanatory copy since D601 moved row explanations behind a help mark. The
  distinction is scope: a caption orients a whole group, a row's explanation
  still belongs behind its question mark, and copy that needs a second sentence
  stays there too. The capability, model and project workbenches already open
  with their own description and declare no subtitle, so no page says its
  purpose twice.
- The page header now repeats the rail's glyph at page scale on an
  accent-tinted fill, and the selected rail row takes an accent-tinted pill
  with an accent glyph. With fifteen rows in four clusters, "where am I" has to
  survive a glance; the fills stay inside the in-flow surface rule (D297) since
  they are tone, not a stroke.
- Prose that routed a reader to a destination that no longer exists was fixed
  in every catalog: the proxy and network-policy messages now say
  Settings → System → Network. The live specs follow
  (`04-ux/06-settings-ia.md`, `00-baseline.md` §40, `04-ux/01-ui-ia.md`,
  `04-ux/08-component-spec.md`, `03-runtime/04-data-storage.md`,
  `03-runtime/computer-use.md`). Earlier decision entries keep their original
  wording: they record what was decided then.
- The renderer shell is now a router. Each destination is a module under
  `features/settings/pages/`, which keeps `SettingsPage.tsx` from growing a
  fifth subject and leaves the settings source contract intact, since it reads
  the facade plus everything under `features/settings`.

## 2026-11-06 — Composer model picker: text rail and segmented reasoning (D685)

- The two-pane model picker shipped with monogram tiles in its source rail and
  the dot-rail reasoning slider. Both read heavy next to the compact rows.
- The rail is now text only, with one 2px marker that slides between sources;
  the model pane slides in from the direction of the move, and the current
  row's check is drawn rather than filled.
- The reasoning control becomes a segmented track in the menu footer with a
  raised pill under the selected level. The native range still owns
  keyboard, drag and accessibility, and the column geometry contract of D458
  holds: pill, label and native stop share one center for every stop count.
- Escape clears a typed search first; a second Escape closes the menu.

## Bundled Official Enhancements defaults

- Enable only generated session titles on first use. Keep next-message
  suggestions, prompt enhancement, and AI memory opt-in. Preserve explicit
  settings and keep the deterministic fallback and manual-title protections.
