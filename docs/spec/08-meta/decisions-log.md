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
| D019 | Plugin session summary access | **Denied by default** |
| D020 | Auto-update | **Post-MVP** |
| D021 | First-run onboarding | **Inline checklist (not modal wizard)** |
| D022 | Local telemetry | **Local logs only in MVP (no remote telemetry)** |


## C. Provider & model coverage decisions (0.3.4)

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D023 | Provider coverage goal | **Universal market coverage** (not a tiny fixed vendor list) | Globalization + real coding workflows |
| D024 | Coverage strategy | **pi-ai native providers + first-class OpenAI-compatible + custom providers** | Maximum reach without rewriting every SDK |
| D308 | Zhipu / Z.AI named endpoint presets | **Amend D024 / ADR 0116: the add-provider Service select offers four OpenAI-compatible Zhipu endpoints — China and international standard API plus GLM Coding Plan — with locked published URLs and models.dev `vendorKey`s (`zhipuai`, `zhipuai-coding-plan`, `zai`, `zai-coding-plan`). No new apiStyle or wire adapter. Completions requests on those URLs use `thinkingFormat: "zai"` and `zaiToolStream: true`. Custom endpoint remains available.** | Users had to know which BigModel / Z.AI URL to paste, and `vendorKey: "custom"` could catalog-match the wrong API vs Coding Plan record. Named presets keep coverage on the existing OpenAI-compatible path. See ADR 0155 and E2E-005D. |
| D309 | Add-provider common path is Service + key | **Amend D308 / ADR 0116 / ADR 0155: a new add-provider dialog starts with only Service. Named endpoints (Zhipu / Z.AI, OpenCode Go) then show Service + API key and a host summary. Custom endpoint then shows Name, Base URL, and API key. Name (named) and API format (custom) stay in Advanced. OpenCode Go is a Service option. No stepper or vendor-card grid.** | Stacking Name, Base URL, and API format next to Service made a known service look like a generic gateway. The common path should be pick a service and paste a key. See ADR 0156 and E2E-005 / E2E-005B / E2E-005D. |
| D310 | Custom API format stays beside the key; Service lists top models.dev vendors | **Amend D309 / ADR 0155 / ADR 0156: Custom endpoint shows Name + Base URL, then API key beside API format on the common path. Named Service options expand to models.dev-backed international and China first-party endpoints (OpenAI, Anthropic, Google, OpenRouter, Groq, xAI, Mistral, Together, Fireworks, OpenCode Go, Z.AI, DeepSeek, Qwen, Moonshot, Zhipu, SiliconFlow, Volcengine, MiniMax, Kimi For Coding), each with a published URL and wire style. Named display names stay in Advanced.** | Custom gateways need the format next to the key, while named vendors should cover the usual domestic and international APIs without a closed allowlist. See E2E-005 / E2E-005B / E2E-005D. |
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
| D244 | Compact context usage summary | **Amend D103 / D184 / ADR 0047: keep the context inspector's remaining-capacity trigger, used/window counts, turn total, completed-turn speed, exact provider values, aggregate tool types/calls/tokens, and checkpoint summary, but render them as a short summary. Remove the per-tool rows, share bars, source badges, explanatory estimate paragraph, and used-capacity meter from the default panel. No protocol, storage, runtime accounting, or model metadata changes.** | The prior diagnostic layout made a routine capacity check tall and visually dense. Keeping the aggregate signal while removing drill-down chrome makes the default status surface scannable without changing the underlying usage data. See ADR 0103 and E2E-060d / US-UI-61. |
| D243 | Model-aware image attachment transport | **Amend D197 / ADR 0059: Composer file references retain structured kind/name/MIME metadata. Electron main resolves vision from the exact models.dev model record when matched, or the exact pi-ai fallback record (`modalities.input` / `input` includes `image`), stores image bytes as `attachments/<sha256>`, sends eligible images as transient image blocks, and falls back to a safe `@path` for unknown/non-vision or oversized images. Durable messages store refs and metadata, never base64; the renderer shows an accessible capability status.** | The previous path-only contract made a vision-capable GPT model receive a scratch path instead of image content. Keeping capability ownership at the selected catalog source prevents provider discovery or unknown model ids from claiming transport, while the path fallback preserves non-vision file-tool behavior (ADR 0101, amended by D266). |
| D245 | OpenCode-style bounded provider 429 retry | **Amend D186 / D233 / ADR 0091: `PROVIDER_RATE_LIMITED` gets five silent, abortable retries after the initial attempt, with one counter shared across request setup and mid-stream recovery. Disable nested pi-ai retries; capture failed response status/headers; honor `retry-after-ms`, `retry-after` seconds, HTTP-date, then 2-second exponential backoff with 25% positive jitter and a 30-second cap. Reuse the assistant bubble and suppress intermediate lifecycle/error events in main sessions and builtin subagents. Authentication, model-selection, malformed-request, and context errors remain terminal; exhaustion records `retryAttempt: 5` and `providerStatus: 429`.** | The prior split one-retry policy exposed transient 429s too early and allowed setup and stream layers to drift. OpenCode's bounded, header-aware policy preserves user control without hiding persistent provider failure or multiplying nested retries. |
| D237 | Vendor-account (OAuth) login for providers | **A provider row may be authenticated by a vendor subscription instead of an API key. pi-ai's seven OAuth flows are registered statically at startup (`registerBunOAuthFlows()`); Electron main owns login/logout orchestration and implements pi-ai's `CredentialStore` over host-core's encrypted secret store under the new ref `secret:provider:<id>:oauth`, serializing `modify` per provider for locked refresh. `auth_kind` gains `oauth`, `has_secret` widens to "api key **or** oauth", and a new `has_oauth` plus a non-secret `oauthAccountLabel` drive badges and hide the key input; host protocol and storage schema are unchanged. The vendor card list is derived from `models.getProviders().filter(p => p.auth.oauth)`, and login upserts one row per `vendorKey`. The sidecar's launch payload for an OAuth row carries `apiKey: ""`; the runtime injects a `resolveAuth` callback that calls the new host-proxy method `provider.resolveAuth`, which Electron main answers itself — never forwarding to host-core — after checking the `(sessionId, providerId)` pair against the per-launch binding table. The reply is a short-lived `ModelAuth` (`apiKey`/`headers`/`baseUrl`), so a refresh token never leaves main and `matches()` keeps a vendor runtime warm across turns. `providers.listModels` and the connection test go through the authenticated account instead of probing `/models`; apiStyle follows the selected model and gains `openai_codex_responses` and `pi_messages`. Five invoke channels plus one event channel under `pi-desktop/providers/oauth/*` carry the interaction.** | Subscribers of Claude Pro/Max, ChatGPT Plus/Pro and Copilot had to buy separate API credit to use the app. pi-ai ships the flows but declares login orchestration app-owned. Vendor tokens expire in about an hour, so resolving once at launch would break long sessions and churn `matches()` every turn; per-request resolution keeps the runtime stable while giving the model-directed process only a revocable token for the provider its session is bound to — strictly less than the long-lived API key it receives today (ADR 0095). |

