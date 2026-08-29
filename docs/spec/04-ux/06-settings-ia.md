# 06. Settings Information Architecture

## 1. Settings root (Codex full-page shell)

Settings is a **full-window page** that replaces the app sidebar + main chrome (Codex electron behavior):

- Left settings rail only (sidebar surface `#f4f4f4` light / `#000` dark), **~275px** (Codex gold at 1200-wide)
- Top of rail: traffic-light clearance, **Back to app** (`返回应用`), pill **Search settings…**
- The 46px top band is a native window drag region across both the rail and the
  content pane, but it is drawn in two parts so each keeps its own surface: the
  rail drags via its own top strip on the rail surface, and the content pane's
  band starts at the rail edge on the primary surface. The band must never paint
  the primary surface over the rail, which would show two colors in one top row.
  Interactive controls remain explicitly non-draggable
- A compact navigation directory with icons, in this exact order:
  1. **Basics** — Lucide `SlidersHorizontal` (appearance)
  2. **全局 AI / AI** — Lucide `Sparkles` (permissions, defaults, command shell)
  3. **Shortcuts** — Lucide `Keyboard` (keyboard shortcuts)
  4. **Instructions** — Lucide `FileText` (global and project instruction files)
  5. **Model configuration** — Lucide `Bot` (providers and default model)
  6. **Import** — Lucide `Download` (bring sessions in from other tools)
  7. **Project archive** — Lucide `Archive` (durable project index)
  8. **Info** — Lucide `Info` (versions, logs, updates, developer)
  Icons are decorative (`aria-hidden` via the SVG default) and stay monochrome
  with the rail label; do not reuse refresh/rotate glyphs here.
- The directory remains a flat searchable list in the same exact order. For
  scanability, the destinations are shown in four titled visual clusters:
  `Personal` / `个人` (Basics, AI, Shortcuts), `Agent` / `智能体` (Instructions,
  Model configuration), `Workspace` / `工作区` (Import, Project archive), and
  `About` / `关于` (Info). Headings are muted, non-interactive labels and use
  whitespace for separation; no divider lines are rendered. These are visual
  landmarks only, not a second navigation level. When search filters the
  directory, empty clusters and their headings disappear.
- No additional settings destinations or placeholder navigation rows are shown
- Main content pane on primary surface with large section title + elevated
  rounded cards of rows. Its content uses the full width available after the
  fixed rail and pane gutters, and resizes continuously with the window.

## 2. Section contents

### Basics
- **Appearance** card:
  - **Theme**: three selectable preview cards (System / Light / Dark, System
    first) with a live mini-window mockup, a per-option description, and a
    selected check badge; selection updates `settings.theme`
  - **Language**: three selectable preview cards (Auto / 简体中文 / English) with
    a sample-text preview, a per-option description, and a selected check badge;
    selection updates `settings.language`
  - **Font**: a searchable picker row (trigger shows the current family rendered
    in that face) offering the System default, bundled open-licensed families
    (Geist, Inter, Noto Sans SC, LXGW WenKai — SIL OFL 1.1, shipped locally),
    and installed system families enumerated by Electron main; selection
    persists as `AppSettings.fontFamily` and applies to the global UI stack
    (`--font-sans`) without a reload; System default clears the override;
    long system lists are windowed so only the visible slice is in the DOM
    (bounded font loading) and opening the picker never blocks input
  - **Auto language detection** resolves the OS locale through the main process
    (`app.getLocale()`) rather than the renderer's `navigator.language`, and the
    Auto card shows the detected language inline (e.g. "当前：简体中文")
  - native select triggers and their opened option lists use the active theme's
    readable foreground/background pairing on macOS, Windows, and Linux; the
    shared native-select contract applies to every app surface
- Platform-specific **Close behavior** remains in Basics because it changes
  application-window behavior rather than agent behavior.
- File-open target, menu-bar behavior, and bottom-panel behavior are not
  rendered until their host-backed settings schemas and runtime effects exist.

### 全局 AI (`ai` tab)
- **Permissions** card: the global permission-mode control
  (ask / accept-edits / auto) that governs how autonomously the agent acts.
- **Defaults** card: the host-backed default operating mode (Agent / Plan / Goal),
  command shell selection, Enter-to-send control, and the large text paste
  threshold. The threshold controls when a text-only paste becomes a temporary
  session-scratch file; it defaults to 600 characters and accepts integer values
  from 1 through 1,000,000.
