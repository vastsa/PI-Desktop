# PI-Desktop Baseline Freeze

- Baseline Version: `0.4.16`
- Date: `2026-08-14`
- Status: `Frozen for implementation details (Plan checkpoint artifact + approval/execution startup fence + protocol v9 + schema v10 + selectable shell catalog + icon-free composer prompt row + turn-boundary context checkpoint compaction + session-scoped work panel + models.dev model catalog with a bundled release snapshot + provider/runtime safety + M5 hardening + settings IA + project archive + sidebar organization + app update delivery + three-platform release + Extensions page density and theme-readable actions + custom global UI font)`
- Language policy: **English-first**
- Backend policy: **Rust host core + pi agent sidecar**

> Version history: `0.3.4` froze provider/runtime-safety decisions
> (D001–D033). `0.4.0` absorbs the Codex visual-parity decision series
> (D034+, gold source = decisions-log §D) and the M5 hardening decisions
> (D078–D083: signing lanes, brand icon, supervision, renderer sandbox,
> log channels, window state). `0.4.1` freezes the compact four-destination
> settings directory from D090 / ADR 0013. `0.4.2` replaces the frozen 720px
> settings content cap with the window-responsive D092 / ADR 0015 layout.
> `0.4.3` adopts retained multi-project sidebar tabs, non-destructive
> project/session organization, and session-rooted tool isolation through
> D093 / ADR 0016. `0.4.4` removes the passive composer context rail through
> D095. `0.4.5` freezes end-to-end thinking levels and provider presets through
> D096/D102 and ADR 0018. `0.4.6` supersedes D020's blanket deferral with the
> packaged application update modes in D120 / ADR 0022 while preserving D010.
> `0.4.7` lifts D010's macOS-only release scope through D126: tag builds
> publish installers and electron-updater feeds for macOS arm64, Windows x64,
> and Linux x64.
> D285 adds a native macOS Intel x64 tag lane alongside the arm64 lane; both
> macOS architectures publish DMG/ZIP artifacts from their matching runners.
> `0.4.8` moves the durable Projects index out of the home sidebar and into
> Settings as the fifth **Project archive** destination through D133 / ADR 0026.
> `0.4.9` made the pinned pi-ai catalog authoritative for known-model metadata
> and removed desktop-owned model parameter overrides through D136 / ADR 0027.
> ADR 0133 / D266 first introduced models.dev as a remote primary; ADR 0134
> supersedes that fallback design and makes models.dev the sole metadata source
> with a checked-in release snapshot. pi-ai remains the transport, OAuth, and
> account-availability layer.
> `0.4.10` replaces destructive work-panel clearing on conversation switches
> with runtime session-scoped contexts through D142 / ADR 0028.
> `0.4.11` adopts turn-boundary model-context checkpoint compaction through
> D158 / ADR 0030 while preserving the complete visible transcript. The
> context-recovery amendment in ADR 0049 adds a durable retained-tail
> fallback for automatic compaction failures. D200 / ADR 0061 derives the
> budgets from the model window instead of settings and removes the compaction
> settings. D203 / ADR 0064 then rebuilds the mechanism to match Codex:
> compaction is inline only, a checkpoint carries the summary plus the latest
> active user message only while a turn continues; completed turns
> carry no naked historical user messages. The model-facing `new_context` tool
> and two budget reminders are
> back, each compaction adds a transcript row and one warning, and a
> no-summary rollover family exists behind an internal switch.
> `0.4.12` standardizes home and thread-docked composer prompt rows without a
> leading brand mark through D160 / ADR 0031 while preserving shell branding
> elsewhere.
> `0.4.13` replaces the Chat operating profile with the Plan operating state
> through D188 / ADR 0052. Plan is the same pi Agent in planning state, keeps
> permission-mode selection, exposes Bash subject to that policy, denies
> Write/Edit/plugin tools, and submits structured plans through a separate
> host-owned approval transition. The host protocol is v7 and storage schema
> v8; persisted Chat values migrate to Plan while Agent remains the default.
> `0.4.14` replaces that proposal with immutable host-written Markdown
> checkpoints under `<workspaceRoot>/.pi/plan/*.md` through D189 / ADR 0053.
> SubmitPlan accepts title, Markdown, and question; the Markdown bytes are
> preserved exactly while title/question remain structured approval fields.
> Approval is approve/reject only with explicit permission selection defaulting
> to Ask, and opens the artifact for review. Pending, queued, and running work
> is interrupted by the startup process fence without replay, while an
> already-approved session remains Agent. ADR 0054 adds the selectable shell
> catalog while retaining the Bash protocol name. The host protocol is v9 and
> storage schema is v10.
> `0.4.15` amends the D169 Extensions presentation through D196 / ADR 0058:
> the four-card numeric overview band is removed, and shared button surfaces
> use semantic theme tokens so primary and secondary actions remain visible in
> dark and light themes. No host protocol or storage schema changes.
> `0.4.16` adds a user-selectable global UI font through D232 / ADR 0083: the
> Settings Appearance card gains a searchable Font picker; the selection
> persists as `AppSettings.fontFamily` and overrides `--font-sans`. Four
> open-licensed (SIL OFL 1.1) families — Geist, Inter, Noto Sans SC, and
> LXGW WenKai — ship locally with license texts, and installed system
> families are enumerated by Electron main through the additive allowlisted
> channel `pi-desktop/app/systemFonts`. No host protocol or storage schema
> changes.

## Frozen Decisions

