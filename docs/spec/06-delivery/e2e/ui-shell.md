# E2E Scenarios: UI Shell

> Part of the [E2E test plan](../04-e2e-test-plan.md). Visual shell scenarios (US-UI), sidebar, settings, task dock, and work panel.
> Scenario template, gates, and traceability live in the plan.

## E2E-SIDEBAR-upgrade-layout-recovery

- In an isolated profile, retain two synthetic Projects and organize metadata.
  Close one Project and restart with the same app data root but fresh Chromium
  storage. Restore the retained Project and metadata; keep the closed tab closed.
- Migrate a valid legacy cache, including an empty list. If neither copy is valid,
  recover the Host catalog once; preserve subsequent explicit closes.
- Reject secondary-renderer/subframe IPC and oversized/invalid writes. Preserve
  unreadable backups, newer user edits, and the last good file on failure.
- Relocate internal retained paths and metadata keys without changing external
  paths, display names or the source profile.
- Automated path: `node scripts/e2e-sidebar-recovery.mjs`, plus the sidebar backup,
  recovery, bootstrap and offline relocation regression tests.

## E2E-TASK-DOCK-tab-content-isolation

- **Preconditions:** Isolated Electron renderer with synthetic todos and a running
  task; production TaskDock, hook and store, with only host IPC stubbed.
- **Steps:** Expand the dock, select Todo, select Background tasks, open its log,
  switch to Todo and back. Repeat with completed todos.
- **Expected:** Only the selected panel appears. Todo contains no task rows,
  Stop control or log; Background tasks contains no checklist. The shared live
  count remains visible, switching never sends Stop, and the open log survives.
- **Entry:** `node scripts/e2e-task-dock-tabs.mjs`.
- **Specs:** `03-runtime/03-tools-and-permissions.md`, shared task container.
- **Acceptance:** Both switch directions preserve task state and log selection.
- **Milestone:** Maintenance. **Status:** Automated renderer interaction test.

## E2E-SETTINGS-ai-tab-pickers-use-in-app-menus

- **Preconditions**: App running with a host that reports at least one configured command shell and at least one catalog shell that is unavailable on this platform.
- **Steps**: 1) Open Settings → Appearance and open the Theme and Language pickers; note the pill trigger and the opened surface. 2) Open Behavior / 行为. 3) Open the Session defaults card's permission-mode control and select ask, accept-edits, and auto in turn. 4) Open the Session defaults card's Command shell control; inspect the unavailable entries and select an available shell. 5) Dismiss each open menu with Escape and then with an outside press. 6) Close Settings, reopen it, and read both rows.
- **Expected**: Both rows open the same anchored menu surface as the Appearance pickers — the app-drawn frame with the shared radius, elevation, border, and theme tokens, a check mark on the current option, and a hover/keyboard highlight — and never a platform-drawn `<select>` popup. Closed triggers size to the current label, capped by the settings control column. Unavailable shells stay listed with their suffix, are not selectable, and cannot become the current value. Escape and an outside press close the menu and restore focus to the trigger; arrow keys move between selectable options with wraparound. The selected permission mode and command shell persist across closing and reopening Settings, and the selected shell stays the only configured-state indicator.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: A (core shell)
- **Milestone**: M4
- **Status**: Documented

## E2E-033: Window bounds persist across restart

- **Preconditions**: App running with default window size.
- **Steps**: 1) Resize/move the window to distinct normal bounds A (≥800×560), maximize before the 600ms save debounce ends, quit, and relaunch. 2) Restore, resize/move to distinct bounds B, quit before the debounce ends, and relaunch again.
- **Expected**: Each relaunch restores the latest normal bounds (A, then B), including when quit occurs while maximized or with a pending save. Maximized/fullscreen geometry is never stored as normal bounds; invalid/tiny saved bounds fall back to the 1200×800 default.
- **Specs linked**: `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Documented

## E2E-044: Development launch uses PI-Desktop Dock branding

- **Preconditions**: macOS development checkout with canonical `build/icon_1024.png`.
- **Steps**: 1) Run `pnpm dev`. 2) Inspect the running application's Dock icon.
- **Expected**: The Dock shows the PI-Desktop brand icon, not Electron's default icon; packaged builds continue to use `build/icon.icns`.
- **Specs linked**: `06-delivery/06-release-runbook.md`
- **Acceptance**: Quality (development shell matches release branding)
- **Milestone**: M5
- **Status**: Unit-covered (`development-branding.test.mjs`); visual scenario Documented

## E2E-045: Global text selection preserves editing and copying

- **Preconditions**: App running with a chat transcript containing a user
  message, an assistant Markdown response with a code block, and an expanded
  tool result.
- **Steps**: 1) Drag across sidebar/titlebar chrome and a button label. 2)
  Drag across user/assistant prose, code, and tool output. 3) Focus the
  composer and a settings/search input, then use `Cmd/Ctrl+A` and replace the
  selected text. 4) Copy selected transcript and code text.
- **Expected**: Chrome does not leave an accidental text selection; message
  prose, code, tool input/output, and editable controls remain selectable and
  copyable; native editing shortcuts, focus-visible rings, and window drag
  behavior remain intact.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Unit-covered (`user-select.test.mjs`); scenario Documented

## E2E-047b: Sidebar session hover card surfaces rich metadata

- **Preconditions**: A retained project with at least two sessions, one of
  which has a recorded git branch; a Temporary/scratch session also exists.
- **Steps**: 1) Hover a session row under the retained project and wait for
  the card to appear; repeat with keyboard focus on the same row. 2) Change
  the active project's Git branch externally, then switch to another
  conversation in the same directory and hover its row; wait for the card. 3)
  Move the pointer to a different session row without leaving the sidebar; wait.
  4) Hover a Temporary/scratch session row. 5) Resize the sidebar narrower
  than 320px; hover again. 6) Right-click a session row while the card is
  visible and open its context menu. 7) Scroll the sidebar body while the card
  is up.
- **Expected**: The card appears after a 500ms dwell, never appears during
  quick pointer passes, and re-targets to the latest hovered row when the
  pointer changes. Each card shows: the localized session title, the
  mode/permission badge, live status, the readable model display name when
  known, the project name (or "Temporary" / "临时对话" for scratch rows)
  with the latest Git branch on the same row, and the row's `Updated`
  timestamp formatted by the active locale without seconds. Ordinary
  sessions do not show a Local task chip, session UUID, separate Provider
  label, or a status-checked timestamp. Refreshing the branch
  does not activate a project or change the selected conversation. The session
  row has no native `title` tooltip; the hover card is the only full-title
  surface. The card never widens past 320px, never causes the underlying row
  to horizontally scroll, and disappears immediately on resize, scroll, or
  context-menu open.
- **Specs linked**: `04-ux/09-interaction-patterns.md §9.1b`
- **Acceptance**: F (local presentation)
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-navigation.test.mjs` and
  `app-store-sidebar.test.mjs` for the session hover card, branch refresh, and
  the absence of a native row `title`); full UI scenario Draft

## E2E-056: Work panel shell docking and persistence

- **Preconditions**: App running with any workspace state.
- **Steps**: 1) Relaunch and inspect the titlebar and application menu; confirm
  the panel starts closed and a viewport-fixed work-panel toggle is present
  (disabled with no session). Press Cmd/Ctrl+J or click the toggle and inspect
  the no-resource New launcher, then press/click again to confirm it
  collapses the
  panel and no tab is created or deleted; a third press must restore the same
  context. 2) Open two distinct file artifacts, the same first file again,
  a URL preview, and a completed Bash row. 3) Verify the header is a tablist:
  open enough tabs to overflow it, confirm only the strip scrolls and the `+`
  trigger stays visible, and activate the scrolled-away tab. Right-click an
  inactive tab and choose Close Other Tabs; verify the pointed-to tab remains
  and becomes active, and that the action is disabled with one tab. Reopen
  multiple artifacts, then right-click and choose Close All Tabs; confirm the
  panel remains open on the New launcher. Reopen resources before checking
  hover/focus `×`, middle-click, drag reorder, insertion indicators, and edge
  auto-scroll. Open a tab menu with Shift+F10, navigate its items with arrows,
  and press Escape to leave the tabs unchanged. With only one or two tabs, drag
  unused header space to move the native window; tab and action clicks must
  still work without moving it.
  4) Click `+` twice and verify each creates and activates a separate New
  launcher tab. Confirm its body lists Review and each in-scope plugin view
  exactly once. With 40 plugin views and long localized names, shrink the
  window and narrow the panel: the New title stays pinned, the row list alone
  scrolls, and 40px rows stay reachable by wheel, scrollbar, and Tab focus
  (#2026). A quiet scrollbar thumb is visible before hover, its reserved
  gutter prevents label shifts, and there is no horizontal overflow or scroll
  chaining into the shell. Repeat with no explicit tab, a `+`-created New tab,
  few/no plugins, and light/dark themes in English and Chinese. Activate the
  last tool, close its view, and confirm the complete launcher returns.
  Open Browser and confirm its native surface opens at unchanged
  bounds. Open its context menu and verify the native popup appears above Browser
  chrome while the page remains visible. With Browser active, right-click another
  tab and confirm it still uses the native menu. Repeat at 50% and 150% app zoom;
  the menu must remain anchored to the pointer. Escape closes it without hiding
  the page or changing bounds. Close the window while a native menu is open and
  confirm the pending request settles. 5) Close active middle/edge tabs, verify neighbor selection,
  then close the final tab and confirm New remains. 6) Collapse/reopen the panel
  and trigger an artifact. In session A, leave Browser open; switch to B and
  create another tab set, then switch repeatedly between sessions and select a
  project without an active conversation. Generate a background artifact. 7)
  Drag the inner divider
  pointer-down does not jump the divider or resize the native window, cancel one
  gesture with Escape, then focus the handle and exercise Arrow/Shift+Arrow/Home/End.
  Commit a different panel width with Browser active, double-click the divider and
  confirm the default 360px width returns (or the live budget when it is smaller),
  then commit a different width again. 8) Record MainChat width
  and native bounds while opening, repeating the same open action, resizing the
  panel, collapsing, reopening, and closing the final resource. Repeat collapse
  on Windows while watching the entire frameless window. 9) With the panel open,
  resize the application from each edge and confirm only the application
  bounds change; the panel remains at its renderer-committed width. Resize from
  the left edge and repeat after toggling the sidebar. 10) Open, resize, and
  collapse on a small work area, then repeat while maximized and fullscreen. 11)
  Move the normal window between displays and change the active display's
  work-area geometry. 12) Send valid and malformed reservation payloads,
  including positive values, and confirm the compatibility seam never changes
  native bounds. 13) Relaunch. 14) Open a contributed plugin view and reload
  the main renderer with Cmd/Ctrl+R. Confirm the native view detaches before the
  new renderer appears, then reopen its tab and verify the cached plugin page
  returns. Repeat with a same-document navigation and a child-frame navigation;
  neither may detach the active view.
- **Expected**: Startup shows no panel, welcome chooser, or fixed tool buttons.
  A viewport-fixed toggle in the window's top-right corner is the pointer
  equivalent of Cmd/Ctrl+J; there is still no application-menu launcher.
  Cmd/Ctrl+J opens the active session's panel at its
  committed width without creating a resource tab and collapses it again on the
  next press while retaining that context,
  and the shortcut does nothing without an active session or while Settings is
  open. Each artifact atomically opens the docked third column and creates or
  activates one resource; file resources are path-keyed and repeated resources
  deduplicate. Opening, collapse, and
  closing animate the panel's width/flex allocation with its bounded
  opacity/slide, so MainChat reflows continuously without a pre-animation jump.
  Opening the panel, collapsing it, or committing a divider resize updates the
  presentation without a native-window jump. The header is a horizontally
  scrollable tablist with stable `92px–180px` tabs, visible spacing, and a
  fixed `+`; labels stay readable instead of shrinking into one cluster, the
  strip alone scrolls, active tabs scroll into view, and close selects the
  right neighbor then left. A localized, keyboard-navigable tab context menu
  offers Close Tab, Close Other Tabs, and Close All Tabs. Close Other Tabs
  retains and activates its target and is disabled for one tab; Close All Tabs
  closes Browser resources and leaves the panel open on New. For an active
  Browser/plugin view, the tab context menu is a Main-owned native popup above
  Browser chrome; the page stays visible and its bounds do not change. When
  Browser is active, right-clicking another tab also selects this native path.
  Native menu labels, order, and enabled states match the renderer menu, while
  platform styling preserves the native-view z-order. Its position follows the
  pointer at the current app zoom, and closing the window settles the request.
  New launcher tabs expose Review and plugin views as body buttons, with no
  overlapping popup. Dragging a tab shows a before/after insertion indicator;
  edge-holding scrolls toward hidden tabs, and reordering leaves the active
  resource unchanged. `Alt+ArrowLeft`/`Alt+ArrowRight` provides keyboard
  reordering. Selecting a launcher row replaces New or activates its singleton.
  Collapse retains runtime tabs while hiding the panel. Width follows the shared
  three-column budget without a fixed pixel cap and
  previews its current/minimum/maximum values through the panel separator. The
  inner divider exposes the panel width to assistive technology and supports
  the documented keyboard steps. Pointer-down preserves the starting width,
  movement follows the pointer continuously, and release commits once only when
  the target changed. Escape or cancellation restores the press-time width, and a
  double-click restores the 360px default inside the live bounds.
  Browser preview does not intercept an active divider drag.
  A and B independently restore their runtime open state, ordered tabs, active
  tab, and Browser resource; selecting a project without an active conversation
  hides the panel, and no relative resource crosses session/workspace context.
  Background artifacts update only their retained context and never change the
  visible panel or native window geometry. Before exit motion, the native
  Browser preview detaches from the window; collapse produces no stale preview
  frame. Only `{width}` is restored after relaunch; every session's open state,
  tabs, active tab, and Browser resource reset. The panel remains exactly at its
  committed width while open, and sidebar or native window changes do not alter
  that preferred panel width. The compatibility reservation seam returns
  `{requested: 0, reserved: 0}` for every valid request, including positive
  legacy values, and never changes native bounds. Malformed payloads fail with
  `INVALID_ARGUMENT` and never coerce. A full main-frame renderer reload
  detaches the visible plugin view without closing its page, so no orphan
  overlay covers the fresh renderer; reopening the tab reattaches that same
  page. Same-document and child-frame navigation leave the view attached. The
  former context-panel overlay no longer exists.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `04-ux/01-ui-ia.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0068, ADR 0151, ADR 0195, D207, D292,
  D357
- **Acceptance**: F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`work-panel-resize.test.mjs`,
  `work-panel-window.test.mjs`, `work-panel-presentation.test.mjs`,
  `work-panel-tabs.test.mjs`, `browser-tab-restore.test.mjs`,
  `work-panel.test.mjs`, `plugin-work-panel-views.test.mjs`,
  `plugin-view-navigation.test.mjs`, `work-panel-tab-menu.test.mjs`);
  isolated Electron tab-menu, Browser native-menu page visibility, and close
  geometry in `scripts/e2e-work-panel-tab-close.mjs`; launcher overflow,
  native focus reveal, hit targets, and open/close user paths in
  `node scripts/e2e-work-panel-launcher-overflow.mjs`; full UI scenario Draft

## E2E-060b: Neutral gray accent across chrome

- **Preconditions**: App running in dark and light themes; plugins page and a
  chat with markdown links/blockquotes available.
- **Steps**: 1) Inspect focus rings, primary buttons, toggles, selected
  session ring, plugin market primary CTAs. 2) Open an assistant answer with
  links and a blockquote. 3) Switch theme and re-check.
- **Expected**: No blue brand accent remains. Interactive accent, markdown
  links/rules, and plugin primary actions resolve through the neutral gray
  accent tokens (`white/gray` dark, dark-ink light). The plugins
  installed/market UI (tabs, search, cards, permission modal, and primary /
  secondary buttons) uses only `--ds-*` tokens with no blue-slate fallbacks in
  either theme; button surfaces and ink remain visible in dark mode. Semantic
  success/warning/error colors are unchanged.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`neutral-accent.test.mjs`,
  `plugins-page-style.test.mjs`); visual scenario Draft

## E2E-060c: Assistant markdown prose hierarchy and code chrome

- **Preconditions**: A completed assistant answer containing headings, a
  blockquote, a GFM table, a fenced code block with a language tag, inline
  code, a task list, and a remote image link; light and dark themes available.
- **Steps**: 1) Open the session in dark theme and scroll the answer. 2)
  Hover the code-block copy control and the table rows. 3) Expand a thinking
  disclosure that contains markdown. 4) Switch to light theme and re-check
  contrast on inline code, blockquote rule, and code card.
- **Expected**: Answer prose uses the `.prose-chat` hierarchy (h1–h6 ramp,
  accent-tinted blockquote, hairline-bordered inline code, zebra/hover table
  shell, inset code card with monospace language tag). A wide GFM table stays
  inside the transcript column: headers and cells wrap rather than overflowing.
  Thinking prose stays
  secondary/smaller and does not merge into the answer. Both themes keep
  readable contrast; copy still copies raw fence text.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md` §8.7
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`user-select.test.mjs`, `thinking-ui.test.mjs`,
  `markdown-prose-style.test.mjs`); full visual scenario Draft

## E2E-061: User message plaintext layout survives wrapping and reload

- **Preconditions**: Provider configured; composer can accept multi-line input
  via Shift+Enter (or Enter-to-send disabled).
- **Steps**: 1) Compose a three-line prompt with two hard newlines and a URL
  whose encoded path is wider than the user plate. 2) Send. 3) Inspect the user
  bubble in the transcript. 4) Copy the user message and paste into an external
  editor. 5) Reload the session.
- **Expected**: The user plate shows three distinct lines (not collapsed to a
  single paragraph). The linked URL wraps inside the plate without horizontal
  overflow, and every continuation line stays logical-start aligned with the
  first line instead of being centered. Copied text retains the original
  newlines. After reload the same line breaks remain.
- **Specs linked**: `04-ux/08-component-spec.md`
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-style.test.mjs`); full visual scenario Draft

## E2E-063: Empty home keeps the primary task surface focused

- **Preconditions**: App running on empty chat home (no transcript) in light
  and dark themes; window can be resized to ~1200×690 and ~900×640.
- **Steps**: 1) Open empty home. 2) Confirm the hero contains the quiet logo,
  localized title, and short supporting line. 3) Confirm no developer starter
  cards or contextual quick-action row is rendered. 4) Dismiss onboarding and
  inspect again. 5) Repeat in the other theme. 6) Resize to a short height and
  scroll the content region if needed.
- **Expected**: The default empty state keeps the hero and bottom composer as
  the visual anchors, with optional onboarding as the only additional content.
  Dismissing the checklist leaves no empty spacer. The composer remains at the
  bottom without covering the hero or checklist, and short windows keep every
  content block reachable via scroll.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `08-meta/decisions-log.md` (D111/D131/D204/D206)
- **Acceptance**: Quality (layout integrity)
- **Milestone**: M5
- **Status**: Unit-covered (`home-empty-layout.test.mjs`); full UI scenario Draft

## E2E-064: Durable notification inbox records terminal task outcomes

- **Preconditions**: Two durable sessions exist; a deterministic provider can
  complete one turn, fail one turn with a stable error code, and abort one
  turn; notification inbox starts empty.
- **Steps**: 1) Focus and view session A, then complete a turn in A. 2) While
  still focused on A, fail a turn in background session B. 3) Unfocus the
  window and complete another turn in A. 4) Restore/focus the app from its
  taskbar or Dock without switching sessions and confirm A's visible terminal
  outcome is acknowledged. 5) Abort a fourth turn. 6) Repeat each terminal
  RPC. 7) Confirm the main titlebar has no bell, then open the bell in
  the expanded sidebar footer and switch between All and Unread. 8) Mark one
  row read and confirm its session has no terminal sidebar mark, then
  close/reopen the popover and restart the app. 9) Select the other session
  from its terminal-marked sidebar row. 10) Generate a host fixture with 205
  eligible terminal turns. 11) Use Mark all read, then Clear. 12) While a
  native task banner and a renderer refresh are still in flight, deliver a
  delayed `notification.changed` payload for a cleared/read durable id and a
  duplicate payload for an id that is already present. 13) On Windows, create
  one unread successful outcome while the bell has no failure rows. Open the
  empty bell popover, use Mark all read, then create another success and use
  Clear. 14) Create enough unread outcomes for a two-digit count and inspect
  the taskbar overlay before and after marking all outcomes read.
- **Expected**: A's visible-current completion creates no row or terminal
  sidebar mark. Restoring/focusing the app with A already visible clears A's
  matching durable outcome and taskbar count without clearing B. Exactly two
  rows exist, newest first: the unfocused A completion and background B failure,
  with localized labels, snapshotted session titles, and B's stable code.
  Abort/repeated terminal calls create no row. The former footer Help shortcut
  is absent; the 32px footer bell and its upward-opening popover replace it.
  Badge and Unread show the exact unread count without opening implicitly
  reading rows. Read state and both
  records survive restart. Row selection marks it read and activates its bound
  project/session. The fixture retains exactly the newest 200 rows. Mark all
  preserves rows with zero unread. Selecting the other session clears its
  terminal sidebar mark and marks its task notification read; neither mark
  returns after refresh or restart. Clear empties only the inbox and leaves
  sessions, turns, and transcripts intact. Clear/read also dismisses any
  outstanding task-native object, a repeated durable id produces no second
  banner or row, and a delayed pre-clear event cannot resurrect the cleared
  item; a genuinely new post-clear turn still produces exactly one row and
  banner. Each newly accepted task notification plays one soft in-app chime;
  duplicate, delayed, and historical rows do not replay it. On Windows, the
  taskbar overlay is a smooth black circular badge with a centered white system-font numeral. Its visual weight matches common
  Windows taskbar badges for both single- and two-digit counts. A success-only
  outcome increments the taskbar badge without adding a bell row or bell
  count; both toolbar actions remain enabled when relevant and clear the
  taskbar badge. The badge also clears when no unread outcomes remain. The
  underlying taskbar button keeps the
  PI-Desktop `P` icon and PI-Desktop name while the overlay is present.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/01-ipc-protocol.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `08-meta/decisions-log.md` (D117/D130)
- **Acceptance**: C (turn completion), F (persistence), Quality
- **Milestone**: M5
- **Status**: Draft

## E2E-065: Native task notifications are unfocused-only and activate sessions

- **Preconditions**: Native notifications are supported; sessions A and B
  exist; the main window can be focused, unfocused, hidden, and minimized. A
  Windows run uses the NSIS-installed app or the standard development command.
- **Steps**: 1) Keep the app focused on A and complete a turn in A. 2) While
  still focused on A, complete a turn in B. 3) Unfocus the app while A remains
  current and complete another turn in A. 4) Let A's notification move into
  the OS notification center, then click it. 5)
  Minimize the app, fail another turn, and click its native notification. 6)
  Unfocus the app and abort a turn. 7) Repeat with native delivery suppressed
  by the OS. 8) On Windows, inspect the native notification attribution,
  notification-settings entry, taskbar group, installed executable, and Start
  menu shortcut. 9) Deliver the same durable id twice, then mark it read and
  clear the inbox while its native object is still pending in the OS.
- **Expected**: Focused-current A creates neither inbox row, terminal sidebar mark, nor native banner.
  Focused-background B creates an inbox row without a native banner. Unfocused
  current A and the minimized failure each create one durable row and one
  localized, silent native notification plus one soft in-app chime. Clicking
  restores, shows, and focuses the main window before activating the matching
  session, including after the notification has moved to Windows Action Center;
  no event opens the wrong currently selected session. Abort shows neither surface. OS suppression does
  not lose the durable row or surface a misleading app error. Every inspected
  Windows system surface identifies `PI-Desktop`; no stock Electron application
  name or identity is exposed. Duplicate delivery is idempotent: one durable
  id owns at most one live native object, and mark-read/clear closes that
  object so a late activation or renderer event cannot show the old task again.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D117/D141)
- **Acceptance**: C (turn completion), Quality
- **Milestone**: M5
- **Status**: Source-contract covered (`notification-contract.test.mjs`); packaged
  Windows Action Center activation remains runner validation; full UI scenario Draft

## E2E-065A: App notifications use one soft chime

- **Preconditions**: A running desktop app with audio output; a second session
  for background notification delivery.
- **Steps**: 1) Trigger info, success, warning, and error toasts. 2) Complete or
  fail a background task. 3) Trigger an asktool request and a permission or plan
  approval request. 4) Replay a durable notification id and refresh the inbox.
- **Expected**: Each newly presented app toast, task notification, interactive
  prompt, and successfully shown plugin-native notification plays one short,
  low-volume chime. Rapid events coalesce; duplicate or historical notification
  rows do not replay it. Asktool's toast does not add a second chime, and native
  banners stay silent to prevent a second, platform-dependent sound. If Web
  Audio is unavailable or blocked, visual notifications still work and no app
  action fails.
- **Specs linked**: `03-runtime/17-asktool-questions.md`
- **Acceptance**: C (notification feedback), Accessibility
- **Status**: Unit/source-contract covered; audible desktop check Draft

## E2E-067: Platform application menus and window chrome

- **Preconditions**: Native macOS, Windows, and Linux runners; built desktop
  app; English and zh-CN locales available. The Windows/Linux harness can set
  `PI_DESKTOP_START_MAXIMIZED=1` before launch so Main maximizes the hidden
  native window before renderer mount.
- **Steps**: 1) On macOS, launch both `pnpm dev` and a packaged build. Confirm
  the application-menu title is PI-Desktop, open About PI-Desktop, and inspect
  its name, version, and icon. Then open every system menu and invoke New Task, Open
  Project, Settings, global search, sidebar toggle, editing,
  zoom/fullscreen, Window, Help, Logs, and Check for Updates actions. Verify
  the update status reports that the current fixture version is up to date.
  2) On Windows/Linux, confirm no File/Edit/View/Window/Help menubar appears
  inside the window and the left-side navigation occupies the reclaimed
  titlebar space. Verify F10 and Shift+F10 are not consumed by shell chrome;
  exercise New Task, Open Project, Settings, close-window, zoom, fullscreen,
  global search (Cmd/Ctrl+K and Cmd/Ctrl+Shift+P), sidebar, and standard editing shortcuts. Invoke
  Check for Updates from Settings -> Info with the same status result.
  3) Close the macOS window, immediately invoke two native menu
  commands, and acknowledge renderer readiness after the replacement loads.
  Verify one window and one delivery per command. 4) On Windows/Linux, repeat
  from the main chat, Settings, and an open work panel. With the work panel
  open, confirm the viewport-fixed toggle and native window controls stay at
  the window's right edge over the panel header, that resource switching plus
  close actions remain available from the panel menu to their left, and that
  the native window controls themselves still take hover and click — clicking a
  control must not move the window. In the
  main chat, send a first user message and confirm its full bubble starts below
  the 46px titlebar control band. Open the Extensions page and confirm its header
  actions, then the detail sheet's close button, also start below that band and
  take their own clicks instead of moving the window. Click the center plus the
  top, bottom, and
  titlebar-facing edges of each right-side control to minimize, maximize,
  restore, and close the window. 5) Start
  the renderer while its native window is already maximized and inspect the
  initial queried glyph/state. 6) Attempt unknown menu/window IPC actions
  while a window exists and after it closes. 7) Build each target on its
  native runner from a clean release-host directory. On Windows, inspect the
  installed app's taskbar button and Start menu shortcut icon.
- **Expected**: macOS development and packaged launches show PI-Desktop as the
  native application identity, and the About panel uses the canonical
  PI-Desktop icon; neither surface exposes the stock Electron name or icon.
  macOS follows native menu conventions and accelerators.
  Windows/Linux show no application menu inside the window; navigation and
  right-side controls do not collide with drag regions, keyboard shortcuts
  remain operational, and a viewport-fixed work-panel toggle is present on
  non-Settings routes (not an application-menu command). While the panel is
  open the native control band and that toggle overlay the panel header; the
  header ends its box before the band, so the resource tabs and close controls stay clear of the
  toggle and neither the window controls nor resource close sit under a drag
  rectangle. Check for Updates
  invokes the allowlisted update command from the macOS system menu and the
  Settings surface and shows the resulting up-to-date state. Replacement-window
  commands wait for renderer readiness without
  creating duplicate windows or losing events. No Main, Settings, or work-panel
  drag rectangle overlaps the reserved control zone. The 120px control band is
  an opaque `bg-primary` surface in both light and dark themes, with an 8px
  visual buffer separating it from adjacent work-panel actions, so destination
  content never bleeds through it. Window controls remain clickable across
  their full 46px-high hit targets, match native state, and
  have accessible names; the first user or assistant transcript row never
  paints beneath them, and neither do the Extensions page header actions or the
  plugin detail sheet close button. The titlebar and right-side control band
  share one continuous 1px `border-subtle` separator; the control band's
  leading divider uses the same token and its bottom edge does not disappear
  under the window buttons. Unknown actions fail closed. The installed Windows
  taskbar button and Start menu shortcut use the PI-Desktop icon, never
  Electron's default icon. Each package contains the target-native host binary
  (`.exe` only on Windows). Passing this scenario on Windows/Linux proves
  shell readiness, not first-release qualification.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/02-i18n-english-first.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `06-delivery/06-release-runbook.md`,
  `08-meta/decisions-log.md` (D118, D121, D129, D357)
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5 on macOS; post-MVP release qualification on Windows/Linux
- **Status**: Unit-covered (`window-menu.test.mjs`,
  `development-branding.test.mjs`); Electron boot probe covers
  platform bridge, native menu installation, and the pre-render maximize
  fixture on Windows/Linux; native visual scenario Draft

## E2E-073: Icon-only message toolbars and editing a user prompt

- **Preconditions**: An idle conversation contains two completed user/assistant
  exchanges; one user turn was sent as a slash-template invocation.
- **Steps**: 1) Hover a completed assistant row and a user row, then hover and
  keyboard-focus each action chip. 2) Choose Edit on the first user prompt. 3)
  Press Escape, reopen Edit, retry the prompt unchanged. 4) Reopen Edit, change
  the text, and retry with Cmd/Ctrl+Enter. 5) After the new answer completes,
  use the `current / total` pager to return to the original exchange and
  forward again. 6) Reload the session. 7) Choose Edit on the slash-command
  turn and inspect the seeded text. 8) Start another response and inspect its
  assistant toolbar while it is streaming and after it completes. 9) Try Edit
  while a turn is running.
- **Expected**: Every toolbar chip shows its glyph only, with the label
  appearing as a fully visible tooltip 8px above the chip on hover and on
  keyboard focus (#74); the tooltip remains fully painted when it overlaps the
  sidebar edge and is never occluded by the sidebar background; no chip renders
  caption text. Clicking an action dismisses its tooltip immediately; it does not
  remain visible while the action retains focus. While an assistant response is
  streaming, its toolbar omits
  Copy; after the response settles, the assistant toolbar offers Copy, Fork,
  Regenerate. The user toolbar offers the pager (when variants exist), Copy,
  Edit, Delete. Edit replaces the prompt bubble with a wider composer-matched
  inline editor plate filled with `--ds-tile-deep` (no outer shadow, inset
  focus ring) so the light plate stays distinct from the white pane without
  a clipped glow, with Retry and Cancel controls; Escape or Cancel restores the bubble
  unchanged. Retry truncates the transcript from that prompt and streams a new
  answer whether or not the text changed, leaving a `current / total` pager on
  the user turn that restores the original prompt with its full answer tail in
  place — surviving reload. The slash turn seeds the typed `/command` form and
  re-expands the template on retry. Edit is disabled while a turn is running.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `03-runtime/01-ipc-protocol.md`, `03-runtime/04-data-storage.md`,
  `08-meta/decisions-log.md` (D137, D274)
- **Acceptance**: C (chat stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-style.test.mjs`); full UI scenario Draft

