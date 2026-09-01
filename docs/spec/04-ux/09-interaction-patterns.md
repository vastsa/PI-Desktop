# 09. Interaction Patterns

> Design system tokens: [07-ui-design-system.md](07-ui-design-system.md)  
> Component anatomy: [08-component-spec.md](08-component-spec.md)  
> Permission UX: [03-permission-ux.md](03-permission-ux.md)  
> Command palette: [04-builtin-commands.md](04-builtin-commands.md)

## 1. Keyboard shortcuts baseline

### 1.1 Global shortcuts

| Shortcut | Action | Context |
|---|---|---|
| `Option + Space` (macOS) / `Alt + Space` (Windows/Linux) | Open plugin launcher | OS-global after application boot; customizable |
| `Cmd/Ctrl + Shift + P` | Open command palette | Global (D014) |
| `Cmd/Ctrl + N` | New chat/session | Global |
| `Cmd/Ctrl + O` | Open project | Global |
| `Cmd/Ctrl + W` | Close window | Global |
| `Cmd/Ctrl + ,` | Open settings | Global |
| `Cmd/Ctrl + B` | Toggle sidebar | Global |
| `Cmd/Ctrl + J` | Toggle work panel | Global; active session |
| `Cmd/Ctrl + [` | Previous destination | Global |
| `Cmd/Ctrl + ]` | Next destination | Global |
| `Cmd/Ctrl + .` | Abort active turn | Global (same as abort button) |
| `Cmd/Ctrl + K` | Open command palette | Global |

### 1.2 Conversation context shortcuts

| Shortcut | Action | Context |
|---|---|---|
| `Enter` | Send message | Composer focused |
| `Shift + Enter` | Newline | Composer focused |
| `Escape` | Clear input / blur composer | Composer focused |
| `Cmd/Ctrl + ↑` | Scroll to top of transcript | Transcript focused |
| `Cmd/Ctrl + ↓` | Scroll to bottom of transcript | Transcript focused |

### 1.3 Command palette shortcuts (within palette)

| Shortcut | Action | Context |
|---|---|---|
| `↑ / ↓` | Navigate results | Palette open |
| `Enter` | Execute selected command | Palette open |
| `Escape` | Close palette | Palette open |

### 1.4 Shortcut rules

- macOS application-menu shortcuts are discoverable through system-menu
  accelerators. Windows/Linux shortcuts remain available without rendering an
  application menubar; command-only shortcuts are discoverable via command
  palette search (keyword "shortcut" or "keybinding").
- Shortcuts must not conflict with macOS system shortcuts or common browser shortcuts
- Never override `Cmd/Ctrl + C`, `Cmd/Ctrl + V`, `Cmd/Ctrl + A`, `Cmd/Ctrl + S`
- Shortcuts are consistent across macOS (Cmd) and Windows/Linux (Ctrl)
- A modifier-only keydown and an IME composition/229 keydown never dispatch a
  command. Repeated keydown events do not repeatedly traverse destination
  history; each back/forward chord advances at most once per physical press.
- Command-only shortcut changes require updating the command palette metadata;
  native roles and visible application-menu accelerators remain menu-owned
- The plugin launcher is registered through Electron's native global shortcut
  API. Windows' reserved default `Alt + Space` additionally uses a host-core
  low-level keyboard hook that consumes the system-menu chord and emits an
  Electron host notification, so it works while another application is
  focused. A focused-window fallback remains available if the hook cannot be
  installed. Custom bindings continue to use Electron's global shortcut API.
  Electron starts warming the launcher in a hidden window as soon as Electron
  is ready, in parallel with backend and main-window boot; shortcut delivery
  during warm-up joins the same in-flight load. The macOS show path relies on
  the panel's normal activation instead of issuing a second application
  activation or window-stack move. The launcher always opens on the display
  nearest the pointer.

### 1.5 Plugin launcher shortcuts

| Shortcut | Action | Context |
|---|---|---|
| `↑ / ↓` | Cycle matching plugins | Launcher focused |
| `Enter` | Open selected plugin panel | Launcher focused, not composing IME text |
| `Escape` | Dismiss launcher | Launcher focused |

The launcher opens with an empty query and shows enabled, ready panel plugins
in most-recently-used order from renderer-local device history, so the last
opened plugin stays one Enter away. Typing still ranks search relevance first;
recency only breaks ties between equally relevant matches.

### 1.5 Platform application menus

- macOS application-menu accelerators dispatch the same allowlisted shell
  commands as renderer controls. Native Edit/View/Window roles retain
  platform text-editing, zoom, fullscreen, hide, and quit behavior.
- Windows/Linux render no application menu in the window. Their frameless
  titlebar keeps sidebar actions at the left edge and native window controls at
  the conversation pane's right edge. While the work panel is open, the
  controls remain in the conversation pane and the panel header uses its full
  width for resource actions; its collapse control no longer sits ahead of the
  window controls. Destination history has no visible back/forward
  controls and remains available through the renderer shortcuts. The first
  transcript row starts below the 46px titlebar control band so user and
  assistant content cannot overlap the minimize, maximize/restore, or close
  targets. Destination pages and the plugin detail sheet start below the same
  band, so page header actions and the sheet close control never stack under
  those targets. F10 and Shift+F10 are not consumed by shell chrome.
- Windows/Linux keep New Task, Open Project, Settings, close-window,
  zoom, fullscreen, search, command-palette, sidebar, and work-panel shortcuts
  through renderer key handling. Standard editing shortcuts remain native
  web-content behavior.
- Developer tools are opt-in. With developer mode enabled, Main handles F12 on
  every platform and Ctrl+Shift+I on Windows/Linux; macOS exposes its native
  developer-tools role in View. With the mode disabled these product entry
  points remain unavailable, and disabling it closes an open console.
- Main queues native commands until the renderer acknowledges that its menu
  event subscription is active on macOS. Closing and recreating a window
  resets this handshake.
- Frameless minimize, maximize/restore, and close controls remain outside the
  drag region. Maximize state is queried on mount and updated from native
  window events, so the restore affordance never depends only on optimistic
  renderer state.
- Windows/Linux explicit minimize actions use native minimize and keep the
  taskbar entry. On Windows, clicking the focused window's taskbar button also
  uses native minimize and keeps the taskbar entry; clicking it again
  restores/focuses the same window, while clicking the entry for a merely
  covered window keeps the normal bring-to-front behavior (D252 / ADR 0117).
  macOS native minimize remains tray-resident. Windows/Linux close behavior is user-configurable
  (ADR 0090): an unset preference asks once via a native prompt (Cancel / Close
  to tray / Quit); `tray` hides the window under that same tray icon, whose
  click restores the window; `quit` exits the app. Close behavior never creates
  or destroys the tray — D216 owns it, so the icon is resident under either
  choice. The choice is persisted, revisitable in Settings → General, and
  applied by both the close button and the close shortcut. macOS keeps the
  native Dock lifecycle (close keeps the app in the Dock; activating recreates
  the window). The bounds watchdog never restores a minimized or tray-hidden
  window.