- The **Command shell** row in Defaults uses the host-discovered catalog of native PowerShell,
  cmd, Git Bash, and Bash with IDs `windows-powershell`, `cmd`, `git-bash`, and
  `bash` where supported. The selected `defaultCommandShell` persists across
  restart; writes reject unavailable or wrong-platform IDs. If a persisted
  choice later becomes unavailable, the first available platform shell is used
  and the fallback state is shown. When the selected shell is available, the
  selector is the only configured-state indicator; status text is reserved for
  the default, fallback, and no-effective-shell cases. A Bash turn verifies its
  pinned ID/dialect before execution.
- Context management has **no card and no controls** (D200 / ADR 0061, kept by
  D203 / ADR 0064). Automatic protection is always on and its budgets and
  retention limits are derived from the active model's window, so there is
  nothing a user could tune from here — the reference implementation does not
  expose these values either. Settings search indexes no compaction keys.
  Manual `/compact` remains available from the command palette for an idle
  session; the transcript shows where each compaction happened and the context
  usage inspector shows whether a checkpoint is installed.

### Shortcuts (`shortcuts` tab)
- **Keyboard shortcuts** card:
  - lists navigation, agent, and window actions from one shared shortcut map
  - renders platform-native modifier labels (`⌘` on macOS, `Ctrl` on
    Windows/Linux) and the platform-specific full-screen default
  - clicking a binding records the next modifier chord or `F1`–`F12`; `Escape`
    cancels recording
  - duplicate application bindings and operating-system/editor-reserved chords
    are rejected with an inline error
  - each override can be restored independently and all overrides can be
    restored together
  - overrides persist in optional `AppSettings.keybindings`; macOS native-menu
    accelerators and renderer-owned shortcuts update from the same map
  - the plugin launcher defaults to `Option + Space` on macOS and `Alt + Space`
    on Windows/Linux; its native global registration follows the same override,
    while the focused frameless window retains an `Alt + Space` fallback

### Model configuration (`agent` tab)
- **Defaults** card: the default provider/model selector. Its native options
  show the provider name only; account labels and model IDs are not appended to
  the visible option label. Global operating mode, command shell, and
  Enter-to-send are owned by the AI destination.
- **Vendor accounts** card (D237/D240), between Defaults and Providers:
  - the card lists accounts, not vendors: one row per local OAuth provider row,
    including multiple rows for the same vendor. Its list surface uses the same
    single-level panel and row structure as AI services. The whole section is
    hidden when the runtime catalog offers no OAuth vendor
  - a primary Add account action in the card header opens every OAuth-capable
    vendor; existing accounts do not remove or disable that vendor from the
    picker, so the same vendor can be added again for a different account
  - an account row shows the vendor name, a Subscription badge where the access
    is plan-backed, a Connected or Needs sign-in badge, and the account label.
    Duplicate accounts receive a stable account number in the row; the default
    model remains available in Defaults and the account editor
  - picking a vendor opens a single dialog that renders whatever the flow asks
    for — an opened browser with a copyable link, a device code, a choice, or a
    text field — with a cancel action that aborts the local callback server or
    the polling loop
  - Remove account is a destructive, two-step action. It deletes that account's
    OAuth credential and provider row, clears or repairs the global default when
    needed, and leaves other accounts from the same vendor untouched
  - Edit account opens a compact dialog for the account name and default model;
    the default-model field is an app-owned searchable combobox with aligned
    model IDs and display names, keyboard selection, and free-form model IDs;
    its fixed, collision-aware suggestion layer is portaled above the dialog
    and does not participate in dialog sizing or get clipped by dialog overflow.
    Saving updates the OAuth provider row and keeps the global default model in
    sync when that account is selected
  - Test connection resolves the account's OAuth authorization and reports a
    transient success or failure without probing the provider with an API key