- **Long-message regression**: Send a log longer than 65,536 characters as
  message text, reopen the saved chat, then Edit and resend with a short
  clarification. The editor and outgoing request must retain the final log
  lines, without a display truncation marker. A failed full-history read must
  show an error without opening a clipped editor; switching chats while the
  read is pending, including A→B→A with the same retained message array, must
  not open a stale editor or publish stale history. A fresh Edit after returning
  must still load the complete text and resend successfully. Automated coverage also
  preserves attachments and the typed slash-command seed.

## E2E-069: Platform-specific sidebar header behavior

- **Preconditions**: PI-Desktop is open with the expanded sidebar and a chat
  session is active.
- **Steps**: 1) Open Extensions on macOS windowed mode. 2) Inspect the expanded
  sidebar titlebar. 3) Confirm no PI-Desktop logo/title is visible and Collapse
  sidebar appears at the right of the traffic lights. 4) Enter
  fullscreen and inspect the same row. 5) On Windows/Linux, confirm the brand
  remains visible; activate it with a pointer, then with keyboard focus and
  Enter/Space.
- **Expected**: macOS uses one 46px row with native lights at left, a usable
  drag region, and an accessible Collapse button at right; the Logo/Home brand
  is absent in both windowed and fullscreen modes. Global search stays on the
  conversation topbar, shortcuts, and application menu, not the sidebar header.
  Windows/Linux render the canonical 20px logo beside the 15px shell name; the
  complete brand has a localized Home accessible name, visible hover/focus
  feedback, and returns the main pane to chat without clearing the active
  conversation or workspace. The logo itself is theme-aware: light mode shows
  `src/assets/brand/logo-light.png`,
  dark mode shows `src/assets/brand/logo-dark.png`, swapping live with
  `data-theme` (no reload).
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`renderer-branding.test.mjs`,
  `sidebar-navigation.test.mjs`); rendered interaction scenario Draft

## E2E-098: Sidebar collapse and expand animate as a docked transition

- **Preconditions**: PI-Desktop is open with the expanded sidebar and an active
  chat session; `prefers-reduced-motion` is off.
- **Steps**: 1) Click Collapse sidebar in the expanded sidebar header (or press
  the sidebar toggle shortcut). 2) Watch the sidebar during collapse. 3) Confirm
  the main pane expands and the collapsed titlebar now shows an Expand control.
  4) Press the sidebar toggle shortcut again from the collapsed state: each
  press must strictly alternate collapse and expand, so the second press
  re-expands the sidebar (regression: it must never re-collapse). 5) Collapse
  and re-expand once more via the shortcut, then repeat the full round trip
  with the pointer controls. 6) Repeat on Windows/Linux.
- **Expected**: Collapse plays the `sidebar-out` keyframe (opacity + ≤8px slide
  plus width/flex allocation) while the aside stays in the tree, then unmounts
  once the animation ends; the main pane fills the freed space continuously.
  Expand plays the `sidebar-in` keyframe and
  the controls return to the expanded header. On Windows the dock stays opaque
  during exit (`sidebar-out-windows`), matching the work-panel dock behavior. No
  layout jump precedes the animation, and focus returns to the sidebar/Expand
  control predictably.
- **Specs linked**: `04-ux/08-component-spec.md`, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-collapse-animation.test.mjs`); rendered
  interaction scenario Draft

## E2E-208: Collapsed sidebar does not force a 640px chat band

- **Preconditions**: PI-Desktop is open with an active chat session at a
  viewport wide enough for the default 760px chat content band; reduced
  motion is off; the user has not resized the band.
- **Steps**: 1) Record the width of the centered transcript or empty-home
  composer band with the sidebar expanded. 2) Collapse the sidebar. 3) Inspect
  the same content band while the dock transition runs and after it settles.
  4) Expand the sidebar and inspect the return transition.
- **Expected**: The outer main pane fills the space released by the sidebar.
  The centered chat content band stays at its preferred 760px ceiling (or
  `min(available, preferred)` if the pane is narrower). It does not jump to
  640px. The transcript, empty-home stack, and Composer share that envelope.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, ADR 0277, D439
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-collapse-animation.test.mjs`,
  `chat-content-width.test.mjs`); rendered interaction scenario Draft

## E2E-UI-tooltip-never-outlives-its-trigger: A themed tooltip always retreats

- **Preconditions**: PI-Desktop is open on a session with at least one message
  toolbar, a sidebar with two retained projects, and a window that can lose
  focus (another application or an OS dialog).
- **Steps**: 1) Hover an icon-only action and wait for its tooltip. 2) With the
  tooltip visible, move the pointer straight out of the window without clicking
  and then return it. 3) Hover one action, then move the pointer quickly across
  a row of adjacent actions. 4) Hover an action, then trigger a sidebar
  re-order or a project expand/collapse that moves its row in the DOM. 5) Hover an
  action, then press Escape. 6) Hover an action, switch to another application,
  then return to PI-Desktop. 7) Repeat step 1 for the project path tooltip
  (long absolute path), a session row's overflow control, and a message-toolbar
  chip.
- **Expected**: Each tooltip appears after its delay (300ms, 500ms for the
  project path) and retreats when the pointer leaves. No tooltip survives its
  trigger unmounting, a window blur, a hidden document, or Escape, and none is
  left painted after the pointer leaves the window entirely. Crossing adjacent
  actions shows at most one tooltip at a time. A move that keeps the same row
  element (list re-order, expand/collapse) keeps the tooltip instead of
  blinking it; a row that React truly unmounts and replaces drops it.
  placement near the top edge.
- **Specs linked**: `04-ux/09-interaction-patterns.md §6.4`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`icon-tooltip.test.mjs` source contract); rendered
  pointer/Escape/blur validation Draft

## E2E-UI-row-actions-do-not-swallow-the-row-click: A hidden row action is inert

- **Preconditions**: PI-Desktop is open with two retained projects, each with
  at least three sessions, and one active conversation.
- **Steps**: 1) Without hovering it, click the right-hand gutter of an idle
  session row where its overflow control will appear, and note which
  conversation opens. 2) Repeat on an idle project header row. 3) Hover a row
  and activate the revealed overflow control on the first click. 4) Tab through
  the sidebar until a row action receives focus and activate it. 5) Repeat step
  1 with an emulated coarse pointer / touch device. 6) With the pointer resting
  on a row and its action revealed, switch focus to another application, then
  return without moving the pointer.
- **Expected**: The idle gutter belongs to the row — the first click there
  opens that conversation (a project header gutter activates and toggles that
  group) instead of an invisible menu, and a coarse pointer never meets a
  hidden control. The hover-revealed control still opens its menu on the first
  click, and keyboard focus reveals and keeps it operable. On window blur the
  row (and the project title tile) drops its hover paint and hides its revealed
  action; moving the pointer back over the row re-arms it.
- **Specs linked**: `04-ux/09-interaction-patterns.md §9.1c`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Source-contract and style assertions cover the hidden/revealed
  `pointer-events` states and the blur release
  (`sidebar-navigation.test.mjs`); rendered pointer/touch validation Draft
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-navigation.test.mjs`,
  `interaction-polish.test.mjs`); rendered pointer/touch validation Draft

## E2E-072: Keyboard shortcut mappings persist and stay conflict-safe

- **Preconditions**: App running on macOS and on one Windows/Linux target with
  Settings open; no custom shortcut overrides are stored.
- **Steps**: 1) Open Settings → Shortcuts and inspect Keyboard shortcuts. 2) Change
  Search to an unused modifier chord. 3) Invoke the new chord and then the old
  chord. 4) Attempt to assign that chord to the command shortcut (now opened via
  global search). 5) Attempt a bare letter and a reserved editing chord. 6)
  Disable Search and confirm its row shows Unbound. 7) Confirm neither the
  default nor custom Search chord invokes Search, then restart and check that it
  remains disabled. 8) Restore Search individually and confirm its default
  returns; choose Restore defaults and confirm all rows return to defaults. 9) On
  macOS inspect the corresponding native application-menu accelerator after
  each save/reset. 10) On Windows disable the plugin launcher and confirm its
  old global binding, focused fallback, and Alt+Space host fallback are all
  inactive. 11) Press and release Ctrl/Command alone, confirm an IME candidate,
  and hold the back/forward chord long enough to generate repeats.
  12) With the main window focused, press the window-visibility chord
  `Alt + Shift + W` and confirm the window hides to the tray with no
  close-behaviour prompt and with the app still running; from another
  application, press it again and confirm the window returns and focuses.
  13) Disable New task, assign its default chord to Search, then reset New task
  individually. Confirm the conflict error preserves both mappings and Search
  still opens with that chord. Repeat with New task customized instead of disabled;
  free the default by resetting Search, then retry New task reset.
  14) Seed one profile with a stored customized `closeWindow` binding and one
  with a customized `summonWindow` binding; confirm each profile keeps that
  binding on the single toggle row after restart and that `Cmd/Ctrl + Shift +
  W` registers nothing.
  15) With an unsent composer draft in the main window, press unmodified
  `Ctrl + R`; confirm the renderer remains loaded and the draft remains intact.
  On macOS, confirm `Cmd + R` and the explicit View → Reload menu action are
  unchanged.
- **Expected**: Actions are grouped as Navigation, Agent, and Window with
  platform-native key labels; recording has visible focus and `Escape` cancels;
  the custom Search chord takes effect immediately, replaces the old chord,
  survives restart, and updates the macOS menu; duplicate, modifier-free, and
  reserved assignments show an inline error without changing either action;
  Unbound displays as a localized explicit state, participates in no conflicts,
  dispatches no old or default chord, persists across restart, removes the
  macOS accelerator, and disables the Windows launcher fallback layers;
  individual reset rejects an occupied default without changing either action;
  conflict-free individual and global reset restore the shared defaults; Keyboard shortcuts is
  its own Settings destination. Modifier-only and IME keydowns dispatch nothing,
  an unmodified `Ctrl + R` is consumed before Chromium reloads the main renderer,
  preserving the unsent draft; macOS `Cmd + R` and View → Reload remain available.
  and a held history chord traverses only once per physical press. The
  window-visibility key is one toggle on `Alt + Shift + W` — a visible, focused
  window hides to the tray, anything else shows and focuses — and it never
  enters the close path, so it raises no close-behaviour prompt and never quits;
  it is globally registered and deliberately avoids `Cmd/Ctrl + W`, which macOS
  spends on its own close-window command; the retired `Cmd/Ctrl + Shift + W`
  chord registers nothing, and a stored `closeWindow`/`summonWindow` override
  folds into the toggle (D438, D439).
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`,
  `03-runtime/01-ipc-protocol.md`
- **Acceptance**: F (settings persistence), Quality (keyboard accessibility)
- **Milestone**: M5
- **Status**: Shortcut unit-covered (`keyboard-shortcuts.test.ts`,
  `settings-keyboard-shortcuts.test.mjs`, `window-menu.test.mjs`,
  `window-toggle-shortcut.test.mjs`); `test:e2e:boot` verifies the main-window
  Ctrl+R input is consumed. The full rendered settings journey remains Draft.

## E2E-074: Concurrent session events and permissions never steal focus

- **Preconditions**: Sessions A and B exist in Agent mode and can run
  concurrently; A is visible with a draft in its composer.
- **Steps**: 1) Start turns in A and B, then return to A. 2) Let B emit streamed
  messages, tool activity, completion, and a permission request. 3) Confirm A
  remains visible and continue editing its draft. 4) Trigger a permission
  request in A as well. 5) Open B explicitly, resolve only B's request, then
  return to A and resolve A's request. 6) Rapidly select A then B while session
  details load in opposite completion order. 7) While B is loading, resolve A's
  Write/Edit request so its tool completion records an inline review card, then
  let B emit a
  BrowserPreview artifact while A is visible. Switch back to each session.
- **Expected**: B's background events update only B's row and retained state;
  they do not change A's active session/project/page, transcript, draft, scroll,
  or keyboard focus, and no global modal appears. Opening B reveals only B's
  inline card with no countdown. Both requests remain independently
  actionable, and resolving B does not clear A. The final rapid selection stays
  on B even when A's older load finishes later. Only explicit notification or
  session activation may navigate. A's post-approval review card is retained only in
  A without a transient open/close flash in B; B's BrowserPreview carries B's
  session identity, updates only B's retained Browser resource, and never opens,
  navigates, focuses, or resizes A's panel. Explicitly returning to either
  session restores its own open state, tabs, active tab, and Browser resource.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/03-permission-ux.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (session isolation), E (permission isolation), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`permission-inline.test.mjs` for scoped state,
  inline rendering contract, no-countdown behavior, and latest-selection guard;
  `work-panel.test.mjs` and `browser-preview-tool.test.mjs` for session-scoped
  artifact retention and routing); full UI scenario Draft

## E2E-075: Sidebar section context menus create sessions and projects
- **Status**: Manual
- **Priority**: P1
- **Covers**: A, C, D / US-UI-57
- **Preconditions**: App running with the expanded home sidebar visible.
- **Steps**:
  1. Right-click the `Sessions` heading label (not a session row).
  2. Choose the single create item.
  3. Right-click empty chrome in the standalone session list.
  4. Right-click the `Projects` heading label.
  5. Choose the single create item and cancel or complete the project picker.
  6. Right-click empty chrome in the project list (outside any project group).
- **Expected**:
  - Sessions context menus apply the temporary-group empty-session reuse rule
    and focus the composer; a new durable row is visible before any message.
  - Projects context menus open the same Create project dialog as the heading
    folder-plus control.
  - Existing row context menus and heading glyph buttons remain available; the
    section menus stay one-item and theme-matched with other sidebar menus.
  - Section, session-row, and project-row right-click menus open to the right
    of the pointer when space permits, and remain fully within the viewport at
    the right edge.
  - Escape and outside click dismiss the menu without creating anything.