1. Product name: **PI-Desktop**
2. Desktop shell: **Electron**
3. UI: **React + TypeScript + Vite + Tailwind**
4. UI language default: **English**
5. Docs / issues / commits language: **English primary**
6. Agent engine: **pi (`pi-ai` + `pi-agent-core`)**
7. Backend host core: **Rust**
8. Agent loop location: **Node/TypeScript pi sidecar** (not renderer)
9. Electron main role: **thin orchestrator**
10. Bridge: **preload IPC only for renderer**
11. Host services transport: **Rust sidecar + stdio JSON-RPC (NDJSON)**
12. Storage ownership: **Rust host-core owns SQLite exclusively**
13. MVP domain: **local coding agent**
14. Default mode: **Agent**
15. Product operating selector: **Agent | Plan**; the internal `page = "chat"`
    value remains a conversation-surface implementation detail, not an
    operating mode
16. Agent tools: **Read / Glob / Grep / Write / Edit / Bash**
17. Permission timeout: **120s → deny**
18. Session grant scope: **by toolName**
19. `~/.pi` auto-import: **not in MVP**
20. Not in MVP: **Gateway / remote WebUI control**
21. Extension model: **user-installable plugin system**
22. Plugin first phase: **commands / panel / agentTools / skills**
23. Plugin runtime target: **separate process**; M4 may use host-managed sandboxed runtime
24. Plugin market: **protocol defined, implementation postponed**
25. Plugin package format: **`.piplug` (zip)**
26. Plugin trust first step: **sha256 checksum; signature later**
27. First release platform: **macOS arm64 only** — lifted in `0.4.7`/D126;
    tag builds now publish native macOS arm64 and Intel x64, Windows x64, and
    Linux x64 artifacts
28. TS schema library: **typebox**
29. i18n library: **i18next**
30. Bash: **non-interactive, streamed, and resolved from the selectable shell
    catalog; default timeout 60s with a bounded override**
31. Onboarding: **inline checklist**
32. Observability MVP: **local logs only**
33. Error model: **shared AppError code registry**
34. Provider coverage: **universal via pi-ai native + OpenAI-compatible + custom**
35. Model policy: **no closed allowlist; models.dev release catalog, generic unknown IDs, and free-form model IDs**
36. Provider storage: **Rust SQLite configs + OS secret store references**
37. Secrets backend: **safeStorage primary + encrypted file fallback**
38. Workspace ignore: **denylist + defaults + `.pi-desktopignore`**
39. Tool result limits: **256KB / 4000 lines with truncation markers**
40. Settings directory: **Basics / Model configuration / Import / Project archive / Info**;
    the project archive owns durable project discovery, archive, restore, and
    reopen workflows;
    plugin management remains the app shell's independent **Plugins** destination
41. Sidebar organization: **retained multi-project tabs with renderer-local
    project/session pin, archive, collapse, and sort metadata**
42. Project activation: **one visible host workspace via existing
    `project.set`; tool roots remain bound to the originating session project**
43. Context management: **pi-native checkpoint summaries in Codex's shape —
     inline compaction at the deterministic pre-request hard guard, the summary
     plus only the latest active user message while a turn continues (and no
     naked historical user messages after a completed turn), durable host
     checkpoints, and one overflow retry. The model can request a new window through
     `new_context`; every compaction adds a transcript row and one warning.
     No user-facing settings**
44. Plan tools and policy: **Read / Glob / Grep / BrowserPreview / Bash plus
    `EnterPlanMode` and `SubmitPlan`; Write/Edit/plugin and
    unknown tools are denied. Bash follows `ask`, `accept-edits`, or `auto`, so
    Plan is planning intent, not a strict read-only security profile.**
45. Plan checkpoint: **`SubmitPlan(title, markdown, question)` causes host-core
    to preserve the exact Markdown bytes in a new unique
    `<workspaceRoot>/.pi/plan/*.md` artifact, while title/question remain
    structured fields in the existing `plan_approvals` row. The row records the
    artifact path/hash/size and execution fields. Approve/reject are the only
    actions; approval explicitly selects `ask`, `accept-edits`, or `auto` with
    Ask as the UI default, opens the artifact for review, and expires after 30
    absolute minutes with `PLAN_APPROVAL_TIMEOUT`.**
46. Plan recovery and shells: **a startup transaction marks prior pending,
    queued, and running Plan work interrupted before serving RPC, with no
    replay; an already-approved interrupted execution leaves the session Agent.
    Configuration is idle-only and each session has one running turn.
    The renderer may stage one latest next-turn configuration while a turn is
    running, but it submits that choice only after the host reports idle.
    `defaultCommandShell` selects the platform catalog entry; unavailable
    persisted choices fall back to the first available platform shell, each
    turn pins effective ID/dialect, and host rejects stale identity before
    streaming output under the 60-second default timeout.**

## Source of Truth

- Spec index: `docs/spec/README.md`
- Navigation: `docs/spec/NAV.md`
- Decisions log: `docs/spec/08-meta/decisions-log.md`
- ADRs: `docs/adr/`
- Example plugin: `examples/plugins/hello`

## Delivery Status

**M6 — Plan** was implemented and accepted on 2026-08-05 against these frozen
details:

1. shared Plan/session/shell contracts and protocol v9
2. schema v10 migration, immutable plan artifacts, and the `plan_approvals`
   execution fields/startup fence
3. Rust-authoritative Plan policy, shell identity, and process cancellation
4. one-Agent SubmitPlan/approval/execution state transitions
5. renderer artifact approval, shell selection, and EN/zh-CN UX
6. focused migration, policy, streaming, timeout, recovery, and rendered
   EN/zh-CN verification

The frozen protocol remains v9 and storage schema remains v10. Future changes
must preserve the automated M6 scenarios E2E-104 through E2E-117 or update the
relevant decision record before changing the contract.