### 1.5.1 Tray-resident and taskbar minimize

- Explicit application minimize means **native taskbar minimize** on Windows
  and Linux: the renderer's window-control button and native-menu minimize
  action use the normal OS transition. macOS traffic-light minimize and the
  macOS Window → Minimize role remain **hide to tray**.
- On Windows, clicking the taskbar button of the focused visible main window
  means **native minimize**. The window stays represented by its taskbar entry;
  the next click restores and focuses it. A taskbar click while the window is
  merely covered brings it to the front and does not hide it to the tray.
- Tray hiding, including a Windows/Linux close with `tray`, removes the main
  window from the taskbar/dock window list while the Electron process and
  background work remain alive. It does not persist a minimized geometry or
  dispose the host/sidecar.
- Clicking or double-clicking the PI-Desktop tray icon, choosing Show from its
  menu, or activating the app from the macOS dock restores and focuses the
  existing window. If the window was closed, the same action creates a fresh
  window.
- The tray menu is localized with the active English/zh-CN shell locale and
  exposes Show PI-Desktop plus an explicit Quit PI-Desktop action. Quit uses
  the existing ordered shutdown path. What closing the window does is the
  user's own choice on Windows/Linux (ADR 0090) and a Dock-lifecycle close on
  macOS; the tray icon itself is created once at startup either way.

### 1.6 Sidebar project and conversation organization

The sidebar is a path-keyed presentation of host-owned projects and sessions.
The `Sessions` heading appears first and contains path-less conversations plus
their create and sort controls. Its bounded list keeps standalone work visible
without consuming the full sidebar. The following `Projects` section heading
exposes the project picker above retained project groups. Several project groups
may be retained while exactly one workspace supplies the visible shell context.

#### Project tab lifecycle

1. **Open** — selecting a project from Settings → Project archive or the picker adds its
   normalized path to the retained set and activates it. Existing tabs remain.
2. **Activate** — selecting a different group calls the existing `project.set`
   bridge. Its path then drives topbar identity, active workspace state, and
   new-task scope.
3. **Collapse** — disclosure state belongs to each project path. Collapsing
   hides children only; it neither changes the selected session nor stops a
   run. The directory row is one full-width disclosure target containing its
   chevron, folder, and label: selecting an inactive directory activates it
   first, and every directory-row click toggles that group's children without
   changing any other group's state. Project actions are separate sibling
   controls and never toggle the directory.
4. **Close** — closing removes only the retained tab. If it was active, the
   last remaining tab is selected or the visible workspace is cleared. Durable
   projects, sessions, and transcripts remain.

#### Organization actions

- **Pin** toggles presentation priority. Pinned projects/conversations appear
  before unpinned rows within the selected secondary order. In the sidebar, a
  pinned project replaces its Folder glyph with a filled accent Star so its
  state remains recognizable without opening its overflow menu.
- **Archive** is non-destructive. Archived rows are hidden by default,
  available through Show archived, and restorable. Archiving does not cancel
  a turn or delete a transcript.
- **Create branch** snapshots an idle conversation's complete active
  transcript into an independent session in the same project/Temporary scope.
  The command is disabled while the source runs. Success selects the child and
  focuses the composer; failure leaves the source visible and unchanged.
- Archiving the visible conversation/project first moves the visible context
  to a non-archived sibling. With no sibling, a conversation receives a fresh
  draft in the same scope and a project clears the visible workspace; the app
  never leaves a hidden archived row as the active context.
- **Sort** offers Recently updated (`recent`), Created date (`created`),
  Oldest first (`oldest`), and Name (`name`). Missing/invalid values fall back
  to `recent`. A persisted `manual` value is accepted for compatibility, but
  no drag or manual-reorder interaction is promised in this baseline.
- Each project group shows the ten most-recent rows in the active sort order
  by default; the remaining sessions fold behind a **Load N more…** control
  (the same affordance used for time-grouped overflow). Selecting it expands
  the full time-grouped list, and the expanded state is per-group, for the
  current session only, and not persisted.
- Presentation changes are saved best-effort. Storage failure must not block
  project activation, session selection, or agent execution.

#### Session isolation across tabs

- Selecting a row immediately marks that destination as selected. A 120ms
  pointer hover or keyboard focus may prefetch its transcript; duplicate reads
  share one in-flight request and the renderer retains at most five recent
  transcript snapshots.
- Transcript loading starts without waiting for an older superseded selection.
  When session summary metadata is available, project activation/clearing and
  transcript IO run in parallel. A monotonic navigation generation permits only
  the newest selection to project the visible workspace, transcript, run state,
  navigation history, and work-panel context.
- The chat surface retains one pane per session, keyed by session id and bounded
  to three (the visible pane plus the two most recent). Hidden panes stay mounted
  and inert — `visibility: hidden` plus `content-visibility: hidden`, never
  `display: none`, which would discard their scroll offset — and each pane keeps
  its own scroll position for its lifetime. Switching to a session that still has
  a pane (warm) reveals it immediately with its retained content and position:
  nothing is dimmed, no skeleton appears, no transcript remounts, and the
  revalidated snapshot lands in the same pane without a visible change.
- Switching to a session with no retained pane (cold) leaves the visible pane on
  its own session until the destination commits. Only a thin progress track and
  `aria-busy` mark the wait, the composer stays non-interactive so a prompt cannot
  reach the session being left, and the destination session id is never paired
  with another session's messages. The destination is then revealed at its final
  record without a top-of-history or empty-home flash. An evicted session is
  indistinguishable from a first visit.
- A first-opened session settles at its newest turn. A revisited pane returns to
  the offset the user left, and a pane still pinned re-anchors to the bottom;
  activation no longer resets manual-scroll state for a revisit (ADR 0137).
- Selecting a project-scoped conversation activates its project as part of the
  store-owned selection transaction. Selecting a Temporary conversation clears
  the visible workspace. Project-scoped new-session actions pass their target
  path to that same store transaction; sidebar and project-index handlers do
  not perform a second project navigation before session creation or selection.
- Run state, permission grants, and streamed events are keyed by session id.
  A project/tab switch does not abort a background turn or copy its events into
  the visible transcript. Background message, tool, completion, and permission
  events never activate their session, change the visible project/page, or move
  focus. Creating a new session or switching to one that is not running returns
  the composer to its idle Send state immediately: a turn still streaming in the
  previously selected session never leaves the destination session's send button
  stuck in the Abort/stop state, and that background turn's later completion
  does not alter the destination composer. Their work-panel artifacts and
  Browser resource update only the
  originating session's retained renderer context and do not reveal or resize
  the visible panel. Only an explicit session/notification activation navigates
  and projects the destination session's retained panel context.