## E2E-076: Startup splash appears then yields to the main shell
- **Status**: Partially automated (`startup-splash-motion.test.mjs` covers splash markup, motion tokens, reduced-motion, and catalog keys; `macos-sidebar-vibrancy.test.mjs` covers the darwin glass splash and shell cross-fade; `startup-animation.test.mjs` and `packages/shared/src/startup-animation.test.ts` cover the D679 animation's bounds, phase machine, discovery, surface, and boot-surface ranking; `pnpm test:e2e:startup-animation` boots the real app against a generated video and asserts `pi-startup:` decoding, advancing playback, the reveal, and that an unplayable file still yields the shell; full window timing remains Draft)
- **Priority**: P1
- **Covers**: A, Quality / US-UI shell polish
- **Preconditions**: App launch path available (dev or packaged).
- **Steps**:
  1. Launch PI-Desktop.
  2. Observe the first painted renderer surface before bootstrap completes.
  3. Wait until sessions/settings bootstrap finishes.
  4. Repeat with OS `prefers-reduced-motion: reduce` when available.
  5. On macOS, compare the splash surface with the sidebar glass after the shell appears.
  6. Repeat with `bootstrap` held unanswered past the watchdog bounds, and observe the boot surface at 30s and after 180s (issue #831).
  7. Drop a short playable video into `<dataDir>/startup/` and relaunch (D679).
  8. Replace it with an unplayable file (for example a renamed text file) and relaunch.
  9. With the animation present, relaunch under `prefers-reduced-motion: reduce`, then reload the renderer, then close the window and reopen it from the tray or Dock.
- **Expected**:
  - Before ready: full-window splash with brand mark, shell name, tagline, and accessible starting status (`data-testid="startup-splash"`).
  - After ready: splash exits with a short fade (or instantly under reduced motion) and the main shell (or settings page) is interactive underneath.
  - If the initial state never arrives, the splash is replaced rather than held: the boot surface gains logs, diagnostics, and quit at 30s (`STARTUP_SLOW_HINT_MS`) without reporting a failure, and at 180s (`STARTUP_STALLED_MS`) becomes the recovery surface, which also offers a retry (`data-testid="startup-recovery"`); every action works without a backend, the renderer-drawn window controls stay above the surface on Windows/Linux, and quit goes through `pi-desktop/app/quit`.
  - On macOS the splash uses the same glass tint and sheen as the sidebar over native `sidebar` vibrancy; the mounted shell stays hidden until the splash exit fade, then cross-fades in. Other platforms keep the opaque `--ds-bg-primary` fill.
  - Use a six-second playable fixture with skip-when-ready off. Observe advancing
    playback beyond the two-second first-frame bound and through at least 5.75s
    before reveal. A `playing` event must retire the first-frame timeout even
    if `loadeddata` was missed. The native fixture also suppresses that event
    in a fresh test renderer to exercise this path deterministically; it resets
    only the temporary window’s one-play mark before that test reload. Keep
    corrupt-media recovery coverage.
  - With a video in `<dataDir>/startup/` (D679): `data-testid="startup-animation"` replaces the splash in the first painted frame, plays over opaque black with no controls and no audio, then holds the same black until bootstrap finishes, then fades out over about a second with the shell already clickable during the fade. A boot slower than the video shows an indeterminate bar after 3s of black. `Escape` jumps straight to that fade.
  - An unplayable file never holds the launch: the animation ends within 2s (no first frame) or on `error`, and the reveal runs exactly as it does after a clean finish.
  - The animation is not played under reduced motion, on a renderer reload, or on a window reopened from the tray or Dock; the brand splash is used instead. Settings → Appearance → Interface names the resolved file, offers the folder, and applies a toggled switch on the next launch only.
  - A boot held past the watchdog bounds replaces the animation with the recovery surface — it is never left behind the opaque mask.
  - No plain unbranded “Starting…” centered text as the only boot UI.
  - Overlay/dialog enter motion uses shared tokens; reduced motion keeps state changes without decorative duration.
  - If a non-settings bootstrap request fails while the settings read is still
    in flight, opening Settings still renders the loaded controls. If the
    settings request itself fails, the active section shows a loading/failure
    state and retry action rather than a blank content pane; retrying after the
    local service recovers restores the controls without leaving Settings.
- **Specs linked**: `04-ux/07-ui-design-system.md` §8, `04-ux/02-i18n-english-first.md`, `04-ux/09-interaction-patterns.md` §1.12, ADR 0338, decisions-log D146 / D304 / D348 / D679
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5

## E2E-099: Brand logo follows the active theme
- **Status**: Draft
- **Priority**: P3
- **Covers**: Quality / US-UI shell polish
- **Preconditions**: App running; theme can switch between light and dark (and system) without restart.
- **Steps**:
  1. In light mode, open the app shell, an empty chat home, and the expanded sidebar (Windows/Linux) or startup splash.
  2. Inspect the rendered `BrandLogo` source in the sidebar and startup splash,
     and inspect the light eight-frame `HomeMascotLogo` GIF in the empty-home
     hero. Hover the mascot and verify that its cadence does not change.
  3. Switch the theme to dark (Settings → Appearance → Interface, or system appearance change).
  4. Re-inspect the same surfaces without reloading.
  5. Switch back to light and re-inspect.
- **Expected**:
  - Light and dark mode render `src/assets/brand/logo-light.png` /
    `src/assets/brand/logo-dark.png`
    live in the sidebar and startup splash without a window reload.
  - The empty-home hero renders the 100px eight-frame mascot GIF for the
    active theme (`home-mascot-light.gif` / `home-mascot-dark.gif`) with a
    short idle hold and a looping wave. Switching theme swaps the pair live
    without a window reload. Pointer hover does not change the cadence;
    under reduced motion the matching still first frame remains visible.
  - Sizes stay stable across theme changes (sidebar 20px, hero 100px, splash
    64px), and the marks stay decorative with no click, keyboard, or focus
    behavior.
- **Specs linked**: `04-ux/08-component-spec.md` §3.7, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality
- **Milestone**: M5
## E2E-077: Theme-aware selection and CJK section labels

- **Status**: Partially automated (`user-select.test.mjs`, `interaction-polish.test.mjs`)
- **Priority**: P2
- **Covers**: A, Quality / US-UI shell polish
- **Preconditions**: App running with at least one selectable transcript or input; language can be switched to `zh-CN`.
- **Steps**:
  1. Select text inside a transcript message or the composer.
  2. Inspect sidebar Sessions/Projects section labels in English.
  3. Switch the app language to `zh-CN` and re-check the same labels.
  4. Hover jump-latest (when visible), stop, search rows, and profile menu items.
- **Expected**:
  - Selection highlight uses a neutral text-primary wash (not browser-default blue).
  - Caret/form accent colors stay on the monochrome token ramp.
  - English section labels may use uppercase + wide tracking; `zh-CN` labels use normal tracking without forced uppercase.
  - Listed chrome controls ease background/color changes via shared motion tokens.
- **Specs linked**: `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`
- **Acceptance**: D147
- **Milestone**: M5
- **Status detail**: Source-level coverage for CSS contracts; visual selection paint remains manual.

## E2E-078: Work panel and settings light-surface polish

- **Status**: Partially automated (`surface-polish.test.mjs`)
- **Priority**: P2
- **Covers**: D, Quality / US-UI shell polish
- **Preconditions**: App running; theme can switch to light; a work-panel tab can be opened.
- **Steps**:
  1. Switch to light theme.
  2. Open Settings and inspect form fields, toggles, segment controls, and shortcut keycaps.
  3. Open the work panel (Review / Files / Browser) beside a chat session.
  4. Hover file-tree rows or diff headers; focus the browser URL field.
  5. Open a confirmation/provider dialog and inspect the scrim.
  6. In both light and dark palettes, inspect the settings rail, search, selected
     item, on-state knob, composer shell, plugin/capability searches, the code
     card's head band, the Mermaid canvas, tool output, the composer placeholder
     and disabled send chip, the dialog scrim and permission backdrop, and the
     dock question card with its option row. Apply custom surface variables,
     keyboard-focus both searches, then remove the custom theme.
- **Expected**:
  - Work panel body reads as quiet `#fafafa` inset paper with a white header band.
  - Settings fields, browser URL, segment tracks, and shortcut keycaps use light inset fills; focused fields lift with a neutral ring.
  - Toggle on-state keeps a white knob on the near-black track.
  - Hover fills on file-tree/diff/resize ease with shared motion tokens, and the divider matches the sidebar: a 32px centered grip on direct hover/focus, not a full-height hairline; keyboard focus and an in-progress drag use the solid accent.
  - Light dialog scrim is softer than the dark 45% veil (~28% ink).
  - The dock question card paints the composer plate in both palettes — light
    `#ffffff` with the composer shadow, dark 96% `#212121` — and its option rows
    are inlaid `--ds-tile-deep` fills with no raised shadow. A custom
    `--ds-bg-composer` / `--ds-tile-deep` repaints both, and removing it
    restores the built-in paint.
  - Tool output keeps its cascade: light paints the same lighter tile over error
    output and over plain tool blocks, while dark shows the error tint and leaves
    plain blocks transparent.
  - Custom variables repaint the corresponding fills, keycap ink, and search
    focus states; removing them restores the built-in 8-bit RGBA paint and the
    existing shadows/focus rings. Prose ink mixes follow `--ds-text-primary`,
    and the `one-dark-pro` / `one-light` Shiki plate and its ink stay with the
    Shiki theme by design. This batch does not change plugin APIs.
- **Specs linked**: `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`
- **Acceptance**: D148
- **Milestone**: M5
- **Status detail**: `pnpm test:e2e:theme-surfaces` exercises these ordinary fills,
  focus states, and built-in restoration with real Chromium, production CSS,
  and deterministic DOM fixtures; plugin installation/lifecycle is not covered.
  Branch runs do not replace post-integration E2E. Other surfaces in this
  scenario retain manual visual checks.

## E2E-079: User-facing catalog copy in English and Chinese

- **Status**: Partially automated (`packages/i18n/test/user-facing-copy.test.mjs`, `catalogs.test.mjs`)
- **Priority**: P2
- **Covers**: A, Quality / US-UI copy
- **Preconditions**: App running; language can switch between English and zh-CN.
- **Steps**:
  1. Inspect empty-home hint, sidebar temporary-chat section, and status/connection toasts.
  2. Open Settings → Models and the marketplace refresh action.
  3. Switch the app language to zh-CN and re-check the same surfaces.
- **Expected**:
  - Copy explains outcomes in plain product language (AI provider, project, marketplace, connected/limited) rather than host/backend/repo jargon.
  - English and zh-CN catalogs keep identical keys and interpolation variables.
  - Crash chrome and empty-home titles remain catalog-backed in both locales.
- **Specs linked**: `04-ux/02-i18n-english-first.md`
- **Acceptance**: D149
- **Milestone**: M5
- **Status detail**: Source-level coverage for catalog contracts; visual wording review remains manual.

## E2E-AGENTS-002: Global settings and project menus manage instruction files

- **Preconditions**: PI-Desktop is running; a project can be opened.
- **Steps**:
  1. Open Settings -> Instructions without an active project and save global
     content.
  2. Start a new agent session and verify its instruction context includes the
     global source.
  3. Open the Projects view and use a project's more menu to edit and save its
     displayed `AGENTS.md`.
  4. Submit a prompt in a new or idle session.
- **Expected**: The global editor targets only `~/.pi/agent/AGENTS.md`. The
  project editor is available only from a known project's Projects-view more
  menu and targets only that project's root `AGENTS.md`. Both editors show
  their resolved paths, preserve the typed text, and save through the dedicated
  IPC rather than a general file write API. Global content precedes project
  content in the next runtime; the saved project content follows it and takes
  precedence on conflicts. The project editor is a viewport-level dialog.
- **Specs linked**: `03-runtime/02-agent-runtime.md`, ADR 0037
- **Acceptance**: C (chat/stream), D (workspace), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`project-instructions.test.ts`); UI journey Draft

## E2E-085: Expanded sidebar typography keeps list content compact

- **Preconditions**: The expanded sidebar contains at least one standalone
  session, one retained project with a session, and one empty project group;
  light and dark themes are available.
- **Steps**:
  1. Open the app at the default window width and inspect session titles,
     project/group titles, empty-state copy, section labels, and the footer's
     Settings, Plugins, and notification icons.
  2. Switch between light and dark themes, then narrow the window to the
     minimum supported expanded-sidebar width.
  3. Compare the sidebar hierarchy with 14px chat body text and inspect long
     session/project names.
- **Expected**:
  - Footer action icons use the shared 32px hit target and compact 14px icon
    sizing; Plugins sits immediately to the right of Settings.
  - Session titles, project/group titles, and empty-state copy use `--text-md`
    (13px); section labels and secondary metadata remain at `--text-sm` (12px).
  - The hierarchy remains readable in both themes, row pitch stays compact at
    approximately 28–32px, and long labels truncate without shell reflow.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, D161
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-navigation.test.mjs`); rendered visual
  scenario Draft

## E2E-SHELL-windows-pwsh-msix-store-alias-is-available

- **Preconditions**: Windows host with PowerShell 7 installed via MSIX /
  Microsoft Store (`winget` `msixbundle`). `%ProgramFiles%\PowerShell\7\pwsh.exe`
  is absent. `pwsh.exe` on PATH is the `WindowsApps` app-execution alias
  (`IO_REPARSE_TAG_APPEXECLINK`).
- **Steps**: 1) Open Settings → command shell. 2) Inspect `windows-pwsh`
  availability. 3) Select PowerShell 7 and persist `defaultCommandShell`.
  4) Run `Bash`.
- **Expected**: `windows-pwsh` is available and selectable. The host resolves
  the Store alias without treating it as missing. `Bash` launches PowerShell 7.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `04-ux/06-settings-ia.md`, ADR 0054, ADR 0209
- **Acceptance**: B (model/config), E (tools/permissions)
- **Milestone**: M6
- **Status**: Documented; host-core unit tests cover the Win32-attribute
  decision (alias attrs `0x420` + tag `0x8000001B`). Live Store-alias probe is
  Windows-only and is not run in Linux CI.

## E2E-103: Settings Agent pages manage file-backed capabilities

- **Preconditions**: The app is running with two registered projects, A and B,
  and an Agent session available in each. The fixtures use only
  `~/.agents/skills`, `~/.agents/servers`, `~/.agents/subagents`, and the two
  projects' `.agents` directories; no `.pi` capability directory exists.
- **Steps**:
  1. Open Settings > Agent and verify Skills, MCP, and Subagents are three
     independent navigation destinations. Open Extensions and verify that only
     Installed and Marketplace tabs are present.
  2. Open Skills. Confirm one toolbar sits above one panel, the panel shows a
     global group header rooted at `~/.agents/skills` and a project group header
     rooted at project A's `.agents/skills`, both flow in one column at natural
     page height, and the project picker changes the selected project. Confirm
     the Skills toolbar has the same single primary action shape as MCP, with
     the concise New label; the level-specific Import action is available in
     each Skills group header.
     On first paint confirm skeleton rows appear; on a later refresh confirm
     the rows already on screen stay and the list dims instead.
  3. Exercise the level filter and the search field. Confirm All / Global /
     Project carry counts that agree with the rendered rows, that selecting a
     level hides the other group without hiding the toolbar or its actions, that
     search narrows both groups and its counts, that clearing the search
     restores every row, and that a search with no matches reports it and
     suggests widening the filter.
  4. Toggle a global skill off while project A is selected. Confirm the switch
     flips immediately without the list reverting to skeletons, the row is
     dimmed, a toast names the skill, every other row stays interactive while
     the request is in flight, and the global document remains unchanged. Switch
     to project B and confirm the global skill remains enabled there. Force a
     host rejection and confirm the switch returns to its previous position.
  5. Create a skill from the page. With the filter on Global confirm the primary
     action names the global destination and the new document lands in
     `~/.agents/skills`; with the filter on Project confirm it names the project
     and lands in project A. With Project selected and no project chosen,
     confirm the attempt reports it instead of failing silently. Edit the new
     skill, save, and confirm the body round-trips.
  6. From a project skill's overflow menu choose Reveal and confirm the project
     file is revealed, not a global file of the same id. Choose Remove and
     confirm the first press only arms and relabels the item, the second press
     deletes, and dismissing the menu disarms it.
  7. Put a same-name project skill in A and disable it. Confirm the effective
     runtime catalog does not fall back to the global skill; the project record
     shadows first and filtering happens second.
  8. Use the Import action to choose exactly one Markdown file. Confirm it is
     physically copied to the level the filter points at, appears immediately,
     and a second file cannot be selected in the same picker invocation.
  9. Open MCP. Add a project server and a global server, edit the project server,
     and test an existing connection from the row's overflow menu. Confirm the
     modal locks the id while editing, rejects a same-level duplicate id or
     label, and reports ready or failed through the row badge and a toast.
     Delete a server through the same two-press menu action and confirm its file
     is gone.
  10. Delete a skill or MCP file outside the app, reload its page, and confirm the
      row disappears and its local state has no orphaned entry. Confirm deleting
      a global file also removes its project overrides.
  11. Open Subagents. Confirm it is one global-only panel rooted at
      `~/.agents/subagents`, with no level filter, no project picker, and no
      project-level controls. Confirm a Built-in group lists the five shipped
      defaults (`explorer`, `code-reviewer`, `test-runner`, `fixer`,
      `ui-designer`) even when the user directory is empty, each with a
      Built-in badge, its tool grant, and an enablement switch, but no reveal
      or delete. Confirm the Global group header carries the global level label
      and item count, that create/edit/delete/reveal all work from the page
      for user-owned rows, that leaving the output limit empty writes a
      definition with no `maxTokens`, and that an empty user
      directory still resolves `settings.subagentsEmpty` to localized
      empty-state copy under the Global group rather than displaying a raw
      translation key. Open New subagent and confirm the
      Model field is a select of the same configured, runnable models as the
      Composer, grouped by provider, with an inherit-session option, not a
      free-typed `provider/model` input. Pin a configured model, save, and
      confirm the document's `model:` frontmatter is `vendorKey-or-name/modelId`.
      When two configured providers share a generic or vendor key, confirm each
      provider remains a separate group and its model pin uses a unique display
      name (or provider id when the names also collide).
      Edit a definition whose pin is no longer configured and confirm that pin
      remains selected instead of snapping to inherit.
  12. Narrow the window to the toolbar's stacking breakpoint. Confirm the
      segmented control spans the width, search moves below it, actions wrap
      left-aligned, group headers drop the resolved path, and the page gains no
      horizontal overflow. With a pointer that cannot hover, confirm the row's
      edit and overflow controls are visible without hovering.
- **Expected**:
  - The three Settings pages use no tabs for switching capabilities, flow at
    natural page height for empty and populated states, support dark and light
    themes, and begin with quiet page-specific descriptions plus
    project-over-global scope copy where relevant. Each page is one toolbar
    above one panel: the toolbar carries the level filter with live counts, one
    search field with a clear affordance, the project picker, and the primary
    actions; the panel divides levels with group headers naming the level, its
    resolved `.agents` path, and a localized count. Rows use quiet capability
    icons, a level badge plus localized source/transport badges, descriptions,
    and persistent enablement switches; edit and the overflow menu stay quiet
    until the row is hovered, focused, or has its menu open, and are always
    visible where hover is unavailable. Skeleton rows appear on first paint
    only, later refreshes dim the rows already on screen and announce the
    refresh, busy state is confined to the row with the in-flight request, and
    counts are exposed to assistive technology. Empty states stay centered
    inside the panel without a decorative frame, show a host Lucide icon in a
    chip wrapper (not a padded raw SVG), and offer the page's primary
    action, and no capability-specific color system is introduced.
  - Create, edit, and delete are available for all three capabilities without
    leaving Settings. New capabilities land at the level the filter points at,
    destructive actions require two presses of the same relabelled menu item,
    and revealing a project-level skill opens that project's file rather than a
    global file sharing its id. The Subagents editor Model field is a grouped
    select of configured runnable models plus inherit-session, not a free-typed
    id; saving writes `vendorKey-or-name/modelId` (using a unique provider name
    or id when aliases collide), and an unconfigured existing pin remains
    selected. The Advanced disclosure also carries the delegate's own output
    limit: it starts empty, shows the model-default
    placeholder rather than an unlimited one, and a value round-trips through
    the document's `maxTokens` frontmatter and back into the field — while
    clearing it removes the key so the delegate follows the model again.
  - Capability files contain configuration/frontmatter only; enablement is
    persisted in the app-local `agent-capabilities` state files.
  - Project records shadow global records by id or name even when disabled,
    and the next runtime activation reflects the same result as the UI.
  - Physical import is single-file and level-specific, and disk deletion is
    removed by scanning rather than represented as a pending row.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §12a–§12d,
  `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/13-model-catalog-and-selection.md` §2 (Subagent editor),
  `04-ux/01-ui-ia.md` §3.4–§3.5,
  `04-ux/06-settings-ia.md` §2 (Agent capability destinations), §4.21–§4.25,
  `07-plugins/01-plugin-system.md` §12.2–§12.3,
  `08-meta/decisions-log.md` (D193, D194, D202, D257), ADR 0112, ADR 0126
- **Acceptance**: D (workspace), E (tools & permissions), F (persistence),
  Quality
- **Milestone**: M6+
- **Status**: Source/unit covered by
  `apps/desktop/test/agent-capability-settings.test.mjs`,
  `apps/desktop/test/extensions-page.test.mjs`,
  `apps/desktop/test/subagent-models.test.mjs`,
  `apps/desktop/test/subagent-output-limit.test.mjs` (the output cap's path from
  the editor draft through host-core to the built delegate model), and host-core
  capability tests;
  full native-picker, rendered modal, project-switch, and runtime journey remain
  Draft (run only in a capable environment when this surface changes)

## UI shell visual scenarios

## US-UI-01 Codex-aligned shell chrome
- Open the desktop app on macOS dark theme.
- Expect charcoal main surface (`#181818`), left sidebar with current-project
  and Temporary session groups, and a floating bottom composer
  with mode/model controls and no workspace rail.
- Expect no blue-slate marketing chrome; primary send control is a circular inverted button.

## US-UI-02 Empty thread hero
- Open or create a thread with zero messages.
- Expect the centered hero copy "What can I help you build?", a short muted
  supporting line, with no developer starter cards. The optional project name
  remains a dotted-underline action when a workspace is open.

## US-UI-03 Sidebar destinations
- Expect the expanded home sidebar to show Sessions and Projects without
  standalone Plugins or Scheduled rows.
- Click the plug-shaped Plugins icon in the sidebar footer, immediately to the
  right of Settings, and expect it to replace the main pane with a dedicated
  page.
- Open Settings → Project archive and use it to open, switch, and close a local
  folder workspace.

## US-UI-04 Composer without workspace context
- With a git workspace open, composer does not show project, Local, or branch
  labels above the prompt surface.
- Operating-mode selector switches between Agent, Plan, and Goal; both contract
  modes keep the permission-mode chip and explain their Bash tradeoff.

## US-UI-05 Locale chrome
- On a zh-CN system locale, sidebar labels render in Chinese (项目 / 临时会话),
  with no extra standalone destination rows. The footer plug-shaped Plugins icon
  exposes the localized accessible name 插件.
- Empty-thread hero and supporting line are localized Chinese copy; project
  name remains a dotted-underline action when a workspace is open.
- Composer omits the 本地 workspace label and shows Agent/Plan/Goal plus the
  active model ID; both locales expose the Plan and Goal approval copy.

## US-UI-06 Session title plugin
- Create a new task and send a first prompt such as "同步代码".
- The core keeps the localized default title while the prompt is sent and after
  completion. When the Session Titles plugin is enabled and authorized, it may
  generate a title after the first completed turn using its configured prompt,
  model, and thinking level. Without the plugin, the title remains the default.
- Rename the session manually and complete another turn. The plugin must not
  replace the user-defined title.

## US-UI-08 Shortcut-only destination history
- Navigate Settings → Project archive → a project session → Plugins.
- Expect no back/forward buttons in the expanded sidebar or main titlebar.
- Press `Cmd/Ctrl+[` and `Cmd/Ctrl+]`; expect them to traverse that history.

## US-UI-09 Default session title persistence
- Open an older session that showed "New task"/"New chat" and has a first user
  message.
- Without the title plugin, its scoped sidebar row keeps the default title;
  with the plugin, the title changes only after the first turn completes and the
  plugin is authorized.

## US-UI-11 Empty draft reuse
- Click New task twice.
- Expect only one empty "New task" draft in the current project or Temporary
  group and the home hero remains visible. Empty drafts in another scope are
  not reused.

## US-UI-12 Composer without workspace rail
- On empty home, project home, and in a thread, expect no project / Local /
  branch context rail above the composer.
- The prompt shell remains one uninterrupted rounded surface with no reserved
  rail height, attached top lip, rail shadow, bottom seam, or separators.

## US-UI-13 Light theme shell parity
- Set theme to system/light on a light macOS appearance.
- Expect sidebar `#f3f3f3`, main `#ffffff`, text `#1a1c1f`, white floating composer, and home hero with project underline.
- Sidebar project/session labels, footer Settings/Plugins/notification
  icons, current-project identity, thread titles, and composer controls must remain
  readable dark-on-light (≥4.5:1). Never white/translucent text on the light
  sidebar.
- The macOS traffic-light row keeps Collapse sidebar readable at the
  right on light chrome without rendering the Logo/Home brand.

## US-UI-14 Semantic chrome tokens
- Toggle theme system → light → dark without restart.
- Shell chrome (sidebar items, composer runtime controls, icon buttons)
  follows semantic `--ds-text-*` / `--ds-bg-*` tokens in both themes; no
  hard-coded white (`gray-0`) text on light surfaces.

## US-UI-15 Codex density + elevation
- Sidebar rows use a compact ~28–32px pitch with the 12–14px hierarchy from
  US-UI-69 and 8px horizontal padding (Codex `radius-token-row` 10px).
- Floating composer uses Codex elevation-prominent: 0.5px stroke + soft 3px/20px shadow (not heavy 10–30px drop).
- Empty hero title is 28px / 34px line-height, weight 400.
- Window restores ≥1000×700 (target 1200×800) if Stage Manager collapses it.

## US-UI-16 Sidebar footer utility layout
- On the light/dark home shell, the sidebar footer is a transparent utility
  band with no separator. Settings, Plugins, and notification actions
  are grouped on the left, while the build/version chip is right-aligned.
- The notification Bell remains visible in the left action group with its
  unread badge and opens the inbox above the footer; the main titlebar has no
  duplicate Bell.
- Clicking the build/version chip checks for updates when current, or opens
  Settings → Info when an actionable update is available.
- Traffic lights sit at Codex `{x:16,y:16}` with a 46px toolbar; the expanded
  macOS sidebar places Collapse sidebar at the right in that same
  row, with no Logo/Home brand or back/forward buttons.

## US-UI-17 PI-Desktop home hero logo
- On empty chat home, the 100px `HomeMascotLogo` GIF renders above the title
  as an eight-frame waving mascot with a short idle hold. Light and dark
  themes each use a dedicated GIF and still PNG.
- Pointer hover does not change the cadence or geometry; reduced motion shows
  the matching still first frame. The mascot remains decorative.
- Title is 28px / weight 400; active project name uses dotted underline (1px, offset 4px).
- Composer does not render attachment or appshot controls before their payload
  reaches pi end to end.

## US-UI-18 Composer has no inert actions
- On chat home and a docked thread, inspect every composer control.
- Expect no file, photo, or appshot controls while those payloads are
  unsupported by the pi runtime. Exact reasoning-capable models expose the
  current Thinking level immediately to the right of Agent / Plan / Goal; unsupported
  models show no trigger. Unknown compatible models can explicitly enable
  thinking from the model menu, and changes update the durable session.
- Expect no project, Local, or branch context labels in the composer.
- Every visible composer control changes the active session, opens its menu, or
  submits/aborts the current turn.

## US-UI-19 Permanent Stage Manager bounds restore (macOS only)
- On macOS with Stage Manager, shrink or unfocus the PI window until width < 800 or height < 560.
- Expect the shell to re-assert a Codex-like footprint (~1200×800, min 800×560 capped to the display work area) and keep restoring while still collapsed (not only during the first 20s after launch).
- The recovery watchdog is macOS-only (D447). On Windows/Linux it must not run at all: the app must never re-layer or re-raise its own window unprompted. Focus another window, then confirm PI-Desktop stays behind it instead of jumping back to the top of the stack, and that a stacking check (`xprop -root _NET_CLIENT_LIST_STACKING`) never shows it returning to the top periodically.
- Windows regression: trigger tiny-bounds recovery through show, focus, or
  restore, then Alt+Tab to another app. PI-Desktop must stay behind that app
  immediately and after four seconds. Ordinary focus must not resize or raise it;
  hidden/minimized windows keep their state. Recovery must never enable
  always-on-top off macOS.
- Automated lifecycle coverage: `window-topmost-lifecycle.test.mjs` executes the
  production recovery handlers and watchdog with controlled time, including the
  unchanged macOS temporary pin and release. Native Alt+Tab validation remains
  a separate platform check.

## US-UI-20 Dark floating composer box
- Switch to dark theme on chat home.
- Expect main `#181818`, sidebar `#000000`, and the floating composer plate at elevated-primary (`#212121f5` / gray-800 96%) with elevation-prominent stroke + soft lift so the box reads against the main surface.

## US-UI-21 Composer model menu configures pi
- Create a session with provider A/model A, then open the Composer-right model ×
  reasoning menu.
- Expect the top bar to show only the task title and window actions. The
  Composer-right model × reasoning chip shows provider A/model A and the current
  reasoning level. Its menu starts with only Model and Reasoning level entries;
  Model opens the searchable provider-group list and Reasoning level opens the
  capability-filtered radio list in the same popover.
- In the searchable provider-group list, expect each provider heading to
  read as the visual parent: its `--text-md` treatment is stronger than the
  indented model rows' normal-weight `--text-sm` treatment. In zh-CN, headings
  must not force uppercase or wide Latin tracking.
- Select provider B/model B, send a prompt, and expect the main-to-sidecar
  `agent.prompt` payload and pi runtime to use B for that session.
- Switch away and back; expect B and its clamped reasoning level to remain
  selected. Selecting a model or reasoning level returns to the root without
  closing the Composer menu; outside click and Escape close it. While a turn
  runs, expect the combined control to remain available only for next-turn
  configuration unless a pending approval gates it.

## US-UI-22 Profile footer menu
- On the sidebar footer, click the `Custom` / `Local profile` trigger.
- Expect a 280px opaque elevated menu 8px above the footer. It repeats the local
  identity in a non-interactive header, then shows a divider and Settings,
  Logs, and Theme actions in that order.
- Arrow keys wrap through the three actions; Home/End jump to the boundary.
  Escape closes the menu and restores trigger focus. An outside pointer press
  closes it without stealing target focus.
- Settings navigates to the settings page, Logs opens local logs, and Theme
  cycles the current theme after closing the menu.

## US-UI-23 Project archive index
- Open Settings → Project archive.
- Expect the Settings title "Project archive" plus the one-workbench
  composition (D168/D267): a quiet intro line carrying the page description
  only, with no hero block, gradient banner, or page-level counter run; one
  toolbar with a Recent / Name sort
  segmented control, a search field, its clear affordance, the live match count,
  and the primary "Add project"; and one panel whose sections run Pinned, All
  projects, Archived as in-panel header strips, each present strip showing its
  label and row count. With no project at all the panel shows one quiet
  empty state with its own primary action.
- Expect each row to carry a colored glyph, the project name with its Active /
  Open / pinned / Archived tags, one meta line with the shortened monospace
  path, branch, and session count, a relative last-active time, and the
  hover-revealed New task and row-menu actions. Ordinary rows use a Folder glyph;
  pinned rows use a filled Star glyph and retain the pinned text tag. Archived rows stay listed and
  softened rather than hidden.
- Expand a non-active project and open one of its sessions; expect the app to
  activate that project before selecting the session, so workspace tools and
  session scope use the same project.
- Switch the sort to Name and expect rows to reorder inside every section with
  no row hidden; clear the search and expect the complete index back.

## US-UI-24 Settings full-page shell
- Open Settings (footer profile → Settings).
- Expect **full-page** Codex settings (no app sidebar/nav). Left rail has Back
  to app, search, and exactly General / AI / Shortcuts / Instructions / Models /
  Skills / MCP / Subagents / Projects, Cloud sync / Remote Hosts / Info in that
  order; packaged builds show both Cloud sync and Remote Hosts with Experimental
  badges. The content pane shows the selected destination.
- Return to the app shell and expect Plugins to remain an independent
  sidebar-footer destination.
- Drag the empty 46px top band over either the rail or content pane; the native
  window moves while Back, search, and navigation remain clickable.

## US-UI-27 Dark destination pages
- Force dark theme and open Plugins and Settings → Project archive.
- Expect black sidebar, main `#181818`, and destination cards/rows readable on elevated dark plates (not flat same-gray).

## US-UI-28 Home empty composer association
- On empty chat home (light + dark), expect the hero, optional onboarding
  checklist, and home composer in one scrollable vertical flow (D111/D204/D206),
  without a large empty gap or starter-card layer.
- The composer remains a standalone plate without an attached workspace rail.
- Starting a transcript restores the bottom-docked composer with fade veil.

## US-UI-29 Light composer plate legibility
- On light theme empty home, the white composer shell uses one uniform solid
  fill with no internal gradient or background image.
- The shell still reads as an elevated box through a hairline stroke and
  restrained soft shadow against the `#ffffff` main surface.
- Toolbar controls and placeholder remain legible (not pure white-on-white).

## US-UI-30 Composer placeholder copy
- Empty home and session composers start with their localized welcome copy:
  `chat.placeholderHome` / `chat.placeholder`.
- The selected guidance stays unchanged until the page/session context changes;
  switching context advances to localized `/`/`@` command/file guidance and the
  keyboard hint `Shift+Enter for newline · Use Send to submit`, with an opacity fade.
- Waiting, focusing, editing, clearing, or composing does not change the copy.
- Placeholder ink is legible on light and dark floating plates.

## US-UI-31 Home empty vertical stack (D111/D204/D206)
- Given empty chat home, when the window is ~1200×690, the hero and optional
  onboarding checklist render in a centered scrollable content stack above a
  bottom-reserved home composer (not dual-grow absolute portal regions).
- No starter cards or absolute overlay are present; the onboarding checklist
  remains actionable and the composer is directly available.

## US-UI-32 Dark floating box elevation
- Given dark theme empty home, when the composer shell is painted, it uses elevated-primary `#212121` on `#181818` with elevation-prominent stroke+lift identical to light (no heavier custom dark shadow).

## US-UI-33 Scoped sidebar session groups
- The home sidebar has no Recents aggregate.
- It shows one independently collapsible header per retained project path with
  nested sessions and one `Temporary sessions` / `临时会话` header for
  path-less sessions.
- Project and Temporary headers expose compact scope-specific `+` controls;
  project/session overflow menus expose pin/archive actions; nav row pitch
  remains ~32px and session row pitch ~28–31px.

## US-UI-34 Home has no developer starter cards (D206)
- On empty chat home (light + dark), no developer starter grid, card, or
  contextual quick-action row renders between the hero and composer.
- Task entry starts directly in the bottom composer, while the optional
  onboarding checklist remains actionable when present.

## US-UI-35 Empty composer plate density
- Empty-home composer is compact and content-driven with an empty or one-line
  draft; it does not reserve the former fixed ~148px empty plate.

## US-UI-36 Hero Y + night box elevation
- At ~1200×690 light home, the hero forms one centered block; the home
  scroller does not clip its top or overlap the bottom composer, and no starter
  grid is rendered.
- Dark home composer plate reads as elevated-primary `#212121f5` with elevation-prominent against `#181818` (not flat same-surface).
- Light composer renders as one uninterrupted solid surface with no context
  rail or independent top elevation.
- Model chip shows the active model ID; its menu contains only runnable
  provider/model choices and Agent.
- Placeholder and approval chip remain legible on light and dark plates.

## US-UI-39 Home mark + hero title optical
- Empty-home PI-Desktop mark is visible (not near-invisible); stroke density remains readable without a decorative ghost effect.
- Empty-home title with a project uses a readable project label span (short basenames may display as `PI-Desktop` for optical parity).

## US-UI-40 Home content width vs rem root
- At 1200×690 light empty home, composer plate outer width is ~744–760px (not ~640px).
- Home suggestion grid spans the same content column as the composer plate.

## US-UI-41 Dark hero + night box readability
- Dark empty home hero title ink is light-on-dark (`--ds-text-primary` / near white), not hardcoded `#1a1c1f`.
- Night composer plate is elevated-primary `#212121f5` on main `#181818` with elevation-prominent; light theme is not forced to the night plate fill.

## US-UI-42 Light scoped session creation chrome
- On the light sidebar, the Sessions and Projects scoped create controls remain
  icon-only with semantic hover wash; no standalone New task row is rendered.

## US-UI-43 Empty home plate Y + night elevated-primary
- Open empty home at ~1200×690 light theme.
- Composer plate is bottom-aligned and content-driven: an empty or one-line
  draft uses the compact shell rather than a fixed ~140px minimum; the surface
  remains uniformly solid with no decorative wash.
- Switch dark theme: night plate is elevated-primary (`#212121f5` / gray-800
  96%) with the same restrained elevation and no internal gradient.

## US-UI-44 Settings compact directory + merged sections
- Open Settings light theme at ~1200×690.
- Full-page shell: rail ~260px on `#f3f3f3`, main `#fff`; search pill at the
  rail top; Back to app pinned at the rail foot and vertically centred on the
  main shell's sidebar footer icon line; Appearance active pill with an
  accent-tinted fill and an accent glyph.
- Rail order is exactly Appearance / 外观, Conversation / 对话,
  Shortcuts / 快捷键, Voice / 语音, Behavior / 行为, Models / 模型,
  Instructions / 指令, Skills / 技能, MCP, Subagents / 子智能体,
  Projects / 项目, System / 系统, Cloud sync / 云同步,
  Remote Hosts / 远程主机, and Info / 信息;
  the rows are grouped under muted Preferences / 偏好, Agent / 智能体,
  Workspace / 工作区, and System / 系统 headings without divider lines,
  duplicate destinations, or placeholder rows. The selected page keeps its
  descriptive title, such as Model configuration or Project archive, and opens
  with the rail's glyph at page scale plus — where the destination declares one
  — a single subtitle line.
- Appearance content: page header and an **Interface** card with working
  system/light/dark controls, then Sidebar, Radial context menu and Startup.
  Behavior holds Session defaults (default mode, permission mode, Command
  shell), Execution and Computer use; Context management has no settings card.
  Conversation holds Display and Input & links. System holds Network, Storage,
  Power and, on Windows/Linux, Close behavior. Shortcuts holds
  the Keyboard shortcuts card.
  File-open target, language
  override, menu-bar behavior, and bottom-panel behavior are absent until
  host-backed implementations exist.
- Model configuration contains the default model selector, separate vendor
  account management with add/edit dialogs, and card-based AI service management
  with an add-provider dialog. The Defaults card reuses the compact geometry of
  every other settings row: the "Default model" label sits above the provider -
  model id line, and the quiet Change action remains separate from the current
  value. Change opens a floating listbox anchored to it: the card's height
  never changes, the model-level list is grouped by provider and scrolls once
  the configured models exceed its bounded height, it flips above the trigger
  near the viewport bottom, it is not clipped by the settings panel, and Escape,
  an outside press, or scrolling the trigger out of view closes it while focus
  returns to Change.
- Plugin load/enable/disable/uninstall remains available from the app shell's
  independent Extensions destination; its Marketplace tab always uses the
  official catalog, so Settings has no duplicate Extensions destination.
- Dark: rail `#000`, main `#181818`, cards elevated `#212121`.

## US-UI-38 Composer workspace context omitted
- On empty home, project home, and after starting a transcript, the composer
  never renders a project / Local / branch capsule.
- Workspace identity remains visible through the home hero or sidebar rather
  than being duplicated above the prompt.

## US-UI-37 Empty draft row + resize
- Empty composer prompt rows show no leading brand icon and retain visible
  placeholder ink (not a blank white/night hole).
- Auto-resize never collapses empty textarea below ~28px.
- Disabled send control is a solid gray chip on light (`#8e8e90`), full opacity with white arrow.
- Dark night plate remains elevated-primary `#212121f5` with readable elevation-prominent on `#181818`.

## US-UI-31b (superseded)
- Superseded by US-UI-31 home empty vertical stack (D111).

## US-UI-45 Composer width remains stable when the minimap appears
- Open empty home and record the composer plate width. Open a short transcript
  that fits one viewport, then grow it until the left-edge conversation minimap
  appears.
- The empty-home and docked composer plates use the same horizontal gutter and
  maximum content width. Their shell, textarea, placeholder alignment, toolbar
  padding, minimum input height, theme fill, and shadow are visually identical;
  only the parent placement and localized welcome copy differ. The minimap
  remains out of flow on the transcript's left edge and does not squeeze or
  resize the composer.
- When transcript content first overflows, the native scrollbar gutter is
  already reserved on both sides, so the transcript and composer keep one
  horizontal center instead of jumping left.

## US-UI-46 Home-with-project composer chrome
- Open a project on empty home (no transcript).
- Expect no workspace controls attached to the plate; there is no legacy draft
  mark, and the placeholder uses the PI-Desktop copy.
- Model chip shows the active model ID; the footer uses the circular local-user
  glyph, two-line Custom / Local profile identity, disclosure chevron, and
  separate Help → Settings Info control.

## US-UI-47 Projects index parity
- Open Settings → Project archive.
- Expect the Settings section title, search pill, Add project button, and the
  complete durable project list including archived rows.
- Rows expand for recent tasks; activating a project or one of its sessions
  uses `setProject` without re-picking via dialog and keeps session/workspace
  context synchronized. Sidebar pin, archive, and close metadata remains local
  to the renderer; only the explicit row-menu Delete project action removes a
  durable Project-archive row, and it removes that project's sessions with it
  (ADR 0251).

## US-UI-48 Home starter glyphs and labels are absent (D206)
- On empty home, no developer starter icon plate, title/description, or
  starter-card glyph renders in light or dark themes.
- The hero, optional onboarding checklist, and bottom composer remain the only
  empty-home task-entry surfaces.

## US-UI-49 Scoped sidebar row chrome
- Hover or select a project or temporary session row.
- Expect restrained title rows with active/hover background and compact
  overflow actions for pin/archive (not a Recents aggregate).
- Multiple retained project groups may be visible at once; sessions remain
  under exact-path groups, while closed-project sessions remain available in
  Settings → Project archive.

## US-UI-50 Destination title scale
- Open Settings → Project archive and Plugins.
- Expect large section titles (~28px) consistent with Codex destination/index pages.
- Dark home scoped session-creation controls remain quiet icon actions without
  a standalone New task row.

## US-UI-52 Settings gold chrome metrics (D070)
- Open Settings light General at ~1200×690.
- Expect ~275px `#f4f4f4` rail, single active General pill, Back + search.
- Expect the working theme selector without inert toggle or open-target rows.
- Expect Appearance in General and Permissions + Defaults in AI. The rail
  contains General, AI, Shortcuts, Instructions, Models, Skills, MCP,
  Subagents, Projects, Cloud sync and Remote Hosts (both Experimental in all
  builds), and Info. Voice may appear between AI and
  builds with developer mode on; plugin-contributed destinations follow the
  core groups. There is no Import destination.
- Resize between 800px, 1200px, and 1600px widths; the content cards fill the
  available right pane at each size without changing the rail or introducing
  horizontal scrolling.

## US-UI-53 Settings dark shell (D070)
- Dark theme Settings General: black rail, elevated cards, blue on-toggles, Back returns to chat.
- Row descriptions use theme-aware secondary text and remain clearly readable on
  the `#212121` card surface; they must not fall back to low-contrast muted ink.

## US-UI-54 Toast variants + lifecycle (D085)
- Trigger a success (save provider), an error (run with an invalid key), and an
  info toast from a test plugin.
- Expect a top-center stack on an elevated plate with a tinted variant icon (green ✓ / red ! / info) and an X dismiss per card; newest enters at the top-center anchor and pushes older cards down.
- Success/info auto-dismiss ~4s, error lingers ~8s; hovering a card pauses its countdown; X removes it immediately.
- With the stack overlapping the frameless titlebar band, hover still pauses
  the countdown and every X remains clickable instead of dragging the window.
- Repeating the same action restarts the existing toast instead of stacking a duplicate; stack never exceeds 4.
- Toast message text is selectable: dragging across a card highlights only
  its message text and `Cmd/Ctrl+C` copies it, while the card icon and its X
  dismiss control expose no selection.
- Capture rig scenes `pi-toasts-light` / `pi-toasts-dark` show the stack in both themes.

## US-UI-55 Composer textarea growth (D089)
- In both home and thread-docked composers, an empty or single-line draft
  displays one visible text line.
- Enter or paste two through seven visual lines; the textarea grows with the
  wrapped content without manual resizing.
- Add an eighth visual line; the textarea stays at seven visible lines and
  scrolls internally instead of growing the composer further.
- Delete back to one line or submit the draft; the textarea contracts to its
  one-line default.
- With a large workspace open and the `@` file menu filtering, type sustained
  text; the caret keeps up with typing without visible stalls and the menu's
  row order is unchanged. Growth through seven lines, internal scrolling past
  the seventh, and contraction on delete or submit behave as above (D264).

## US-UI-56 Codex transcript tool activity
- In light and dark themes, tool calls use transparent compact activity rows,
  not elevated cards or colored success rails.
- Historical consecutive calls appear inside a default-collapsed processing
  group. During a live turn, the latest group opens automatically so its
  process list is visible, but tool-call details stay collapsed. The latest
  thinking step opens automatically; when the turn settles, only that automatic
  thinking disclosure closes. A group or row touched by the user keeps its
  chosen state.
- Its active header shows `Processing · {elapsed}` and a localized current
  action/phase capsule such as `Editing`, `Thinking`, or `Waiting for model`;
  its completed header shows `Processed for {elapsed}`, plus a localized step
  count.
- The row shows a semantic 15–16px icon, progressive/past-tense action,
  ellipsized monospace argument hint, quiet disclosure chevron, and localized
  running/error/denied state.
- Fork-family tools show the GitFork branch icon instead of the generic tool
  glyph.
- Expanding a completed call reveals output before input. Both sections are
  independently copyable and capped with internal scrolling.
- Reloading the session preserves the action label and argument hint instead of
  degrading the row to a generic `Tool`.
- Run a turn that emits assistant text, calls multiple tools, and resumes with
  more assistant text. During streaming and after session reload, expect one
  assistant article for the whole user turn, with fragments and activity in
  original order but only one trailing model/usage row and one Copy/Fork/Retry
  toolbar. Copy includes all assistant text fragments in order.

## US-UI-57 Multi-project sidebar groups
- Open projects A and B without closing either.
- Expect a `Sessions` heading above `Projects`, containing path-less
  conversations plus new-session and sort actions. With more than five
  standalone conversations, expect a five-row-high list that scrolls to every
  remaining row without growing further.
- Right-click the `Sessions` heading or empty standalone list chrome and expect
  a one-item create menu that creates/reuses a path-less temporary session.
- Expect the following `Projects` heading to retain its new-project folder
  action, one path-keyed group per retained project, and an active-state marker
  on exactly one group. Its list consumes the remaining height and scrolls
  independently. Adjacent project groups read as a compact continuous tree
  without detached card spacing.
- Right-click the `Projects` heading or empty project-list chrome and expect a
  one-item create menu that opens the same project picker as the folder-plus
  action.
- Expect project and session lists to scroll inside the sidebar body without
  clipping behind the footer; sidebar Collapse remains in the sidebar
  header. When the work panel is open, expect its sole collapse control to be
  the viewport-fixed toggle in the window's top-right corner rather than a
  chevron in the work-panel content header.
- Collapse A by clicking its directory label, expand it from the chevron area,
  then activate B and return to A. Only A's child rows collapse; project `+`
  and overflow actions do not toggle it; the
  active project, topbar path, and transcript switch together; the composer
  remains free of workspace identity chrome.
- Close B and reopen it from Settings → Project archive. Closing removes only the sidebar tab;
  durable project/session rows remain available.

## US-UI-58 Sidebar organization actions
- Open a project and conversation overflow menu.
- Expect localized Pin/Unpin, Archive/Restore, and (for conversations) Delete
  actions with keyboard-reachable menu semantics.
- Open the sort menu from the standalone `Sessions` heading, pin one
  project/session, and choose each user-facing sort mode (Recently updated,
  Created date, Oldest first, Name). Pinned projects remain first in Projects;
  pinned conversations appear once in the global Pinned section above Sessions
  and Projects, with the selected session sort and no date headers.
- Archive a row, verify it is absent by default, enable Show archived, and
  restore it. The transcript and project binding remain unchanged.
- A legacy `manual` preference loads without presenting a drag-reorder
  affordance.

## E2E-SIDEBAR-global-pinned-conversations

- Seed an old pinned conversation in project A, today's unpinned conversation
  and eleven other normal rows in A, a pinned conversation in collapsed project
  B, one in closed project C, and a pinned Temporary conversation.
- Expect one Pinned section above Sessions and Projects, containing all four
  pins with their project names or Temporary space label. Pins have no date
  headers and do not appear a second time in ordinary history. A still shows
  ten normal rows initially, with its remaining rows behind Load more.
- Change the date across midnight and select each session sort. Pins remain
  above history; sorting changes only their internal order. Selecting B or C's
  pin activates its original conversation and project; selecting the Temporary
  pin clears workspace context. Running and unread states remain visible.
- Pin and unpin through the keyboard menu. The row moves immediately and focus
  follows its overflow control, or returns to the Sessions sort control if the
  row is now folded or belongs to a closed project. Unpin the last pin and
  expect no empty Pinned section.
- Archive a pin and a pinned conversation's project. Both disappear by default;
  Show archived reveals them and Restore preserves the pin. Delete a pinned
  conversation and expect no stale row. Reload and expect saved pins to return.
- With enough pins to overflow, scroll within Pinned and verify that Sessions,
  Projects, and the footer remain reachable in light/dark themes at minimum
  supported window size. Existing hover cards, context menus, drag/drop, and
  project pinning retain their normal behavior.

## US-UI-59 Session-rooted background tools
- Start a visible turn in project A, switch to project B while it runs, and
  inspect both sidebar status indicators.
- Expect A's turn to continue in the background, B's composer/context to show
  only B, and tool output/artifacts from A to remain rooted in A without
  opening or activating a work-panel tab over B.
- Open a Temporary session and invoke a workspace-required tool; expect the
  normal `WORKSPACE_REQUIRED` result rather than inheritance from B.

## US-UI-60 WorkBuddy transcript plates (D101)
- Open a mixed transcript in light and dark themes.
- Expect right-aligned compact user plates, transparent full-width assistant
  prose, denser row spacing, and hover-only copy chips under each turn.
- While an assistant answer streams, expect the same transparent full-width
  prose as a completed turn — no left rail and no whole-turn tile. The tile
  belongs only to a subagent/delegation card (D319, D323).

## US-UI-60b Assistant markdown prose redesign
- Open an assistant answer with headings, table, code fence, blockquote, and task list.
- Expect the refined `.prose-chat` hierarchy and inset code chrome in both themes.
- Expand thinking markdown and confirm it stays visually subordinate to the answer.

## US-UI-60c Compact assistant error card
- Trigger a retriable provider/model failure in the transcript in light and dark themes.
- Expect the assistant error to use a restrained inline surface with a thin error rail. The localized summary, stable code, and details disclosure share one compact header; the card does not render a second bottom action row.
- Confirm the details remain expanded on first render, keep the redacted provider response and provider/model IDs, and expose an icon-only copy control with an accessible label/tooltip. On a narrow window, header actions wrap without horizontal overflow. At default and widened chat content widths, the card fills the assistant column; resizing the content band makes the card follow it, and a constrained pane does not overflow.
- Expect the compact assistant error card itself to expose one localized **Continue** action beside the details disclosure. Click it and expect the app to append the localized continuation prompt (`Continue the current task` / `继续当前任务`) to the same session and start the next turn without truncating the failed turn.
- For a terminal `PROVIDER_RATE_LIMITED` (including HTTP 429), expect the
  structured assistant error card to remain the only failure surface: it
  exposes exactly one localized **Continue** action and no **Regenerate**
  action, while the generic TurnOutcomeCard is omitted.
- Click **Continue** and expect the app to append the localized continuation
  prompt (`Continue the user's unfinished task.` / `继续用户未完成的任务`) to the
  same session and start the next turn without truncating the failed turn.
- Activate the localized **Dismiss** action. Expect the error card to disappear
  from the current transcript view while its underlying error message and raw
  diagnostic data remain unchanged; navigating away and back in the same app
  runtime keeps the dismissal.

## US-UI-61 Assistant context summary + retry (D103, D184, D244, D347)
- Complete an assistant turn that reports usage.
- Expect a model badge under the answer and the compact Context inspector in
  the composer toolbar, left of the model picker. The trigger shows the
  remaining-capacity ring and percentage; clicking it (or activating it from
  the keyboard) shows remaining tokens plus percentage, used/window counts,
  two unboxed turn/speed values, one inline exact provider-usage summary, and
  one aggregate tool-usage summary with types, calls, and approximate tokens.
  Per-tool rows, bars, badges, explanatory estimate copy, and inner section
  hairlines are not shown.
- Hovering the trigger changes nothing; the open panel closes on a second
  activation, an outside click, or Escape.
- Scroll or resize while the panel is open; expect the body-level overlay to
  flip, clamp, and remain fully visible instead of being clipped by the
  composer or transcript.
- Hover the action row and click Retry; the nearest preceding user prompt is
  re-sent.

## US-UI-62 In-place regenerate (D105)
- On a multi-turn transcript, regenerate an earlier assistant answer.
- Expect the later turns to disappear and the chosen user prompt to re-run in
  place, without stacking a second copy of the prompt.

## US-UI-63 Regenerate history pager (D109)
- Regenerate an assistant answer twice.
- After each retry, hover or focus the root user bubble and expect its action
  toolbar to expose a `1/N` pager for restoring earlier variants.

## US-UI-64 Empty home no composer overlap (D111/D204/D206)
- Open empty home at ~1200×690 and at a shorter height (~900×640).
- Expect the hero and optional onboarding checklist in a scrollable content
  region, with the home composer visibly reserved at the bottom and no starter
  cards.
- Short windows scroll the content region rather than stacking the composer over
  the checklist; when the checklist is absent, no empty spacer remains.

## US-UI-65 Durable notification inbox (D117/D130)
- Verify a focused-current completion leaves the inbox unchanged, then
  populate it through background/unfocused completed and failed task rows,
  including one long session title. Inspect the expanded sidebar footer and
  popover in light/dark themes at default and narrow supported widths.
- Expect no titlebar bell, a stable 32px footer bell in the former Help position,
  a non-overlapping `1`–`99` / `99+` badge,
  dense 360px-or-narrower list, localized kind/session/time/error content, and
  distinct text/icon/unread-dot semantics without nested cards or clipped text.
- Switch All/Unread; use Tab, arrow keys, Home/End, Enter/Space, Escape, and
  outside click. Focus order remains predictable, row activation opens the
  correct session, and Escape restores focus to the bell.
- Mark all read and Clear expose icon tooltips/accessible names, disabled and
  empty states remain understandable, and reduced-motion mode changes the
  popover instantly without suppressing focus or unread state.
- While a task banner is pending, mark its row read and then clear the inbox;
  inject a delayed duplicate event afterwards. The old row, sidebar mark, and
  native banner stay dismissed, while a new post-clear task appears once.

## US-UI-66 Application update notice layout
- In a conversation with the docked composer visible, exercise manual
  `available`, in-app `downloading`, and `downloaded` update fixtures in light
  and dark themes at default and minimum supported window sizes. Grow the
  composer draft to its maximum visible height.
- Expect one compact update notice below the titlebar in the main pane's
  top-right safe area. It never intersects the composer, including while the
  draft grows, and it does not cover an open work panel.
- Expect a stable update icon/title/message hierarchy, determinate progress for
  `downloading`, the applicable View release or Restart to update action, and a
  24px dismiss control with an accessible name. Dismissing one status stage
  does not suppress a later stage for the same version.
- When the fixture includes `releaseNotes`, expect a "What's new" section under
  the status message on both the banner and Settings → Info Updates row, using
  the product UI locale (EN or zh-CN). A fixture without notes omits the
  section. Switching language re-resolves the same version's notes without a
  new check.

## US-UI-67 Distinct sidebar task status indicators (D135)
- In light and dark themes, keep session B selected while session A progresses
  through in-progress, completed, a new in-progress turn, failed, and aborted
  states. Repeat with reduced motion enabled and inspect keyboard focus.
- Expect A to show an orange dot that breathes twice over 3.2 seconds and then
  stays steady while in progress, a green check on completion, and a red circled
  alert on failure. Starting a new turn clears A's earlier terminal mark; abort
  leaves no completed or failed mark.
- Expect selected idle B to show a static accent-blue outlined ring and active
  row background. If selected B starts work, its orange in-progress dot takes
  precedence until the turn settles; its latest terminal result remains hidden
  behind the selected ring while selected.
- Every indicator exposes localized In progress / Selected / Completed / Failed
  text through its accessible name and tooltip. Reduced motion makes the orange
  dot static without changing its color or meaning. Row height, title truncation,
  pin icon, hover actions, and focus ring remain stable in both themes.
- Open a conversation with a completed or failed mark and expect that terminal
  mark to clear immediately while its durable task notification becomes read.
  Refresh notifications and restart the app; the acknowledged mark must not
  return. A terminal notification marked read from the inbox likewise produces
  no sidebar terminal mark.
- Repeat for a running related-session marker in the hover card. After 3.2
  seconds, neither running marker has an active animation; recording an otherwise
  idle native macOS window must show no continuous frames from these markers.
  Start a new turn and reopen the hover card: the bounded animation can play again.
  GPU measurements must distinguish app frame submissions from whole-system load.
- Repeat with the three idle-reachable indicators, one per idle window: leave a
  session parked on a tool approval request, turn plan mode on, and raise a
  backend warning banner. After 3.2 seconds none of the permission dot, the
  plan-mode chip, or the warning dot has an active animation, and recording an
  otherwise idle native macOS window shows no continuous frames from them.
  Under reduced motion all three are static from the first painted frame.

## US-UI-68 Session-scoped inline permissions and artifacts (D138/D142)
- Run two sessions concurrently and keep A visible while B reaches a tool
  approval request. Inspect light/dark themes at default and narrow widths.
- Expect no backdrop, modal, page/session switch, work-panel hide, transcript
  replacement, or composer-focus change in A. B retains its pending state.
- Open B explicitly and expect one inline permission card after B's latest
  activity, with readable risk, args, workspace, and wrapping action controls.
  Switching away and back preserves the pending request without a deadline.
- Make A and B pending together, resolve each independently, and confirm neither
  action removes or changes the other card.
- Resolve A's Write/Edit permission and switch to B before completion. Expect no
  transient Review panel in B and no panel/window flash; returning to A restores
  A's prior panel selection with the inline review card in its transcript — the
  edit opened no tab — while B's tabs and Browser resource remain unchanged.

## US-UI-69 Sidebar type balance (D144/D161)
- Open the expanded sidebar in light and dark themes at default and minimum
  supported widths with at least one session, one project group, and the local
  profile footer visible.
- Expect Plugins, footer profile name, and profile menu actions to render at
  the body chrome size (`--text-base` / 14px).
- Expect session/thread titles, project/group titles, and empty-state copy at
  `--text-md` / 13px, with uppercase section labels (`SESSIONS` / `PROJECTS`)
  at `--text-sm` / 12px — never below `--text-md` for primary list content.
- Confirm row pitch remains compact (≈28–32px), titles still truncate cleanly,
  and collapsed icon-rail controls stay legible without reflowing the shell.

## US-UI-70 Disable text correction on editable fields (D145)
- Open empty home, a docked transcript, Settings search, Plugins market search,
  Projects archive search, global search (which now includes commands), provider model combo,
  message-edit textarea, and the work-panel browser URL bar in light and dark.
- Expect every text `input`/`textarea` to expose `spellcheck="false"` (React
  `spellCheck={false}`) plus `autocorrect="off"` and `autocapitalize="off"`.
- Expect no red spelling underlines while typing code-like tokens, paths, model
  ids, or URLs; checkboxes and non-text controls remain unchanged.

## US-UI-71 Composer runtime chip descenders (D150)
- Open empty home and a docked thread with a model ID that contains descenders
  (for example `gpt`, `gemini`, or any id with `g`/`y`/`p`/`q`/`j`).
- Inspect Agent/Plan/Goal, Thinking (when present), permission mode, and the
  model chip in light and dark.
- Expect every chip label to show full glyph ink — bottoms of `g`/`y`/`p` are not
  clipped by the 28px capsule — while long model IDs still ellipsize horizontally.
- **Specs linked**: `04-ux/07-ui-design-system.md` §8.2, `04-ux/08-component-spec.md` §11.5, decisions-log D150
- **Milestone**: M5
- **Status**: Partially automated (renderer source test: chip line-height + no leading-none)

## US-UI-72 Apple-inspired global corner hierarchy (D210)
- Open the empty home, a populated transcript, Settings, Plugins, Project
  archive, a menu, and a dialog at the default supported desktop size in light
  and dark themes.
- Expect fixed corners to follow the global 4/6/8/10/12/14/16/18/20/24px
  ladder, with visually larger or more elevated surfaces receiving the larger
  radii.
- Standard compact and medium buttons and fields remain rounded rectangles,
  not capsules. Pills, segmented selections, status labels, progress tracks,
  switches, equal-width circular icon controls, and dots retain their explicit
  capsule or circle shape.
- Where a rounded child sits against a rounded parent corner, expect the radii
  to read concentrically with the intervening inset. Full-width sidebar,
  titlebar, and work-panel edges remain square rather than becoming floating
  cards.
- Resize to the minimum supported window and inspect menus/dialogs near each
  edge. Rounded surfaces must not clip text, focus rings, actions, or scrollable
  content.
- **Specs linked**: `04-ux/07-ui-design-system.md` §6.2, ADR 0071
- **Milestone**: M5
- **Status**: Partially automated (radius token and shared-control source test)

## US-UI-73 Composer mode selector has stable width
- Open the empty home and a docked thread in both English and zh-CN.
- Open the Composer mode chip and switch between Agent/Plan/Goal several times.
- Expect the chip to list the three modes as checked menu items, to name only
  the committed mode, and to keep one fixed width sized for the longest built-in
  label (English "Agent" / zh-CN "智能体") plus its caret; the adjacent Thinking
  and permission controls, send button, and composer shell do not move or
  resize.
- In Goal, expect the permission chip to remain visible with the same geometry,
  show Full auto / 全自动, and stay disabled without opening a permission menu.
  The Plan/Goal approval card remains the separate execution-policy control.
- **Specs linked**: `04-ux/08-component-spec.md` §11.3
- **Milestone**: M5
- **Status**: Partially automated (renderer style/source contract)

## US-UI-74 macOS native sidebar vibrancy
- Open the desktop app on macOS in both light and dark appearances with the
  sidebar expanded, then exercise the existing collapse/expand path.
- Expect the main window to use native `sidebar` vibrancy with a thin
  theme tint behind `.sidebar` and any rendered `.sidebar-rail`: the material
  follows the app theme (`nativeTheme.themeSource`), so a dark shell stays on a
  dark plate and a light shell stays on a light plate. Desktop content stays
  perceptible through the material and the surface carries a top-to-bottom
  sheen rather than a flat fill. The dock carries no seam or hairline — the
  glass meets the opaque main pane flush, so no hard divider separates the two
  panes. Switching language or other non-theme settings does not rebuild the
  glass. Disabling or uninstalling a selected plugin theme returns native
  chrome to `system`.
- Expect `.main-pane`, `.main-titlebar`, and `.conversation-topbar` to remain
  solid theme surfaces without whole-window transparency or a strong artificial
  blur/card treatment. Sidebar collapse/expand, resize, traffic-light placement,
  and drag/no-drag hit regions remain unchanged.
- **Specs linked**: `04-ux/08-component-spec.md` §1.7, §3.4; decisions-log D304 / D348
- **Milestone**: M6
- **Status**: Partially automated (`macos-sidebar-vibrancy.test.mjs` source contract); native visual verification Draft

## US-UI-75 Light message-edit plate
- Open a populated transcript in light and dark themes and choose Edit on a
  user prompt.
- Expect the inline editor to be a `--ds-tile-deep` plate at
  `--ds-composer-radius` with no outer shadow and no hairline stroke. On
  light theme the 8% ink wash must remain distinct from the `#ffffff` chat
  surface; the composer glow must not appear or get clipped at the plate
  edges. Retry and Cancel stay legible in the footer.
- Focusing the textarea paints an inset 2px accent ring inside the plate;
  Escape or Cancel restores the bubble.

## E2E-124: Window controls minimize to the taskbar and close to the chosen surface

- **Preconditions**: Built desktop app on macOS, Windows, and Linux; English
  and zh-CN locales are available; a normal main window is open.
- **Steps**: 1) On Windows, maximize the focused main window and click its
  taskbar button; confirm it minimizes while the PI-Desktop taskbar entry
  remains. Click the same taskbar button again; after the restore settles,
  confirm the window remains maximized within the display work area and the
  taskbar stays visible. Cover the window with another app, click the PI-Desktop
  taskbar entry, and confirm it comes to the front without entering the tray. 2) On
