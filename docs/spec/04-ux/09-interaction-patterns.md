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
| `Alt + Shift + W` | Show or hide the window (toggle) | OS-global (D439); hides to the tray, never quits |
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
| `Enter` | Send message when Enter-to-send is on; newline when it is off | Composer focused |
| `Cmd/Ctrl + Enter` | Send message when Enter-to-send is off | Composer focused |
| `Shift + Enter` | Newline | Composer focused |
| `Alt + Enter` (`Option + Enter` on macOS) | Steer the current turn; send normally when idle | Composer focused, outside IME composition |
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
- A missing shortcut override uses the shared platform default; a valid
  string uses the custom binding; an explicit `null` means `Unbound` and never
  dispatches. Unbound actions do not conflict with other bindings.
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
  installed. An unbound launcher disables both the hook and focused-window
  fallback. Custom bindings continue to use Electron's global shortcut API.
  Electron starts warming the launcher in a hidden window as soon as Electron
  is ready, in parallel with backend and main-window boot; shortcut delivery
  during warm-up joins the same in-flight load. The macOS show path relies on
  the panel's normal activation instead of issuing a second application
  activation or window-stack move. The launcher always opens on the display
  nearest the pointer.
- The window visibility key is one toggle (`Alt + Shift + W`): a visible,
  focused window hides to the tray, and anything else — hidden, minimized, or
  behind another application — is shown and focused. Hiding never enters the
  close path, so it raises no close-behaviour prompt, destroys nothing, and
  never quits the app. The key is globally registered, so it deliberately
  avoids `Cmd/Ctrl + W`, which macOS spends on its own close-window command and
  which would be taken from every application if the app claimed it. The
  retired `Cmd/Ctrl + Shift + W` summon chord is not registered either, and
  stored `closeWindow`/`summonWindow` overrides are folded into the toggle when
  the map is read (D438, D439).

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
  the conversation pane's right edge while the work panel is closed. While the
  work panel is open, those controls stay viewport-fixed at the window's right
  edge over the panel header, which reserves the control band plus the
  work-panel toggle so resource close remains reachable. The sole panel
  collapse control is that viewport-fixed toggle. Destination history has no visible back/forward
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
  developer-tools role in View; the conversation overflow menu adds Copy
  conversation ID and Open session path. With the mode disabled these product
  entry points remain unavailable, and disabling it closes an open console.
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
  applied by both the close button and the close shortcut. Explicit quit
  (Cmd+Q, application-menu Quit, tray Quit) is a separate confirm step
  (D363): Cancel leaves the app running; Confirm runs the ordered shutdown.
  A D230 window-close Quit does not ask again. Automated boot, supervision,
  and capture probes skip the dialog, as does the restart that installs an
  already-downloaded update — its installer is already running and gives up
  when the app stays alive. macOS keeps the
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
- Double-clicking the PI-Desktop tray icon (or single-clicking on Windows/Linux),
  choosing Open, or activating the app from the macOS dock restores and focuses the
  existing window. If the window was closed, the same action creates a fresh
  window.
- The tray menu is localized with the active shipped shell locale and
  exposes Open, bounded session groups, and an explicit Quit action. Quit uses
  the existing ordered shutdown path. What closing the window does is the
  user's own choice on Windows/Linux (ADR 0090) and a Dock-lifecycle close on
  macOS; the tray icon itself is created once at startup either way.

### 1.5.2 Tray session navigation (issue #293)

- The native menu shows Running, Unread, and Pinned in that order, at most
  nine sessions in total. Every non-empty group keeps up to three rows; the
  share smaller groups leave unused goes to the groups that still overflow,
  in priority order, so one busy group can fill all nine while the others are
  empty. Membership is assigned before applying limits; higher-priority
  overflow never spills into a lower group.
- Empty groups are hidden. Archived sessions/projects and deleted sessions
  are excluded. Running/Pinned follow sidebar sorting; Unread follows the
  latest unread result per session, newest first, including failed results.
- Long titles use one line capped at 32 display columns including the
  ellipsis; an East Asian wide or emoji code point counts as two, so a CJK
  row stays as wide as a Latin one. An overflowing group offers View more to
  restore the window and expand session navigation. A session row
  restores/focuses its exact conversation, activating its project through the
  existing selection flow.
- macOS single-click opens the menu without restoring/focusing a conversation
  or marking it read. Entering a conversation uses normal acknowledgement.
  Open and double-click restore the window; Quit keeps its confirmation and
  ordered shutdown. Group/action labels follow the active shipped locale.
- Start/finish, read, pin, rename, archive, delete, and backend restart update
  the menu. The menu remains available when the main window is hidden or
  closed, without creating another window until an explicit activation.
- macOS does not listen for tray mouse-enter: that event replaces the native
  status item and hides the extra. Windows/Linux still retry a failed Host
  read on hover/right-click; macOS retries from the next session or inbox event.


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

- **Rename** — the session row menu and Project archive task rows open the same
  modal editor. Saving trims the title and persists 1–80 Unicode code points;
  blank values are not submittable. The title is metadata only, so the task's
  transcript, activity ordering, project binding, and empty-session state are
  unchanged. Escape, Cancel, or clicking the scrim dismisses the editor.
- **Edit project** — the project overflow menu in the sidebar and Project
  archive opens the same editor for the selected logical project. The editor
  trims and persists a 1–80 Unicode-code-point group name and lists every
  registered folder. The Primary folder stays first and cannot be removed;
  additional folders can be added through the native multi-selection picker or
  removed individually. Saving updates the host-owned group while preserving
  the normalized paths, workspace identity, sessions, transcripts, and on-disk
  folders. A folder with existing chats cannot be removed.
- **Pin** toggles presentation priority. Pinned projects/conversations appear
  before unpinned rows within the selected secondary order. In the sidebar, a
  pinned project replaces its Folder glyph with a filled accent Star so its
  state remains recognizable without opening its overflow menu.
- **Archive** is non-destructive. Archived rows are hidden by default,
  available through Show archived, and restorable. Archiving does not cancel
  a turn or delete a transcript.