- The composer draft is also session-scoped in renderer memory: switching
  sessions saves/restores the source text and file references, an uncached
  destination starts empty, and the home composer has its own draft slot.
  Creating a new session does not copy another slot. A completed send clears
  only the draft belonging to the session that submitted it, even if the user
  switches sessions while the request is in flight; deleted sessions cannot
  retain drafts.
- Every tool call resolves `workspaceRoot` from the originating durable
  session, not from the currently selected project tab. Background completion
  refreshes the matching row without redirecting the active conversation.

#### Focus and semantics

- Project directory rows expose `aria-expanded` and `aria-controls`;
  new-project/new-session controls have scope-specific accessible names, and
  sort/archive menu choices expose their checked state. Active session rows
  retain `aria-current`.
- Toggling disclosure or a menu action keeps focus on its control. Selecting a
  project/session returns focus to the composer after loading.
- Sort, archive, restore, pin, Create branch, and close actions remain
  keyboard-reachable;
  they cannot exist only as pointer-hover affordances.
- Sidebar body-level menus opened from toolbar or row triggers remain
  content-sized and use the same fixed rule as right-click menus: open 4px to
  the anchor's right without flipping to the left. Their surface width is
  capped for narrow viewports. This includes the Sessions sort menu,
  session/project overflow menus, and section create menus.

### 1.6 Local profile footer

- The `44px` profile trigger toggles the menu; its chevron and
  `aria-expanded` state change together.
- The `280px` menu opens `8px` above the transparent footer band. Opening it
  moves focus to the first actionable row after the non-interactive identity
  header and divider.
- `ArrowDown` / `ArrowUp` wrap among Settings, Logs, and Theme. `Home` and
  `End` move to the first and last action.
- `Escape` closes the menu and restores focus to the profile trigger. A pointer
  press outside closes it without stealing focus from the pointer target.
- Selecting Settings, Logs, or Theme closes the menu before performing the
  action. Theme applies the next theme value without reopening the menu.
- The separate `32px` Help button bypasses the profile menu and navigates
  directly to Settings → Info.
- Collapsing the sidebar closes the menu and restores the collapsed rail's
  normal navigation state.

### 1.7 Notification inbox (D117)

#### Event-to-surface flow

1. Renderer reports the current chat's session id to Electron Main; navigating
   away clears it. Main combines this hint with its own window visibility and
   focus state when a turn reaches `completed` or `error`.
2. If the exact finishing session is already visible in the focused window,
   `session.endTurn` closes the turn without inserting a notification. Any
   background session or unfocused/hidden window creates the durable record.
   An `aborted` turn never creates one.
3. Electron emits `notification.changed` to every live renderer so the bell
   badge and currently open inbox refresh.
4. If the main window is focused, no other surface appears. If it is
   unfocused and native notifications are supported, Electron shows one
   platform notification derived from the event kind and session title. On
   Windows, the banner is attributed to the canonical PI-Desktop
   AppUserModelID shared with the NSIS package and taskbar identity.
5. Clicking the native notification shows/restores and focuses the main
   window, then emits `notification.activated { sessionId }`.
6. Renderer activation selects the bound project when present, loads the
   session, and focuses the transcript/composer using the same path as an inbox
   row click. Native and in-app activation must not diverge.

#### Popover behavior

- Bell click toggles the non-modal popover; a second click, Escape, or outside
  press closes it. Escape restores focus to the bell.
- Opening preserves the most recently selected `All` / `Unread` filter for the
  current renderer lifetime and never marks rows read implicitly.
- Arrow keys move through rows with wrap disabled; `Home` / `End` jump to the
  first/last row; Enter/Space marks the row read and activates its session.
- Mark all read updates every unread row in one host transaction. Clear
  removes all inbox rows in one host transaction. Both operations are
  idempotent, refresh the exact unread count, and leave sessions/turns intact.
- The renderer does not synthesize notification records from stream events.
  Host-core's unique `turn_id` is the exactly-once boundary across repeated
  terminal updates, renderer reloads, and process restarts.
- All visible event labels and native title/body strings are localized at the
  presentation boundary from structured fields; persisted rows never contain
  localized prose.

### 1.8 Work panel entry and resources (D128, D142, D154, D173, D179, D207, D221)

- The shell starts without a visible work panel. `Cmd/Ctrl + J` toggles the
  active session's panel: it reveals the retained context without creating a
  resource tab, and collapses the visible panel through the same path as the
  header collapse control, retaining tabs, active resource, and committed
  width. It is a no-op without an active session or while Settings is the
  active page. The panel's context trigger can then create Browser or an
  in-scope plugin view.
- An artifact trigger atomically creates or reuses its resource, activates it,
  and opens the panel. Background artifacts never open the visible panel.
- File resources use normalized paths as identity. Browser and plugin views
  are singletons; repeated triggers preserve resource order and activate the
  existing resource.
- Once open, the panel's unified context trigger anchors the left of the header
  and opens a single dropdown. Its top section lists Browser and in-scope
  plugin views, each row carrying its own open state and, once open, its own
  close control. A second section appears after a divider only when the
  transcript opened further resources, so no entry is ever listed twice. The
  right action cluster is pinned to the header's right edge behind a divider
  and never shifts with the label length (D173).
- Menu rows own DOM focus. Opening with the trigger's ArrowDown/ArrowUp lands on
  the active row or the last row respectively; Arrow/Home/End then walk rows
  only, never their trailing close buttons. Delete/Backspace closes the focused
  row's resource without dismissing the menu and keeps focus on the neighbor
  that takes its place. Selecting a row, Escape, or Tab closes the menu and
  restores focus to the trigger; only a session switch dismisses it implicitly
  (D173).
- Activating a tool that is already open activates its existing resource instead
  of replacing it, so Browser keeps its URL and Files its selection (D173).
- Every resource can be closed from the menu, and the active resource has
  a direct header close control. Closing the active resource selects the right
  neighbor, then the left; closing the final tab hides the panel. The separate
  panel collapse control in the session pane top-right hides the panel without
  deleting tabs.
- On every platform, opening the visible panel requests native width equal to
  its committed width. Collapse and final close reclaim the reservation, and a
  committed divider resize updates it. Native window-edge drag changes
  MainChat only and never the panel width (D163, ADR 0032).
- A successful workspace Write/Edit creates or activates Review in its
  originating session. Failed and scratch writes do not. Background-session
  artifacts update only their retained context and never open, activate, resize,
  focus, or change the visible panel.
- Each successful workspace Write/Edit tool result carries one durable review
  snapshot. Its compact InlineReviewCard is rendered in the same activity
  disclosure, immediately after its tool row; it is never moved to the
  transcript bottom and never shared with another session. Its status badge
  covers added, modified, and deleted changes, while counts and expandable
  hunks come from that message's result, not a current Git diff.