-  macOS, click the traffic-light minimize control and confirm it hides the
  window to the tray. On Windows/Linux, use the renderer minimize control and
  confirm the native taskbar entry remains available; click it again and
  confirm the same window restores and focuses. 3) Select Close to tray and
  close the Windows/Linux window; confirm it leaves the taskbar and is
  restored by the tray icon. Select Quit and repeat; confirm the process exits.
  4) Open the tray menu and choose Show, then repeat with Quit. 5) Repeat in
  zh-CN and invoke macOS app activation while the window is tray-hidden.
- **Expected**: Windows native taskbar toggling and the Windows/Linux renderer
  minimize controls keep the taskbar entry and round-trip through native
  minimize/restore. Restoring a maximized frameless Windows window keeps it
  within the display work area and leaves the taskbar visible. A taskbar click
  on a covered window brings it to the front.
  Close to tray is the only Windows/Linux close path that hides the window,
  while Quit exits. On macOS the menu bar icon is a readable transparent
  monochrome PI mark without the rounded application tile, and native minimize
  remains tray-resident. Show/click/double-click/app activation restores the
  existing window; the localized menu contains Show PI-Desktop and Quit
  PI-Desktop. Quit runs the normal shutdown sequence and leaves no orphan host,
  sidecar, or tray process.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/07-process-model.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D216, D230, D252, D256), ADR 0078, ADR 0090,
  ADR 0117, ADR 0123
