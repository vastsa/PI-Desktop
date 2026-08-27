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
| D025 | Model allowlist | **No closed product allowlist** | Models churn; power users need free-form IDs |
| D026 | Catalog sources | **bundled snapshot + discovery/refresh + user-defined** | Works offline and stays current |
| D027 | Default identity | **Model selection is `(providerId, modelId)`** | Same model id can exist on many gateways |
| D028 | Secrets | **OS safeStorage (or controlled fallback) via secretRef; never in provider JSON** | Security boundary with Rust host ownership |
| D029 | Local models | **Supported through OpenAI-compatible local gateways** | Ollama/LM Studio/vLLM without special-case architecture |
| D030 | Connection test | **First-class host method before trusting provider for runs** | Fail early, actionable setup UX |
| D031 | Secrets backend | **OS safeStorage primary + encrypted file fallback** | Robust on macOS first release |
| D032 | Workspace ignore | **security denylist + defaults + `.pi-desktopignore`** | Safe/predictable tool FS behavior |
| D033 | Tool result limits | **256KB/4000 lines defaults with explicit truncation markers** | Protect context & UI |
| D244 | Compact context usage summary | **Amend D103 / D184 / ADR 0047: keep the context inspector's remaining-capacity trigger, used/window counts, turn total, completed-turn speed, exact provider values, aggregate tool types/calls/tokens, and checkpoint summary, but render them as a short summary. Remove the per-tool rows, share bars, source badges, explanatory estimate paragraph, and used-capacity meter from the default panel. No protocol, storage, runtime accounting, or model metadata changes.** | The prior diagnostic layout made a routine capacity check tall and visually dense. Keeping the aggregate signal while removing drill-down chrome makes the default status surface scannable without changing the underlying usage data. See ADR 0103 and E2E-060d / US-UI-61. |
| D243 | Model-aware image attachment transport | **Amend D197 / ADR 0059: Composer file references retain structured kind/name/MIME metadata. Electron main resolves vision only from the exact pi-ai model record (`input.includes("image")`), stores image bytes as `attachments/<sha256>`, sends eligible images as transient image blocks, and falls back to a safe `@path` for unknown/non-vision or oversized images. Durable messages store refs and metadata, never base64; the renderer shows an accessible capability status.** | The previous path-only contract made a vision-capable GPT model receive a scratch path instead of image content. Keeping capability ownership at pi-ai prevents discovery metadata or unknown model ids from claiming transport the adapter cannot provide, while the path fallback preserves non-vision file-tool behavior (ADR 0101). |
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
| D071 | Transcript interaction parity | **Tool calls render as Codex-style lightweight disclosure rows (caret + name + mono arg hint + spinner/status, clamped inset body) replacing boxed cards; auto-scroll only while pinned to bottom with floating jump-to-latest pill (send / retry / regenerate re-pin per D151); shimmer Working… line with elapsed time; hover copy on messages and code blocks** | Boxed tool cards and forced scrollIntoView diverged from Codex transcript feel; spec 7.4 scroll pause was unimplemented |
| D072 | Typography/radius token enforcement | **All font-size/weight/line-height/letter-spacing/border-radius values must use `@theme` token vars (`--text-*` ramp with `-plus` half-steps, `--font-weight-*` incl. 520/560, `--leading-*`, `--tracking-*`, 12-step `--radius-*`); raw literals in CSS and TSX arbitrary utilities are blocked by `scripts/check-style-tokens.mjs` wired into `pnpm lint`; pixel values preserved exactly (no visual change)** | ~130 scattered literals drifted from any scale; design-system doc §5.2/§6.2 tables were stale vs implementation |
| D073 | Full renderer i18n coverage | **Every user-visible renderer string flows through i18next (`en` source of truth, `zh-CN` via `satisfies EnglishCatalog`): ContextPanel/CommandPalette/PermissionDialog wired; toast/aria/title/placeholder literals keyed; session default titles come from `i18n.t` with a shared case-insensitive `isDefaultSessionTitle` matcher covering legacy titles across locales; proper nouns (VS Code, Finder) and native language names stay untranslated** | Six components bypassed i18n entirely; default-title matching was duplicated in store and Sidebar and missed zh "新对话" |
| D131 | Empty home without suggestion cards | *(starter-grid clause amended by D205, then superseded by D206)* **The empty chat home temporarily rendered only the hero, optional first-run checklist, and composer; the original four Explore / Build / Review / Fix cards, their colored glyphs, and their prompt-prefill actions were removed. This superseded D049/D067 and the original card-specific clauses of D111 while retaining its single scrollable flow layout.** | The direct composer remained the primary task entry; removing the original decorative starter row addressed noisy card treatment. D205 briefly reintroduced a quieter, non-submitting developer grid before D206 returned the empty state to direct entry. |
| D133 | Project index moves to Settings archive | *(five-destination count/order superseded by D166; flat-list presentation superseded by D168)* **The home sidebar no longer has a standalone Projects destination. Settings adds Project archive (zh-CN: 项目归档) after Import and before Info, bringing the compact directory to Basics / Model configuration / Import / Project archive / Info. The archive reuses the durable Projects index and always includes archived records, with search, add, activate, task expansion, pin, archive/restore, and close actions. Project and session groups remain in the home sidebar for active work. Global search exposes the archive as a Settings result, not a standalone page. This supersedes the standalone-destination clauses of D042/D066 and D090's four-destination limit without changing project storage or activation semantics.** | Active project work already lives in retained sidebar groups; moving historical project management into Settings reduces primary navigation while keeping recovery and archive controls discoverable. |
| D168 | Project archive presentation redesign | **Project archive renders three stacked bands: an overview banner (intent sentence, primary Add project, and four derived counters for projects, open, archived, sessions), a toolbar (search with clear affordance and live match count, plus a Recent/Name sort segmented control), and a grouped index whose always-visible sections run Pinned / All projects / Archived with per-section counts, one settings panel per section, and hairline row separators. Rows carry a disclosure control, glyph, name with Active/Open/pinned/Archived tags, one meta line (shortened monospace path, branch, session count), relative last-active time, and hover/focus-revealed New task plus row menu; the menu groups create/edit above pin, archive/restore, and destructive Close, and dismisses on Escape or outside press. Archived rows are grouped and softened, never hidden or filtered, so D133's no-visibility-toggle rule still holds. This supersedes D133's flat-list presentation without changing project storage, search matching, session batching, or activation semantics.** | The flat single-list archive gave equal weight to pinned, working, and archived records and hid its disclosure and row actions behind hover, so scanning a long durable index meant reading every row. Grouping with derived counters and an explicit sort makes state legible at a glance while keeping archived history permanently reachable. |

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
| D101 | WorkBuddy-inspired transcript density | **User turns render as compact right-aligned soft plates (`min(78%, 560px)`, subtle border + hairline shadow). Assistant turns stay transparent full-width prose (max 720px). Message row vertical padding tightens to 10px. Hover/focus-within reveals quiet copy chips under each turn (right-aligned for user, left-aligned for assistant). Streaming assistant answers use a thin accent left rule. No mascot, reactions, or cost-chip UI yet.** | Current right-aligned user bubbles were underspec'd and visually sparse versus WorkBuddy's task chat; denser plates improve scanability without abandoning the Codex/developer restraint |
| D103 | Per-message model + token meta and retry | **Completed assistant turns surface modelId + token usage chips under the answer (tokens-only; hover breakdown for input/output/cache/reasoning). Usage is attached on runtime message_end from pi-ai Usage, persisted in message meta_json, and reloaded with the transcript. Action row adds Retry, which re-sends the nearest preceding user prompt. No currency pricing and no like/dislike.** | WorkBuddy per-message meta improves trust/scanability; token totals already flow from the provider while priced cost still needs a catalog |
| D105 | In-place regenerate for assistant turns | **Regenerate truncates the session transcript to the nearest preceding user prompt (exclusive of that prompt and everything after), disposes the live pi-agent for the session, and re-sends the prompt so the new assistant/tool tail replaces the discarded branch instead of stacking a duplicate turn.** | Users expect regenerate to rewrite the current turn; append-only retry polluted long sessions and left stale answers above the redo |
| D106 | Preserve user hard newlines in transcript | **User bubbles render plaintext with hard newlines intact. Composer only trims leading/trailing whitespace; transcript uses `message-user-text` with `white-space: pre-wrap` (no forced mid-glyph word-break) so multi-line prompts never collapse into one paragraph. Copy and session reload keep the original line breaks.** | Multi-line prompts (code snippets, lists, pasted blocks) are common in coding agents; collapsing newlines makes the transcript hard to re-read and re-edit |
| D107 | Configuration provider studio | **Settings → Agent uses a compact provider studio: a Defaults card, separate vendor-account rows with edit/test/remove actions, modal add/edit dialogs, and card-based AI-service management with secret badges, test connection, and make-default/delete actions. This refines the Providers presentation inside the compact settings directory without adding rail destinations.** | Dense stacked forms, a redundant summary hero, and cramped list rows made multi-provider setup hard to scan and over-emphasized secondary fields |
| D110 | Model configuration label + add-provider dialog | **Settings rail label for the agent destination is Model configuration (zh-CN: 模型配置). Adding a provider opens a modal dialog instead of an inline collapsible composer; the destination id remains `agent`.** | Clarify the model-setup purpose of the tab and reduce page churn while editing provider credentials |
| D108 | Conversation minimap only when overflowing | **The left-edge conversation minimap rail renders only when at least two visible user/assistant messages exist and the transcript overflows one viewport (`scrollHeight > clientHeight`). Short one-page threads hide the rail; streaming growth, content resize, and window resize re-evaluate visibility.** | A navigation rail is noise when every message already fits on screen; overflow is the signal that jump/preview navigation is useful |
| D109 | ChatGPT-style regenerate revision history | **Regenerate archives the discarded assistant/tool tail under a stable `revisionRootId` family in `message_revisions` (schema v4). The live root user turn carries `revisionCount` / `activeRevision` and a quiet `current / total` pager switches linear variants in place. First regenerate stores the original branch as revision 1; later regenerates append new branches and mark the newest active. No free-form branch tree.** | Users expect regenerate to keep prior answers reachable like ChatGPT; D105 in-place rewrite alone deleted history that was still useful for comparison |
| D111 | Empty home scroll stack | *(card-specific clauses superseded by D131)* **Empty chat home is a single scrollable vertical stack inside `home-main-content`. Short windows top-align and scroll; content stays in document flow and the home composer remains non-docked.** | Dual-grow + absolute portal let the home composer overlap guidance on shorter windows; flow layout preserves every remaining block without collision |
| D112 | Readable chat beside the work panel | *(dynamic width clamp superseded by D163; welcome chooser superseded by D128)* **MainChat has a 360px readability target beside the panel. D163 preserves it through native width reservation whenever the display work area can supply the complete committed panel width; otherwise MainChat absorbs the unavoidable shortfall while the panel remains fixed.** | A panel-only width cap could leave roughly 109–205px for chat at supported window sizes; native reservation now preserves chat without compressing the tool surface. |
| D113 | WorkBuddy-inspired local profile footer | **The expanded sidebar ends in a transparent 58px footer. Its 44px profile trigger contains a 30px circular local-user glyph, two-line `Custom` + `Local profile` / `本地配置` identity, and a chevron; a separate 32px Help shortcut opens Settings → Info. The 280px profile menu opens 8px above the footer with a repeated identity header, divider, and Settings / Logs / Theme actions, preserving Escape, outside-click, arrow-key, and focus-restore behavior. This supersedes D041; no cloud account, notification, share, or update capability is implied.** | Adapt WorkBuddy's avatar-and-actions footer grammar to PI-Desktop's truthful local-only capabilities while improving identity hierarchy and eliminating the stale cloud stand-in |
| D137 | Glyph-only message toolbars; edit means edit-the-prompt | **Message toolbars carry icons only: the label lives in a CSS hover/focus tooltip (`data-tip`) plus `aria-label`, never as a visible chip caption (worded buttons stay only on error surfaces). Edit moves off the assistant answer onto the user turn: it opens the prompt in an inline textarea (slash turns seed the typed `command` form so the resend re-expands the template) and saving replays the D105/D109 regenerate path with the new text in the same session — the replaced prompt and its whole answer tail are archived as a revision, so the existing `current / total` pager walks back to the original. Editing the assistant's own text and its fork-into-a-child-session variant (D134) are dropped; Fork stays as the explicit divergence action.** | Four worded chips under every answer read as a sentence and crowded the transcript; and the useful correction is almost always "I asked it wrong", which users expect to re-run in place with history intact (ChatGPT semantics) rather than to hand-edit the model's words in a new session |
| D165 | Safe lazy Mermaid diagrams in assistant answers | **A completed `mermaid` fence in assistant answer prose renders as a theme-aware SVG after entering the near-viewport band. Partial stream fences and all thinking prose stay source code. The renderer dynamically loads official Mermaid, serializes its global theme renders, caps source at 20,000 characters and edges at 500, locks strict/no-HTML/no-link configuration, and applies a second SVG-profile sanitizer. Invalid or oversized diagrams fall back to visible copyable source; the diagram toolbar toggles source and copies it.** | Diagrams improve architecture and flow explanations, but parsing partial streams or every offscreen historical fence would undermine direct-stream and fast-session-switch behavior. Strict bounded local rendering adds the capability without a new protocol, network, or Electron privilege boundary. |

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
| D153 | Reasoning sessions default to maximum thinking | **A newly created session whose inherited default model supports reasoning starts at the highest canonical entry in that model's pi-published `supportedThinkingLevels`. Non-reasoning models and missing capability metadata start at `off`; existing sessions retain their durable choice. This refines D096 without adding a provider override.** | Reasoning-capable models should use their strongest available effort by default while preserving explicit per-session choices and pi-ai's model authority. |