- The transcript cards and Review consume the active session's persisted
  message history. A commit, workspace focus change, or external Git state
  change cannot remove or rewrite an old card. Review is a chronological
  snapshot history and each reversible card exposes host-guarded rollback;
  conflicts are reported without replacing a later edit. Scratch, failed,
  denied, and unstructured results do not render a card. A background
  session's card remains with its own transcript and becomes visible only
  after that session is selected; its event never renders in the currently
  visible session. Successful workspace artifacts may still create or
  activate the singleton Review tab.
- Each session retains `{open, tabs, activeTabId, browserResource}` in renderer
  memory. Selecting another session swaps the visible context atomically and
  switching back restores it; selecting a workspace without an active
  conversation hides the panel. Session/workspace identity remains attached to
  every relative resource, preventing cross-context reinterpretation.
- Relaunch discards every session context, including Browser resources; only
  the committed preferred panel width persists. Native window state is stored
  independently from normal bounds, including when the app closes while
  maximized or before a pending bounds-save debounce completes. Panel width
  remains fixed rather than being responsively clamped.

### 1.9 Application updates (D120)

- Electron Main checks the fixed release feed 15 seconds after packaged app
  startup and every 6 hours afterward. Development builds remain disabled.
  The checker always tracks GitHub's latest stable release
  (`allowPrerelease = false`), so installs that still carry a prerelease
  version such as `0.2.0-rc.6` are offered the newer stable tag instead of
  staying pinned to the same prerelease channel.
- Settings → Info and application-menu checks share one typed update state.
  Manual checks expose up-to-date or error feedback; automatic failures do not
  open a toast or ambient banner.
- Manual delivery (`darwin` and non-AppImage Linux) stops at `available` and
  offers the fixed GitHub Releases page. In-app delivery (Windows NSIS and
  Linux AppImage readiness builds) automatically advances through
  `downloading` to the stable `downloaded` state.
- `downloaded` remains actionable until Restart to update or normal app quit;
  later scheduled/manual checks do not replace it with `checking`.
- A compact update notice appears in the main pane's top-right safe area only
  for manual `available`, in-app `downloading`, or `downloaded`. It stays clear
  of the bottom composer at every supported window size and draft height. The
  notice uses a stable icon/title/message hierarchy, shows determinate download
  progress when available, and keeps the relevant action inside the same
  surface. Dismissal suppresses the current version-and-status stage; a later
  stage such as `downloaded` appears again.
- When Main attaches dual-locale product notes for the discovered version
  (`UpdateState.releaseNotes`, D164), the notice and Settings → Info Updates
  row show a compact "What's new" list under the status message. Notes come
  from the shipped EN/zh-CN changelog catalog selected by the product UI
  locale — never from a renderer-supplied feed or remote URL. Missing catalog
  entries omit the section; locale changes re-resolve notes without a new
  check.
- Settings → Info keeps a Release notes action available in every updater
  state. It opens a modal over Settings with the complete local stable
  changelog in newest-first order, localized from the same shared catalog.
  The current release and a discovered available release are identified with
  compact badges. The list scrolls independently, closes by its close control,
  Escape, or the backdrop, and restores focus to the invoking control.
- D126 tag releases publish all platform manifests and installers. Windows
  NSIS and Linux AppImage therefore use the in-app lane; macOS and Linux deb
  remain notify-and-link delivery modes.

## 2. Streaming message behavior

### 2.1 Token rendering

- Tokens append to the current assistant MessageBubble as they arrive
- Renderer displays runtime stream chunks directly; it does not enqueue a
  second requestAnimationFrame-driven typewriter state loop
- Rendering uses incremental markdown parse — do not re-render the entire message on each token
- Transcript reconciliation keeps completed history in a memoized history boundary;
  token updates do not reconcile each historical row in React while preserving
  the full history for selection, copying, minimap anchors, and accessibility.
- An unfinished `mermaid` fence remains a source code block. After its closing
  fence arrives, answer prose loads and renders the diagram only when it
  approaches the viewport; thinking disclosures always retain Mermaid source.
- Diagram render failure or the 20,000-character / 500-edge safety limit keeps
  the source visible and copyable instead of failing the assistant turn.
- Cursor indicator: subtle pulsing accent dot or line at the end of streaming content
- Before the first assistant or tool event, the active turn shows one compact
  localized `Working…` status with elapsed time. It is replaced by concrete
  thinking/tool/answer feedback or the inline permission card as soon as one
  of those states exists.
- When stream completes: cursor indicator replaced by success state (2s fade)

### 2.2 Auto-scroll

- Opening a session for the first time resets follow mode and positions the
  transcript at its last record before the browser paints its pane. Revealing a
  retained pane restores that pane's own follow state and offset instead: still
  pinned re-anchors to the bottom, scrolled up returns to the same offset.
  Neither path animates through history, and no pane may ever expose the
  transcript top or another session's scroll position.
- Auto-scroll to bottom on each new token group (throttled: check every 100ms, not every token)
- The first upward manual scroll movement pauses auto-scroll immediately and
  cancels any pending follow frame; small trackpad deltas must not snap back to
  the bottom
- Sending a new prompt, retrying, or regenerating always re-pins follow mode and jumps to the bottom before the turn continues, even if the user had scrolled up
- "Scroll to bottom" floating button appears as soon as manual upward scrolling
  releases follow mode
- Click "Scroll to bottom" button: resumes auto-scroll and snaps to bottom
- Stream completion: if user was auto-scrolling, keep at bottom; if manual, stay at position
- An asynchronously completed diagram height update follows the same rule:
  ResizeObserver keeps a pinned transcript at the bottom, while a user who has
  scrolled upward remains at their reading position.

### 2.4 Active turn surface

- An active turn keeps the lower transcript surface clear. Streamed assistant
  and tool rows remain inline with the transcript; no generic understanding,
  working, or checking card is rendered underneath them.
- A permission card remains visible only when the agent is blocked on an
  explicit approval. It is an actionable interruption, not a progress status
  card.
- Background sessions continue without adding progress chrome to the visible
  session or moving focus. Reduced motion therefore has no progress-card
  transitions to preserve.

### 2.5 Turn outcome closure

- A failed visible turn renders one session-scoped recovery card after the
  transcript content. It is based on the terminal agent event, not a timeout
  or a guessed spinner state. Completed turns do not add a success card; their
  existing transcript and message-scoped review cards remain the completion
  evidence.