- **Acceptance**: A (app lifecycle), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; native cross-platform tray journey
  Draft (run only in a capable environment when this surface changes)

## E2E-150: A second launch surfaces the running app instead of starting one

- **Preconditions**: Built desktop app on macOS, Windows, and Linux, installed
  with the default data directory; one instance is running with at least one
  session in its sidebar.
- **Steps**: 1) Launch the app again from the platform's normal entry point
  (Start menu/desktop shortcut, `.AppImage`, `open -n` on macOS) and observe
  both the window and the process list. 2) Minimize the window into the tray,
  then launch again. 3) On Windows/Linux with close behavior `tray`, close the
  window, then launch again. 4) While the app is running, launch a build with
  `PI_DESKTOP_DATA_DIR` set to an empty directory. 5) Still while the packaged
  app is running, start a development build (the `dev` script, with no
  `PI_DESKTOP_DATA_DIR`). 6) Quit the app, confirm no process remains, and
  launch once more.
- **Expected**: Steps 1–3 never create a second window, tray icon, host-core,
  agent sidecar, or log file: the existing window is restored and focused, the
  duplicate process exits, and the running instance's session list, in-flight
  turn, and `pi.sqlite` are untouched. Step 4 starts normally as an independent
  instance against its own data directory. Step 5 also starts normally: the
  development build takes its own `userData` and `~/.pi-desktop-dev`, so it
  neither waits for nor disturbs the running packaged app. Step 6 starts a clean
  single instance, proving the lock is released on exit and never leaves a stale
  block.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `08-meta/decisions-log.md` (D236, D599, D002), ADR 0094
- **Acceptance**: A (app lifecycle), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; native cross-platform relaunch
  journey Draft (run only in a capable environment when this surface changes)

## E2E-125: Bilingual VitePress documentation entry points remain usable

- **Preconditions**: Docs dependencies are installed and the VitePress preview
  server is running from the repository.
- **Steps**: 1) Open `/` at 1440×900 and verify the English landing page,
  system map, read-by-intent journeys, reference shelf, global search,
  Guide/Specs/ADRs navigation, and language selector. 2) Switch to `/zh-CN/`
  and verify the translated hero, topic map, guides, and Chinese specification
  index. 3) Open `/zh-CN/spec/README`, follow a specification link, and verify
  it opens the English page and the sidebar lists the English specifications,
  including the `06-delivery/e2e/` catalogs. 4) Search in each locale and open
  a matching result. 5) Repeat the homepage and a long table-heavy
  specification at 390×844 in light and dark mode.
- **Expected**: Both locale entry points render without broken links or
  page-level horizontal overflow. Landing and reading columns are visually
  centered within their available layout; the mobile hero presents text before
  the system visual. Search returns local results. The mobile navigation opens
  and closes without shifting or obscuring the page. Code blocks and tables
  remain readable through contained scrolling, theme contrast stays clear, and
  every Chinese page identifies its English page as the canonical source.
- **Specs linked**: `02-architecture/04-documentation-site.md`, ADR 0079, ADR
  chinese-docs-entry-points-only
- **Acceptance**: Quality, documentation discoverability, responsive layout
- **Milestone**: M6+
- **Status**: Browser-rendered desktop/mobile verification is authorized for
  this documentation redesign.

## E2E-126: Appearance card selects a global UI font

- **Preconditions**: App running on macOS with an installed system font
  distinct from the built-in token stack (for example PingFang SC); a clean
  `~/.pi-desktop` profile.
- **Steps**:
  1) Open Settings → Appearance and confirm the Interface card shows a Font row
     below Theme and Language with a trigger labeled "System default".
  2) Open the Font picker and confirm it lists System default followed by
     installed system families only — no bundled open-licensed families and no
     license badge on any row; confirm the search input filters families and the
     current selection shows a check badge; confirm the menu opens as a floating
     layer above the card (not clipped or squeezed inside it) and stays readable
     when the card is near the bottom edge of the window; with many installed
     families, confirm the list opens without an input stall and scrolls
     immediately (only the visible rows are rendered, with an overscan buffer).
  3) Select an installed system family (for example PingFang SC) and confirm the
     trigger label and the whole UI re-render in that family without a reload,
     including CJK fallback rendering for Chinese text.
  4) Reopen the picker and confirm the family is still selected, then select
     System default and confirm the UI returns to the built-in token stack
     immediately.
  5) Restart the app and reopen Settings and confirm the default is still
     applied (the override is cleared, persisting an empty
     `AppSettings.fontFamily`).
  6) With a profile whose stored stack names a formerly bundled family (for
     example `"Geist", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
     sans-serif`), confirm the Font row shows that family under the Saved group,
     that no font file is loaded from the app, and that the UI renders through
     the system CJK fallback tier.
- **Expected**: The Font row is a searchable picker whose trigger previews the
  current family in that face; options are System default and the installed
  system families enumerated by Electron main via
  `pi-desktop/app/systemFonts` (cached 60 s, hidden `.`-prefixed families
  excluded); the app ships no font files, so no bundled group and no license
  badge appear, and a stored stack that matches no option stays listed first
  under Saved; selection persists as a CSS stack in `AppSettings.fontFamily` and
  overrides `--font-sans` live; Chinese text stays readable through the
  system-only CJK fallback tier; the menu is a body-level floating layer that is
  never clipped by the settings card; the option list is windowed with fixed row
  heights and an overscan buffer so only the visible slice is in the DOM, keeping
  opening, scrolling, and typing responsive regardless of how many families
  are installed; System default clears the override by persisting an empty
  stack.

- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`,
  `03-runtime/01-ipc-protocol.md`, ADR 0083, ADR 0298
- **Acceptance**: A (core shell), H (localization)
- **Milestone**: M5+
- **Status**: Documented

## E2E-193: Appearance card sets a global type scale

- **Preconditions**: App running with a clean `~/.pi-desktop` profile and an
  open conversation that shows transcript text, the composer, and the sidebar.
- **Steps**:
  1) Open Settings → Appearance and confirm the Interface card shows a Font
     size row below Font, with Grande selected and the slider at 100%.
  2) Choose Venti. Confirm chat transcript, composer, settings labels,
     sidebar session titles, and Lucide chrome icons all enlarge without a
     reload, keeping their relative steps, and that the control shows 115%.
  3) Drag the slider to 125%. Confirm Trenta becomes selected and
     every `--text-*` surface and icon grows further. Confirm the UI never
     shows a px field.
  4) Open the Browser and Files work-panel tabs, then use Zoom In and Reset
     Zoom. Confirm window zoom still scales chrome, that the type scale
     remains 125% after reset, and that both docked plugin pages follow it:
     their text and controls keep the same proportion as the app, and the
     Browser guest page still fills the area under its per-type-size toolbar.
  5) Restart the app and confirm the 125% scale is still applied
     (`AppSettings.fontScale` = 1.25).
  6) Choose Grande. Confirm the whole UI returns to 100% immediately;
     restart and confirm the default remains.
- **Expected**: Font size is Starbucks-style cup presets Tall / Grande /
  Venti / Trenta
  plus a percentage slider 80%–150% in 2.5% steps. Selection persists as
  `AppSettings.fontScale` (absent means 1) and sets `--font-scale`, multiplying
  every `--text-*` token and shared Lucide icon. Window Zoom In/Out/Reset remains
  independent.
  Docked plugin work-panel views (the bundled Browser and Files pages) repeat
  that multiplier — times the window zoom — as their own page zoom instead of
  importing the app tokens, so they stay in proportion at every setting, and a
  `pi.browser` guest rect is converted with the same factor. Detached plugin
  windows and widgets keep their own base size.
  Invalid values are rejected or clamped. No protocol or schema version bump.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`,
  ADR 0180, D343
- **Acceptance**: A (core shell), B (settings), H (localization)
- **Milestone**: M5+
- **Status**: Unit-covered (`packages/shared/src/font-size.test.ts`,
  `apps/desktop/test/settings-font-size.test.mjs`,
  `apps/desktop/test/plugin-view-scale.test.mjs`,
  `apps/desktop/test/browser-guest-hole-scale.test.mjs`); full UI journey Draft
  (run only in a capable environment when this surface changes)

## E2E-128: Revealed work panel with no resource offers available views

- **Preconditions**: App running with a project open and an active conversation
  that has produced no file, URL, or review artifact, so the session's work
  panel context holds no tabs.
- **Steps**:
  1) Press `Cmd/Ctrl + J` and confirm the panel appears with an empty body that
     shows the title "New" and Review plus Browser/in-scope plugin-view rows —
     not a blank area below the title bar.
  2) Tab into the available rows and confirm each takes a visible focus ring
     and that hovering a row shows only a background fill.
  3) Activate Browser or a plugin view and confirm its singleton tab is created
     and selected; the empty body and its view list disappear.
  4) Click `+` to create a New launcher tab, activate the same view from its
     body, and confirm it selects the existing tab rather than creating a
     second one.
  5) Close the view tab and confirm the panel remains open on the New launcher
     when it was the last tab; press `Cmd/Ctrl + J` again and confirm it hides.
  6) Repeat step 1 in Chinese and in both light and dark themes, and at the
     244px panel minimum, confirming the copy wraps rather than clipping.
- **Expected**: `Cmd/Ctrl + J` reveals the panel without creating a tab, and the
  New launcher lists the same Review/plugin-view entries as its `+`-created
  page; a row creates or selects that singleton view. Each `+` click creates a
  separate closable New tab. Closing the final tab leaves the panel open on New.
  The no-tab empty body is not exposed as a `tabpanel`; explicit New tabs are
  labelled tabpanels. Their rows are buttons in a `role="group"` labelled
  Tools. Panel empty states share the app's empty-state
  proportions with no action button in the "open a project" states.
- **Specs linked**: `04-ux/08-component-spec.md` §5.2, §5.2.1, §5.3, §5.4, §5.5,
  `04-ux/07-ui-design-system.md`, ADR 0108
- **Acceptance**: A (core shell), H (localization)
- **Milestone**: M5+
- **Status**: Documented

## E2E-129: A run row shows its command once and copies it from the head

- **Preconditions**: App running with a project open and a conversation that has
  produced at least three command rows: one that succeeded with output, one that
  failed with both output and errors, and one still running.
- **Steps**:
  1) Leave the running row collapsed while it produces output and confirm the
  row remains a compact one-line status; then click its disclosure while the
  command is still running and confirm the current output appears immediately.
  1a) Keep the command running through enough output to exceed the output area's
  visible height and confirm the output stays inside its capped scroll region,
  rather than pushing the transcript out of view. Confirm later output replaces
  the same body in place while the row remains open.
  1b) Expand the successful row and confirm the body shows the command's output
     as plain text — no `Output` heading, no bordered card, no per-block copy
     button — and that the command is not repeated inside the body, with no
     argument list in its place.
  2) Confirm each row's head states its outcome to the right of the summary:
     `Done`, `Failed`, `Denied`, or `Working…`, each with a dot in the matching
     tint, and that the running row shows the pulsing dot instead of the row
     spinner.
  2a) Run a command that exits non-zero (`pnpm test` on a failing suite, or
     `false`) and confirm the row reads `Failed` with the error dot and opens
     itself, even though the tool call completed. Confirm the exit-code chip and
     the worded outcome agree.
  2b) Interrupt a long command so the shell is killed with no exit code, and
     confirm the row reads `Failed` rather than `Done`.
  3) Hover the successful row and confirm a copy button and the chevron appear
     between the summary and the row's right edge; move the pointer away and
     confirm both fade while the status label stays visible.
  4) Activate the copy button and confirm the clipboard holds the command as it
     was issued — a multi-line command keeps its line breaks, unlike the
     single-line summary in the head — and that the button acknowledges the copy
     before returning to its idle icon.
  5) Confirm the hover fill covers the whole head, including the copy button and
     chevron, and that a row with nothing to expand takes no fill at all.
  6) Tab through the row and confirm the header is the only stop that toggles
     the body, the copy button is reachable and takes a visible focus ring
     (revealing itself on focus), and the chevron is never a tab stop.
  7) With a screen reader, expand and collapse the row and confirm the outcome
     is announced once, not twice.
  8) Ask the agent to run a command that requires approval and confirm the
     permission card still shows the command it is asking about.
  9) Enable "reduce motion" and confirm the running dot holds still and the copy
     button appears without a fade.
  10) Repeat steps 1–3 in Chinese and in both light and dark themes.