| D238 | Flat Settings directory and marketplace context ownership | **Settings renders one flat searchable directory in the exact order Basics / AI / Shortcuts / Instructions / Model configuration / Import / Project archive / Info. Personal, Integrations, Coding, and other group headings are removed. The Settings Extensions destination is removed; its official/mirror/custom marketplace source selector moves into Extensions → Marketplace beside the catalog and retains the same persisted settings and refresh behavior. No IPC, host protocol, storage, provider, permission, or project ownership contract changes.** | The nine-entry Settings rail repeated its own navigation hierarchy and used the same Extensions label as the app-shell plugin destination. Putting marketplace source selection beside marketplace browsing removes the duplicate entry while preserving the mirror/custom-source workflow (ADR 0096). |

| D239 | Place global defaults under AI | **The eight-destination Settings directory remains unchanged. Basics owns Appearance and platform-supported close behavior. 全局 AI / AI owns Permissions and the Defaults card containing default operating mode (Agent / Plan / Goal), command shell selection/fallback status, and Enter-to-send. Model configuration retains the default provider/model selector. Only renderer content and Settings search ownership move; persisted settings, host APIs, runtime semantics, and deep-link contracts remain unchanged (ADR 0097).** | Default mode, command shell, and Enter-to-send change global agent behavior, so placing them beside appearance mixed unrelated concerns and made the AI destination incomplete. |
| D240 | Independent vendor OAuth accounts and settings ownership | **Amend D237 / ADR 0095: every OAuth login creates a fresh provider row and row-scoped `CredentialStore`, even when `vendorKey` matches an existing account. The Vendor accounts card owns the full OAuth row lifecycle and deletes through `providers.delete`; the AI services list excludes OAuth rows but the default selector may still choose them. Vendor auth bindings and resolution use the exact `providerId`; ambiguous vendor/name aliases for subagents fail closed.** | One vendor-global row made a second account overwrite or reuse the first credential, while sign-out left a stale AI-service row. The row id is the only unambiguous account identity and lets deletion remove exactly one credential and configuration. See ADR 0098. |
| D242 | Builtin subagents inherit the parent permission mode | **Builtin subagents use the default `permission: inherit` behavior. The builtin `fixer` no longer overrides the parent session, so `auto` covers its in-root and explicit external-path calls without a second authorization card; explicit non-`inherit` scopes on eligible builtin or user definitions remain intentional overrides.** | The observed popup came from the builtin `fixer` replacing an `auto` parent with `accept-edits`; inheriting the parent fixes the UX without weakening host-core containment or external-path permission rules (ADR 0100). |
| D241 | Titled Settings navigation clusters | **Keep the eight-destination Settings directory flat and searchable, but render four non-interactive localized group headings — Personal / 个人 (Basics, AI, Shortcuts), Agent / 智能体 (Instructions, Model configuration), Workspace / 工作区 (Import, Project archive), and About / 关于 (Info). Headings use whitespace for separation and no divider lines. Empty groups disappear with filtered search. This supersedes only D238's prohibition on group headings; destination order, IDs, search ownership, and marketplace placement remain unchanged.** | The flat rows became visually dense without scan landmarks. Muted headings restore grouping while preserving one-level navigation and the existing destination ownership. |

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
| D267 | Project archive is one workbench, not three bands | **Revise D168's band layout: Settings → Project archive renders the D257 one-workbench composition — a quiet intro line carrying only the page description, one toolbar (Recent/Name sort on the shared `settings-segment` primitive, search with clear affordance and live match count, primary Add project), and one settings panel whose always-visible Pinned / All projects / Archived groups are non-interactive in-panel header strips with per-section counts instead of one panel per section. The decorative gradient hero band is removed together with the four page-level overview counters it carried, retiring the `project.statProjects`, `project.statOpen`, `project.statArchived`, and `project.statSessions` keys; the per-group counts on the panel's header strips are now the only totals. The external uppercase section labels are removed as well; row geometry matches the capability rows (32px controls, 14px list gap, 28px row glyph). Beyond dropping the four retired counter keys this is presentation only: D168's row anatomy, row menu grouping, search matching, session batching, activation semantics, and accessibility semantics are unchanged, and no ADR is required.** | D168's overview banner used a decorative gradient and `--text-xl` counter tiles, which the design system forbids, and its per-section panels repeated the same elevated frame three times. Demoting the counters to an inline run kept the clutter without earning it: every total they showed is already legible from the per-group strip counts, so restating them above the toolbar duplicated numbers and gave the destination a header no sibling page has. Dropping them leaves the durable index looking and behaving like the agent capability pages. |