- Failure copy states that the existing work remains available. The card has
  exactly one **Continue** action and no **Regenerate** action. Continue appends
  the current locale's continuation prompt (`Continue the user's unfinished
  task.` / `继续用户未完成的任务`) to the same session and starts a new turn without
  truncating the failed turn or its completed work.
- Aborted turns do not render a failure card. Starting a new turn clears the
  previous card, and background-session results remain scoped until that
  session is selected.

### 2.3 Stream interruption

- If connection drops mid-stream: show error state on partial message
- Partial message is preserved — not deleted
- User sees "Stream interrupted" with retry option

## 3. Abort running agent

### 3.1 Trigger methods

- Topbar abort button (visible during running state)
- Keyboard shortcut: `Cmd/Ctrl + .`

### 3.2 Abort behavior

1. Cancel the current agent turn immediately
2. Cancel any pending permission request (per [03-permission-ux.md](03-permission-ux.md) §7)
3. If no assistant text, thinking, or tool row has begun, remove the just-sent
   user row and restore its pre-serialization composer draft
4. The restored draft keeps ordinary text and file-reference chips as separate
   state; serialized canonical paths never occupy the textarea
5. If a reply has begun, preserve the user turn and partial assistant/tool rows
   with aborted status and restore no draft. Preserve the measured stream
   duration and use provider output usage when available; otherwise store a
   visibly estimated output count so the conversation still shows throughput
6. Composer re-activates (unblocked)
7. Abort is idempotent — pressing abort when already aborting does nothing

### 3.3 Abort UX

- Abort button changes to "Aborting..." briefly (100ms), then disappears
- No confirmation dialog for abort — it is always immediate
- A partial aborted message gets a muted "(aborted)" suffix. Only the
  unanswered smart-stop branch deletes its just-sent user row.

### 3.4 Queued send

- While a session is running, Send remains enabled alongside Abort. Accepted
  prompts clear the composer and append to that session's renderer-local FIFO
  queue; session switching never moves or clears another session's queue.
- The queue renders above the composer. Each row has an independently
  keyboard-reachable Remove action and a Send now action.
- Send now moves its row to the head and requests the new `agent/stop` channel.
  The current assistant response and completed tool batch finish normally;
  after `agent_end`, the promoted row is dispatched through the normal
  `agent/prompt` flow before the remaining rows. An idle Send now dispatches
  immediately.
- Abort remains immediate and never clears the queue. Queued prompts are
  intentionally lost on application restart because the queue is not durable.

## 3A. Context checkpoint lifecycle

- `turn_end` marks one completed model/tool turn and may be followed by another
  provider request. It never re-enables the composer or session configuration.
- Automatic context protection evaluates after every `turn_end` and runs
  inline: the user waits for it. The model can also ask for it early through
  `new_context`, which lands at the same boundary.
- `compaction_start` keeps the session running. Threshold and overflow
  `compaction_end` events remain inside the active run; only `agent_end` or
  `error` settles it. A manual-only checkpoint settles on `compaction_end`.
- Every successful compaction shows one warning toast: earlier detail is gone,
  and starting a fresh session is a decision only the user can make. The three
  more specific toasts stay on top of it — a successful manual `/compact`
  result, a warning before an overflow retry, and the fallback warning below.
- If automatic summary generation fails but a retained-tail checkpoint is
  persisted, `compaction_end.fallback = "retained_tail"` shows one warning
  toast and the active run continues with reduced historical context.
- Manual failure shows one error toast. Automatic hard/overflow failure does
  not duplicate the assistant error with a toast; the terminal error remains
  attached to the failed turn.
- Compaction never removes visible transcript messages. The checkpoint affects
  only future model context and survives session switching/restart.
- Each compaction adds one divider row to the transcript, immediately after the
  last message it covers, reading how many times the session has compacted and
  the summary's estimated token cost (or that no summary was generated). The row
  has no actions and is not selectable.
- The context usage inspector keeps one muted line for the newest checkpoint,
  shown while its panel is open — the count and summary cost sit below the
  compact model/tool usage summaries without adding explanatory copy.

## 4. Long content collapse / expand

### 4.1 Collapse thresholds

| Content type | Default state | Collapse threshold | Expand limit |
|---|---|---|---|
| Assistant markdown message | Expanded | 50 lines → collapsed to 20 lines visible | Full |
| Tool activity input | Row collapsed | Always behind disclosure | 220px scroll region |
| Tool activity output | Row collapsed | Always behind disclosure | 220px scroll region (per D033 host cap) |
| Bash output | Row collapsed | Always behind disclosure | 220px scroll region |
| Error messages | Expanded | No collapse | — |

### 4.2 Collapse indicator

- Tool activity starts as a lightweight collapsed row; failed calls open
  automatically so the error remains local to its invocation.
- Consecutive tool activity is wrapped in one collapsed processing group. Its
  header updates elapsed time once per second while active, freezes after the
  next transcript message, and exposes the number of contained steps.
- A failed row is invocation-local truth and remains visible immediately. The
  containing group reports processing duration only and settles as processed,
  even when a later call recovers. Terminal turn failure is derived only from
  the terminal agent event and appears through the assistant error,
  TurnOutcomeCard, sidebar state, and notification surfaces.
- Expanding the processing group reveals the ordered rows; each row retains its
  own nested disclosure for output and input.
- Activating the row reveals clamped output first and raw input second.
- Each section scrolls internally and exposes its own copy action.
- The disclosure chevron rotates on expansion. Reduced-motion disables
  non-essential shimmer/rotation animation.

### 4.3 Tool result truncation

- Per D033: tool results exceeding 256KB or 4000 lines are truncated with explicit markers
- Truncation marker: `[truncated: output exceeded 256KB or 4000 lines]` (host-enforced, see [16-tool-result-limits](../03-runtime/16-tool-result-limits.md))
- Truncated content is never silently omitted — always marked
- Disclosure expansion does not load content beyond the host-enforced cap

## 5. Permission interrupt flow

### 5.1 Flow sequence

```text
Agent calls a permission-gated tool (including Plan/Goal Bash under Ask or Accept edits)
  → PermissionCard inserted inline in transcript
  → Composer disabled (cannot send new prompt)
  → Countdown starts (120s)
  → User responds: Allow once / Allow session / Deny
  → Card transitions to resolved state
  → Composer re-enabled
  → Agent continues or receives denial result