- **Expected**: A command appears exactly once per row, in the head, alongside a
  copy control that yields it verbatim and a worded outcome that does not rely
  on the dot's color. The outcome reports what the command did — a non-zero or
  missing exit code reads `Failed` regardless of the tool call's own status — and
  a row with nothing to report states nothing instead of claiming `Done`. The
  running row is collapsed by default, and expanding it during execution shows
  the cumulative `details.output` stream in the stdout channel. The body keeps
  the live output in a capped internal scroll region and updates in place without
  rerendering unrelated rows; the completed `details.stdout` value wins over any
  older partial snapshot. The expanded body holds only what the command printed,
  as bare text, and a command that printed nothing opens empty rather than
  falling back to its arguments.
  Approval cards are unaffected, since they have no head of their own.
- **Specs linked**: `04-ux/08-component-spec.md` §9.2, §9.3, §9.5, §9.10
- **Acceptance**: E (tools & permissions), H (localization)
- **Milestone**: M5+
- **Status**: Documented

## E2E-130: Read mints a tag that an Edit consumes without re-reading

- **Preconditions**: A project-bound Agent session with a writable workspace and
  a source file of at least 300 lines. The provider fixture can emit an exact
  `Edit` payload.
- **Steps**:
  1. `Read` the file with no `offset` and record the `[path#TAG]` header, the
     `tag` field, and the `N:` prefixes on the returned lines.
  2. Emit `Edit` with that `tag` and a single `PUT N.=M:` whose body replaces two
     lines inside the read window.
  3. Confirm the successful result reports a new `tag`, then emit a second `Edit`
     with the returned tag and a `PUT >$:` append, with no intervening `Read`.
  4. `Read` a 200-line window at an `offset`, then `Edit` a line inside that
     window using the tag from the windowed read.
  5. Reopen the file on disk and compare it to the intended content byte for
     byte.
- **Expected**: The header tag is the whole-file tag, not the window's, so a
  windowed read anchors correctly; line numbers are absolute and unaffected by
  `offset`. Both edits apply, the second without any re-read, and each success
  returns the post-write tag. The file on disk matches the intended content
  exactly, with its original line endings and BOM state preserved.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §3, §4.2, §5,
  §6, §9, `03-runtime/16-tool-result-limits.md` §5, ADR 0087
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

## E2E-131: An edit on never-displayed lines is rejected and the retry succeeds

- **Preconditions**: A session that has read only lines 1–50 of a 400-line file.
  A second fixture file has one line longer than 16,384 characters.
- **Steps**:
  1. Emit `Edit` with the correct `tag` and a `PUT 300.=301:` op.
  2. Inspect the error code and confirm the message inlines the current content
     of lines 300 and 301.
  3. Retry the identical `Edit` payload, unchanged, including the same `tag`.
  4. Emit `Edit` with the correct tag and a `PUT 5.=60:` op spanning 56 unseen
     lines, and inspect the reveal.
  5. Retry that identical payload unchanged.
  6. `Read` the second fixture, confirm the long line is clipped and counted in
     `notice`, then `Edit` that clipped line.
- **Expected**: Step 1 fails with `EDIT_LINES_UNSEEN` and the file is unchanged.
  Step 3 applies, because the complete reveal merged those lines into the
  session's provenance. Step 4 fails with a reveal truncated at 40 lines that
  says to re-read the range, and step 5 fails again — a truncated reveal merges
  nothing, so the guard cannot be walked past in under-cap slices. Step 6 fails
  with `EDIT_LINES_UNSEEN`: a clipped line was never displayed.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §4.3, §9.1,
  §11, §12, `03-runtime/16-tool-result-limits.md` §2, ADR 0087
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

## E2E-132: Gap inserts, deletes, and multi-op payloads apply against one snapshot

- **Preconditions**: A read file whose content is known line by line.
- **Steps**:
  1. Emit one `Edit` combining `PUT <1:`, `PUT >40:`, `CUT 12.=14`, and
     `PUT 80.=80:` in a single `ops` payload.
  2. Compare the result against the same four changes computed against the
     original line numbering.
  3. Emit `PUT >$:` on the same file and confirm the append lands after the final
     line with exactly one terminating newline.
  4. Emit an `ops` payload whose body row starts with a literal `-` written as
     `+- item`, and one with a literal `+` written as `++ item`.
  5. Emit an `Edit` whose `PUT` body exactly reproduces the range's current
     content.
- **Expected**: Every anchor indexes the tagged snapshot, so no op shifts
  another and the combined result equals the four independent changes. `+-` and
  `++` write a single leading `-` and `+`. Step 5 returns `EDIT_NO_CHANGE` rather
  than reporting a successful write of nothing, and leaves no review record.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §7.2, §7.3,
  §7.4, §8.1, §9.3, ADR 0087
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

## E2E-133: Block ops resolve, echo their span, and decline instead of guessing

- **Preconditions**: Read fixtures in a supported grammar (a Rust file with a
  decorated/attributed function), a Markdown file with nested headings, and a
  file in a language outside the supported grammar list.
- **Steps**:
  1. Emit `PUT N*:` anchored on the `fn` line of a function whose declaration
     carries an `#[attribute]` line above it, and inspect the echoed
     `{anchorLine, start, end, op}`.
  2. Repeat anchored on the attribute line and compare the echoed span.
  3. Emit `PUT >N*:` on the same opener and confirm the insertion lands after the
     block's last line at sibling indentation.
  4. Emit `CUT N*` anchored on a lone `}` closer.
  5. Emit `PUT N*:` on a `##` heading in the Markdown fixture and confirm the
     span reaches the next same-or-higher heading, not the next deeper one.
  6. Emit `PUT N*:` in the unsupported-language file.
  7. Introduce a syntax error into the Rust fixture, re-read, and emit a block
     op.
- **Expected**: Step 1's span starts at the `fn` line and excludes the
  attribute; step 2's includes both — the difference is visible in the echo
  before the model has to infer it. Steps 4, 6, and 7 fail with
  `EDIT_BLOCK_UNRESOLVED` and a message naming the plain-range alternative;
  neither approximates a span. Range and gap ops still work in the unsupported
  language.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §8.2, §11,
  §12, ADR 0087 §4
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

## E2E-134: Registers move code within a call and across calls

- **Preconditions**: Two read files in the same session.
- **Steps**:
  1. In one `Edit`, emit `CUT 20.=30` followed by `PUT <5 ` with no register
     label, and confirm the lines moved within the file.
  2. In one `Edit`, emit two `CUT` ops with no labels followed by one unlabeled
     paste.
  3. Emit `CUT 40* @fn` on the first file, then in a separate `Edit` call emit
     `PUT <10 @fn` on the second file.
  4. Emit `PUT <10 @missing` for a register that was never set.
  5. Emit `PUT 10.=12 @fn` with a body row attached.
  6. Emit `PUT <1 ` with no label in a fresh `Edit` call that performed no
     capture.
  7. Delete the source file, then paste `@fn` again in a later call.
- **Expected**: Step 1 applies as one move with no duplicated or orphaned lines.
  Step 2 fails with `EDIT_REGISTER_AMBIGUOUS` instead of using the most recent
  capture. Step 3 completes the cross-file move across two calls, each with its
  own permission gate, review record, and artifacts row. Steps 4 and 6 fail with
  `EDIT_REGISTER_EMPTY` — the anonymous register did not survive the earlier
  call. Step 5 fails with `EDIT_PARSE_FAILED`. Step 7 still pastes: a register
  holds captured content, not a live reference.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §7.5, §8.3,
  §11, §13.2, ADR 0087 §5
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

## E2E-136: A stale tag still applies for head and tail inserts

- **Preconditions**: A read file whose tag is recorded, plus an external writer.
- **Steps**:
  1. Modify the middle of the file externally, then emit `PUT >$:` with the stale
     tag.
  2. Repeat with `PUT <1:` and the same stale tag.
  3. Repeat with a payload that mixes `PUT >$:` and an anchored `PUT 50.=50:`.
  4. Emit an `Edit` whose `tag` is well formed but was never recorded for that
     path in this session.
  5. Emit an `Edit` with a `tag` that is not four hex digits.
- **Expected**: Steps 1 and 2 apply with a drift warning, because neither anchor
  can be moved by content drift. Step 3 does not take the position-stable path:
  it goes to recovery and, failing that, to `EDIT_TAG_MISMATCH`. Step 4 returns
  `EDIT_TAG_UNKNOWN` and step 5 returns `EDIT_TAG_REQUIRED`; neither is reported
  as a generic `TOOL_FAILED`.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9, §11,
  `03-runtime/08-error-codes.md` §3.4
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

## E2E-137: Boundary repair fixes an off-by-one edge and refuses a tie

- **Preconditions**: A read source file with nested closing delimiters.
- **Steps**:
  1. Emit a `PUT N.=M:` whose range includes one trailing `}` that the body does
     not restate, and inspect the result and its warning.
  2. Emit a `PUT N.=M:` whose body restates a line that sits immediately outside
     the range.
  3. Emit a payload constructed so that two distinct repaired texts tie at the
     minimum repair cost.
  4. Emit a payload against a file that already fails to parse, and confirm the
     repair does not retain a row on parse-success evidence alone.
- **Expected**: Steps 1 and 2 apply with a warning naming exactly what was
  repaired, so a silent structural change is impossible. Step 3 returns
  `EDIT_REPAIR_AMBIGUOUS` rather than choosing; step 4 does not invent a
  retention. In every case the file either contains the repaired result described
  in the warning or is untouched.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §8.4, §11,
  ADR 0087
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

## E2E-140: Recoverable edit failures each get one retry before the guard counts three

- **Preconditions**: A session with one file read, and a way to make the file
  drift on disk between calls.
- **Steps**:
  1. Let the file drift, then emit an `Edit` with the now-stale tag whose anchors
     cannot be remapped, so it fails with `EDIT_TAG_MISMATCH`.
  2. Re-read, then emit an `Edit` anchored on lines the session never displayed,
     so it fails with `EDIT_LINES_UNSEEN` and a truncated reveal.
  3. Emit an `Edit` on that same path with a malformed op header.
  4. Emit a second `Edit` with a malformed op header.
  5. Emit a third `Edit` with a malformed op header.
- **Expected**: Steps 1 and 2 return their own codes with no `terminate` hint —
  each recoverable code spends its single grace on that path, and the turn keeps
  going, so the agent can act on what the error handed it. Steps 3 and 4 count as
  attempts 1 and 2 and still do not terminate. Step 5 terminates. A successful
  `Edit` inserted anywhere before step 5 resets the count, so the following
  failure is attempt 1 again.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9.3, §11,
  `03-runtime/03-tools-and-permissions.md` §4d, ADR 0087, ADR 0207
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

## E2E-EDIT-legacy-replacement-preserves-unmatched-text: A legacy Edit replaces only the matched text

- **Preconditions**: A workspace with an LF file containing `let x = foo;`,
  `value = 1; // keep me`, and a two-line statement, plus a CRLF copy of the
  first line.
- **Steps**:
  1. Issue an `Edit` with only `path`, `old_string` `= foo;`, and `new_string`
     `= bar;` (no `tag`, no `ops`).
  2. Issue a legacy `Edit` whose `old_string` is `value = 1;`, then one whose
     `old_string` starts mid-line and ends mid-line on the following line.
  3. Issue a legacy `Edit` whose `old_string` is a whole line including its
     newline and whose `new_string` is empty.
  4. Repeat step 1 on the CRLF file, then issue one legacy `Edit` whose
     `old_string` is not in the file.
  5. Compare every file on disk to the intended content byte for byte.
- **Expected**: Each replacement succeeds and returns a new `tag`, and only the
  matched text changes: the line reads `let x = bar;`, the trailing comment
  survives, the multi-line match keeps the text before its start and after its
  end, the whole-line deletion removes that line without leaving a blank line or
  touching its neighbours, and the CRLF file keeps CRLF endings. The missing
  `old_string` fails with `EDIT_LEGACY_MATCH_FAILED` and leaves the file
  unchanged. A replacement whose only effect would be toggling the terminal
  newline fails with `EDIT_NO_CHANGE` and leaves the file unchanged.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §11
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Automated (host-core unit tests:
  `edit_legacy_replacement_preserves_unmatched_bytes`,
  `edit_legacy_identical_replacement_leaves_file_unchanged`,
  `edit_legacy_terminal_newline_only_change_reports_no_change`,
  `edit_accepts_legacy_old_string_new_string_shape`)

## E2E-157: Global scrollbars stay quiet while remaining discoverable

- **Preconditions**: PI-Desktop is open with the expanded sidebar, more
  temporary sessions than the five-row cap, and enough retained project
  sessions to overflow the Projects region.
- **Steps**: 1) Inspect the idle Sessions and Projects scrollbars in light and
  dark themes. 2) Move the pointer into each list and then away from it,
  confirming that only the hovered list's thumb appears. 3) Move the pointer
  back into each list, drag its thumb through the region, and keyboard-focus a
  row to confirm the focused list keeps its thumb available. 4) Scroll the
  list with the wheel or trackpad after moving the pointer away from the thumb.
  5) Open a long conversation and a long right-side work-panel view, including
  the file manager view when the bundled plugin is enabled, and compare their idle,
  hovered, focused, and scrolling states on Windows.
- **Expected**: Both regions remain independently scrollable and the footer
  stays fixed. Every in-app scrollbar is trackless, 6px wide, and transparent
  at rest; hovering or focusing the owning scroller reveals only its thumb,
  while scrolling reveals it for 300ms after the last scroll event. Dragging
  keeps it visible without changing the scroll region's width. Chat, code,
  Settings, and the right-side work-panel scrollbars all match this rule. A
  docked or detached plugin panel receives the same host-injected rule; an
  external page inside Browser keeps its own page-owned scrollbar.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality (sidebar polish and independent navigation)
- **Milestone**: M6+
- **Status**: Unit-covered (`interaction-polish.test.mjs`); rendered scenario
  pending

## E2E-159: A long transcript keeps a bounded mounted window

- **Preconditions**: PI-Desktop is open on a session whose transcript is
  substantially longer than one `session.get` page (several hundred messages,
  including fenced code blocks and expanded tool activity), on a memory-
  constrained Windows machine where the regression was reported.
- **Steps**:
  1. Activate the session and confirm the first paint lands at the newest
     message without a top-of-transcript flash.
  2. Record the renderer's transcript row count and heap usage, then scroll
     upward continuously to the oldest loaded message and past it so older pages
     are fetched.
  3. At each point where the view stops advancing, confirm it resumes: earlier
     rows appear without the rows under the cursor being pushed down, and the
     earlier-messages indicator appears only when a page is actually fetched.
  4. Re-record the row count and heap usage after paging far back, then scroll
     back to the bottom and send a new prompt.
  5. While the answer streams, confirm following stays pinned and typing in the
     composer stays responsive. Scroll up mid-stream and confirm follow releases
     and the jump-to-latest pill appears.
  6. Hover and click conversation minimap dashes at several heights, then switch
     to another session and back.
  7. Activate a long session whose newest page collapses to less than one
     viewport (one tool-heavy turn) and confirm the outline is present with its
     earlier-history continuation, that clicking it reveals earlier turns, and
     that it keeps advancing without a manual scroll gesture until the whole
     history is loaded and mounted.
  8. Confirm the continuation disappears once nothing earlier remains, and that a
     short completed conversation that fits one viewport still shows no rail.
- **Expected**: Mounted transcript rows stay bounded by the window rather than
  growing with how far back the user scrolled, so the recorded row count and heap
  usage after paging far back stay close to the values recorded before it.
  Upward travel is continuous: growing the window and fetching a page both keep
  the viewport anchored to the row being read. Every minimap message dash jumps to
  a real row. Streaming stays smooth with the composer responsive, pinned-follow
  and jump-to-latest behave as specified, and switching away and back paints the
  retained pane at the position it was left. Earlier history is never stranded: with rows withheld or an older
  page pending, the outline stays available with an actionable earlier-history
  continuation and keeps advancing when the top boundary remains visible, even
  when the mounted tail does not overflow one viewport (D269). The continuation
  and the rail disappear once the full history is loaded and mounted and the
  transcript fits one page.
- **Specs linked**: `04-ux/08-component-spec.md` §7 and §8,
  `03-runtime/04-data-storage.md`, ADR 0120, ADR 0127, ADR 0130, D108, D269
- **Acceptance**: C (conversation), H (diagnostics), Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`transcript-window.test.mjs`,
  `conversation-minimap.test.mjs`, `interaction-performance.test.mjs`); rendered
  desktop journey and the low-memory Windows measurement pending

## E2E-160: Dragging the window across displays keeps the dropped position

- **Preconditions**: PI-Desktop is open on a machine with two displays arranged
  side by side, ideally with different work areas (a menu bar or taskbar on one
  only, or different resolutions). Run the case once with the work panel closed
  and once with it open at a committed width.
- **Steps**:
  1. Note the window position on the first display, then drag it by its
     titlebar onto the second display and release the pointer.
  2. Confirm the window stays where it was released: no jump, no snap to the
     display edge, and no vertical shift inherited from the first display.
  3. Drag the window so it straddles the boundary between the two displays and
     release it, then confirm it settles fully inside one display's work area
     without changing size.
  4. With the panel open, repeat the cross-display drag and confirm the panel
     remains an internal column at its committed renderer width; no reservation
     is re-planned and no panel-specific native geometry is applied.
  5. Drag the window back to the first display and confirm the application
     bounds continue to follow the dropped position without panel expansion.
  6. Leave the window on the second display, quit, and relaunch.
  7. Disconnect the second display while the window is on it, then reconnect it.