- **Providers** studio:
  - OpenAI-compatible and custom-service add-provider dialog (opened from Add
    provider / empty-state CTA)
  - provider cards with host, first configured model, secret status,
    and test / make-default / delete actions
  - Add account and Add provider use the same primary button treatment
  - the add/edit dialog configures connection identity (name, endpoint, API
    style, and secret), then selects one or more models from a searchable
    multi-select catalog. Each selected model has an independent, compact
    configuration row for context window, max output, supported thinking
    levels, and the default thinking level. The row keeps the model ID,
    source, capabilities, and token limits visible at a glance, and expands
    in place for edits. The first row starts expanded so the form remains
    discoverable; additional rows stay collapsed to keep large model sets
    scannable. The bundled models.dev release snapshot pre-fills known rows; custom IDs
    absent from it use the runtime generic values. The portaled
    option list can scroll without dismissing the picker; scrolling an
    outside settings container dismisses it before the trigger can become
    detached. Search results keep a dedicated no-match state instead of
    reusing the search placeholder.
  - each model option and configuration row shows a compact text/vision
    capability state. Vision is derived only from the exact models.dev model
    record; provider discovery or a user-entered ID cannot promote an unknown
    model to image transport.
  - model discovery is debounced after a valid endpoint, key, or API style
    change, including no-auth/local endpoints; the picker remains usable with
    free-form custom model IDs when discovery is unavailable
  - thinking chips follow canonical order. Removing the current default falls
    back to the first enabled level; no enabled levels disable the default
    selector and show the model's thinking-disabled hint
  - selecting the **OpenCode Go** API style applies the fixed name
    **OpenCode Go** and endpoint `https://opencode.ai/zen/go/v1`; those two
    fields remain visible but read-only, the API key remains editable, and
    model discovery continues through the fixed endpoint
  - helper copy stays out of the model cards; labels, status badges, and the
    empty/error state carry the necessary context without explanatory
    paragraphs
  - empty state with primary add action
  - API keys are never shown raw after save
  - vendor-account rows are not rendered in the AI services list; a connected
    vendor account can still be selected in Defaults and is managed only in the
    Vendor accounts card

The permission-mode selector remains available in the composer while the
session is in Agent, Plan, or Goal. In Plan and Goal it controls Bash
confirmation only: Ask and Accept edits prompt, while Auto may run a mutating
Bash command without confirmation. The AI Defaults card must describe that both
contract modes are intent boundaries, not strict read-only security profiles.

### Agent capability destinations (Skills / MCP / Subagents)

Skills, MCP servers, and user-owned Subagents remain three independent
destinations under the Agent group. They share a capability-management visual
system while preserving their different data ownership:

- Each capability page starts with a quiet, page-specific description and a
  short scope note on one shared line rather than a decorative hero or alert.
  Light and dark themes use the shared Settings surface, typography, borders,
  and semantic tokens; capability pages do not introduce a separate color
  system.
- Each page is one workbench, not a stack of per-level sections (D257): a
  single toolbar above a single elevated panel. The toolbar carries the level
  filter as a segmented control with live counts (All / Global / Project), one
  search field with a clear affordance, the selected-project picker, and the
  page's primary actions right-aligned. Subagents omits the filter and the
  picker because it is global-only, keeping only search and its actions.
- The level filter narrows which groups the panel renders; it never hides the
  toolbar or moves the actions. New capabilities are created at the level the
  filter points at — Global under All or Global, Project under Project — and
  the primary action's tooltip names that destination so the choice is never
  implicit. Choosing Project without a selected project reports that instead
  of failing silently.
- Inside the panel, each level is a group header row — level name, resolved
  `.agents` path in mono, localized count — followed by its rows. Lists flow
  at natural page height like every other Settings surface; the page scrolls
  as one document instead of nesting fixed-height scroll wells.
- Rows follow the provider-row rhythm: a quiet muted icon, name, a level badge
  plus any source/transport badges, single-line description, optional mono meta
  (MCP target, subagent tool grant), then the row actions. Every row carries
  its own level badge so a row scrolled away from its group header still says
  where it lives. MCP expresses connection state only through a small status
  dot inside the state badge — the only color on an otherwise monochrome row.
  Disabled rows dim their icon and copy while keeping the switch fully legible.
- Row actions are Edit, an overflow menu, and the enablement switch. Edit and
  the overflow menu stay quiet until the row is hovered, focused, or has its
  menu open; the switch is always visible because enablement is the state the
  list is read for. Without hover the quiet actions are always shown. The
  overflow menu holds the level-aware destructive and out-of-app actions —
  Reveal and Remove for skills and subagents, Test connection and Remove for
  MCP — and Remove arms on first press, relabels to ask for confirmation, and
  disarms on its own if the menu is dismissed or left alone.
- Skeleton rows appear on first paint only. A later refresh keeps the rows it
  already has and dims the list instead, announcing the refresh to assistive
  technology, so toggling a switch never replaces the list with skeletons.
  Enablement flips locally first and reverts only if the host refuses, and
  busy state is scoped to the row that is working — one pending request never
  disables the rest of the page. Empty states are quiet centered
  glyph-and-copy blocks inside the panel; an empty level offers the same
  primary action rather than being a dead end, and a search with no matches
  says so and suggests widening the level filter.