## E. M5 hardening decisions (0.4.0)

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D078 | macOS signing lanes | **Static config stays unsigned (`identity: null`) for local builds; `scripts/release-macos.sh` injects Developer ID + hardened runtime + optional notarization from env** | Contributors build without certs; releases sign per 06-delivery/06-release-runbook |
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
| D093 | Sidebar organization, retained project tabs, and session workspace isolation | **The renderer retains normalized open-project paths and local project/session presentation metadata for pin, archive, collapse, sort, and optional compatibility order. The sidebar renders one independently collapsible group per retained path plus Temporary sessions. User-facing sort modes are recent, created, oldest, and name; `manual` remains a persisted compatibility value without a new reorder gesture. Activating a group reuses `project.set`, so the shell still has one selected host workspace. Tool execution resolves its root from the durable session project, and per-session turns/grants remain independent when another tab becomes active. Archive and close are non-destructive.** | Preserve a multi-repository working set and make long conversation lists manageable without creating multiple host workspace singletons or allowing an active-tab switch to redirect a background session's tools |
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
| D317 | Live/durable transcript merge keeps chronological order | **Amend ADR 0120 / D261 / ADR 0137 in the renderer: `mergeLiveSessionMessages` stitches a bounded durable `session.get` page onto the live snapshot in chronological order. Live rows older than the page stay before it; an optimistic user row or in-flight assistant/tool tail stays after it. Completed overlapping ids still prefer the durable row. Live-only rows are never appended after the durable page. A previously appended older prefix is healed back in front when its `createdAt` precedes the page. Renderer only: no IPC, storage, host-protocol, or pagination change.** | A session that stayed open past the newest-100 page accumulated hundreds of live rows. Revalidation used the durable page as the array prefix and appended the rest, so D261's trailing mounted window painted old history and hid the just-sent prompt while the turn kept running. Abort then idle reload showed only the durable page, which is why the messages appeared to come back after Stop plus another switch. |
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
| D183 | Segmented tool and model latency logs *(UI clause superseded by D184)* | **Every `tools.execute` call is timed in segments instead of one opaque duration: host-core emits a `tool timing` line on the `host` channel and persists `prompted`, `permissionWaitMs`, `overheadMs`, and `totalMs` next to the existing `durationMs` on `tool_execute` / `tool_denied` audit rows; the sidecar writes greppable `[timing] kind=tool …` (`hostRttMs`) and `[timing] kind=model …` (`providerWaitMs`, `streamMs`, including failed/aborted turns) lines to the `agent` channel, suppressible with `PI_DESKTOP_TIMING=0`. The original no-UI clause is superseded by D184; logging remains unchanged.** | "Executing a command is slow" was undiagnosable from the logs: approval waiting, the tool body, and the provider round trip were indistinguishable, so a 45s gap between two audit rows with 0ms durations gave no clue whether it was the user, the model, or the host. Splitting the stages makes the answer readable without reproducing the run. |
| D158 | Turn-boundary context checkpoint compaction *(soft-boundary, model-tool, and visibility clauses superseded by D200; the model tool and visibility restored in Codex's shape by D203)* | **PI-Desktop reuses pi-agent-core's context estimation, session-context, and compaction primitives but owns the orchestration and durability. After every `turn_end`, before any next provider request, the runtime evaluates model-aware soft/hard budgets. A transient deduplicated instruction can ask the model to call the internal `CompactContext` tool; the tool's normal activity row is visible/durable, while the instruction is not. Crossing the hard budget forces checkpoint generation and blocks the request on failure. A final atomic tool batch that reaches half the hard budget is fairly head/tail-truncated only in the checkpoint copy, with explicit markers and every call/result envelope retained; original transcript rows remain complete. Exact provider overflow removes the failed assistant from model context, creates one checkpoint, and retries once. Host protocol v6 appends checkpoint records beside the untouched visible JSONL transcript; restart, late truncation, and included-boundary forks preserve the newest valid checkpoint. Disabling automatic compaction removes the tool and all automatic threshold/overflow recovery, while `/compact` remains available. OpenCode DCP is an AGPL-3.0 behavioral reference only and is neither linked nor copied (ADR 0030).** | pi's end-of-run-only behavior cannot protect long tool loops, and a model reminder alone cannot guarantee provider safety. Reusing pi's tested compaction format while adding a deterministic `turn_end` gate prevents another provider request from crossing the known window, retains user-visible history, and avoids importing an incompatible plugin/runtime and license boundary. |
| D185 | Lazy per-turn tool activation *(the always-active `CompactContext` clause is void under D200, and holds again for `new_context` under D203)* | **The sidecar keeps a complete local tool registry but sends only the mode core set and local `ToolSearch` on each new prompt. `BrowserPreview`, plugin tools, `Skill`, and plugin-development helpers appear as bounded compact catalog entries and are activated by exact-name or capability search; the next turn receives their schemas, native pi-ai deferred search is used when supported, and the set resets before the next user prompt. Host permissions, containment, timeouts, and audits are unchanged.** | Full tool schemas made simple first requests disproportionately large and repeated optional capability cost across turns. A pi-style active set preserves core coding ergonomics while making ancillary tools pay-as-you-go and provider-independent. |
| D200 | Imperceptible background context compaction *(background pre-computation, incremental trigger, silence, and no-model-tool clauses superseded by D203)* | **Compaction becomes a host-owned background activity with no user-visible surface. `contextBudget()` keeps the D158 hard limit and request headroom, derives the retained-tail target from the model window (`clamp(hardLimit * 0.2, 8k, 64k)`, still capped at half the hard budget) instead of settings, and adds `backgroundLimit = floor(hardLimit * 0.7)` as a pre-computation trigger; the soft boundary is deleted. Checkpoint generation is split from installation: `buildCheckpoint` produces one without persisting or activating it, and installation re-estimates, appends through host-core, and emits `compaction_end`. Pre-computation runs only in provider-idle windows — while a tool executes and after a run ends — and only when the context is past the background limit **and** grew by at least the retained-tail target since the newest checkpoint's baseline, so a large tail cannot trigger a summary every turn. A pre-computed checkpoint installs at the next turn boundary or prompt only if its base is still active, its `throughMessageId` anchor still exists, and it still fits the current model's budget; any miss falls through to the unchanged blocking path, and a failed background build is discarded with no event, no persistence, and no ADR 0049 fallback. The `CompactContext` tool, the `<context_management>` nudge, and the host no-confirmation allowlist entry are removed, so triggering is entirely deterministic. `compaction_start`/`compaction_end` gain an optional `phase` (`background` | `blocking`, absent means `blocking`) and `compaction_end` gains an optional `status { generation, summaryTokens }`; both are additive inside protocol v9. A successful automatic compaction produces no toast, no run-state change, and no transcript row; only a `retained_tail` fallback, an overflow retry, and manual `/compact` still notify. The context usage inspector is the single visible trace, reading `status` and the durable `SessionDetail.compaction`, with the generation counter carried inside the checkpoint's opaque `details` so no record schema change is needed. Settings exposes no compaction controls and persisted `contextCompaction` values are ignored (ADR 0061).** | Compaction was correct but intrusive: it toasted, moved the run state, spent a model turn on a tool call, left a transcript row, and always ran at the moment the user was waiting. Codex's graded trigger and increment-scoped threshold show the summary can be paid for off the critical path, and its host-only triggering removes a class of wasted turns. Deriving budgets from the model window also fixes applying one pair of absolute token counts to both a 32k and a 1M window; keeping the hard boundary untouched means none of this trades provider safety for UX. |
| D201 | Bounded subagents behind a `Task` tool | **Agent mode exposes `Task` when the catalog contains one of the four inline builtins or an enabled global document under `~/.agents/subagents/*.md`. The catalog is loaded by Electron main for the next prompt, is capped at 16, and keeps delegate reports out of the parent model context. There is no project-level subagent capability directory; `.pi/agents` is not scanned.** | Keeping delegation as a bounded tool preserves parent ownership of context and permissions while a global user directory makes personal delegates portable across projects (ADR 0062, ADR 0112). |
| D202 | Managed global subagent definitions | *(Page-shape clause superseded by D257 / ADR 0126; the global-only data boundary stands)* **host-core scans global Markdown documents under `~/.agents/subagents`, stores enabled state in `<data>/agent-capabilities/subagents.json`, and exposes them through the Settings > Agent > Subagents page. The page is one fixed-height global list with no project picker or project-level source. The runtime combines enabled global documents with builtins; malformed or deleted documents produce diagnostics or disappear after scanning, and no capability state is written into the Markdown file.** | Personal delegates follow the user without creating repository changes; the explicit global-only boundary avoids a second project precedence model and keeps Extensions focused on Installed and Marketplace (ADR 0063, ADR 0112). |
| D203 | Codex-parity context compaction | **Compaction is rebuilt to match Codex's mechanism, reversing four D200 clauses and keeping the rest. All background pre-computation and the incremental trigger scope are deleted: `prepareNextTurn()` compacts synchronously when the total context crosses `hardLimit` or the model asked for a new window. A checkpoint carries the summary plus recent **user** messages only — pi's cut point still marks the boundary, but its split-turn prefix and recent tail are folded back into the summary input so the summary covers the whole range, and the retained tail is rebuilt newest-first from user messages up to 20,000 tokens (capped at half the hard budget) with the crossing message truncated rather than dropped, then restored to chronological order. Two families run the identical lifecycle: `summary`, and a `fresh_window` rollover that requests no summary and stores a fixed marker text, selected by construction option or `PI_DESKTOP_COMPACTION_STRATEGY` and exposed in neither settings nor i18n. The model-facing `new_context` tool returns (parameterless, Codex's description verbatim, on the host no-confirmation allowlist, never assignable to a subagent) together with two per-window budget reminders appended to the current turn's system prompt — one at `clamp(hardLimit * 0.15, 8k, 32k)` remaining, one at 2,000 — each claimed once and reset on install. host-core persists the whole checkpoint chain (`read_compactions`, `write_transcript_with_compactions`, per-record fork validation, `SessionDetail.compactions`) with `compaction` kept as its newest element. `compaction_start`/`compaction_end` drop `phase`, and `compaction_end` replaces `status` with `mark { id, throughMessageId, generation, summaryTokens, summarized }`; the transcript draws one divider row per compaction after the message it covers, ending the assistant turn it lands inside and dropping a mark whose anchor is gone, and every successful compaction raises one warning toast on top of the fallback/overflow/manual toasts. Deliberate deviations from Codex: the summary precedes the retained users because `buildSessionContext` fixes that order, `hardLimit` stays "window − output reserve" instead of 90% of the window, the tool is registered in both families, and the reminders are system-prompt appends with our own thresholds and wording (ADR 0064).** | The previous round cited Codex while implementing its opposite on four counts, and its Context section claimed Codex has no model-side compaction tool when `new_context` exists. The user asked for Codex's mechanism specifically, after being told it reverses the imperceptibility goal. Parity also buys three things on its own merits: a checkpoint that keeps only user messages is far cheaper and cannot strand a tool call without its result, a visible row makes a lossy operation auditable from the transcript again, and a warning puts the "start a fresh session instead" decision where it belongs. The cost is accepted: the user waits for compaction again. |
| D186 | Bounded provider stream recovery and diagnostics *(429 budget amended by D245)* | **Provider request setup uses one bounded retry for non-rate-limit transient failures. A transient `STREAM_FAILED`, `NETWORK_ERROR`, or `TIMEOUT` after streaming begins is replayed once in the same turn after abortable backoff; the failed assistant is removed from model context and its visible message id is reused. HTTP 429 setup and stream recovery follow D245's shared five-retry budget. Provider `AppError.details` carries only bounded phase, timing, provider status/code, and retry-attempt diagnostics. Mutation guidance uses one fresh read/regeneration after an `Edit` mismatch; a second failed `Edit` for the same path or a second failed shell patch command returns a terminating tool hint instead of repairing old patch artifacts.** | Unbounded or regenerate-driven recovery made transient stream termination expensive and made patch loops consume turns without new information; finite runtime budgets preserve context and user control while keeping failures diagnosable (ADR 0050, amended by ADR 0091 and D245). |

| D187 | Resource-isolated host RPC stdio | **host-core reads stdin and serializes stdout through one dedicated named OS thread per direction, never through Tokio's dynamic blocking pool. The threads retry interrupted and transient `EAGAIN`/`EWOULDBLOCK` errors while preserving NDJSON framing; inability to create a control thread is a structured startup failure. The login-shell PATH probe also treats helper-thread creation as best effort and falls back to the inherited PATH. RPC/tool admission limits remain unchanged.** | Tokio stdio can panic when OS thread creation returns `Resource temporarily unavailable` (errno 35 on macOS), turning temporary resource pressure into `HOST_UNAVAILABLE`; isolating the control pipe removes that process-level crash path while retaining bounded overload behavior (ADR 0051). |
| D191 | Agent-only mode; Chat renamed to read-only | *(superseded by D188/D189: the mode selector returned as `Agent | Plan`, and `chat` migrates to `plan`)* **`agent` is the only session mode the product exposes. The former `chat` profile is renamed `read-only` and keeps its `Read`/`Glob`/`Grep` hard deny in host-core, but it has no UI surface: no top-bar toggle, no composer chip, no Settings row, no palette command or slash alias, and no localized labels. The host normalizes `chat` to `read-only` on every write path (`session.create`, `session.configure`, `session.import`) and the permission gate is negative — anything that is not `agent` gets the read-only surface — so an unknown or legacy value can never widen the tool set. Error codes become `BASH_DISABLED_IN_READ_ONLY` / `WRITE_DISABLED_IN_READ_ONLY`. A boot fix-up rewrites existing `sessions.mode = 'chat'` rows and a stored `defaultMode` of `chat` to `agent`.** | A mode switch the product never intends users to reach is a footgun and dead UI weight: sessions could be stranded on a read-only profile with no way back, and two toolsets doubled the surface every tool, prompt, and permission change had to be reasoned about. Keeping the narrow profile enforced host-side preserves the security boundary for imported and legacy rows without shipping a control for it (ADR 0055). |

## N. Notification decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D117 | Durable task notification inbox | **Rust host-core exclusively owns a schema-v6 `notifications` table and atomically inserts one structured `task.completed` / `task.failed` row when `session.endTurn` moves a running turn to completed/error only if Electron reports that result was not already visible. Renderer supplies the current chat session through an allowlisted viewing-context IPC and a matching prompt-dispatch snapshot; Main suppresses insertion only when its window is visible/focused and that session matches, while unknown, background, hidden, or unfocused state fails safe to notification. `turn_id UNIQUE` prevents duplicates, abort is silent, session deletion cascades, and only the newest 200 rows remain. The titlebar bell exposes exact unread count, All/Unread, row mark-read/session activation, mark-all-read, and clear with complete keyboard/accessibility behavior. Protocol v4 adds singular `notification.list/markRead/markAllRead/clear`; `session.endTurn` returns an inserted record, Electron emits renderer `notification.changed`, and only while the main window is unfocused it also shows a native system notification whose click restores/focuses the window and emits `notification.activated`. Persisted rows contain structured kind/session/turn/error data plus the session-name snapshot, never localized notification title/body prose. The task inbox has no permission, scheduled-reminder, preference, cloud-notification, or plugin-notification source; plugin-native notifications are the separate D213 surface. D113's profile footer remains unchanged.** | Notifications should recover task outcomes the user did not see, not duplicate a result already visible in the current chat. A bounded host-owned inbox keeps background/unfocused outcomes durable and navigable without violating SQLite ownership, duplicating events, or turning every terminal event into notification history. |

## O. Desktop shell decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D118 | Platform application menu and window chrome | **macOS installs a conventional system application menu and keeps hidden-inset traffic lights. Windows/Linux use the shared 46px frameless shell with localized File/Edit/View/Window/Help menus and renderer-drawn minimize/maximize-or-restore/close controls. Both menu surfaces route renderer-owned actions through a fixed `AppMenuCommand` allowlist; renderer menus route native editing/window actions through a separate fixed allowlist. Target packaging builds the local release host before Electron packaging. This adds platform-ready shell behavior but does not reverse D010: Windows/Linux release qualification remains post-MVP.** | A default Electron menu leaves macOS shell commands incomplete, while a frameless Windows/Linux window otherwise loses both application menus and window controls. Shared allowlists keep behavior consistent without exposing an arbitrary privileged command bridge. |
| D120 | Application update delivery | **Electron Main exclusively owns a fixed GitHub Releases feed, update polling, typed state, and install lifecycle. Development is disabled; packaged macOS and non-AppImage Linux use notify-and-link delivery, while Windows NSIS and Linux AppImage download in-app and install on quit. Renderer IPC cannot provide feed URLs. Automatic failures stay ambient, explicit checks surface status, and downloaded state remains actionable. The updater always forces `allowPrerelease = false` so prerelease installs (for example `0.2.0-rc.6`) track GitHub's latest stable release instead of electron-updater's default same-channel pin. D126 later publishes every platform feed produced by the tag matrix while macOS remains manual until a signed channel is qualified.** | Keep package installation outside the sandboxed renderer, match delivery to each installer format, and provide one consistent state across menus, Settings, and the update banner (ADR 0022). Without the stable-channel pin, RC builds never surface newer stables because electron-updater treats `rc` as a custom channel. |
| D313 | Main-owned GitHub issue feedback | **GitHub issue forms are the only intake path. The bug form requires description, reproduction steps, expected and actual behavior, app version, and OS; the feature form requires a problem and a proposed change. Settings → Info exposes one Report a problem action on `pi-desktop/app/openFeedback`. Electron Main builds a fixed `bug_report.yml` URL, prefills `app-version` / `os` / `environment` from Main-owned version info, and opens it with `shell.openExternal`. The renderer cannot supply a URL. Feature requests stay on GitHub's template picker. No host-protocol, storage, or update-feed change (ADR 0157).** | Reports without version or steps cannot be triaged, and a renderer-chosen destination would weaken the same Main-owned GitHub URL rule as D120. |
| D314 | Shipped locale registry and language picker | **Amend D073: UI locales are listed in `@pi-desktop/i18n` (`en`, `zh-CN`, `tr`). Native names stay untranslated. Settings → General language is a searchable picker (Auto + registry), not three preview cards. Plugin labels and the changelog stay `en` + `zh-CN` with English fallback. See ADR 0160 and E2E-091.** | Preview cards cannot scale past two languages; a registry lets Turkish (and later locales) ship without rewriting the Appearance card. |
| D316 | Searchable theme picker | **Amend ADR 0160: Settings → General theme is a searchable picker row (same anchored-menu pattern as Language), not three preview cards. System / Light / Dark stay pinned at the top; plugin themes follow after a divider. `AppSettings.theme` and plugin-theme fallback are unchanged. See ADR 0161 and E2E-091.** | Plugin themes wrap a three-column card grid, and Language already solved the growing-list control. |
| D121 | Branded macOS development host | **`pnpm dev` on macOS launches electron-vite through a fingerprinted, ad-hoc-signed PI-Desktop copy of the installed Electron host bundle under `.cache/electron-dev/`. The generated bundle changes only development host metadata, executable name, bundle identifier, and the ICNS resource; it never mutates `node_modules`. Windows/Linux keep the stock development executable, while packaged lanes remain electron-builder-owned.** | AppKit ignores runtime app-name/menu overrides for the top-level application identity and takes the native menu name and About icon from the host bundle; a branded development host is required for parity with packaged PI-Desktop. |
| D129 | Menu-free Windows/Linux window chrome | **The application menu is a macOS system-menu surface only. Windows/Linux retain the shared frameless 46px titlebar and renderer-drawn minimize/maximize-or-restore/close controls, but render no File/Edit/View/Window/Help menu inside the window and reserve no left-side titlebar space for one. Existing application, editing, zoom, fullscreen, and close shortcuts remain available through renderer/native web-content handling; update checks remain reachable from Settings -> Info. This supersedes only the Windows/Linux renderer-menubar portions of D118 and ADR 0021.** | An in-window desktop menu duplicates macOS-specific system-menu chrome, consumes navigation space, and does not belong in PI-Desktop's frameless Windows/Linux titlebar. |
| D130 | Sidebar-footer notification entry | **The durable notification Bell moves from the main titlebar to the separate `32px` action at the right of the expanded sidebar footer, replacing D113's Help shortcut. Its unread badge and complete D117 inbox behavior remain unchanged; the popover opens above and to the right of the footer, and no duplicate Bell remains in the main titlebar. This supersedes only the entry-location clauses of D113 and D117.** | Notification history belongs with the persistent local profile controls and the footer position keeps the main titlebar quiet while preserving a compact, familiar status entry. |
| D141 | Canonical Windows native application identity | **Electron Main sets the product name before readiness and registers `com.pi-desktop.app` as the Windows process AppUserModelID before creating any window. That ID is the existing electron-builder/NSIS application ID; Windows packaging explicitly retains `PI-Desktop` for the executable and Start menu shortcut. Native notification attribution, notification settings, taskbar grouping, installed shortcuts, and packaged executable identity must expose `PI-Desktop`, not the stock Electron host. D121 remains unchanged: Windows development may use the stock Electron executable while its OS-facing runtime identity uses the canonical AUMID.** | `app.setName` changes Electron's internal name but not the Windows identity used by notifications and shell integration. One stable ID across runtime and packaging prevents both the observed notification-source leak and adjacent shell-brand drift without changing the published NSIS upgrade identity. |
| D204 | Empty home task-entry surface | *(supersedes D111's non-docked home-composer clause and its contextual quick-action clauses; starter-grid amendment in D205 is superseded by D206)* **The empty chat home keeps the restrained hero and optional first-run checklist in the scrollable content region. The home composer is a bottom-reserved sibling of the scroller, remains visible at the bottom of the chat surface, and never covers the content.** | The direct composer remains the stable primary action and the flow layout preserves checklist reachability in short windows (ADR 0066). |
| D205 | ChatGPT-inspired empty-home guidance | *(superseded by D206)* **The empty chat home adds a compact four-card developer starter grid between the hero and optional checklist: Explore a codebase, Build a feature, Fix a bug, and Review a change. Each localized card only prefills and focuses the bottom composer; it never sends a prompt or creates a turn. The bottom-reserved composer and single scrollable home flow from D204 remain unchanged.** | The previous hero-only middle left too much unused space and offered no starting cues. ChatGPT's clear empty-state hierarchy improves first-task discoverability while developer-specific prompts keep the surface purposeful rather than promotional. |
| D206 | Remove empty-home developer starter cards | **The empty chat home does not render developer starter cards, starter glyphs, or a contextual quick-action row. It keeps the restrained hero, short supporting line, optional onboarding checklist, and D204's bottom-reserved composer; task entry starts directly in the composer. This supersedes D205 without changing D204's scroll and bottom-reservation layout.** | Review confirmed that the direct composer is the preferred task-entry surface and that the cards add an unnecessary decision layer to the empty home. |
| D208 | Recoverable native-tool path contracts | **Keep D185's deferred Glob/Grep boundary, but make every prompt and schema explicit that Read accepts an existing regular file, Glob accepts a directory, and Grep accepts a file or directory. A directory Read returns `INVALID_ARGUMENT` plus structured Glob recovery args; an explicit-file Grep searches only that file and applies `include` to its basename. Tool errors remain visible on their ToolCallRows, while activity groups report processing duration only and never infer terminal turn failure from a child row; terminal agent events and the dedicated outcome surfaces remain authoritative (ADR 0069).** | Durable sessions showed directory Read and file-as-directory Grep mistakes repeatedly, then displayed recovered work as terminally failed. Compatibility at the narrow host boundary plus one outcome owner removes retries and false failure UI without restoring every search schema to the Agent core. |
| D216 | Cross-platform tray-resident minimize | *(Windows taskbar clause amended by D252 / ADR 0117; explicit Windows/Linux action clauses amended by D256 / ADR 0123)* **Electron Main creates one packaged-resource tray icon on macOS, Windows, and Linux. Explicit application minimize actions and macOS/Linux native minimize hide the window without disposing the host or sidecar; Windows' native taskbar minimize remains an ordinary taskbar-visible OS minimize. Tray click/double-click, Show, and macOS app activation restore and focus the existing window (or create one if it was closed). The localized tray menu exposes Show PI-Desktop and an explicit Quit PI-Desktop action.** | Users need background work to continue without losing the app window, while Windows users also expect the active taskbar button to retain its normal minimize/restore behavior. Main-owned tray lifecycle avoids renderer privilege expansion and keeps explicit exit observable. |
| D218 | Host-owned cross-platform plugin panel chrome | **Plugin panel windows adopt the main window's 46px platform chrome: macOS uses `hiddenInset` with traffic lights at `{x:16,y:16}`, while Windows/Linux are frameless with a 112px custom minimize/maximize-or-restore/close band. The sandboxed plugin preload renders the manifest title and controls in a closed Shadow DOM, offsets content by the titlebar height in addition to existing top padding, and consumes a private sender-validated fixed window-action channel; `window.pluginBridge`, the per-plugin partition, and host protocol v9 do not expand. Reopening a minimized panel restores and focuses it.** | Default Electron frames made plugin tools look detached from PI-Desktop and varied by platform. Preload-owned chrome provides parity without moving untrusted plugin HTML into the host renderer or exposing general Electron window authority (ADR 0081). |
| D234 | Plugin-owned panel surface with a host window-control capsule | **Plugin panels use frameless windows on macOS, Windows, and Linux. The sandboxed preload reserves a transparent 46px safe area and renders only one fixed top-right capsule with exactly three buttons — minimize, maximize/restore, and close — in a closed Shadow DOM. It no longer renders a panel title or development reminder. The plugin owns its title, toolbar, background, and all other visible UI; normal-flow content is offset automatically, fixed/sticky UI uses `--pi-plugin-titlebar-height: 46px`, and plugin-owned drag regions use `-webkit-app-region: drag` with interactive controls opting out. The private sender-validated control channel, localized labels, page-adaptive colors, `window.pluginBridge`, per-plugin partition, host protocol v9, and storage schema remain unchanged. This amends D218 / ADR 0081 and D232 / ADR 0082.** | The host titlebar consumed the plugin's visual hierarchy and still made macOS different from Windows/Linux. A compact host capsule preserves safe native window actions while leaving the panel surface to the plugin. |
| D235 | Strict 46px plugin drag band with a minimal capsule | **Plugin panels reserve exactly 46px for a transparent host drag band on every platform. Normal-flow content is offset by that value, the band blocks plugin clicks outside the capsule, and development panels show a localized reminder that the top 46px is drag-only. The host renders no panel title. The fixed top-right capsule stays inside the band, contains exactly minimize, maximize/restore, and close, and uses a subtle page-adaptive surface without heavy shadow or blur. This amends D234 / ADR 0092; the private sender-validated control channel, closed Shadow DOM, `window.pluginBridge`, protocol v9, and storage schema remain unchanged.** | Frameless panels need a reliable drag target and a clear authoring constraint, but the host band must not grow or compete with the plugin's visual hierarchy. |
| D232 | Custom global UI font | **Settings → Basics → Appearance gains a searchable Font picker (trigger previews the current family). Selections persist as `AppSettings.fontFamily`, a CSS stack; absent means the built-in `--font-sans` token stack, and the renderer applies the stack by overriding `--font-sans` on the root element without a reload. Four bundled families — Geist, Inter, Noto Sans SC, LXGW WenKai — ship locally as woff2 under the SIL OFL 1.1 with license texts; every custom stack appends a CJK fallback tier and the mono stack is unchanged. Installed system families are enumerated by Electron main using platform tooling only (macOS: `osascript` JXA bridging the CoreText query `CTFontManagerCopyAvailableFontFamilyNames` — the same API dbx's `font_kit::all_families()` calls — with `system_profiler` as a slow fallback; Windows: PowerShell; Linux: `fc-list`), deduplicated/sorted/filtered and cached 60 s, exposed through the additive allowlisted channel `pi-desktop/app/systemFonts`; host protocol v9 and storage schema v10 are unchanged.** | Users want a Codex/dbx-style global font preference, but the sandboxed renderer cannot enumerate OS fonts and the host RPC should stay unchanged for a renderer-only preference. Bundling OFL-licensed families keeps every offered font commercially safe and offline, while the fast CoreText path returns the canonical CSS family names (e.g. PingFang SC) in tens of milliseconds and the 60 s cache bounds repeated enumeration (ADR 0083). |
| D230 | User-configurable close behavior with close-to-tray | **Windows/Linux close behavior is a persisted preference stored by Electron main in `<data>/close-behavior.json`. `ask` is the transient unset state: the first close shows a native modal (Cancel / Close to tray / Quit); picking one persists it forever, Cancel keeps the window open and unset. Only `tray` and `quit` are ever settable — Settings -> General renders a two-option radio segment (Close to tray / Quit app) for Windows/Linux only, and `pi-desktop/window/closeBehavior/set` rejects `ask`, so a choice can be switched but never reverted to prompting. `tray` hides the window under the resident D216 tray icon (click restores, menu shows or quits); switching to `quit` leaves that icon in place, because minimize-to-tray still needs it. Close interception runs for every non-macOS close that is not already an approved quit; `quitting` and macOS closes fall through, a `quit` close calls `app.quit()` itself, and `window-all-closed` stays silent only under `tray`, so the boot probe and explicit quits are unaffected and a resident tray never keeps a `quit` session alive. `closeBehavior/set` also fails with `INVALID_ARGUMENT` on macOS. The bounds watchdog skips minimized and hidden windows so a tray-hidden window is never force-restored. macOS keeps the native Dock lifecycle (D216, ADR 0078, ADR 0090).** | Minimizing already hides the window into the D216 tray; the gap was close: it quit outright on Windows/Linux. A fixed close-to-tray would surprise users who expect exit, so the choice is asked once, remembered, and revisitable in Settings — matching how Codex-style shells keep long-running sessions alive without taking over the close button. |
| D252 | Windows taskbar preserves native minimize/restore | *(Explicit renderer/menu minimize clauses superseded by D256 / ADR 0123)* **Amend D216 / ADR 0078: when the focused Windows main window is toggled from its taskbar button, Electron lets the native `minimize` transition complete instead of hiding the window. The taskbar entry remains available and the next taskbar click restores/focuses it. Explicit renderer/menu minimize actions still hide to the resident tray; macOS/Linux native minimize remains tray-resident. No IPC, storage, host protocol, or background-work changes.** | D216's unconditional `window.hide()` handled the taskbar-originated Windows `minimize` event as a tray hide, unexpectedly removing the taskbar entry and leaving the user with only the tray restore path. |
| D236 | One desktop instance per data directory | **Electron main takes `app.requestSingleInstanceLock()` during module evaluation — after `app.setName`, because the lock lives under the name-derived `userData` path, and before the logger, the persistence outbox, or any other data-directory access. A launch that does not take the lock calls `app.quit()` and boots nothing: the readiness and `before-quit` handlers both return early, so it creates no window, tray, child process, or log line inside the running instance's data directory. The lock holder answers `second-instance` by restoring and focusing its main window through the same path as the tray's Show action, which recreates a window that was closed or hidden into the tray. The lock is requested only when `PI_DESKTOP_DATA_DIR` is unset, so E2E harnesses, the capture rig, and deliberate side-by-side profiles keep the current start-anytime behavior. No IPC channel, host protocol, or storage schema changes.** | A second launch booted a complete second app: another host-core over the single-writer `pi.sqlite` (D002), another outbox and log tree in the same directory, another tray, launcher-chord registration, and updater, leaving two shells divergent over one database. Relaunching the app is a request to see the one already running, and scoping the lock to the installation keeps isolated-data-directory runs launchable (ADR 0094). |

## P. Transcript storage decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D119 | Transcript file store; SQLite index-only | **Schema v7: message content moves out of SQLite into per-session JSONL files under `~/.pi-desktop/sessions/` — `<id>.jsonl` (a session-header line, then one canonical block-array message line per message, RFC3339 stamps) plus an append-only `<id>.revisions.jsonl` for regenerate branches. `messages` drops `content_json`/`meta_json` and becomes a pure index (ordering, promoted filter columns, extracted `text` feeding FTS); `message_revisions` swaps `messages_json` for `message_count`, with `is_active` tracked in the DB only. Writes are file-first then index transaction; reads skip unknown/torn lines and dedupe repeated message ids keep-last; full rewrites are temp-file + atomic rename; session files are deleted only with their session and never age/orphan-swept. Opening a pre-v7 database archives it as `pi.sqlite.v6.bak` and bootstraps fresh — an explicit breaking reset, with all v1–v6 migration code removed. RPC wire format is unchanged, so Electron/renderer/importers need no changes.** | The database grew without bound carrying tool args/results and thinking payloads; codex/claude-code-style per-session files keep transcripts human-readable, greppable, and portable while SQLite stays a small, fast index (list, search, badges). A dev-phase breaking reset was chosen over migration machinery. |
| D122 | Independent conversation session fork | **Protocol v5 adds host-owned `session.fork`: an idle source's complete active canonical transcript is copied into a new independent session with remapped message/tool-call ids and inherited project/provider/model/mode/thinking/permission configuration. Turns, regenerate revisions, notifications, artifacts, session grants, scratch/runtime state, pin state, and parent-child lineage are not copied. Create branch activates the child; D109 remains unchanged because no message-level branch tree is introduced.** | A single host-owned snapshot preserves canonical blocks and persistence consistency while giving users a Codex-style divergence workflow without conflating independent conversations with regenerate variants. |
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
| D209 | Composer file references separate compact display from canonical prompt paths | **Completed workspace-file selections and materialized clipboard files become renderer-owned, session-scoped reference chips above the textarea. A chip persistently displays only the leaf name, exposes the canonical path through tooltip/accessibility metadata, and can be removed without deleting scratch bytes. Immediately before submit, references serialize in stable order after the visible draft with D124's exact quoting, so reference-only drafts, slash templates, and Agent/Plan/Goal mode aliases retain their current behavior. Accepted dispatch clears the active editor but keeps a renderer-only, turn-scoped pre-serialization snapshot while smart Stop can still undo an unanswered send. That undo restores the original text and chips rather than prefilling serialized message content; abort after reply start keeps the partial transcript and restores nothing. Rejected/failed sends retain the active draft. `ComposerPastedFile.name` is the sanitized original leaf label while `path` retains the UUID-backed absolute storage identity. No binary payload, provider attachment, host RPC, or schema is added.** | Long relative paths and UUID-backed scratch paths overwhelmed the prompt row even though only the agent needs them. Separating presentation from serialization preserves exact tool-readable paths, duplicate-name identity, textarea/IME behavior, and the text-only provider contract (ADR 0070). |
| D211 | Global plugin launcher | **A customizable `openPluginLauncher` shortcut defaults to Option+Space on macOS and Alt+Space on Windows/Linux. Electron main registers it during startup and owns one prewarmed 620×440 frameless utility window centered on the display nearest the pointer; macOS uses a cross-workspace panel, while Windows uses a host-core low-level hook for the reserved default Alt+Space chord and retains a focused-window fallback if that hook is unavailable. The sandboxed renderer lists only enabled, ready panel plugins, matches Chinese names by original characters, tone-free full pinyin, or pinyin initials (plus normalized name/id/description), and opens the selected result through the existing plugin panel host. Up/Down selects, Enter/click opens, Escape/blur hides, and IME composition never dispatches. The additive toggle/dismiss/shown IPC is Electron-local; host-core's additive shortcut method/notification carries only the binding event.** | Plugin panels need a keyboard-first entry point that works while PI-Desktop is unfocused, without restoring the full shell or weakening the existing panel sandbox/permission boundary (ADR 0072/0076/0080). |
| D212 | Running composers stage next-turn configuration and stopped turns preserve throughput | **During an active turn, draft text and mode/thinking/permission selectors remain editable. The single submit slot renders Stop only for an empty draft; a non-empty draft renders enabled Send and queues the next prompt. The renderer projects the latest full configuration per session and calls the existing idle-only `session/configure` only after the terminal event, so the running runtime remains pinned; pending Plan/Goal approval still gates editing. User-stopped partial answers preserve `responseDurationMs`; when final provider output usage is absent, visible thinking+answer text is estimated at four Unicode code points per token into optional `responseOutputTokens`. Rust transcript metadata persists both fields, exact usage wins, and the UI marks estimate-only throughput.** | Preparing the next prompt should not wait for the current stream, but host safety requires immutable in-flight configuration. A stopped visible answer still has enough measured data for useful, explicitly approximate generation speed (ADR 0073). |
| D215 | Windows-reserved global shortcut fallback | **On Windows, host-core installs a narrow `WH_KEYBOARD_LL` hook for the effective `Alt+Space` default binding because the shell may reserve it from Electron's `globalShortcut`. The hook consumes only the matching chord and emits `keyboard.shortcut({ binding: "Alt+Space" })`; Electron toggles the existing plugin launcher. Electron calls additive `keyboard.setGlobalShortcut({ binding })` whenever settings change, and host-core enables the hook only for that exact binding. Other platforms and custom bindings remain on Electron's global shortcut path.** | Windows' active-window system menu reservation made the shipped global launcher unavailable whenever PI-Desktop was unfocused. A narrowly scoped host fallback preserves the shortcut without reading text or expanding plugin/renderer privileges (ADR 0076). |
| D217 | Early plugin launcher warm-up | **As soon as Electron is ready, before backend/plugin boot completes, Electron starts creating and loading the retained plugin launcher while it remains hidden. Window creation uses one shared in-flight promise, so a shortcut received during warm-up joins the same renderer load; failures destroy the incomplete window, clear the promise, and remain retryable on the next invocation. Each show still refreshes the live plugin catalog. On macOS, showing the panel relies on its normal activation and skips a redundant application activation/window-stack move.** | Overlapping launcher renderer startup with backend boot and avoiding duplicate macOS activation work removes first-invocation delay and visible stutter without weakening plugin freshness, IPC, or sandbox boundaries (ADR 0080). |
| D219 | Plugin launcher most-recently-used history | **The launcher renderer records each successfully opened plugin id with a timestamp in renderer-local `localStorage` (key `pi.desktop.pluginLaunchHistory`, capped at 24) and presents an empty query in most-recently-used order. A typed query ranks search relevance first and uses recency only as a tiebreaker, so unused plugins sort after the recent ones by name. Corrupted or unavailable storage degrades to the existing name order without breaking launching. This refines D211's presentation without changing IPC, host RPC, permissions, protocol v9, or storage schema v11.** | Keyboard-first launcher users reopen the same plugins repeatedly; remembering the last-used order keeps the most frequent target one Enter away while relevance stays authoritative once the user types. |
| D221 | Renderer output size controls | **The renderer build sets `minify: "esbuild"` explicitly because `electron-vite` hard-defaults its renderer preset to `minify: false`. A `pi-drop-legacy-font-fallbacks` plugin strips comma-prefixed `woff`/`truetype` `src` entries with `enforce: "pre"`, before Vite registers them as assets, since the bundled Chromium always supports `woff2`; a face whose only source is a legacy format keeps it. `BrandLogo` imports 192x192 marks derived from the canonical masters at `src/assets/brand/logo-{light,dark}.png` rather than the 1024px installer icons in `build/`, refining D079/D094 without changing the visual identity. `packaging-footprint.test.mjs` asserts all three so a framework default or a reverted import cannot silently regress them. The two bundled CJK faces stay unsubset per ADR 0083 section 2.** | `out/renderer` fell from 31 MiB to 24 MiB with no feature loss; the unminified default and the installer-icon import were accidental costs, while CJK subsetting would drop glyphs from user content and needs an ADR revision |
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
| D126 | Three-platform release delivery (lifts D010) | **Tag builds publish every artifact the matrix produces to the GitHub Release: macOS dmg/zip (arm64), Windows NSIS x64, Linux AppImage + deb (x64), each with blockmaps and the platform's `latest*.yml` electron-updater feed. Publishing the feeds activates D120's in-app update lanes for Windows NSIS and Linux AppImage; macOS stays in notify-and-link mode until a signed channel is qualified. The NSIS artifact name is pinned space-free (`PI-Desktop-Setup-${version}.${ext}`) because GitHub asset URLs mangle spaces. D010's macOS-only scope is lifted per the baseline-bump rule (baseline `0.4.7`); the release pipeline itself was qualified end-to-end on v0.1.1-rc.1/v0.1.1.** | The pipeline builds and validates all three platforms on every tag anyway; keeping installers as expiring Actions artifacts (90-day retention) withheld them from users without adding safety. Publishing the update feeds is the point of shipping: platforms with in-app lanes update silently, and future platform regressions surface through real installs instead of unused artifacts. |
| D260 | Release documentation is a version surface | **A stable version bump must update every version-bearing surface before the tag: the dual-locale in-app changelog and its test list, every workspace `package.json` including `docs/package.json` (a third workspace root `scripts/release.mjs` previously skipped), the Cargo workspace version and `host-core` lockfile entry, `APP_VERSION`, and the `<major>.<minor>.x` release line stated in `README.md` and `README.zh-CN.md`. `scripts/check-release-docs.mjs` verifies all of them; `scripts/release.mjs` runs it after bumping and refuses to commit or tag while any surface disagrees, with `--skip-docs-check` reserved for deliberate non-release bumps. Extends D164.** | The in-app changelog gate alone left published documentation behind: the READMEs still advertised the `0.5.x` line at `0.10.8`, and `docs/package.json` sat at `0.5.8`. A tag is irreversible, so the check runs before the tag exists rather than as review etiquette. |

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
  above the 20 MiB inline bound receive a safe scratch/project path fallback;
  replayed content-store images use a session `replayed/` copy. Renderer
  discovery cannot promote an unknown model.
- Decision D243 amends the image portion of D197 / ADR 0059. It fixes the
  observed GPT vision gap without moving provider logic into the renderer or
  putting binary data into host persistence. See ADR 0101,
  `03-runtime/01-ipc-protocol.md` §5.1/§13c,
  `03-runtime/04-data-storage.md`, `04-ux/08-component-spec.md` §11.7–11.8,
  and E2E-102c–102e.

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
  `shouldStopAfterTurn` flag, so the current assistant response/tool batch
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
  surface before the tag: the dual-locale changelog and its test list, all
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
  delegation, the Task tool returns a tool error listing available models.
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

## 2026-09-01 — Expanded sidebar width is user-resizable (D280)

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