- **Expected**: Every pointer release leaves the window at the position the user
  dropped it on the display they dropped it on. A straddling drop is normalized
  into one work area without a resize. Relaunch reopens the window on the
  display it was last used on rather than the one it started on. Removing the
  display the window occupied still relocates it to a live display, and
  reconnecting preserves the same application bounds contract; no work-panel
  reservation is restored.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/09-interaction-patterns.md` §8, ADR 0132, ADR 0151
- **Acceptance**: F (persistence), Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`work-panel-window.test.mjs`: cross-display drag
  adoption, previous-display replan regression, work-area clamping); the
  two-display desktop journey and the relaunch/hotplug legs are pending

## E2E-167: Window edge resize stays smooth and persists the settled bounds

Native gesture regression: run `node scripts/e2e-window-native-behavior.mjs`
with the pinned Electron in an interactive desktop. The isolated fixture uses
production minimum-size and maximize-guard logic. On macOS test both opaque
and translucent windows: a 1440 DIP display's half-width minimum must allow a
window below 800 DIP, maximize must preserve native zoom/green controls,
and restore must re-enable edge resizing. `node scripts/e2e-window-controls.mjs`
then covers the built shell: maximized caption regions must compute to no-drag,
and a double-click must restore through the real preload/IPC and unlock the
normal caption. `maximized-window-chrome.test.mjs` covers late-query/event races,
repeated clicks, no-drag controls and unmount cleanup.
Windows covers maximize/restore with the same production guard; Linux keeps
its compositor-owned geometry. Unit tests cover cancellable edge events and
listener cleanup (`window-native-behavior.test.mjs`).

For transparent Windows 10 windows, send native caption double-click and
Win+Up/top-edge maximize; `SC_MAXIMIZE` must reach the public maximize path
exactly once. Restore/minimize/fullscreen and closing before deferred dispatch
must not trigger a maximize. Opaque Windows 11 windows keep their existing path.
These native Windows commands are unit-covered, not qualified by the macOS run.

Physical acceptance remains required on each target OS: double-click empty
regions across the 46 DIP titlebar (not action buttons), restore, drag to both
screen edges on a small/scaled display, maximize, attempt each edge/corner
resize and titlebar movement, then restore and repeat ordinary resizing.
On macOS enable system edge tiling (15+) and double-click zoom; repeat with
translucency on/off. Preserve fullscreen entry/exit and green-button access.
On Linux record desktop environment and X11/Wayland; do not claim one
compositor's behavior qualifies the others. A missing native runner or input
permission is NOT RUN, not passing native gesture acceptance.


Native Windows snapping regression (issue #2330): on an interactive Windows
desktop with a work-area half at least the nominal minimum width, run
`pnpm test:e2e:window-snap` against the candidate Windows Host and pinned Electron.
The isolated fixture uses production Main snapping/corner/fullscreen services,
real Host RPC, HWND-owner rejection checks, physical Win+Left/Right and titlebar
drag input, edge pixels, native resize/minimums, maximize/minimize/restore and
fullscreen/restore. Left/right snapping must equal the work-area halves; normal
and snapped client edges have no native insets or painted rim. Maximized client
and DWM-visible bounds must equal the work area. `--baseline` must fail the
keyboard assertion. `--legacy-surface` covers the older transparent surface on
the available OS only. `--prepare <directory>` stages portable fixture sources;
record actual OS/DPI, source revision, Host, Electron version, result and artifacts
from the Windows run separately. Native Windows 10 and mixed-monitor DPI checks
remain separate qualification, and hover Snap Layouts is outside this regression.

For independent review, run `--matrix --artifacts <new-directory>` or the
`Windows native snap acceptance` workflow. Only the exact unchanged-bounds
Win+Left baseline failure plus a fully passing candidate qualifies. Locked
desktops, session 0, input failures and startup errors must fail the job.
Before each native drag sweep, cross the drag threshold near the press point
and confirm the target HWND owns Windows' move/size loop. A registered mouse
button or correct cursor coordinate alone must not qualify a drag.
Run keyboard maximize/restore before physical resizing to isolate it from
the Shell's user-resize restore history; retain its exact normal bounds check.
Retain SHA/tree/source hashes, binary hashes, OS/session/display metadata,
baseline/candidate JSON, timestamped logs, stdout/stderr and normal/snapped/
maximized/restored client PNGs. Upload artifacts even on failure; exclude
profiles and redact runtime/user paths. See
[native replay procedure](../../../project/windows-native-snap-replay.md).
Repeat pixel checks after transferring focus away and back, including a
PowerShell-launched fixture; activation must not restore the native outline.

- **Preconditions**: PI-Desktop is open in a normal, non-maximized window on
  macOS, Windows, or Linux. On Windows, the left, bottom, and right rim must
  have no visible native border. Run the case with the work panel closed and once
  with it open at a committed width.
- **Steps**:
  1. Drag each reachable window edge and one corner slowly, including a brief
     pause during the gesture, then release.
  2. Confirm the window follows the pointer continuously and does not jump to
     the default size or display edge while the pointer is down.
  3. With the work panel open, drag its inner divider slowly in both directions
     and confirm the panel width changes inside the existing window while the
     native bounds stay fixed. Repeat below the panel minimum and above its
     maximum, then verify the target follows the live budget (`client width - 360px - expanded sidebar`) instead of a fixed cap.
  4. Close and relaunch the app after the resize settles.
  5. On Windows, start an edge gesture, press Escape, and verify original bounds
     return. Maximize and enter fullscreen; corners must be square in both
     states. Restore the window and confirm the selected corner preference
     returns. Record native corner hit behavior rather than assuming that DWM
     corners pass clicks through.
  6. On Windows, inspect the default 12 DIP corner request before and after
     resizing. Apply authorized theme radii of 0 and 24 DIP, then return to a
     built-in theme. Radius 0 must be square. On Windows 11, positive values
     request the same system-rounded preference and are not asserted as exact
     DIP radii; on earlier Windows builds, the existing clip retains its exact
     DIP behavior. Reject an out-of-range radius without changing the surface.
  7. On Windows, minimize and restore the window, then confirm the selected
     corner preference is applied again. Open browser and plugin child views and
     confirm their pixels stay within the top-level silhouette. On Windows 11,
     also verify alpha theme colors are flattened over the built-in theme
     background on an opaque top-level window.
- **Expected**: Native edge and corner hit regions remain available in frameless
  chrome, the minimum size remains 800×560 (capped to the display
  work area), and the recovery watchdog does not
  compete with a slow resize stream. The renderer-owned divider updates the
  bounded panel target without changing native bounds; the last settled window
  bounds and the committed panel width reopen after relaunch. Windows uses
  Electron's frameless native hit regions without the thick-frame rim; no left, bottom,
  or right native rim is visible. No temporary
  work-panel reservation width is persisted or restored.
  Windows 11 uses DWM's native rounded preference for positive radii and a
  square preference for radius 0, maximize, and fullscreen. The default request
  remains 12 DIP and authorized themes retain the integer 0..24 DIP range, but
  DWM selects the actual positive radius and the test does not require 12 and
  24 to look different. Its top-level surface is opaque, including when a
  contributed alpha color is flattened over the built-in theme background.
  Earlier Windows builds retain the existing content clip and integer shape
  hit region. Browser/plugin child views stay within the top-level outline;
  Windows 11 corner click behavior is recorded as native system behavior and
  is not treated as `setShape()` click-through.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  ADR 0029 / ADR 0151 / ADR 0317 / ADR 0325
- **Acceptance**: A (app shell), F (persistence), Quality
- **Milestone**: M6+
- **Status**: `test:e2e:window-controls` covers corner preferences before and
  after minimize/restore, theme radius changes, fullscreen, maximize, and
  controls in an isolated profile. The isolated `test:e2e:window-surface`
  candidate samples controlled light/dark desktop backgrounds and child-view
  bounds. Windows 11 additionally verifies the opaque DWM path and system
  preference; earlier Windows builds verify the legacy clip and shape path.
  Both Windows suites still require a dedicated Windows desktop; source tests
  do not qualify native compositing.
  `test:e2e:window-resize-native` adds physical Windows left/right/bottom/corner
  drags and the 800×560 minimum; run it on a dedicated interactive desktop,
  since another app can take foreground or pointer input during the gesture.
  Relaunch persistence remains for native qualification; macOS/Linux native
  edge behavior is unchanged.

## E2E-168: Expanded sidebar width follows an anchored resize gesture

- **Preconditions**: PI-Desktop is open in the chat shell with the sidebar
  expanded and a retained project/session visible.
- **Steps**:
  1. Drag the sidebar's right-edge handle from its default width toward both
     directions, including a slow drag with a brief pause, then release.
  2. Confirm the main pane reflows continuously and the sidebar does not jump
     when the pointer is pressed.
  3. With the work panel open or on a small supported window, continue the
     resize toward the maximum; inspect the composer toolbar while the main
     pane reflows.
  4. Repeat with a target below 240px and above the live maximum; release and
     confirm the sidebar width stops at 240px and the live cap (at most 520px)
     while MainChat stays at or above 450px. Continue the drag below 160px and
     confirm the sidebar collapses immediately without saving the in-progress
     width.
  5. Focus the edge handle and press ArrowLeft/ArrowRight, Home, and End;
     inspect the separator's current ARIA value. ArrowLeft at 240px must not
     collapse the sidebar.
  6. Start a resize, press Escape or cancel the pointer, then restart the app.
     Collapse and re-expand the sidebar as a separate check; the preferred
     expanded width must return.
  7. Drag the handle wide, double-click it, and confirm the width returns to the
     default 275px. Repeat after a minimum-width drag and on a squeezed window
     where the live cap is the binding bound.
- **Expected**: The handle is discoverable on direct hover/focus without a
  full-height white/accent rail when the sidebar body is hovered, has no native
  window drag or text-selection side effect, and remains anchored to the press
  point. MainChat follows the live width until its 450px floor. Pointer release
  saves one clamped preferred width; Escape/cancellation restores the starting
  width without saving it. Double-clicking the handle restores the default
  275px width, clamped to the live budget so the reset never breaches the 450px
  MainChat floor. A pointer width below 160px collapses the sidebar as
  a user action and restores the preferred expanded width on reopen. Keyboard
  changes commit immediately and expose localized width semantics. The saved
  width survives relaunch and is restored after sidebar collapse; collapse does
  not convert the preferred width into the icon-rail width. MainChat never
  falls below 450px, and the composer toolbar keeps its left and right groups
  on one row without squeezed buttons. Mode/permission labels remain
  single-line and ellipsized; no toolbar text is vertically split or overlapped.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  ADR 0141, ADR 0238, ADR 0290, D280, D408, D459
- **Acceptance**: A (app shell), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`sidebar-preferences.test.mjs`,
  `sidebar-resize.test.mjs`, `sidebar-resize-math.test.mjs`); rendered desktop
  drag and relaunch journey remains pending

## E2E-170: Shell titlebars use borderless chrome

- **Preconditions**: PI-Desktop is open in chat, at least one destination page,
  and Settings on a supported light or dark theme. On Windows/Linux, renderer-
  drawn window controls are visible.
- **Steps**: 1) Inspect the top band on the chat, destination, and Settings
  surfaces. 2) Switch between light and dark themes and repeat. 3) On
  Windows/Linux, inspect the window-control band and its boundary with the
  adjacent surface. 4) Drag the titlebar and activate each window-control
  button.
- **Expected**: The shared 46px top band remains stable and draggable, but its
  lower edge has no visible border line in either theme or route. The
  Windows/Linux control band has no bottom line; only its existing faint side
  seam separates the controls from the adjacent surface. Focus rings, hover
  states, window actions, and content clearance remain unchanged.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: A (app shell), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`topbar-consistency.test.mjs`,
  `settings-drag-region.test.mjs`, `window-menu.test.mjs`); rendered light/dark
  desktop journey remains pending

## E2E-175: A paged Read is not shown as truncated

- **Preconditions**: A project-bound Agent session; the workspace contains a
  text file of at least 3000 lines whose lines are shorter than 16,384
  characters, plus a fixture whose first line exceeds that cap.
- **Steps**:
  1. `Read` the long file with no `offset`/`limit`.
  2. `Read` the same file with `offset` equal to the reported next offset and
     a modest `limit`.
  3. `Read` the over-long-line fixture.
  4. Grep a token that matches more than the default `headLimit`.
- **Expected**:
  - Step 1 returns the default 2000-line window, `truncated: false`, no
    truncated chip, `totalLines` of the whole file, and a `notice` naming the
    next offset. It does not tell the model to Grep.
  - Step 2 continues without overlap and stays `truncated: false`.
  - Step 3 sets `truncated: true`, counts the clipped line in `notice`, and
    shows the truncated chip.
  - Step 4 sets `truncated: true` because remaining matches exist, and shows
    the chip.
- **Specs linked**: `03-runtime/16-tool-result-limits.md` §2 / §5,
  `04-ux/08-component-spec.md` §9.2, `08-meta/decisions-log.md` (D306)
- **Acceptance**: C (chat & stream), E (tools & permissions)
- **Milestone**: M5
- **Status**: Unit-covered (host-core `tools` tests)

## E2E-176: Settings Info opens a prefilled GitHub bug form

- **Preconditions**: Settings can be opened; the machine can launch a system
  browser.
- **Steps**: 1) Open Settings → Info. 2) Confirm the Application row shows the
  current app version. 3) Search settings for the Report a problem label.
  4) Activate Open GitHub.
- **Expected**: The row is indexed by Settings search and stays on Info. The
  action calls `pi-desktop/app/openFeedback` with no URL from the renderer.
  Main opens `https://github.com/vastsa/PI-Desktop/issues/new` with
  `template=bug_report.yml` and prefills `app-version`, `os`, and
  `environment`. The GitHub bug form still requires description, reproduction
  steps, expected, actual, version, and OS; blank issues remain disabled.
- **Specs linked**: `04-ux/06-settings-ia.md`, `03-runtime/01-ipc-protocol.md`,
  `06-delivery/03-ai-development-workflow.md`, `08-meta/decisions-log.md`
  (D313), ADR 0157
- **Acceptance**: H (diagnostics), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`github-feedback.test.ts`,
  `feedback.test.mjs`); rendered desktop journey remains pending
  (run only in a capable environment when this surface changes)

## E2E-184: Completed AI replies survive closing and reopening the app

- **Preconditions**: A session with at least one finished user prompt and
  assistant reply. The reply may still be in the persistence outbox or only
  in `sessions/<id>.inflight.json` when the process exits.
- **Steps**: 1) Send a prompt and wait until the assistant reply is complete
  and the session is idle. 2) Quit the app (window close / tray Quit) and
  relaunch. 3) Open the same session. 4) Repeat with a hard kill of the
  process immediately after the reply appears on screen. 5) Repeat with
  several completed turns, then quit and reopen.