- **Delete** removes a session or a project permanently and takes two clicks:
  the first arms the overflow item and relabels it (`nav.deleteTaskConfirm` /
  `project.deleteMenuConfirm`), and only the second click removes the row. The
  arm expires on its own, so a row never stays one stray click away from a
  permanent delete, and the folder on disk is never touched. A project whose
  turn is still live still opens the confirmation dialog that names those
  sessions and stops them first; an idle project is removed on that second
  click.
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
  to `recent`. Pressing a project title and moving 8px, or ArrowUp/ArrowDown
  on that focused title, switches project ordering to `manual` and persists a
  contiguous order per normalized path. Archived and pinned priority remains
  ahead of the manual order; projects without an assigned order fall back to
  a stable path order until they are moved.
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
- A transcript window that reports no messages for a session the sidebar counts
  as having history is read as unreadable, not as empty (**D615**, issue #795):
  the selection asks once more, then keeps the snapshot the user already has,
  and otherwise reports `chat.sessionTranscriptEmpty` instead of committing an
  empty transcript. Such a page is never cached, so a hover prefetch cannot
  re-serve emptiness on every later open.
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
  nothing is dimmed, no skeleton appears, and no transcript remounts. If the
  destination is running or still holds a completed reply the durable page has
  not caught up to, revalidation treats the durable read as a lower-water mark
  and keeps its renderer-owned assistant/tool tail; completed durable rows may
  be added, but the partial or just-finished reply cannot be rolled back. The
  bounded durable page is stitched onto the live snapshot in chronological
  order: live rows older than that page stay before it, and an optimistic,
  streaming, or not-yet-flushed tail stays after it. Live-only rows are never
  appended after the page, which would move the newest turn out of the mounted
  trailing window (D317 / D261 / D324). Live provenance is cleared only once
  that page already contains every live row.
- Switching to a session with no retained pane (cold) leaves the visible pane on
  its own session until the destination commits. Only a thin progress track and
  `aria-busy` mark the wait, the composer stays non-interactive so a prompt cannot
  reach the session being left, and the destination session id is never paired
  with another session's messages. The destination is then revealed at its final
  record without a top-of-history or empty-home flash. An evicted session is
  indistinguishable from a first visit.
- New Task is not a cold switch. Creating a session reveals the empty home on
  the first frame (the previous conversation and retained panes clear before
  `session.create`). Reusing the group's latest empty session commits that empty
  transcript on the same frame rather than waiting for `session.get`. The
  durable row is inserted from the `session.create` summary; send and paste wait
  for that in-flight create instead of opening a second slot (ADR 0154).
- A first-opened session settles at its newest turn. A revisited pane returns to
  the offset the user left, and a pane still pinned re-anchors to the bottom;
  activation no longer resets manual-scroll state for a revisit (ADR 0137).
  History continuation (D269) does not page earlier rows from a collapsed
  scroller or from a pinned overflowing transcript whose `scrollTop` has been
  reset to 0; a real gesture in the near-top band still continues history. An
  empty first paint does not spend the first-commit hydration gate, so a later
  long page is still bounded and re-bottomed in the layout phase, before the
  browser paints it.
- Selecting a project-scoped conversation activates its project as part of the
  store-owned selection transaction. Selecting a Temporary conversation clears
  the visible workspace. Project-scoped new-session actions pass their target
  path to that same store transaction; sidebar and project-index handlers do
  not perform a second project navigation before session creation or selection.
- Run state, permission grants, and streamed events are keyed by session id.
  A project/tab switch does not abort a background turn or copy its events into
  the visible transcript. Background message and tool events update that
  session's renderer-owned live cache, so reopening a running session does not
  lose the partial tail when its durable detail read completes. Transcript
  revalidation and older-page prepends are idempotent by message id and keep the
  last version at the first row position, so reopening or a stale page response
  cannot add a second copy of a user message. These events never activate their
  session, change the visible project/page, or move
  focus. Creating a new session or switching to one that is not running returns
  the composer to its idle Send state on that first frame: a turn still streaming in the
  previously selected session never leaves the destination session's send button
  stuck in the Abort/stop state, and that background turn's later completion
  does not alter the destination composer. Their work-panel artifacts and
  Browser resource update only the
  originating session's retained renderer context and do not reveal or resize
  the visible panel. Only an explicit session/notification activation navigates
  and projects the destination session's retained panel context.
- The composer draft is also session-scoped in renderer memory (D301): the
  cache outlives any one Composer mount, so switching sessions, empty-home ↔
  docked, chat ↔ other pages, or OS windows saves/restores the source text and
  file references. An uncached destination starts empty, and the home composer
  has its own draft slot. Creating a new session does not copy another slot. A
  completed send clears only the draft belonging to the session that submitted
  it, even if the user switches sessions while the request is in flight;
  deleted sessions cannot retain drafts.
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

#### Floating dropdown surfaces

- Every renderer-owned custom dropdown/menu opens as a viewport-fixed floating
  layer, outside its triggering row or card, so opening it never changes parent
  height, width, or scroll allocation.
- Shared anchored menus are measured before reveal, clamp to the viewport,
  prefer the requested side, and recalculate on anchor movement, scroll, and
  resize. Outside press and Escape close the surface and restore focus to its
  trigger unless the pattern explicitly retains input focus.
- Native `<select>` popups remain platform-owned; this rule covers custom
  renderer surfaces only.
- Pointer-anchored context menus (transcript rows, conversation
  background, markdown links) are the same family: they portal to
  `document.body` as a viewport-fixed layer, measure before reveal so
  they never flash at the origin, clamp inside the viewport instead of
  flipping, and close on outside press, Escape, Tab, window blur, or a
  scroll of anything behind them. An empty item list never opens a
  surface.

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
3. Electron emits `notification.changed` to every live renderer for the newly
   inserted durable row so the bell badge and currently open inbox refresh.
   Renderer delivery is keyed by the durable `id`: duplicate ids and delayed
   events for rows already acknowledged or cleared are ignored.
4. For a task result, a focused main window produces no native banner. If
   it is unfocused and native notifications are supported, Electron shows one
   platform notification derived from the event kind and session title. The
   separate interactive ask/permission/plan path may alert for a focused
   background session while suppressing the exact visible session. On
   Windows, the banner is attributed to the canonical PI-Desktop
   AppUserModelID shared with the NSIS package and taskbar identity. Electron
   retains at most one task-native object per durable id; successful read,
   mark-all-read, and clear actions close the matching objects and retain a
   tombstone against late/replayed delivery.
5. Clicking the native notification shows/restores and focuses the main
   window, then emits `notification.activated { sessionId }`.
6. Renderer activation selects the bound project when present, loads the
   session, and focuses the transcript/composer using the same path as an inbox
   row click. Native and in-app activation must not diverge.

#### Popover behavior

- The list shows `task.failed` rows only and the bell badge counts only
  unread failures. `task.completed` rows are still persisted and still drive
  the sidebar outcome badge and the native notification, but the inbox hides
  them so failures are not buried under routine completions (D295).
- Bell click toggles the non-modal popover; a second click, Escape, or outside
  press closes it. Escape restores focus to the bell.
- Opening preserves the most recently selected `All` / `Unread` filter for the
  current renderer lifetime and never marks rows read implicitly.
- Arrow keys move through rows with wrap disabled; `Home` / `End` jump to the
  first/last row; Enter/Space marks the row read and activates its session.
- Mark all read updates every unread row in one host transaction and dismisses
  outstanding task-native objects. Clear removes all inbox rows in one host
  transaction, dismisses outstanding task-native objects, and leaves
  sessions/turns intact. Both operations are idempotent and refresh the exact
  unread count; a failed host mutation does not optimistically dismiss a
  banner.
- The renderer does not synthesize notification records from stream events.
  Host-core's unique `turn_id` is the exactly-once boundary across repeated
  terminal updates, renderer reloads, and process restarts.
- All visible event labels and native title/body strings are localized at the
  presentation boundary from structured fields; persisted rows never contain
  localized prose.

### 1.8 Work panel entry and resources (D128, D142, D154, D173, D179, D207, D221)

- The shell starts without a visible work panel. The viewport-fixed toggle and
  `Cmd/Ctrl + J` both toggle the active session's panel: they reveal the
  retained context without creating a resource tab, and collapse the visible
  panel without deleting tabs, retaining tabs, active resource, and committed
  width. They are a no-op without an active session or while Settings is the
  active page. The panel's `+` trigger can then create a New launcher tab whose
  body offers Browser or an in-scope plugin view.
- An artifact trigger atomically creates or reuses its resource, activates it,
  and opens the panel. Background artifacts never open the visible panel.
- File resources use normalized paths as identity. Browser and plugin views
  are singletons; repeated triggers preserve resource order and activate the
  existing resource.
- Once open, the panel header is a `tablist` that scrolls horizontally while a
  tight `+` trigger stays fixed beside it. Each tab owns its active state and
  close button; the active tab is scrolled into view. Clicking `+` creates a
  unique New launcher tab; its data-driven Review, Files, Browser, and plugin
  view rows are ordinary buttons in the page body.
- Tab focus uses roving `tabIndex`: ArrowLeft/ArrowRight/Home/End move across
  tabs and Delete/Backspace closes the focused tab. Pressing and moving a tab
  by 8px starts pointer reordering; dropping on the target's left or right half
  inserts before or after it, and `Alt+ArrowLeft`/`Alt+ArrowRight` provides the
  keyboard equivalent. Holding the pointer near the tab strip's edge scrolls
  toward off-screen tabs and keeps the drop indicator synchronized. The active
  tab remains active after reordering.
  Middle-click closes a tab; closing an active tab selects the right neighbor,
  then the left. Selecting a launcher row replaces that New tab with the
  destination or activates its existing singleton. Shortcut labels appear only
  for bindings that actually exist.
- Activating a tool that is already open activates its existing resource instead
  of replacing it, so Browser keeps its URL and Files its selection (D173).
- Every resource can be closed from its tab. Closing the active resource selects
  the right neighbor, then the left; closing the final tab keeps the panel open
  on the New launcher. The viewport-fixed panel toggle hides the panel without
  deleting tabs.
- On every platform, opening and collapsing the visible panel change only the
  internal flex allocation; native window bounds remain unchanged. The inner
  divider updates the renderer-owned panel target from 244px upward, capped by
  the live three-column budget, while native window edges resize only the fixed
  application window (ADR 0151).
- No tool result creates or activates a work-panel tab. Review opens only from
  an explicit user action — its `+` launcher row, or the retained context the
  viewport-fixed toggle and `Cmd/Ctrl + J` reveal — so a successful workspace
  Write/Edit never takes the panel away from what the user was reading. Failed
  and scratch writes behave the same. Background-session events update only
  their retained context and never open, activate, resize, focus, or change the
  visible panel.
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
  visible session. A successful workspace artifact cannot create or activate
  the singleton Review tab; it appears only after the user opens it.
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
- Manual delivery (non-AppImage Linux and Windows ZIP runs, or legacy Windows
  portable runs with `PORTABLE_EXECUTABLE_FILE`) stops at `available` and
  offers the fixed GitHub Releases page. In-app delivery (packaged macOS,
  Windows NSIS, and Linux AppImage) automatically advances through
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
- When Main attaches localized product notes for the discovered version
  (`UpdateState.releaseNotes`, D164), the notice and Settings → Info Updates
  row show a compact "What's new" list under the status message. Notes come
  from the shipped-locale changelog catalog selected by the product UI locale
  — never from a renderer-supplied feed or remote URL. Missing catalog entries
  omit the section; locale changes re-resolve notes without a new check.
- Settings → Info keeps a Release notes action available in every updater
  state. It opens a modal over Settings with the complete local stable
  changelog in newest-first order, localized from the same shared catalog.
  The current release and a discovered available release are identified with
  compact badges. The list scrolls independently, closes by its close control,
  Escape, or the backdrop, and restores focus to the invoking control.
- D126 tag releases publish all platform manifests and installers. Packaged
  macOS, Windows NSIS, and Linux AppImage use the in-app lane; Linux deb/rpm
  and Windows ZIP remain notify-and-link delivery modes.

## 2. Streaming message behavior

### 2.1 Token rendering

- Tokens append to the current assistant MessageBubble as they arrive
- Renderer displays runtime stream chunks directly; it does not enqueue a
  second requestAnimationFrame-driven typewriter state loop
- Rendering uses incremental markdown parse — do not re-render the entire message on each token
- Transcript reconciliation keeps completed history in a memoized history boundary;
  token updates do not reconcile each historical row in React while preserving
  the full history for selection, copying, minimap anchors, and accessibility.
- Within the active assistant turn, unchanged activity groups without Task
  delegations also keep their memoized boundary across text updates. Changed
  tool messages still render, and Task groups still receive later lifecycle
  status and completion timing updates from the same turn.
- An unfinished `mermaid` fence remains a source code block. After its closing
  fence arrives, answer prose loads and renders the diagram only when it
  approaches the viewport; thinking disclosures always retain Mermaid source.
- Diagram render failure or the 20,000-character / 500-edge safety limit keeps
  the source visible and copyable instead of failing the assistant turn.
- Cursor indicator: subtle pulsing accent dot or line at the end of streaming content
- Before the first assistant or tool event, the active turn shows one compact
  localized `Working…` status with elapsed time. When the runtime reports a
  quiet interval, that same row names the wait: starting, waiting for the
  model, preparing the next request, compacting context, recovering an empty
  response, retrying a provider request, or waiting for delegated work (with
  each running subagent's latest coarse action). Existing thinking, tool, or
  answer output does not hide the row: the running turn keeps one tail status
  through output pauses. Pending permissions, questions, and plan/goal
  approvals suppress it; terminal turns and history reading have no live row.
- When stream completes: cursor indicator replaced by success state (2s fade)

### 2.2 Auto-scroll

- Opening a session for the first time resets follow mode and positions the
  transcript at its last record before the browser paints its pane. Revealing a
  retained pane restores that pane's own follow state and offset instead: still
  pinned re-anchors to the bottom, scrolled up returns to the same offset.
  Neither path animates through history, and no pane may ever expose the
  transcript top or another session's scroll position.
- A first open whose history exceeds the initial mount budget settles under an
  opaque skeleton veil (D287). The veil is in the same commit as the bounded
  first paint, covers the scroller but not the composer, and lifts only once the
  scroller's `scrollHeight` and `clientHeight` have read the same for three
  consecutive frames, or after a 600ms cap. Every sampled frame re-pins a pinned
  transcript, so the frame the veil reveals is already at the newest turn. The
  minimap and the jump control mount after the veil lifts. Short transcripts
  never show the veil.
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
  working, or checking card is rendered underneath them. A compact runtime
  status row remains in the reserved tail lane for the running turn. It shows
  the runtime phase when known, otherwise Planning/Goal or Working. Text and
  tool rows can stop changing while the turn remains active; their presence
  must not suppress that feedback. User-interaction waits suppress the row.
- A permission card remains visible only when the agent is blocked on an
  explicit approval. It is an actionable interruption, not a progress status
  card.
- Background sessions continue without adding progress chrome to the visible
  session or moving focus. Reduced motion therefore has no progress-card
  transitions to preserve.

### 2.5 Turn outcome closure

- A failed visible turn without a structured assistant error renders one
  session-scoped recovery card after the transcript content. It is based on the
  terminal agent event, not a timeout or a guessed spinner state. If the failed
  turn already contains a structured assistant error, that inline error card is
  the only failure surface and the session-scoped recovery card is omitted;
  users must not see duplicate failure summaries for one turn. Completed turns
  do not add a success card; their existing transcript and message-scoped
  review cards remain the completion evidence.
- A structured inline assistant error can be dismissed from the transcript. This
  hides only its UI card, keyed by message id in renderer runtime state; the
  original UiMessage, host transcript, and database record remain untouched.
  The dismissal survives rerenders and session switches for the current app
  lifetime, and does not add a restore or destructive transcript action.
- Failure copy states that the existing work remains available. The applicable
  failure surface has exactly one **Continue** action and no **Regenerate**
  action. Continue appends the current locale's continuation prompt (`Continue
  the user's unfinished task.` / `继续用户未完成的任务`) to the same session and
  starts a new turn without truncating the failed turn or its completed work.
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

- While a session is running, the composer shows Send when the draft has
  content and Stop when it is empty. Normal Send and Enter-to-send are follow-up
  actions. Accepted follow-ups clear the composer and
  append to that session's Host-owned, persisted FIFO queue; session switching
  never moves or clears another session's queue.
- The queue renders above the composer. Each row has an independently
  keyboard-reachable Remove action and a Send now action once Host admission
  returns a durable id. While admission is pending, row actions are disabled
  with Saving tooltips and a Saving label on Send now; edit/remove leave both
  the queue and composer draft unchanged.
- Send now moves its row to the head and requests the new `agent/stop` channel.
  The current assistant response and completed tool batch finish normally;
  after `agent_end` and durable turn finalization, the promoted row is
  dispatched through the normal `agent/prompt` flow before the remaining rows.
  An idle Send now dispatches immediately. While waiting, promoted rows retain
  Remove and explain that the current task must finish. A refused or failed
  graceful stop reports an error without losing the queued message. Removal
  waits for Host acknowledgement; if delivery wins the race, report that the
  message has already started and direct the user to Stop.
- Without Send now, the next FIFO row starts automatically after the active
  turn completes, fails, or is aborted. A terminal event can arrive before
  persistence releases the session; finalization must wake the queue again
  after releasing ownership. No additional send or session switch is required.
- Abort remains immediate and never clears the queue. Queued prompts survive
  application restart and remain held until a controller attaches (ADR 0213).
  Finalization during application shutdown must not start another queued turn.

### 3.5 Steer the current turn

- `Alt+Enter` submits the visible draft to the current turn immediately. On
  macOS this is `Option+Enter`. It works with Enter-to-send on or off and takes
  precedence over an open autocomplete menu. An idle composer sends normally.
- `Shift+Enter` and `Alt+Shift+Enter` insert a newline. An Enter confirming an
  IME candidate (`isComposing` or key code 229) never sends or steers.
- Steering appears as a user message in the current transcript, clears the
  draft immediately, and reaches the next model request after the current
  response/tool batch. It creates no FIFO row and does not interrupt tools.
- Submission captures the session and current turn identity. If that target
  ends, rejects input, or is awaiting approval, the draft is restored in its
  own session and a concise error is shown. New text typed after submission
  takes precedence over restoration. The running turn is not marked failed.
- File/image chips use the existing attachment checks and the active model's
  capability. Queued configuration changes apply to the next ordinary turn;
  steering keeps the current configuration and sends slash-prefixed text
  literally, without dispatching local mode or extension commands.
- Stop retains all accepted steering input as history. Smart Stop does not
  remove the latest steering row or restore the original prompt over it,
  including after renderer reload. The persisted message marker is the source
  of truth; the renderer does not keep a separate steering registry.
- The Send tooltip identifies follow-up and uses the platform's key labels
  for the steering shortcut (`⌥+Enter` on macOS). The
  existing single Send/Stop slot and Host-owned follow-up list are retained.

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

- Tool activity starts as a lightweight collapsed item row. Failed and denied
  calls keep their issue in the row header and do not auto-expand their payload.
- Both modes give each loaded assistant turn one whole-process disclosure. It
  contains thinking, tools, hosted searches and intermediate progress text; the
  trailing answer, assistant errors and stopped trailing text remain outside it.
- A contiguous activity segment receives a group disclosure only when it has at
  least two mode-visible items. Progress text ends the segment, a singleton uses
  its item disclosure directly, and compact-hidden thinking does not create a
  redundant group. Existing Task topology remains separate.
- Detailed starts active and completed whole processes open. Its active ordinary
  group starts open and closes when it completes only if untouched; completed
  groups otherwise start closed. Compact starts the process and groups closed,
  except an untouched active process with any recorded failed/denied tool remains
  open through recovery and closes on completion.
- In Detailed, leaf auto-open applies only when the literal final item of the last
  activity group is an eligible tool-call or hosted-search row. Failed/denied
  items stay closed, and a final thinking item never causes a backward scan.
  Compact keeps every item payload closed and hides reasoning text/excerpts while
  retaining its active thinking indicator.
- Activating a process, group or item header toggles only that level. Closing a
  parent preserves child state, reopening restores it, and sibling groups remain
  independent. Opening a parent is never an expand-all action.
- A manual item action claims its group and process as user-owned without toggling
  them. Streaming and completion cannot reopen a manual close or close around
  content the user opened, focused or selected. Choices survive mode changes,
  singleton-to-group growth and remounts while the retained session pane lives.
- Search/navigation opens the process and activity group that own the named
  message, once per reveal request. Item-level targeting is not part of this
  change. Compact reasoning requires an explicit switch to Detailed. Closing
  search does not collapse the revealed path.
- Pending permission, question, plan/goal approval and other action cards remain
  reachable outside hidden process content.
- Each disclosure uses its own button, `aria-expanded` and `aria-controls`; closed
  descendants leave the tab and accessibility order. Reduced-motion disables
  non-essential marker and chevron animation.

### 4.3 Tool result truncation

- Per D306 / D194: budgets are per tool class (see [16-tool-result-limits](../03-runtime/16-tool-result-limits.md)). Search/read results cap at 128KB / 4000 lines; Bash stdout/stderr cap at 96KB / 4000 lines with a spill file.
- Read/Glob/Grep report `truncated: true` only when this result was cut short (budget, a clipped line, or remaining Grep/Glob hits). A filled Read window of a longer file is not truncated; `notice` names the next offset.
- Bash markers name which end survived and the spill path, for example `[truncated: kept the first 4000 of 51234 lines; limit 4000 lines / 96KB. …]`.
- Truncated content is never silently omitted — always marked
- Disclosure expansion does not load content beyond the host-enforced cap
- The collapsed-row `truncated` chip follows `details.truncated`

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
   While that turn is live `planning`, the Composer mode chip pulses and a compact
   Planning row occupies the same reserved tail slot as Working until completion
   or pending user interaction. A known runtime phase takes precedence; tool
   and answer output do not hide the running status.
3. The Agent calls `SubmitPlan` or `SubmitGoal` alone in its tool batch.
   Host-core preserves the exact Markdown bytes in a new immutable
   `.pi/plan/*.md` or `.pi/goal/*.md` artifact, records its path/hash/size and structured
   title/question, and the renderer displays the shared contract approval card with
   only the title and artifact opener; the question remains host-side contract data.
   The opener hands that path to the bundled file view when it is launchable and to
   the host file tab otherwise, so the artifact opens beside the conversation in the
   same view the user's other project files use (D452).
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

### 6.4 Icon-only action labels

- Every icon-only action exposes a localized purpose through both its accessible
  name and its hover/focus tooltip.
- Use the shared `TooltipButton` for interactive buttons and `Tooltip` for
  non-button controls. Both render the themed tooltip in a body-level portal so
  it is not clipped by pane overflow or hidden below a neighboring surface.
  Native `title` remains for full-value metadata such as paths, IDs, and
  descriptions; rich hover cards and popovers keep their specialized surfaces.
- Decorative icons remain `aria-hidden` and do not need a tooltip.
- Tooltip text must describe the action, not the icon shape, and must come from
  the active i18n catalog.
- Clicking an action dismisses its tooltip immediately and suppresses it until
  the pointer leaves or focus moves away; keyboard focus still reveals the
  tooltip before activation.
- A tooltip is bound to one live trigger. It closes when that trigger unmounts
  or is detached, when the window loses focus, when the document is hidden, and
  on Escape; a trigger that moves in the DOM within a quarter second without
  being replaced keeps the tooltip instead of blinking it. A tooltip revealed
  by keyboard focus is not closed by unrelated pointer movement, and at most one
  themed tooltip is ever painted, so a pointer crossing between two adjacent
  buttons never shows both. The guard listeners behind this are shared by the
  whole renderer, so a long transcript does not add one listener set per row.


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

Work-panel and application-window resizing are implemented in MVP:

- The 10px inner left-edge separator anchors to the press position and
  starting panel width, then follows pointer delta without jumping. Moving it
  left grows the panel until the shared budget is exhausted; when MainChat
  reaches its 450px minimum the expanded sidebar collapses immediately. Moving
  it right gives space back to MainChat.
- The inner divider's target clamps to the shared three-column budget
  (`client width - 450px - expanded sidebar`, with no fixed pixel cap); pointer movement is
  frame-coalesced and release commits the preferred width. Escape, pointer
  cancellation, and lost capture restore the press-time panel width. A
  double-click restores the default 360px width inside those same live bounds.
- Opening and closing animate the dock's `width` and `flex-basis` together with
  the bounded opacity/transform feedback, so MainChat reflows continuously
  inside the existing client area without crossing its 450px minimum instead of
  changing width before the first motion frame. While `sidebar-out` still
  occupies flex space, the shared budget continues to count the sidebar.
- Reopening a sidebar the layout collapsed spends work-panel width first: the
  panel keeps its width while MainChat stays at or above 450px, and otherwise
  the reopen targets 460px. Closing the panel restores only a sidebar the
  layout collapsed; a manual collapse stays collapsed.
- No panel action requests a positive native reservation: the preferred panel
  width is renderer-local, the native seam stays at zero, and native window
  edges resize only the fixed app window. Background-session artifacts never
  update the visible panel or window geometry.
- The native Browser view still follows the renderer-measured panel rectangle;
  it is detached before collapse motion because it cannot participate in
  renderer CSS animation. Native bounds recovery and persistence continue to
  apply to ordinary window resize/move gestures without panel-specific deltas.

- Preview mode unmounts MainChat and lets the work panel fill the client area
  beside the sidebar. A window-level 46px chrome row keeps New Task, sidebar,
  and native window controls available through a pointer-transparent row that
  declares neither drag nor no-drag across the panel. The panel header's drag
  border box starts after the shell actions plus an 8px gap, including expanded
  sidebar New Task. All platforms use an 8px left inset, except collapsed-sidebar
  windowed macOS (88px). That reserve uses `--ds-window-lead-inset`: the
  traffic-light cluster's 76px right edge (from `@pi-desktop/shared`) plus 12px.
  Native pointer clicks must operate the controls and dragging empty header
  space must move the window; DOM/CDP clicks alone do not establish native hit testing.

The expanded sidebar is user-resizable from 240px to 520px (default 275px) via
the right-edge handle. Pointer motion below 160px collapses the sidebar and
keeps the preferred expanded width. Keyboard Arrow/Home/End resize without collapsing.
Double-clicking the handle restores the 275px default inside the live budget.

Project ordering is implemented for retained project groups. There is no
reorder grip. Pressing the project title and moving 8px starts a project drag,
so a click still activates and toggles collapse, and menus and nested
session rows keep their existing click behavior. A drop inserts before or after
the target group based on the pointer position and persists the result.

Sidebar drag/drop is implemented:

- A session row is draggable while idle. Dropping it on another project group
  moves that session to the project: the host updates only the session's
  project association, and the transcript, attachments, tasks, revisions,
  artifacts, notifications, and scratch data stay with the session.
- A running session is not draggable, and the session menu's project targets
  are not available. The host rejects the move as well, so a turn that starts
  mid-drag cannot leave the agent bound to the previous project's instructions.
- The dragged row paints at opacity 0.5 and the eligible project group
  highlights with an accent outline. A session's own project group is not a
  drop target, so a same-project drag never issues a request.
- Project reassignment is available through the drag/drop interaction only;
  the session context menu does not contain a project list.
- Dropping a folder on the projects list adds it as a project, or switches to
  it when it is already known; duplicate paths resolve to one project row. A
  drop that carries no folder reports why nothing happened.

Native file-system drops into the composer are implemented. The target uses an
accent outline without changing layout; regular files use the session-scratch
reference flow below. A dropped folder is never attached: it raises an explicit
choice between opening it as a project and inserting the literal directory path
into the draft, so an unknown directory tree cannot enter the context.

### 8.2 Project drag/drop contract

Project drag/drop follows these patterns:

- The project title is the reorder control: press and move 8px to arm a drag
- A click with no qualifying movement still selects and toggles collapse
- Touch does not start a reorder so the list can scroll
- An accent insertion line shows before/after placement
- Cancel drag with Escape
- Drag feedback: opacity 0.5 on source
- ArrowUp/ArrowDown on the focused title moves the project one row and
  persists the same manual order without requiring a pointer

## 8a. Composer autocomplete and clipboard files (D123–D125, D197, D209, D262, D362, D397, ADR 0131, ADR 0222)

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
  the row tooltip and accessible name. Accepting a file (Enter/Tab/click)
  replaces the `@` token with an inline sentinel-backed leaf-name chip at the
  caret, backed by the full `entry.path`; that confirmation does not send.
  Accepting a directory keeps the full literal path in the draft so deeper
  completion can continue.

### 8a.2 Reference chips and clipboard files

- Select non-whitespace `text/plain` over accompanying generated `image/*`
  copies only when every file lacks a native path (Word text selection).
  Native files, any non-image file, and image-only/whitespace-plus-image paste
  retain their attachment flow. This uses the existing preload file-path
  resolver and does not reread the system clipboard.
- Selected text stays editable when its character count is at or below the
  persisted `largePasteThreshold` (default 600); larger text becomes a temporary
  session file reference. Small multiline paste preserves blank/trailing lines,
  surrounding text, caret, and native undo; CRLF/CR becomes editor LF. Literal
  HTML remains text: only escaped text and generated line breaks are inserted.
- While bytes are being transferred, the textarea is read-only and exposes
  `aria-busy="true"`; the send and autocomplete controls are disabled.
- Electron main saves bounded bytes under the originating session's scratch
  root and returns unique absolute paths plus sanitized original leaf names.
  The composer leaves visible text unchanged, appends leaf-name reference
  chips in clipboard order, then restores the textarea selection and focus.
- For an oversized text-only paste, the renderer sends the exact UTF-8
  `text/plain` bytes through the same session bridge, inserts a
  sentinel-backed `pasted-text-*.txt` chip at the original selection, and keeps
  a token-to-canonical-path mapping in the draft. Clicking the chip or pressing
  Enter/Space reads the bounded text file and replaces the sentinel in place
  with editable text, removing the reference and placing the caret after the
  inserted content. A failed or unsupported read leaves the chip intact.
  Pasting in the middle of a draft keeps both the prefix and suffix intact.
- If the home composer has no active session, it creates or reuses one before
  writing. Failure leaves the existing draft unchanged and shows the error in
  the normal toast surface.
- A chip remove button removes only that draft reference and restores textarea
  focus; it does not eagerly delete session scratch bytes. Backspace on an
  empty textarea removes the most recent active reference.
- A text/plain or `.txt` chip exposes button semantics and expands on click or
  Enter/Space. The read is bounded by the existing `fsRead` policy; binary,
  image, oversized, or failed reads show the normal error toast and preserve
  the chip.
- A reference-only draft enables Send. Before dispatch, active references are
  appended after visible text and ordinary references are serialized with the
  canonical relative or absolute paths and existing whitespace quoting.
  Pasted references are submitted as structured attachments so the main
  process can choose visual input or the same path fallback from the exact
  model capability. Inline large-paste references are resolved in the visible
  draft instead of being appended or sent as duplicate attachments.
  Successful dispatch clears both; failed or rejected dispatch retains both.
  References are session-scoped and scratch references survive a workspace
  switch while their owning session remains available. Workspace `@` chips
  are relative to the project that produced them and are removed from the
  draft, sentinels included, when the workspace changes.
- When an image reference is active, Composer shows one compact live status
  line. It names visual transport for a model whose pi-ai `input` includes
  `image`, and names the file-path fallback for unknown/non-vision models.
  The status is informational, keyboard-safe, and never relies on color alone.
- A native file-system drop over the Composer prevents the browser's default
  file-open behavior and shows the same accent target outline for the whole
  shell. Regular files are read through the existing bounded paste bridge and
  become removable leaf-name chips in drop order. A dropped folder is not
  traversed or copied; its complete native path is inserted at the caret using
  the literal `@<path>/` directory form so the path remains visible; directory
  tokens without spaces can continue into `@` completion. Mixed file/folder
  drops preserve their order, and the draft/focus/caret are retained across the
  asynchronous file save.
- Accepted dispatch retains an in-memory, session/turn-scoped copy of the
  visible text and structured references only while unanswered smart Stop can
  undo the send. That undo restores the original chip order and labels; it
  never parses serialized `@path` text. Once reply content begins, abort keeps
  the partial transcript and restores no draft.
- After a successful send, the user bubble parses those serialized `@path`
  tokens back into composer-matching leaf-name chips for display only. The
  persisted message and model context stay canonical `@path` text. Clicking a
  chip completes the reference through `pi-desktop/fs/resolveRef`, which
  searches the whole open project — its group's folders, primary first
  (ADR 0263) — and then opens where it resolved: a project file in the bundled
  `pi.file-manager` work-panel view (the host `file:` tab when that view is not
  available), a session-scratch or attachment file in the host `file:` tab, and
  a `.html`/`.htm` page of the project's primary folder in the side browser,
  because the side browser is rooted at that folder. The address handed to
  the work panel follows the folder that answered: a file of the primary folder
  travels as a project-relative path, a file of a sibling folder of the same
  project as an absolute one, exactly as a scratch or attachment file does. A
  chip whose reference matches nothing opens nothing and reports itself, and so
  does a right-click on it: the file-reference menu — offered on every
  reference the transcript renders, a sent `@path` chip, an inline code span, a
  local link, a local image, a tool row's own file path, a path in a tool
  result's file or match list, and an image attachment's thumbnail — shows the
  file in the system file manager through that same completion and that same
  address, and copies that file's full path or its project-relative path. A file
  outside the project has no relative path to copy and says so. The OS default
  application is no longer what this click does, though that action stays
  reachable from the file view's own context menu.
- The same destination rule governs every other surface of the transcript that
  names a file, because one opener serves them all: clicking the file path in a
  tool row's summary (Read, Write, Edit, fetch) and clicking a path in a tool
  result's file or match list both complete the reference the same way and open
  where it resolved (ADR 0262). A tool surface therefore picks no destination of
  its own, and a reference it cannot resolve reports itself instead of opening a
  panel.

### 8a.3 Keyboard while open

- ↑/↓ move the highlight with wraparound; Home/End are left to the textarea.
- Enter / Tab accept the highlighted item; Alt+Enter uses active-turn steering
  instead of accepting a suggestion. Enter and Cmd/Ctrl+Enter never send
  while the menu has a highlighted item (this precedes the Enter-to-send setting).
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
- A pinned transcript re-pins in the same frame the content or the viewport
  changes size, never one frame later. That includes the composer growing under
  a multi-line draft: the bottom reserve is padding on the transcript content, so
  the content is observed on its border box and the newest turn moves up with
  the composer instead of sliding behind it (D287).
- A manual disclosure — whole process, activity group, tool/search/thinking item,
  delegate brief, or error detail — holds the reading position of the scroller
  that owns it (issue #324). Only the initiating level claims the anchor; marking
  ancestors user-owned does not claim their scroll positions. The title is handed
  to the scroller before the state changes, follow mode is left, and the scroller
  restores the title's viewport offset for every frame of the height change. A
  nested scroller (the delegate run dock, D302) holds its own position and passes
  the hold outward because growing it also grows the outer content.
  Search reveal opens the required ancestors at message precision and uses the
  Search reveal opens the required ancestors and uses the precise target as the
  final anchor. Leaving follow for any disclosure is not a re-pin: the transcript
  stays where the reader put it, with jump-to-latest visible, until real scroll
  input, that control, a new turn or navigation releases the hold (D430).
- Scroll input is attributed to the scroller that can consume it. A press on a
  row, a control or an editable field is an ordinary click rather than the start
  of a scroll; a keystroke inside a text field belongs to that field; and input a
  nested scroller consumes is not the outer scroller's gesture. Arrow keys still
  scroll and Space still activates a focused title.
- User send / retry / regenerate: re-pins, hides the jump control, and positions the latest content in the layout phase so the new turn is visible without a top-of-history flash; subsequent persisted and streamed rows continue to follow the bottom
- Scroll-to-bottom button: position fixed at bottom-right of transcript area, offset 12px
- Button appears as soon as upward scrolling releases follow mode
- Click button: scrolls to bottom, resumes auto-scroll
- Button disappears when at bottom
- A delegation tab uses the same single-body scroll owner as the work panel.
  It renders the delegate's conversation — each `Task` call's prompt as a user
  row followed by the delegate's live thinking, tool, and answer rows — in
  normal content flow; it does not mount a nested `.subagent-run-rows`
  workflow scrollbar. While the panel is pinned, new rows stay in view; a real
  upward gesture pauses follow and shows the standard jump-to-latest control.
  This keeps the conversation readable without a second scrollbar or an empty
  tail.
- Clicking a delegation topology node opens (or activates) a dedicated
  `subagent` tab in the work panel instead of expanding the transcript or
  replacing the tab strip. Multiple delegations coexist as independent tabs —
  ten subagents yield ten tabs — with the standard tab affordances (activate,
  drag-reorder, close via ×, middle-click, or Delete, and wheel overflow).
  A tab shows the delegation as a message list: every `Task` call of the
  resume chain renders its prompt as a user row, and the rows the delegate
  produced under that call render with the main transcript's message-list
  language, so a follow-up prompt reads as the next user turn. The tab is
  display-only: a disabled two-row composer sits at the foot with an in-field
  hint that subagents are driven by the main agent and cannot take input; no
  send path exists. At the minimum panel width, long commands, paths, and
  tool summaries wrap inside the committed width instead of expanding the
  panel past the client area.
  A tab is never opened automatically when a delegate starts; only a node
  click opens one. Tabs persist after the delegate settles until the user
  closes them, and they are scoped to their session like every other tab.
  Switching sessions or routes hides the panel; `Cmd/Ctrl + J` toggles the
  whole work panel.

### 9.1a Sidebar project path and open folder

- Hovering or focusing a retained project title shows the full absolute path.
- The truncated project name remains visible in the row; the full path is
  tooltip/accessible-description only and never forces horizontal scroll.
- Right-clicking a project row or opening its overflow menu exposes **Open
  folder** as a project action, along with the project management actions. It
  does not expose project activation; click the directory row to activate it.
  Conversation overflow no longer carries the folder action.
- Choosing **Open folder** opens the project directory in the system file
  manager without changing the active session transcript.

### 9.1b Sidebar session hover card

- Hovering or focusing a session row reveals a multi-line hover card after
  the same 500ms delay used by the project path tooltip; the card never
  anchors to a torn-down row.
- The card surfaces only key metadata, in this order, top to bottom: title;
  a Session task chip when the session was created by another session; the
  mode/permission chip; live status; collaboration details when present;
  the readable model display name (falling back to the provider's readable
  name); workspace name and branch on one row; and **Updated {{when}}**
  without seconds. Temporary/scratch sessions show the localized
  "Temporary" / "临时对话" placeholder instead of a workspace name. The
  card does not show the session UUID, a Local task chip, a separate
  Provider/Model label pair, or the collaboration poll timestamp.
- For a session with host-owned collaboration activity, the card adds a
  bounded collaboration section after the chips: creator/source session
  when present (title, not UUID), current task preview, up to two recent
  exchanges with direction, and terminal result. Created-session
  references remain keyboard-navigable buttons (at most eight), and show a
  localized running indicator only while the referenced session has an active
  runtime; idle, queued, permission, and terminal states add no label. It may
  show a live `running` or `waiting_permission` state for the hovered session,
  but never loads the complete transcript or exposes message content beyond
  the host's bounded preview. Completion and failure results are derived from
  the durable target turn and remain visible after reload.
- Before showing a project session card, the renderer re-reads the active
  workspace through the existing project-read operation. This keeps the Git
  branch current after an external checkout without activating a project or
  changing the selected conversation. If the read fails, the last cached
  branch is used.
- The card is rendered through a portal at `document.body`, never widens
  beyond 320px, and never causes horizontal scroll on the underlying row. It is
  interactive only through its own session links (real buttons with an
  accessible open-session name); the rest of the card is not a control, so a
  click on the card's background never leaks into the row behind it.
- The session row does not set a native `title` attribute. The hover card is
  the only full-title surface, so the browser tooltip never stacks on the
  card.
- The card cancels on pointer leave, focus blur, scroll (any scroll
  container), resize, and the moment a context menu opens.

### 9.1c Session row hover and row actions

- A session row and a project header are each one click target. Their
  hover-revealed actions (the row overflow control, the header's add and menu
  controls) are inert while hidden: the space they occupy before they appear
  never swallows a click that belonged to the row. A click in that space opens
  the conversation, or activates and toggles the project group, exactly as a
  click on the title does; a no-hover pointer gets the controls revealed so it
  never meets a hidden target.
- Project headers and conversation rows (project, pinned and standalone) use
  the same full-row hover surface, radius and transition. The title button is
  transparent; hover never draws a nested title tile. The selected conversation
  keeps its selected fill on hover. A current workspace uses only the project
  dot, not another selected background; folding a selected child or leaving the
  chat page never promotes its project to a selected navigation item.
- Keyboard focus keeps its outline independently of selection. The add and
  overflow buttons retain local hover feedback, and drag-target paint takes
  precedence over ordinary header hover.
- Hover paint belongs to the pointer that caused it. When the window loses
  focus the row and the project header drop their hover background and their
  revealed actions hide, so nothing is left lit or armed after the window
  returns; moving the pointer over the row again re-arms it.
- Revealed actions become clickable the moment the row is hovered or focused,
  and remain reachable through keyboard focus (`:focus-within` /
  `:focus-visible`) without a pointer. A spelled-out control never triggers the
  row or header underneath it as well.
- The hover card's own navigation controls are the only interactive surfaces
  inside the card; the row keeps receiving pointer events everywhere else on
  it.


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
- Resize observers never synchronously measure every transcript row from their
  callback. The one synchronous action they may take is the bottom re-pin of a
  pinned, visible transcript (a single `scrollTo`), because a frame requested
  from inside the callback lands after the current frame has already painted
  the grown content unpinned (D287).

## 11. Acceptance criteria

1. All keyboard shortcuts in §1 are functional and do not conflict with system shortcuts
2. Enter sends when Enter-to-send is on; when it is off, Cmd/Ctrl+Enter sends and Enter/Shift+Enter insert a newline
3. Abort immediately cancels running turn and pending permissions without confirmation dialog
3a. Send stays enabled while running, queues prompts per session, and Send now
    finishes the current boundary before releasing its prioritized prompt
4. Long content (>50 lines for messages, >10 for args, >20 for results) is collapsed by default with expand link
5. Tool results that were cut short show a truncation marker or chip per D306; a filled Read window of a longer file does not
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
    send/abort button. New Task reveals the empty destination on the first
    frame rather than leaving the previous transcript visible until host IO
    completes.
10. Focus rings visible on `focus-visible` only, 2px accent offset 2px
11. Command palette traps focus; Escape returns to previous focus
12. All animations respect `prefers-reduced-motion: reduce` — state changes are instant, no decorative motion
13. Project/session rows support non-destructive pin/archive, independent
    project collapse, project drag/manual reorder, and the documented
    user-facing sort modes
14. Shell chrome does not create accidental text selections, while editable
    controls and transcript/code/tool content remain selectable and copyable
15. Retained project tabs survive restart; activating one changes the selected
    shell workspace without redirecting background session tool roots
16. Project groups can be reordered by dragging the title or with
    ArrowUp/ArrowDown on that title; the normalized-path order survives a
    renderer restart and does not change the host workspace identity
17. Completed and failed turns appear exactly once in the durable inbox;
    aborted turns never appear
18. All/Unread, mark-all-read, clear, row activation, Escape/focus restore, and
    arrow/Home/End keyboard navigation behave as documented in §1.7
19. Native task notifications appear only while the main window is unfocused;
    interactive prompt notifications may alert for a focused background session.
    Activation focuses the window and opens the corresponding session
20. Streamed message updates stay within the chat render boundary; shell
    navigation, composer, completed rows, and work-panel content do not rerender
    solely because the current assistant message appended content
21. The work panel opens and collapses inside the fixed client area; the inner
    divider follows the shared budget while MainChat keeps its 450px minimum,
    the expanded sidebar yields at the threshold and returns when the panel
    closes, and divider cancellation restores the prior panel width
    (ADR 0033 / ADR 0151 / ADR 0238)