```

### 5.2 Multiple pending permissions

- Each session has at most one active permission card because that agent loop
  is paused; multiple sessions may wait independently.
- Abort cancels only the active session's pending permission.
- Timeout (120s from original receipt) auto-denies only the matching request;
  switching sessions never resets the deadline.

### 5.3 Focus management during permission

- A visible permission card is announced through `aria-live` without forcing
  focus. A background session's card is not mounted and cannot move focus.
- Action buttons are tab-reachable within the card
- After resolution: focus returns to composer
- Full spec: [03-permission-ux.md](03-permission-ux.md)

## 5A. Plan and Goal workflow

1. The user selects Plan or Goal while the session is idle, or the same Agent
   calls `EnterPlanMode` / `EnterGoalMode`; the host persists/validates the
   matching contract mode and the renderer projects `planning`.
2. The Agent investigates with the selected contract tool set. Read/Glob/Grep and
   BrowserPreview are allowed; Bash follows the visible permission mode. A
   contract-mode Bash command may mutate under Auto, so the mode chip remains visible.
3. The Agent calls `SubmitPlan` or `SubmitGoal` alone in its tool batch.
   Host-core preserves the exact Markdown bytes in a new immutable
   `.pi/plan/*.md` or `.pi/goal/*.md` artifact, records its path/hash/size and structured
   title/question, and the renderer displays the shared contract approval card with
   only the title and artifact opener; the question remains host-side contract data.
4. Approve requires Ask / Accept edits / Auto selection. The renderer remembers
   the last selected mode on this device and uses it as the next approval's
   default. Host-core commits the approval, `mode = agent`, permission mode,
   and `queued` state atomically; the same Agent continues on a fresh turn with
   Agent tools.
5. Reject stops the pending run and keeps the durable session in its contract
   mode. The live state returns to editable planning; revisions are new-turn
   `SubmitPlan`/`SubmitGoal` calls with a new complete Markdown snapshot and new artifact. Earlier snapshots
   remain immutable; there is no request-changes action.
6. Expiry, abort, persistence failure, renderer/host/sidecar crash, or stale
   response renders a failed-closed state. A host restart interrupts pending,
   queued, and running work without replay; an already-approved interruption
   keeps the session in Agent.

The approval card is session-scoped. Background sessions may retain a pending
approval or queued/running execution state in `plan_approvals`, but opening
another session never covers it or moves focus; returning to the originating
  session restores the renderer-lifetime snapshot; while the host remains alive,
  `plans.pending` can rehydrate a still-pending row. The approval card does not
  expose a validity/deadline concept.
Mode/provider/model/permission/shell configuration and new prompts remain
disabled while an active `pending` approval or turn exists. During pending
approval the existing draft remains in the textarea but is read-only; only
Approve and Reject remain enabled on the approval surface. Reject, expiry, or
interruption re-enables them; terminal proposal snapshots do not keep the gate
closed. The renderer retains the latest checkpoint/execution status per session
only for its current lifetime, so rejected, expired, interrupted, approved,
queued, and running outcomes may remain visible across session switches. A
renderer reload rehydrates only a pending row; terminal cards are dropped and
are not restored. Host restart interrupts prior work without replay or stale
action, and the UI is not required to present the interrupted terminal
snapshot. The Composer-left Agent/Plan/Goal chip is the only active-session mode
control.

During project or session initialization, the home composer can render before
an `activeSessionId` is projected. Idle mode, Thinking, and permission
controls remain usable in that interval; the durable empty session row is
created or selected by the New Task action and the first configuration action
applies to that session once it is projected. The startup-only home composer
may still materialize a session when pasted input arrives before selection.
Running turns and pending approvals continue to gate the controls.

## 6. Toast vs inline error

### 6.1 Toast notifications (use for)

| Scenario | Toast type | Duration | Rationale |
|---|---|---|---|
| Provider connection test result | Success/Error | 4s/8s | Transient feedback, not blocking workflow |
| Plugin load/unload success | Success | 4s | Confirmation of background action |
| Settings saved | Success | 4s | Quick confirmation |
| Manual menu update check failure | Error | 8s | Direct feedback for an explicit command |
| Context checkpoint completed | Info (Warning before overflow retry) | 4s/8s | Confirms a background context transition without altering transcript rows |
| Manual context checkpoint failure | Error | 8s | Direct feedback for explicit `/compact`; automatic terminal failures stay inline |

### 6.2 Inline errors (use for)

| Scenario | Inline placement | Rationale |
|---|---|---|
| Tool call failure | Error state on ToolCallCard | Context-dependent, user needs to see which tool failed |
| Permission denial | Resolved state on PermissionCard | Already inline, part of conversation flow |
| Stream interruption | Error state on MessageBubble | Belongs to the message that failed |
| Provider/model turn failure | Assistant error message in transcript | Keeps summary, stable code, redacted detail, and recovery action attached to the failed turn |
| Provider configuration validation error | Inline in settings form | User needs to see which field is wrong |
| Application update status/error | Settings → Info Updates row | Preserves the latest Main-owned state without interrupting background checks |
| Composer validation (no model) | Disabled state + tooltip on send button | Immediate context |

### 6.3 Rules

- Never use toast for errors that are tied to a specific message or tool call
- Assistant error detail uses a keyboard-operable disclosure with
  `aria-expanded` / `aria-controls`; it is open on first render so the provider
  response is immediately discoverable, and supports copying the redacted text
- Never use inline error for transient background operations (plugin load, connection test)
- Toasts stack vertically, newest on top, at top-center
- Error toasts require manual dismiss or timeout at 8s (longer than success)
- Success toasts auto-dismiss at 4s

## 7. Focus management

### 7.1 Focus flow on page load

1. Composer textarea receives initial focus in main chat view
2. Settings pages: first interactive element receives focus
3. Command palette: search input receives focus on open

### 7.2 Focus flow after actions

| Action | Focus target |
|---|---|
| New session created | Composer textarea |
| Session switched | Composer textarea |
| Message sent | Composer textarea (cleared, ready for next) |
| Stream completed | Composer textarea (re-enabled) |
| Permission resolved | Composer textarea |
| Abort completed | Composer textarea |
| Command palette closed | Previously focused element |
| Dialog closed | Previously focused element |
| Notification popover closed with Escape | Notification bell |
| Notification row/native notification activated | Activated session composer after transcript load |

### 7.3 Focus trap

- Command palette: focus trapped within palette while open
- Settings modals: focus trapped
- Escape always closes the trapped surface and returns focus

### 7.4 Focus ring rules

- Only show focus ring on `focus-visible` (keyboard focus), not on click/mouse focus
- Focus ring: 2px accent color border, 2px offset from element edge
- Per [07-ui-design-system.md](07-ui-design-system.md) §6.4
- Never remove focus rings globally — accessibility requirement

### 7.5 Text selection

- Application chrome is non-selectable by default to prevent accidental
  selection while clicking or dragging the shell.
- Editable controls (`input`, `textarea`, `select`, and
  `[contenteditable]`) preserve normal text editing and `Cmd/Ctrl+A/C/V`
  behavior.
- Transcript prose, rendered Markdown, code blocks, and tool input/output
  remain text-selectable for inspection and copying.
- Interactive controls nested inside selectable content remain
  non-selectable and must keep their click and keyboard behavior.
- Selection rules must not disable `focus-visible` feedback or native window
  drag regions.

## 8. Drag / drop

### 8.1 MVP status

Work-panel width resizing is implemented in MVP:

- The 10px left-edge separator anchors to the press position and starting
  width, then follows pointer delta without jumping.
- The committed width clamps to the fixed `244px–720px` range.
- Pointer movement is frame-coalesced. Pointer release persists one committed
  preferred width; Escape, pointer cancellation, and lost capture roll back both.
- Opening and closing animate the dock's `width` and `flex-basis` together with
  the bounded opacity/transform feedback, so MainChat reflows continuously
  instead of changing width before the first motion frame.
- Opening requests a native reservation equal to the committed panel width;
  collapse and final close request zero after the exit animation (ADR 0122).
  Repeating a target is idempotent.
- MainChat reflows continuously while the panel flex allocation opens or
  closes. When the display work area can supply the reservation, the chat
  width stays stable and the window returns to its base bounds after collapse.
  When the work area is too narrow, chat absorbs the unavoidable shortfall and
  may reflow below its 360px target.
- Native window and sidebar resize never clamp or rewrite the panel. Native
  edges and corners resize MainChat by reflow only. The OS retains ownership of
  the native hit regions; recovery logic waits for a 300ms stable-bounds window
  and state persistence runs 600ms after the final resize/move event, so neither
  can fight a slow edge drag or save an intermediate rectangle.
- Maximized/fullscreen is unaffected; display/work-area changes reconcile the
  reservation against the current bounds. Ordinary movement within one
  unchanged work area does not reapply geometry. Persisted base bounds exclude
  temporary reservation width and its x shift.
- Background-session artifacts never update the visible panel or reservation.

Sidebar width resizing is also implemented in MVP:

- The expanded sidebar's right-edge `separator` handle anchors to the press
  position and starting width, then previews a clamped width from `240px` to
  `520px` while the main pane reflows.
- Pointer release commits and persists the final width. Pointer cancellation,
  lost component ownership, unmount, and Escape restore the press-time width
  without changing the saved preference.
- The focused handle supports ArrowLeft/ArrowRight in 16px steps plus Home and
  End. Keyboard changes commit immediately and expose `aria-valuenow` and a
  localized width description.
- Collapsing the sidebar hides the handle but does not discard the preferred
  expanded width; re-expanding restores that width.

The following gestures remain reserved for future milestones:

- Drag project/session items to assign manual order
- File drag into the composer remains unhandled; clipboard file/image paste
  uses the session-scratch reference flow below

### 8.2 Spec reservation

When drag/drop is implemented, these patterns should apply:

- Drag handle must be visible on hover (no invisible drag affordance)
- Drop targets highlight with accent border during hover
- Cancel drag with Escape
- Drag feedback: opacity 0.5 on source, accent outline on target

## 8a. Composer autocomplete and clipboard files (D123–D125, D197, D262, ADR 0131)

### 8a.1 Triggers

- `/` opens command mode only when it is the first character of the input
  and the cursor is still inside that first token (no whitespace typed yet).
  A space after the command name closes the menu; arguments are free text.
- `@` opens file mode when the token containing the cursor starts with `@`
  and the character before `@` is start-of-input, whitespace, or one of the
  pi delimiters (`"`, `'`, `=`). The query is the text between `@` and the
  cursor; a query containing `/` matches across path segments. A quoted
  token (`@"…`) is treated as one token until the closing quote.
- Pasting text never opens a menu unless the caret lands inside a valid
  trigger token.
- File results keep each row compact by rendering only the leaf name (with a
  trailing `/` for directories). The full relative path remains available as
  the row tooltip and accessible name. Accepting a file creates a compact
  reference backed by the full `entry.path`; accepting a directory keeps the
  full literal path in the textarea so deeper completion can continue.

### 8a.2 Reference chips and clipboard files

- A paste containing one or more OS `File` objects is intercepted in the
  textarea. Text-only paste stays native when its character count is at or
  below the persisted `largePasteThreshold` (default 600); text-only paste
  above the threshold is intercepted and converted into a temporary session
  file reference.
- While bytes are being transferred, the textarea is read-only and exposes
  `aria-busy="true"`; the send and autocomplete controls are disabled.
- Electron main saves bounded bytes under the originating session's scratch
  root and returns unique absolute paths plus sanitized original leaf names.
  The composer leaves visible text unchanged, appends leaf-name reference
  chips in clipboard order, then restores the textarea selection and focus.
- For an oversized text-only paste, the renderer sends the exact UTF-8
  `text/plain` bytes through the same session bridge, inserts a generated
  `@<temporary-name>` token plus a space at the original selection, and keeps a
  token-to-canonical-path mapping in the draft. The token remains inline in the
  textarea rather than becoming a chip; dispatch replaces it in place exactly
  once with the canonical scratch path. Pasting in the middle of a draft keeps
  both the prefix and suffix intact.
- If the home composer has no active session, it creates or reuses one before
  writing. Failure leaves the existing draft unchanged and shows the error in
  the normal toast surface.
- A chip remove button removes only that draft reference and restores textarea
  focus; it does not eagerly delete session scratch bytes. Backspace on an
  empty textarea removes the most recent active reference.
- A reference-only draft enables Send. Before dispatch, active references are
  appended after visible text and ordinary references are serialized with the
  canonical relative or absolute paths and existing whitespace quoting.
  Pasted references are submitted as structured attachments so the main
  process can choose visual input or the same path fallback from the exact
  model capability. Inline large-paste references are resolved in the visible
  draft instead of being appended or sent as duplicate attachments.
  Successful dispatch clears both; failed or rejected dispatch retains both.
  References are session-scoped and scratch references survive a workspace
  switch while their owning session remains available.
- When an image reference is active, Composer shows one compact live status
  line. It names visual transport for a model whose pi-ai `input` includes
  `image`, and names the file-path fallback for unknown/non-vision models.
  The status is informational, keyboard-safe, and never relies on color alone.
- Accepted dispatch retains an in-memory, session/turn-scoped copy of the
  visible text and structured references only while unanswered smart Stop can
  undo the send. That undo restores the original chip order and labels; it
  never parses serialized `@path` text. Once reply content begins, abort keeps
  the partial transcript and restores no draft.

### 8a.3 Keyboard while open

- ↑/↓ move the highlight with wraparound; Home/End are left to the textarea.
- Enter / Tab accept the highlighted item; Enter never sends while the menu
  has a highlighted item (this precedes the Enter-to-send setting, which
  otherwise keeps its behavior).
- Escape closes only the menu — it takes precedence over the composer's
  "clear input or blur" Escape and must not propagate to overlay handlers.
- Any other typing re-filters in place; zero matches behaves as closed.

### 8a.4 IME (first normative IME rules)

- All autocomplete key handling sits behind the standard guard
  (`isComposing || keyCode === 229`).
- During active composition the trigger detector neither opens, updates,
  nor closes the menu; state re-evaluates on `compositionend`.
- Enter that confirms an IME candidate never sends and never accepts a menu
  item; ↑/↓ during candidate navigation belong to the IME.

### 8a.5 Close and focus rules

- Close on: outside mousedown, textarea blur, deleting past the trigger
  character, session or workspace switch, accepting an item (except `@dir/`
  continuation, which keeps the menu open on the deeper query).
- Focus stays in the textarea for the menu's whole lifecycle (input-retained
  overlay); the menu is never a focus trap and never steals the caret.

## 9. Scroll behavior

### 9.1 Transcript scrolling

- Default: auto-scroll to bottom on new content during stream while pinned
- The first upward scroll **gesture** (wheel / trackpad / touch / scrollbar /
  keyboard) pauses auto-scroll and shows the "↓ Scroll to bottom" button;
  queued stream or resize follow work must not reverse that movement
- Programmatic follow scrolling and layout-driven clamps never release follow:
  a scroll event with no preceding user input (for example a scrollTop clamp
  when the composer collapses after send or an indicator row unmounts) is
  treated as layout noise and re-baselined instead of being mistaken for a
  user scrolling up
- User send / retry / regenerate: re-pins, hides the jump control, and positions the latest content in the layout phase so the new turn is visible without a top-of-history flash; subsequent persisted and streamed rows continue to follow the bottom
- Scroll-to-bottom button: position fixed at bottom-right of transcript area, offset 12px
- Button appears as soon as upward scrolling releases follow mode
- Click button: scrolls to bottom, resumes auto-scroll
- Button disappears when at bottom

### 9.1a Sidebar project path and open folder

- Hovering or focusing a retained project title shows the full absolute path.
- The truncated project name remains visible in the row; the full path is
  tooltip/accessible-description only and never forces horizontal scroll.
- Right-clicking a project row or opening its overflow menu exposes **Open
  folder** as a project action. Conversation overflow no longer carries that
  action.
- Choosing **Open folder** opens the project directory in the system file
  manager without changing the active session transcript.

### 9.2 Sidebar scrolling

- The standalone Sessions body is capped at five compact rows and scrolls
  internally when additional sessions exist.
- Retained project groups occupy the remaining sidebar height and scroll in a
  separate region. Both regions stay independent from the footer and primary
  navigation.
- No horizontal scroll in sidebar
- Scroll indicators use the platform's subtle overlay treatment without
  changing either region's width. The 6px thumb is transparent at rest and
  appears when the owning list is hovered or focused; dragging keeps it
  visible until the interaction ends.

### 9.3 Settings scrolling

- Settings content scrolls independently within main area
- Left nav (settings sections) is sticky, does not scroll

## 10. Reduced motion

### 10.1 Policy

All animations must respect `prefers-reduced-motion: reduce`:

1. **Suppress:** streaming pulse, expand/collapse transitions, dropdown slide, hover color transitions
2. **Keep (instant):** state changes still occur (card status changes, loading → complete) but with no transition duration
3. **Never remove:** focus rings, status colors, layout positioning — these are structural, not decorative

### 10.2 Implementation

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

This does not prevent state changes — it makes them instant.

### 10.3 Affected patterns from this doc

| Pattern | Normal | Reduced motion |
|---|---|---|
| Streaming pulse | accent pulse on left border | static accent border (no pulse) |
| Tool card expand/collapse | 200ms transition | instant toggle |
| Hover state transition | 150ms background change | instant color change |
| Startup splash | Brand splash + progress, min dwell then fade out | Instant static splash, no bar motion, instant reveal |
| Dialog / search enter | overlay-in + surface-in via motion tokens | Near-zero duration enter |
| Scroll-to-bottom button fade-in | 150ms opacity | instant appear |
| Toast slide-in | 200ms slide | instant appear |
| Modal/dialog enter | 300ms fade+scale | instant appear |
| Notification popover enter | menu-scale/fade token | instant appear |

### 10.4 Programmatic scrolling

- Session activation uses an immediate layout-phase bottom position so the
  first visible frame is already stable at the latest record.
- Jump-to-latest and minimap navigation use smooth scrolling only when the OS
  has not requested reduced motion.
- Turn-start following uses an immediate layout-phase update and then a
  frame-coalesced instant follow; it does not start overlapping smooth-scroll
  animations for token groups.
- Manual upward movement cancels a queued pinned-follow frame before it can
  restore the previous bottom position. Follow remains released across content
  growth until the viewport is scrolled down within 48px of the bottom or an
  explicit turn-start / jump-to-latest action re-pins it.
- Released-follow detection is gated on a recent user scroll input. Native
  scroll events from a follow `scrollTo` whose position was later clamped by
  layout changes (composer height, indicator rows) arrive after the fact and
  look like an upward gesture; because they have no preceding input they are
  ignored and follow mode is preserved.
- Resize observers schedule work and never synchronously measure every
  transcript row from their callback.

## 11. Acceptance criteria

1. All keyboard shortcuts in §1 are functional and do not conflict with system shortcuts
2. Enter sends message; Shift+Enter inserts newline in composer
3. Abort immediately cancels running turn and pending permissions without confirmation dialog
3a. Send stays enabled while running, queues prompts per session, and Send now
    finishes the current boundary before releasing its prioritized prompt
4. Long content (>50 lines for messages, >10 for args, >20 for results) is collapsed by default with expand link
5. Tool results exceeding 256KB/4000 lines show truncation marker per D033
6. Permission interrupt inserts inline card, disables composer, shows countdown, and re-enables after resolution
7. Toasts used for transient background operations; inline errors used for context-specific failures
8. Focus returns to composer after session switch, message send, permission resolution, and abort
9. Background message, tool, completion, and permission events never change
   the active session/project/page or keyboard focus; concurrent permission
   requests remain independently actionable in their originating transcripts,
   and background artifacts update only their session's retained work-panel
   context
9a. Creating a new session or switching to a non-running session returns the
    composer to its idle Send state even while another session is still
    streaming; the destination session's own run state alone decides the
    send/abort button
10. Focus rings visible on `focus-visible` only, 2px accent offset 2px
11. Command palette traps focus; Escape returns to previous focus
12. All animations respect `prefers-reduced-motion: reduce` — state changes are instant, no decorative motion
13. Project/session rows support non-destructive pin/archive, independent
    project collapse, and the documented user-facing sort modes
14. Shell chrome does not create accidental text selections, while editable
    controls and transcript/code/tool content remain selectable and copyable
15. Retained project tabs survive restart; activating one changes the selected
    shell workspace without redirecting background session tool roots
16. Drag/manual reorder is not implemented; `manual` remains a compatibility
    value and future drag patterns follow §8
17. Completed and failed turns appear exactly once in the durable inbox;
    aborted turns never appear
18. All/Unread, mark-all-read, clear, row activation, Escape/focus restore, and
    arrow/Home/End keyboard navigation behave as documented in §1.7
19. Native notifications appear only while the main window is unfocused and
    their activation focuses the window and opens the corresponding session
20. Streamed message updates stay within the chat render boundary; shell
    navigation, composer, completed rows, and work-panel content do not rerender
    solely because the current assistant message appended content
21. Native window-edge resize changes MainChat by reflow without compressing the
    fixed work panel; divider commit updates the committed preferred width and
    active reservation, while divider cancellation restores the prior width and
    reservation (ADR 0122)