- **Expected**: Every user prompt and every completed assistant reply is
  visible after relaunch. No session shows user rows with empty gaps where
  the answers were. A reply recovered from a leftover checkpoint of a
  `completed` turn is `complete`, not `aborted`. Tool rows that had reached
  `tool_end` are also present. Earlier turns already on disk are unchanged.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/07-process-model.md`, `03-runtime/10-session-state-machine.md`,
  ADR 0041, ADR 0153, `08-meta/decisions-log.md` (D327)
- **Acceptance**: C (conversation & stream), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`sessions.rs` D327 inflight tests,
  `persistence-outbox.test.mjs`, `inflight-checkpoint.test.mjs`); protocol
  reproduction in the issue-42 host+outbox harness; full desktop journey
  Draft (run only in a capable environment when this surface changes)

## E2E-185: External URL opens stay on http(s) and mailto

- **Preconditions**: A chat transcript can render markdown links. A plugin
  is granted `shell.openExternal`. The work-panel preview can load an
  http page and a workspace HTML file.
- **Steps**: 1) Modified-click https, mailto, `file:`, `javascript:`,
  `ms-msdt:`, and a custom-scheme markdown link (`target="_blank"`).
  2) From the plugin, call `pi.shell.openExternal` with https, mailto, and
  `file:`. 3) In the embedded preview, `window.open` an https URL and a
  `file:` URL; use Open in browser on the http page and on the workspace
  HTML file.
- **Expected**:
  - https and mailto open in the OS handler. `file:`, `javascript:`,
    `data:`, `ms-msdt:`, and custom schemes do not.
  - Plugin `file:` fails with `INVALID_ARGUMENT`; mailto succeeds.
  - Preview `window.open` of a non-allowlisted scheme is denied in-app and
    does not call `openExternal`.
  - Open in browser for http(s) uses `openExternal`; for an in-root file
    preview it uses `openPath`, not a `file:` URL through `openExternal`.
- **Specs linked**: `05-security/01-security.md`,
  `07-plugins/04-plugin-security.md` §8, `07-plugins/03-plugin-api.md`,
  ADR 0109, ADR 0168, `08-meta/decisions-log.md` (D330)
- **Acceptance**: Security
- **Milestone**: M5
- **Status**: Unit-covered (`safe-open-external.test.mjs`,
  `feedback.test.mjs`); full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-190: Settings Network proxy applies to app-owned HTTP

- **Preconditions**: A reachable local HTTP or SOCKS5 proxy, or a known-bad
  port for the failure path. A configured provider/model whose endpoint is
  reachable through the proxy is available for the model-request step. For
  System mode, the OS has a local system proxy or PAC fixture with a capture
  endpoint and a direct fallback route.
- **Steps**:
  1. Open Settings → System. Confirm a Network card with Proxy modes
     System, Direct, and Custom. System is selected on a profile that never
     set a proxy.
  2. Choose Custom. Confirm a Proxy URL field, Bypass defaulting to
     localhost / 127.0.0.1 / ::1 / `<local>`, and Test. Enter
     `not-a-proxy` and blur. Confirm an inline invalid-URL error and that
     settings are not saved.
  3. Enter `socks5://127.0.0.1:1080` or `http://127.0.0.1:7890`, then select
     System immediately without clicking elsewhere. Confirm `settings.get`
     retains the URL and Bypass while `mode` is `system`. Select Custom again
     and confirm both values return to the fields and `mode` is `custom`.
     With the valid URL saved, enter `not-a-proxy` and blur so the invalid
     draft remains visible. Switch to System and back to Custom; confirm the
     field returns to the remembered valid URL and `settings.get` still holds
     that URL instead of the built-in default.
  4. Click Test against a listening proxy. Confirm a Connected status. Click
     Test against a closed port. Confirm a failure status without changing
     the saved URL. Enter `http://user:pass@127.0.0.1:<auth-port>` and
     `socks5://user:pass@127.0.0.1:<auth-port>` against proxies that require
     those credentials. Confirm Test reports Connected rather than
     `net::ERR_NO_SUPPORTED_PROXIES` (issue #490).
  5. With Custom saved, send a short prompt through the configured provider.
     Confirm the provider request and response pass through the proxy,
     including when a SOCKS5 proxy returns the complete bind response in one
     TCP chunk. Confirm a subsequent marketplace refresh and a models.dev
     catalog refresh use the proxy (host-core curl `--proxy`, Electron
     `net.fetch`), and confirm a loopback URL in Bypass is not proxied.
  6. Switch to Direct. Confirm Chromium returns to `mode: "direct"`, provider
     and marketplace traffic bypass the System relay, and workspace Bash does
     not inherit proxy variables from the setting.
  7. Switch to System. Confirm Chromium returns to `mode: "system"` and send a
     provider request and marketplace refresh. Confirm both follow the OS/PAC
     route selected for each destination, including ordered proxy-to-direct
     fallback, without restarting the app. Select Custom again. Confirm the URL
     and Bypass entered in step 3 come back from `AppSettings.networkProxy`,
     which kept them while System was selected.
- **Expected**: Custom covers model calls, marketplace, updates, plugin
  `net.fetch`, and the in-app browser. System covers provider and marketplace
  requests through Electron's OS/PAC resolver. Workspace Bash `env` does not
  show `HTTP_PROXY` / `ALL_PROXY` from the setting. TLS verification remains
  enabled on all routes. OAuth still opens the system
  browser. Invalid schemes (`file:`, `ftp:`, and SOCKS4) and malformed
  percent-encoded credentials are rejected. Authenticated HTTP and SOCKS5
  URLs Test and apply without `net::ERR_NO_SUPPORTED_PROXIES` (issue #490).
  No protocol or schema version bump.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `03-runtime/07-process-model.md`, ADR 0177, D340
- **Acceptance**: B (settings), F (providers), Security
- **Milestone**: M5
- **Status**: Custom-path unit coverage exists (`network-proxy.test.ts`,
  `node-proxy.test.ts`, `authenticated-proxy-relay.test.ts`,
  `settings-general.test.mjs`, host-core `network_proxy` tests); malformed
  credentials and unsupported SOCKS4 schemes are covered by shared parser
  tests. `system-proxy-relay.test.ts` covers authenticated provider traffic,
  PAC proxy fallback, HTTP proxy forwarding, and scheme detection on
  non-default ports. The stale-invalid-draft Custom → System → Custom
  restoration path is covered by `pnpm test:e2e:settings-scroll`. The full UI
  journey remains Draft (run only in a capable environment when this surface
  changes).

## E2E-191: Newly emitted AppError codes stay registered

- **Preconditions**: The shared package test suite is available.
- **Steps**:
  1. Run the shared error helper tests.
  2. Inspect the newly emitted runtime and Edit code list used by the test.
- **Expected**: Every code introduced by this update, including
  context-compaction, empty-response, and Edit recovery failures, exists in
  `packages/shared/src/errors.ts` with an identical key and value. Reserved
  codes remain excluded until they are emitted.
- **Specs linked**: `03-runtime/08-error-codes.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`packages/shared/src/errors.test.ts`); full UI
  journey not applicable

## E2E-SETTINGS-inline-capability-imports: Import skills and MCP in their owning pages

- **Preconditions**: A supported external skill and MCP configuration are
  available. At least two projects exist. One MCP source is disabled and its URL
  includes userinfo and query credentials.
- **Steps**:
  1. Open Settings → Skills, select Project and a project, then expand Scan
     other tools. Confirm its scan explanation is visible without a help icon
     and that opening the panel does not scan. Scan, select a skill, choose its
     copy or link mode, and import it.
  2. Confirm the new skill belongs to the selected project. Change the project
     and confirm the prior candidates and selection are cleared.
  3. Open Settings → MCP, select Project and the same project, expand Scan
     other tools. Confirm its scan explanation is visible without a help icon
     and that opening the panel does not scan. Scan, select the disabled MCP
     candidate, and import it.
  4. Confirm the server belongs to that project, remains disabled, and the
     candidate row shows only the URL host without userinfo, path, or query.
  5. Change project scope and confirm the prior MCP candidates and selection
     are cleared.
- **Expected**: Skills and MCP scans start only after an explicit Scan action.
  Project scans and writes carry the selected project path; scope changes clear
  stale candidates. MCP disabled state is preserved and URL credentials never
  render in candidate metadata. Scan explanations render inline; the skill
  mode explanation remains on its existing help control.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md` §18.3 / §18.6 / §18.7, ADR 0319 / D645
- **Acceptance**: F (persistence), Security, Quality
- **Milestone**: M6+
- **Status**: Source-contract and scoped IPC tests covered
  (`settings-import-page.test.mjs`, `agent-capability-settings.test.mjs`,
  `agent-import-ipc.test.mjs`, `import-format.test.mjs`). The project MCP scan,
  selection, import, visible result, and scoped payload are exercised by
  `pnpm test:e2e:settings-inline-import` in an isolated Electron fixture.

## E2E-210: Documentation screenshots resolve from GitHub and VitePress

- **Preconditions**: The repository contains the gallery assets under
  `docs/public/screenshots/app/`; documentation dependencies are installed.
- **Steps**:
  1. Open `docs/guide/screenshots.md` and
     `docs/zh-CN/guide/screenshots.md` from the GitHub file view. Confirm the
     gallery images resolve to files under `docs/public/screenshots/`.
  2. Open the English and Chinese screenshot pages in the VitePress preview.
     Confirm representative images from the home, panel, and settings sections
     render.
  3. Confirm the navigation logo loads `docs/public/app-icon.png` on both
     locale pages.
  4. Confirm each locale footer includes an `AIUO.NET` link to
     `https://aiuo.net`.
  5. Run `pnpm docs:build` and inspect the generated pages for image load
     failures.
- **Expected**: GitHub renders every gallery image instead of requesting a
  repository-root `/screenshots/` path; both VitePress locale pages continue to
  render the gallery from the same checked-in assets. The navigation uses the
  app icon, both footers expose the `https://aiuo.net` link, and the docs build
  succeeds.
- **Specs linked**: ADR 0079, `docs/README.md`,
  `docs/guide/screenshots.md`, `docs/zh-CN/guide/screenshots.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Static/documentation check covered (`pnpm docs:build` and path
  audit); remote GitHub and browser journey pending

## E2E-196: Chat links honor destination settings and context menu actions

- **Preconditions**: A chat transcript can render an HTTP(S) Markdown link. The
  work-panel Browser view and the system browser opener are available. The
  clipboard can be observed or stubbed for the copy action.
- **Steps**:
  1. In Settings → Conversation → Input & links, select **Work panel browser** and click the
     link from a chat reply.
  2. Select **Default OS browser** and click the same link again.
  3. Right-click the link and activate each context-menu item with the pointer:
     Open in default browser, Open in work panel, and Copy link address. Repeat
     the menu actions with keyboard focus and Arrow/Home/End navigation.
  4. Repeat a link click with Ctrl/Cmd, Shift, and Alt held.
  5. Render and use links whose HTTP(S) destination is wrapped as a nested
     linked-host Markdown destination, such as
     `[#1106](([github.com](https://github.com/vastsa/PI-Desktop/issues/1106)))`.
- **Expected**:
  - Wrapped linked-host destinations resolve to their inner HTTP(S) URL before
    sanitization, so the link is clickable and its right-click menu offers both
    browser destinations and Copy link address.
  - The Work panel browser is the default plain-click destination.
  - The Default OS browser setting routes chat, transcript, and plugin HTTP(S)
    clicks through the main-owned external opener, including markdown links,
    autolinked URLs, and inline-code URLs in assistant replies; changing the
    setting persists after reload.
  - The body-level context menu remains interactive when clicked. Its external
    and work-panel actions open the requested destination, and Copy link address
    updates the clipboard before showing the success toast. A rejected clipboard
    write shows an error toast instead of a success toast.
  - Modifier clicks continue to open links externally regardless of the setting.
  - Plugin/settings clicks that want the work panel return to chat so the
    dock is visible, without recording a navigation hop. A missing session
    falls back to the OS browser.
  - Workspace HTML preview, BrowserPreview, OAuth, and Feedback keep their
    existing destinations.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md` §8.3, `03-runtime/01-ipc-protocol.md`,
  `08-meta/decisions-log.md` (D330)
- **Acceptance**: B (settings), C (conversation & stream), Security, Quality
- **Milestone**: M5
- **Status**: Wrapped destinations, plain-click routing, and pointer context-menu
  presence are covered in `pnpm test:e2e:transcript`; settings persistence,
  browser-action activation, and keyboard menu navigation remain Draft. Unit
  coverage: `apps/desktop/test/markdown-link-menu.test.mjs`,
  `apps/desktop/test/markdown-link-destinations.test.mjs`,
  `apps/desktop/test/markdown-math-rendering.test.mjs`, locale catalog tests,
  and `apps/desktop/test/open-http-url.test.mjs`.

## E2E-239: An older build names the newer data schema instead of looping

- **Preconditions**: a data directory last opened by a newer PI-Desktop whose
  host-core migrated it past the schema this build supports.
- **Steps**: 1) Launch the older packaged app on that data directory.
  2) Observe the banner and `logs/app/runtime.log`.
- **Expected**: host-core exits once; no further restart attempts are logged.
  The fatal banner says this PI-Desktop is older than the local data, shows
  both schema numbers, and tells the user to install the newer version. The
  data directory is not modified.
- **Specs linked**: `03-runtime/07-process-model.md` (boot outcomes)
- **Acceptance**: B
- **Milestone**: M3+
- **Status**: source-contract covered by
  `apps/desktop/test/host-boot-diagnostics.test.mjs`

## E2E-251: Custom dropdowns float without changing page layout

- **Preconditions**: A desktop build with a configured provider, at least one
  project/session, and the default dark theme. The Settings, Plugins, Projects,
  chat composer, work panel, and sidebar surfaces are reachable.
- **Steps**: 1) Open each available custom dropdown/menu from Settings,
  Projects, Plugins, the sidebar, the composer, Plan approval, and Scope. 2) Repeat
  with the trigger near the bottom and right
  edges of the window, and while the surrounding page/card has scrollable
  content. 3) Scroll the owning pane and resize the window while a menu remains
  open. 4) Close each menu with Escape and by pressing outside it.
- **Expected**: Every custom dropdown is a body-level fixed layer that overlays
  content without increasing row/card height or changing page/sidebar/work-panel
  allocation. It stays within the viewport, flips or clamps when space is tight,
  follows its trigger after scroll/resize, is not clipped by settings cards or page
  overflow, and restores focus to its trigger on close. Native `<select>`
  popups are excluded because they are rendered by the operating system.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality, responsive layout, Accessibility
- **Milestone**: M5+
- **Status**: Source-contract covered (`fixed-dropdown-surfaces.test.mjs`);
  desktop journey Draft (run only in a capable environment when this surface changes)

## E2E-253: Project groups support manual drag and keyboard reordering

- **Preconditions**: The sidebar contains at least three project groups,
  including one pinned or archived project, and each project has a stable
  host workspace/path/directory.
- **Steps**:
  1. Press a project title, move it above or below another project group,
     inspect the insertion line, and release.
  2. Click a project title and confirm it still selects the project and
     toggles collapse without changing order.
  3. Focus the same title and press `ArrowUp` or `ArrowDown`; repeat once in
     each direction.
  4. Restart the app and inspect the project order.
  5. Open a session from a reordered project and confirm its host workspace,
     path, and directory are unchanged.
- **Expected**: The project groups render in the released order and the
  manual order survives restart. There is no reorder grip and no 400ms
  delay. An insertion line shows drop placement. The title exposes a
  keyboard-accessible reorder action, a short click does not reorder,
  `Escape` cancels an active drag, and the existing pinned / archived
  priority rules remain intact. Reordering never changes a project's host
  workspace, path, directory, or session sort.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `03-runtime/04-data-storage.md`,
  `08-meta/decisions-log.md` (D399, D402, D403)
- **Acceptance**: D (workspace), F (persistence), Quality
- **Milestone**: M5
- **Status**: Source-contract covered (`app-store-sidebar.test.mjs`,
  `sidebar-preferences.test.mjs`, `sidebar-project-reorder.test.mjs`);
  rendered desktop journey Draft

## E2E-256: Empty-home project name switches among sidebar projects

- **Preconditions**: At least two local projects are open in the sidebar; the
  visible chat is an empty project-bound session, and one open project has no
  session at all.
- **Steps**:
  1. Confirm the hero title underlines the current project name.
  2. Click the underlined name and inspect the menu.
  3. Search for a sidebar project, select a different one, and inspect the
     hero and sidebar.
  4. Reopen the menu and choose Open project, then pick a folder or cancel.
  5. Reopen the menu, choose Clone git project, paste a repository URL, then
     pick a parent folder or cancel.
  6. Open a temporary empty session and confirm the underline is absent.
  7. Click the session-less project in the sidebar and inspect the hero.
- **Expected**: The click opens a searchable, fixed switcher of the sidebar's
  open projects instead of the folder picker. Choosing another project
  activates it and lands on that project's empty home (reusing an empty
  session when one exists). Open project still uses the folder picker. Clone
  git project asks for a URL, then a folder, runs `git clone`, and opens the
  cloned project. Temporary heroes and the no-project home (no workspace) stay
  without the switcher, while a project the user opens without any session
  still names that project and keeps the switcher, because a task sent from
  that empty home joins the project. Escape and outside click dismiss the menu.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`
- **Acceptance**: Quality (navigation and accessibility)
- **Milestone**: M5
- **Status**: Unit-covered (`home-project-switcher.test.mjs`,
  `home-project-name.test.mjs`, `git-clone.test.mjs`,
  `sidebar-preferences.test.mjs`); full UI scenario Draft
  (run only in a capable environment when this surface changes)

## E2E-LAYOUT-three-column-width-priority

- **Preconditions**: A desktop session is open in a non-Settings route with a
  persisted preferred work-panel width, on a window wide enough for the three
  columns.
- **Steps**:
  1. Open the work panel and request the user's preferred width.
  2. Drag the inner divider toward MainChat's left edge, including during
     pointer preview, then release.
  3. Manually reopen the sidebar after the layout collapsed it. Repeat in an
     866px viewport, where the reopen narrows the panel below 244px, then
     collapse the sidebar again and drag the divider toward the panel.
  4. Close the work panel and confirm the sidebar returns; repeat after
     manually collapsing the sidebar.
  5. Repeat divider changes with `ArrowLeft`, `ArrowRight`, `Home`, and `End`.
  6. Navigate to the real Plugins and Scheduled routes with the
     work panel closed, then collapse the sidebar. In light and dark themes,
     measure both titlebar actions and compare their rest/hover styling with the
     shared work-panel toggle. Reopen the sidebar, collapse it again, and use
     New Task to return to an editable chat composer on each route.
- **Expected**: The ordinary `.main-titlebar` actions (without a preview chrome
  ancestor) render as centered 28px square targets, with the shared transparent
  rest surface, secondary ink, radius, and semantic hover wash/primary ink.
  Hover does not change geometry; sidebar and New Task actions remain usable.
  The native window width never changes. MainChat never measures
  below 450px — including mid-drag and while `sidebar-out` still occupies flex
  space. The effective panel maximum is the client width minus the 450px
  MainChat floor and the expanded sidebar width, with no fixed pixel cap. When that
  budget is exhausted the expanded sidebar collapses immediately, and the panel
  may keep growing afterwards. A manual reopen spends panel width first;
  MainChat is preserved where possible and otherwise lands on the 460px reopen
  target. That width is lent, not stored: the stored preferred width is
  unchanged, collapsing the sidebar again restores it, and divider drags still
  stop at 244px. Closing the panel restores only a sidebar the layout collapsed. The
  separator's ARIA minimum/maximum follow the same dynamic budget. The panel
  header's `+`, maximize, and viewport-fixed collapse toggle resolve to a single
  control gap (`--ds-work-panel-control-gap`) with no divider, inset, or margin
  of the action group's own, and all three are the shared chrome icon control:
  28px square on a transparent seat with only a semantic hover wash, so the
  header shows quiet icons rather than filled or raised squares. The collapse
  toggle's open state changes its glyph and ink only.
- **Overlay coverage measured in the running app**: on the Plugins route a plugin
  modal opens; the modal veil is the topmost hit at the work-panel toggle inside
  the titlebar band; the titlebar band is not the topmost hit there, so it does
  not paint over the modal veil; and closing the modal leaves the route clean.
  `pnpm test:e2e:layout` asserts those four hits as renderer DOM/CDP evidence,
  not as native hit-test proof.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md` §10,
  `04-ux/08-component-spec.md` §1 and §5, `04-ux/09-interaction-patterns.md` §8,
  ADR 0238
- **Acceptance**: F (persistence), Quality
- **Milestone**: Post-M6 desktop shell maintenance
- **Status**: Automated (`scripts/e2e-three-column-layout.mjs` via
  `pnpm test:e2e:layout` — fixed-window width invariance, the 450px floor across
  a pointer drag, one non-wrapping composer toolbar at that floor with the
  model chip collapsed to its 32px icon, sidebar
  yield/restore, the 460px reopen target, the panel action group's shared
  control gap, preview mode, and ordinary Plugins/Scheduled titlebar
  Source contracts in `chrome-control-geometry.test.mjs` also cover the shared
  disabled state and panel controls' transparent seat; the panel surface still
  needs the eyes-on pass above. DOM/CDP checks establish renderer behavior, not
  native Windows/Linux hit testing; native platform checks remain separate.
  Unit coverage in
  `work-panel-resize.test.mjs`

## E2E-LAYOUT-work-panel-maximize

- **Preconditions**: A desktop session is open with the work panel visible and
  the bundled Browser plugin active on a loaded page.
  1. Note the current panel width. If the sidebar is expanded, collapse it;
     then click the panel header's `+` action to open a real work-panel tab.
  2. Click the panel header's preview toggle.
  3. While preview remains active, collapse and reopen the sidebar. Compare the
     Browser/plugin placeholder's viewport-relative rectangle with the latest
     native bounds report after each layout settles.
  4. Inspect the header border box and tab alignment with the sidebar collapsed
     and expanded on macOS windowed/fullscreen and Windows/Linux. Confirm the
     overlay row and spacer declare neither drag nor no-drag and do not cover
     the panel controls with opaque paint.
  5. Using native pointer input, click the centers and edges of sidebar and
     New Task controls; confirm sidebar toggles and New Task exits preview to
     an editable composer. Reenter preview, operate tabs, close, add, restore,
     panel toggle and native controls, then drag empty header space and confirm
     the native window moves. Repeat in light/dark themes and both sidebar states.
- **Expected**: Entering preview mode stops rendering MainChat and hands its
  width to the panel, so the panel spans the client area minus the expanded
  sidebar (the whole client area when the sidebar is collapsed). The native
  window never changes size. The divider is inert while preview mode is on
  (`aria-disabled`). The native Browser/plugin surface matches the complete
  renderer placeholder rect after both sidebar transitions, including when
  only its absolute position changes; no stale page edge or uncovered strip
  remains beside it. Leaving preview mode restores the previous panel width and
  keeps whatever sidebar state the user chose last. The mode is transient: it is
  not persisted and ends when the panel closes. Preview mode keeps the shell's
  new-task, sidebar, and system-window actions reachable while MainChat is
  absent. The panel header is the sole drag owner in the preview pane. Its
  actual border box and first tab start at least 8px after the shell actions,
  including expanded-sidebar New Task, on every platform. Left inset is 8px
  except collapsed-sidebar windowed macOS (88px). The preview row renders the
  shared `--ds-window-lead-inset` (76px native cluster edge plus a 12px gap)
  as its own left padding; the check reads the resolved padding rather than
  restating the number. Fullscreen retains the action lane with an 8px inset.
  The right native-control border exclusion remains intact. Controls receive
  native clicks without moving the window; empty header space still drags it.
  Header-height background paint fills the excluded lane without hiding controls.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md` §10,
  `04-ux/08-component-spec.md` §5, `04-ux/09-interaction-patterns.md` §8,
  ADR 0238 §6, issue #289
- **Acceptance**: F (persistence), Quality
- **Milestone**: Post-M6 desktop shell maintenance
- **Status**: Partially automated (`scripts/e2e-three-column-layout.mjs` —
  preview entry/exit, DOM action behavior, header border-box exclusion, row/spacer
  drag ownership, and all-platform/fullscreen CSS fixtures in both sidebar
  states). `plugin-view-bounds-sync.test.mjs` mounts the production
  `PluginViewTab` in Electron and covers a position-only layout commit with
  unchanged surface dimensions. DOM clicks and CDP input are not native hit-test
  proof; native pointer, window-drag, and visual checks remain required on each
  platform. Branch runs are exploratory and do not satisfy the integrated-main
  gate.

## E2E-WORK-PANEL-overflow-tab-drag-exclusion

- **Preconditions**: On Windows, open a desktop session and create enough work-panel
  tabs to overflow the horizontal tab strip.
- **Steps**: Scroll the strip toward both ends, switch to another conversation and
  back, reorder a tab with the keyboard, then close tabs until one and none remain.
  Query native `WM_NCHITTEST` over the adjacent sidebar and conversation titlebars,
  visible tabs, header actions, and spare header space.
- **Expected**: Offscreen tabs do not block native dragging outside the visible
  scroll viewport. Adjacent titlebars and unused header space return `HTCAPTION`;
  visible tabs and actions return `HTCLIENT`. Switching, reordering, and closing
  tabs preserve those hit regions.
- **Specs linked**: `04-ux/07-ui-design-system.md` §10
- **Acceptance**: Quality
- **Status**: Windows native regression covered by
  `scripts/e2e-work-panel-drag.mjs` (`pnpm test:e2e:work-panel-drag`). macOS/Linux
  native dragging remains unqualified.

## E2E-WORK-PANEL-active-tab-close-visibility

- **Preconditions**: Render the work panel with enough long-named tabs to
  overflow the horizontal strip.
- **Steps**: Activate an overflowing tab in the narrow layout and inspect its
  close-button rectangle and `elementFromPoint` hit target. Resize the layout
  while keeping the same tab active and repeat. Then partially scroll the strip
  to an inactive tab, hover it, and inspect its close button the same way.
- **Expected**: The active close button stays fully inside the strip after
  activation and resize. Hovering a partially visible inactive tab scrolls its
  close button into the viewport too. In all three states the button is visible
  and hit testable without requiring a middle click, keyboard shortcut, or
  widening the panel.
- **Specs linked**: `04-ux/07-ui-design-system.md` §10, issue #1762
- **Acceptance**: Quality
- **Milestone**: Post-M6 desktop shell maintenance
- **Status**: Electron geometry and hit-target coverage runs in
  `scripts/e2e-work-panel-tab-close.mjs`; `apps/desktop/test/work-panel.test.mjs`
  also covers the reveal contract. The Windows probe in
  `scripts/e2e-work-panel-drag.mjs` checks native hit testing separately.

## E2E-LAYOUT-sidebar-project-group-fold

- **Preconditions**: Five retained sidebar project groups, seeded through the
  host: one holding five sessions with recent and old reply dates, one holding
  a single session, one holding none, and one holding ten pinned sessions.
  A fifth group has twelve unpinned sessions for the project history pager.
  `prefers-reduced-motion` is unset.
- **Steps**:
  1. Inspect the groups: body layering, row and per-row date counts, no time
     headings, the empty state, the tail each expanded group contributes to
     the next one, and the non-project lists' budgets.
  2. Collapse the multi-row group with a real pointer click on its directory row —
     scrolled into view and confirmed to hit that button — and read the group
     body's height, opacity, resolved `grid-template-rows`, and the distance to
     the next group on every frame for about half a second, while recording the
     fold's own `transitionrun` / `transitionend`.
  3. Expand it again and confirm the open geometry returns.
  4. Collapse and re-expand it within the same motion.
  5. Repeat the collapse with `prefers-reduced-motion: reduce` emulated.
  6. Scroll the pinned list to its last row.
- **Expected**: A project group is one grid row (`grid-template-rows: 1fr`) that
  animates to `0fr` over the 200ms normal duration — no `max-height` clamp, no
  opacity transition — so the fold is a single continuous height ramp with no
  plateau followed by a snap, and `opacity` stays 1 on every frame: the rows are
  clipped, never faded. The fold fires one transition and its own event reports
  the 200ms normal duration. The rows are clipped by an inner `min-height: 0`
  box, and the 1px row gap plus the group's 2px / 7px inset sit on the list inside
  that clip, so the inset travels with the rows. An expanded group's 7px inset
  plus the 1px scroller gap read as an 8px tail to the group below it; the last
  group in the list has no neighbour, so it is checked against its own inset and
  clip instead. A folded group's tail leaves with its rows, its section is its
  header plus the 1px scroller gap, and its rows stay mounted past the clipped
  edge while the group is `aria-hidden` and `inert`. A reversal mid-flight turns
  on the frame it reached and settles back on the open height without
  overshooting, and the empty group folds its empty state the same way. Under
  reduced motion both endpoints are kept and the travel is dropped. The pinned
  list holds eight rows inside `min(233px, 30vh)` and scrolls to its remaining
  rows, and the standalone list keeps its flex column and 146px budget. The group
  indent, ordering, and workspace state are unchanged. The five seeded project
  sessions remain in one flat list with no time headings and each has its own
  date label.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md` §6.1 and
  §13, `04-ux/08-component-spec.md` §6.2, `08-meta/decisions-log.md`
  (2026-09-16, sidebar list rhythm and project-group fold)
- **Acceptance**: Quality
- **Milestone**: Post-M6 desktop shell maintenance
- **Status**: Automated (`scripts/e2e-three-column-layout.mjs` via
  `pnpm test:e2e:layout` — host-seeded groups and pins, a hit-tested CDP pointer
  click, per-frame height and opacity sampling across the real fold, the
  transition's own reported duration, mid-flight reversal, and reduced-motion
  emulation). Unit coverage in
  `apps/desktop/test/sidebar-collapse-animation.test.mjs` and
  `apps/desktop/test/sidebar-pinned-rendering.test.mjs`. The sampled values are
  renderer geometry, not an eyes-on visual pass.

## E2E-LAYOUT-sidebar-row-states

- **Preconditions**: Host-seeded project, pinned and standalone conversations;
  the sidebar Session time preference enabled; a current workspace; built
  desktop with isolated data and profile directories.
- **Steps**: In dark and light themes, select a project conversation, hover its
  project title and an unselected conversation, then hover the selected row.
  Check that a project session date is visible at rest and replaced by its
  action in the same trailing slot on hover and focus; verify no divider appears
  before the date, dates through seven calendar days are relative, and older
  dates show month and day without a year. Exercise the window-blur handler,
  drop-target styling, project action hover and keyboard Tab/Shift+Tab focus. Fold and
  reopen its group. Select pinned and
  standalone conversations. Open Settings and return. Enable reduced motion and
  inspect both row transition durations. In a separate twelve-session project,
  load the remaining two sessions, fold and reopen the group, and verify only
  the initial ten sessions remain visible.
- **Expected**: Project and conversation hover backgrounds, radii and transitions
  match. The title button stays transparent. Only a conversation uses selected
  fill, which wins over hover; workspace identity remains a separate dot with
  no persistent header fill. Folding never promotes the project to selected.
  Pinned and standalone rows use the same selected surface. Keyboard focus
  retains an outline, action buttons retain local feedback, drop-target paint
  wins over hover, and blur releases hover without clearing selection. Settings
  replaces sidebar navigation, and returning restores conversation and workspace
  context without a second selected row. Project session rows show dates at rest
  in the same trailing slot used for session actions, with no divider. Hover and
  focus replace the date with the action in that slot. Dates through seven
  calendar days are relative and older dates show month and day without a year.
  Loading more sessions
  reveals all twelve; folding and reopening restores the initial ten and the
  two-session remainder control. Rendered component tests additionally cover no
  selected session, a pending destination and non-chat page state.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md` §9.1c
- **Acceptance**: C, D, Quality
- **Milestone**: Post-M6 desktop shell maintenance
- **Status**: Automated via `pnpm test:e2e:layout` and
  `scripts/e2e/sidebar-row-states.mjs`: real CDP pointer/keyboard input and
  computed-style assertions, plus the load-more / fold / reopen session-history
  flow. Window blur/focus events and the drop-target class are injected for those
  styling checks; this is not a native focus/drag test. Unit coverage:
  `sidebar-navigation.test.mjs`, `sidebar-pinned-rendering.test.mjs`, and
  `sidebar-project-sessions.test.mjs`.

## E2E-LAYOUT-sidebar-settings

- **Preconditions**: Built desktop, isolated host/profile, visible chat sidebar.
- **Steps**:
  1. In dark/light palettes and darwin/win32/linux CSS branches, compare the
     home sidebar and Settings rail color, image layers, size and position.
     Inspect transparent ancestors and opaque settings content/titlebar.
  2. Before entering Settings, retain the current .chat-surface DOM node. While
     Settings is open, verify the chat shell is hidden, inert, and still
     contains that connected node. Return through Back to app and verify the
     same node is revealed while tracing sidebar insertion, width and
     animationstart events. Repeat quick round trips, a previously collapsed
     sidebar, and settings navigation interrupting an entrance.
  3. Explicitly reopen a collapsed sidebar, then repeat settings return with
     reduced motion. Repeat material comparisons with legacy and canonical
     theme color overrides and a sidebar background image.
- **Expected**: Both navigation surfaces share one material. Settings navigation
  and shell have no entrance animation; only a nested content-enter wrapper
  inside its opaque pane animates, and that motion is opacity-only so it cannot
  trap `position: fixed` overlays. Settings dialogs cover the full window, including the rail. On macOS
  all ancestors behind the rail are transparent, while right
  content and titlebar stay opaque. Returning to an expanded sidebar starts and
  stays at 275px without sidebar-in events; a collapsed sidebar stays absent.
  A real reopen still produces sidebar-in and a width ramp. Legacy theme color
  input remains supported for both rails, and a canonical override wins.
  Portaled layers owned by the hidden chat surface stay hidden while Settings is
  open; the shared app-level search, toast, and extension-prompt layers remain
  available.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md` §1.4 and §1.7
- **Acceptance**: A, C, Quality
- **Milestone**: Post-M6 desktop shell maintenance
- **Status**: Automated via `pnpm test:e2e:layout` and
  `scripts/e2e/sidebar-settings.mjs`, with trusted CDP pointer/keyboard input,
  mutation-time and subsequent geometry samples, animation events and computed
  styles. CDP focus emulation keeps the isolated page painting while its native
  window is occluded; otherwise Chromium can freeze CSS motion and hover input.
  Platform branches and palettes are renderer emulation, not native
  Windows/Linux or OS material/theme validation. Optional
  `PI_DESKTOP_LAYOUT_ARTIFACT_DIR` captures renderer screenshots. State tests in
  `sidebar-settings-return.test.mjs` cover initial presentation, both interrupted
  phases, hidden-state changes and reversals. The CDP layout journey verifies
  that Settings preserves the same chat surface node across round trips.
  `settings-dialog-overlay.test.mjs`
  covers the full-window overlay contract. `pnpm test:e2e:theme-surfaces`
  verifies the opaque fallback and legacy theme override in real Chromium.

## E2E-CHROME-window-controls-survive-work-panel

- **Preconditions:** A built desktop and matching host-core binary; isolated
  profile and data directory with one local session; no real provider calls.
- **Steps:** Open the work panel from the titlebar, toggle the sidebar, maximize
  and restore the panel, maximize and restore the native window, close the panel,
  visit Settings and return, reopen the panel, minimize/restore the window, then
  click Close with close-to-tray configured in the disposable profile. Also
  enter and leave native fullscreen with the panel open. Check the three controls
  with Chromium hit testing throughout, including light/dark Windows/Linux CSS.
- **Expected:** Windows/Linux minimize, maximize/restore, and close stay visible
  and hit-testable at the window edge. Native actions work with the panel open.
  Preview sidebar navigation remains clickable. On macOS no duplicate renderer
  window controls appear; the native traffic-light and fullscreen contracts stay
  unchanged. CSS emulation does not qualify another operating system's native UI.
- **Specs:** `04-ux/01-ui-ia.md` titlebar; ADR 0021 and ADR 0025.
- **Acceptance:** Window actions remain accessible independently of pane state.
- **Milestone:** Post-MVP regression coverage.
- **Automation:** `pnpm test:e2e:window-controls`; macOS traffic-light geometry
  also has `apps/desktop/test/traffic-light-reserve.test.mjs` contract coverage.
- **Status:** Automated for the executing native platform; run on macOS/Linux
  runners for native qualification. Optional screenshots are written only to
  `PI_DESKTOP_CHROME_ARTIFACT_DIR`.

## E2E-SETTINGS-destination-scroll-reset

- Open Settings → Conversation and scroll midway down. Select Shortcuts: its title and
  first settings appear at the top. Scroll and return to Conversation: it starts at top.
- Re-select the active destination and update settings without navigating:
  the content keeps its scroll position.
- Repeat for built-in → plugin, plugin → plugin, and plugin → the previously
  selected built-in destination. Re-selecting a plugin keeps its position.
- Follow a global search setting anchor into Conversation from another
  destination, from an open plugin destination, and within Conversation: the
  plugin page is gone and the target row is visible before the next paint. Consuming the anchor keeps
  that position. An external tab change with no anchor also leaves the plugin
  and starts at the top.
- Run in light and dark themes.
- Automated coverage: `pnpm test:e2e:settings-scroll` mounts the production
  SettingsPage, store, translations, and built CSS in isolated Electron. Only
  preload data is stubbed; search navigation uses SearchDialog's public store
  entry points. The development UI path checks both destinations and their
  Experimental badge surfaces; `settings-developer-only-destinations.test.mjs`
  separately verifies packaged visibility/search and developer-only fallback.
  This covers
  renderer interaction, not host persistence or the
  full global-search dialog.

## E2E-SETTINGS-one-destination-one-subject

- **Scenario:** The D684 directory split. Every setting is reachable from the
  destination that owns its subject, and nothing is reachable from two.
- **Steps:**
  1. Open Settings. The rail lists Appearance, Conversation, Shortcuts, Voice,
     Behavior, Models, Instructions, Skills, MCP, Subagents, Projects, System,
     Cloud sync, Remote Hosts, Info, in four titled clusters.
  2. Visit Appearance: Interface (theme, language, font, font size, and on
     macOS translucency), Sidebar with its two indented sub-switches, Radial
     context menu, Startup. No network, storage, power or close-behavior card.
  3. Visit Conversation: Display (show thinking + sub-row, transcript display +
     sub-row, context usage, smooth streaming, inline visualizations) under one
     visible caption saying presentation only, then Input & links (enter to
     send, paste threshold, link open destination).
  4. Visit Behavior: Session defaults (default mode, permission mode, command
     shell), Execution (infinite retry, scheduled tasks), Computer use last.
  5. Visit System: Network, Storage, Power, and on Windows/Linux Close
     behavior.
  6. Search the rail for `theme`, `主题`, `proxy`, `scheduled`, `paste`, and
     `permission`. Each query surfaces exactly the destination that renders the
     row, and following a hit scrolls to and flashes that row.
  7. Change one setting on each of the four pages, close Settings, reopen it,
     and read the value back.
- **Expected:** No setting appears on two destinations and none is orphaned.
  Each page opens with its rail glyph at page scale, its title, and one
  subtitle line; the capability, model and project workbenches show their own
  description instead and no subtitle. A row's explanation is still only behind
  its help mark; the only always-visible explanatory line is a card caption.
  Persisted values are unchanged by the move — a profile written before the
  split reads back identically.
- **Automation:** `settings-general.test.mjs` pins the destination index, the
  per-page ownership, and the locale keys; `pnpm test:e2e:settings-scroll`
  exercises the rail, search anchors and per-destination scroll in Electron.
  `node scripts/e2e-storage-settings.mjs` opens System with a failed settings
  read, verifies its visible error and retry action, then restores the settings
  snapshot through retry before exercising storage controls and confirmations.

## E2E-SETTINGS-retired-destination-ids-resolve

- **Scenario:** A destination id written before the split still opens a page.
- **Steps:** With a profile or deep link selecting `general`, open Settings;
  repeat with `ai`. Trigger the native Settings menu item and the command
  palette's Settings entry.
- **Expected:** `general` opens Appearance and `ai` opens Behavior; neither id
  appears in the rail or in settings search. An unknown id opens Appearance.
  The content pane is never blank.
- **Automation:** `settings-general.test.mjs` asserts the resolution table, and
  `settings-developer-only-destinations.test.mjs` asserts the hidden-destination
  fallback uses the index's default rather than a literal id.

## E2E-264: Reopening an archived project restores sidebar visibility

- **Preconditions**: A durable project group exists for a local folder and can
  be archived through the renderer-owned sidebar preferences.
- **Steps**:
  1. Archive the project and confirm its row is hidden from the default
     sidebar but remains available in Settings → Project archive.
  2. Use the project's Open action in Project archive.
  3. Archive it again, open Add project, select the same folder, and create.
  4. Archive it again and open one of its sessions from Project archive.
- **Expected**: Each successful activation clears the path's archived
  presentation state, returns to chat, and makes the project visible in the
  sidebar. Selecting an inspector row without activating it and ordinary
  session refreshes leave the archive state unchanged. Reopening the same
  folder reuses the existing group without duplicating project or session data.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0294, D659, issue #1653.
- **Acceptance**: Renderer project activation restores the normalized path's
  local archive metadata only after the host project activation succeeds.
- **Status**: Source-contract coverage in
  `apps/desktop/test/app-store-sidebar.test.mjs` and
  `apps/desktop/test/project-create-dialog.test.mjs`; full UI scenario remains
  Draft and is run only when explicitly requested in a capable environment.