- When the viewport is narrow the toolbar stacks: the segmented control spans
  the width with evenly divided segments, search sits below it, and the
  actions wrap left-aligned. Group headers drop the resolved path so row copy
  keeps the width.

### Instructions (`instructions` tab)
- Edit the global instruction Markdown used by every PI-Desktop Agent session.
- Show the resolved instruction-file path and save through the host-backed
  instruction API; project instructions remain managed from the active project
  menu and are resolved after the global layer.

### Import
- Scan supported local agent stores and review candidates through
  `SessionImportPanel`
- Source and project-path grouping behavior follows
  [08-component-spec §18](08-component-spec.md#18-sessionimportpanel)

### Project archive
- Reuses the durable Projects index as a settings-scale management surface
- Always includes archived records; archived rows are grouped, never hidden, so
  the destination still has no visibility toggle
- Supports project search, add, activate, project-session expansion, pin,
  archive/restore, and close
- The destination is one workbench, not a stack of bands (D267, revising D168):
  a quiet intro line above a single toolbar above a single elevated panel. It
  reuses the same composition, control height, and row rhythm as the agent
  capability pages (D257) and adds no page-specific chrome.
  1. **Intro line** — one quiet description line, the same shape as the
     capability pages' intro. The destination shows no page-level totals: there
     is no hero block, decorative gradient, counter banner, or inline counter
     run. The per-group counts on the panel's header strips are the only totals,
     so a number is never repeated in two places
  2. **Toolbar** — one row carrying the Recent/Name sort as the shared
     segmented control, the search field with a clear affordance and a match
     count while searching, and the primary Add project action right-aligned
  3. **Panel** — one settings panel holds every group. The always-visible
     sections run Pinned, All projects, Archived as non-interactive in-panel
     header strips, each carrying its label and row count. Every section is a
     labelled region wrapping its own list, so the strip is never a non-list
     child of a list and each row keeps its group name in the accessibility
     tree; rows follow with hairline separators. Empty sections are omitted,
     and an index with no rows renders one quiet in-panel empty state instead
     of the panel groups
- Row anatomy: disclosure control, color glyph, project name with state tags
  (Active, Open, pinned tag, Archived), one meta line carrying the shortened
  monospace path, branch, and session count, a relative last-active time, and a
  hover/focus-revealed action pair (New task, row menu). The colored glyph uses
  Folder for ordinary projects and a filled Star for pinned projects, while the
  pinned tag remains as the localized text cue.
- The row menu groups create/edit actions above pin, archive/restore, and the
  destructive Close action, and closes on Escape or any outside press
- Project search also matches session titles. Matching a session retains and
  expands its owning project; expanded sessions are ordered by latest activity,
  show a count and relative update time, and reveal additional rows in batches
  of eight rather than silently truncating the history
- Activating a project or project session returns to chat; archive and close
  actions keep Project archive open even when the active workspace changes

### Info
- app/host/protocol versions + open logs
- Updates row with the current delivery state and one applicable action:
  Check for updates, View release, or Restart to update
- **Developer** card:
  - developer mode is off unless the optional persisted
    `AppSettings.developerMode` value is `true`
  - the developer mode switch unlocks the Open console button, F12 on every
    platform, Ctrl+Shift+I on Windows/Linux, and the macOS View-menu developer
    tools item
  - disabling developer mode closes an open console and disables or removes
    every entry point; Settings search indexes the card, switch, and console
    action
- The Updates row always exposes a Release notes action. It opens a modal
  containing the complete shipped stable changelog in newest-first order,
  localized to the product language and marking the current and available
  versions when present
- When an update is available, downloading, or downloaded and Main attached
  dual-locale product notes, the Updates row shows a compact "What's new"
  list under the status text (same notes as the ambient banner; D164). The
  full-history modal remains available when the app is up to date or update
  checks are disabled in development

## 3. Navigation rules

- Profile footer / command palette open Settings full page (default Basics)
- Composer model menu and provider setup actions deep-link to the Providers
  card inside Agent
- Plugin management remains available from the app shell's independent
  **Plugins** destination, including load, enable, disable, and uninstall; it is
  not duplicated in Settings
- The marketplace source selector lives inside **Plugins → Marketplace**, next
  to the catalog controls; it is not a separate Settings destination.
- Project archive is indexed by Settings search and is not duplicated as a home
  sidebar destination or standalone global-search page
- Back to app returns to chat shell

## 4. Acceptance

1. Opening Settings hides the coding app sidebar (full-page takeover)
2. Rail shows search + back and exactly Basics, 全局 AI/AI, Shortcuts,
   Instructions, Model configuration, Import, Project archive, and Info in that
   order
3. Appearance is part of Basics and has no standalone rail destination
4. Providers is part of Agent and has no standalone rail destination
5. Plugins has no Settings destination; the app-shell Plugins page supports
   load, enable, disable, and uninstall
6. Basics shows the host-backed Appearance card; the AI destination shows
   Permissions and Defaults, including the Command shell row; the Shortcuts
   destination shows the Keyboard shortcuts card; Info shows the Developer card.
   No additional settings destinations are rendered
7. Provider secrets never display raw key values
8. Model configuration shows compact Defaults, separate vendor accounts, the
   account edit/add dialogs, and AI service cards rather than a dense always-on
   form dump
9. Row descriptions use semantic secondary text and maintain at least 4.5:1
   contrast against their card surface in both light and dark themes
10. Dragging the empty top band from either side of Settings moves the native
   window without blocking Back, search, or navigation controls
11. Resizing the window expands or contracts the content cards with the
    available content pane; the fixed rail and pane gutters remain intact and
    the page does not gain horizontal overflow
12. Project archive always exposes archived records and can restore them without
    duplicating the index in the app shell
13. Project archive renders one quiet description line — no hero, banner, or
    page-level counter run — above one search + sort toolbar and one panel
    containing the Pinned / All projects / Archived group strips; each strip's
    count agrees with its rendered rows, sorting reorders rows inside every
    section without hiding any, and clearing the search restores the complete
    index
14. Info renders disabled, checking, up-to-date, available, downloading,
    downloaded, and error update states without adding another destination
15. Native select option lists remain readable in both light and dark themes,
    including when Chromium delegates the opened list surface to Windows; the
    same global rule covers non-Settings native selects
16. Shortcut recording rejects modifier-free non-function keys, reserved
    editor/OS chords, and conflicts; successful overrides immediately drive
    app behavior and macOS menu accelerators and survive restart
17. Developer tools remain unavailable by default; enabling developer mode
    unlocks the localized Settings action and platform shortcuts, persists
    across restart, and disabling it closes an open console
18. Context management exposes no settings at all; protection is always on and
    its budgets scale with the active model's context window, so no persisted
    value can leave a small-window model uncompactable or the guard disabled
19. The default operating-mode selector contains Agent, Plan, and Goal; legacy
    Chat values migrate to Plan and do not reappear as a selectable option
20. Command shell selection persists a platform-valid catalog ID, exposes
    status only when it adds information (default, unavailable, fallback, or no
    effective shell), and never authorizes a stale ID/dialect
21. Skills, MCP, and Subagents each render one toolbar above one panel; the
    level filter changes which groups appear without hiding the toolbar or the
    primary actions, and the counts on the segments agree with the rows the
    panel renders under the active search
22. Each capability page can create, edit, and delete a capability without
    leaving Settings; new capabilities land at the level the filter points at,
    the primary action names that destination, and choosing a project level
    with no selected project reports it instead of failing silently
23. Removing a capability requires two presses of the same menu item, the
    second press labelled as the confirmation, and the arming lapses on its own
    if the menu is dismissed
24. Revealing a project-level skill opens that project's file, not a global
    file of the same id
25. Toggling one capability leaves every other row interactive, does not
    replace the list with skeletons, and restores the previous switch position
    if the host rejects the change

## 5. Basics chrome metrics

The shell retains the Codex gold chrome while allowing the content pane to use
the current window width:

| Token | Value |
|---|---|
| Rail width | ~275px (`--ds-settings-nav-width`, shared by the rail and the top band inset) |
| Rail light bg | `#f4f4f4` |
| Top band | content pane only, inset by the rail width; rail keeps its own surface |
| Active nav pill | denser 6px/10px pad, ~8px radius, gray mix on rail |
| Section title | 28px / 560, first baseline ~y70 |
| Content width | Full available pane width after rail and gutters |
| Card radius | ~14px elevated stroke |
| Toggle | **32×20** thumb 16, neutral accent on (not green) |
| Open-target pill | leading VS Code glyph |