## T. Release delivery decisions

| ID | Topic | Decision | Rationale |
|---|---|---|---|
| D126 | Three-platform release delivery (lifts D010) | **Tag builds publish every artifact the matrix produces to the GitHub Release: macOS dmg/zip (arm64), Windows NSIS x64, Linux AppImage + deb (x64), each with blockmaps and the platform's `latest*.yml` electron-updater feed. Publishing the feeds activates D120's in-app update lanes for Windows NSIS and Linux AppImage; macOS stays in notify-and-link mode until a signed channel is qualified. The NSIS artifact name is pinned space-free (`PI-Desktop-Setup-${version}.${ext}`) because GitHub asset URLs mangle spaces. D010's macOS-only scope is lifted per the baseline-bump rule (baseline `0.4.7`); the release pipeline itself was qualified end-to-end on v0.1.1-rc.1/v0.1.1.** | The pipeline builds and validates all three platforms on every tag anyway; keeping installers as expiring Actions artifacts (90-day retention) withheld them from users without adding safety. Publishing the update feeds is the point of shipping: platforms with in-app lanes update silently, and future platform regressions surface through real installs instead of unused artifacts. |

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
- Decision D153.

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

## 2026-07-31 — Project archive presentation redesign

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
- Decision D168; supersedes D133's flat-list presentation.

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
  execution; the duration timer includes tool execution.
- A timeout returns `timed_out` with `SUBAGENT_IDLE_TIMEOUT` or
  `SUBAGENT_DURATION_TIMEOUT`, preserving the latest partial assistant output
  where available. Fatal provider errors, parent aborts, and explicit
  per-definition `maxTurns` remain unchanged.
- `maxTurns` is now optional (`none`, `0`, and omission mean unlimited), with
  explicit values capped at 80. Definitions may override the watchdogs via
  `idle-timeout` and `max-duration` within their documented bounds; invalid
  values warn and fall back to defaults.
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
