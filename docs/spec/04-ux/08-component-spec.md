# 08. Component Spec

> Layout and IA reference: [01-ui-ia.md](01-ui-ia.md)  
> Design tokens and foundations: [07-ui-design-system.md](07-ui-design-system.md)  
> Interaction behavior: [09-interaction-patterns.md](09-interaction-patterns.md)


> Shell layout is Codex-aligned: left thread sidebar (240–520px, 275px by default), main transcript, floating bottom composer with runtime mode/permission/model controls, and a compact action-only top bar. Prefer neutral charcoal surfaces over blue-slate chrome.
>
> **Precedence rule**: where a metric or copy string below disagrees with a
> Codex parity decision in [decisions-log §D](../08-meta/decisions-log.md)
> (D034+), the decision log wins — it tracks the live gold captures. Known
> updated values: sidebar 240–520px (275px default), toolbar 46px (not 44px),
> composer placeholder per D094/D066, home empty stack and bottom composer per
> D111/D204/D206,
> Projects index table per D066/D133, settings full-page shell per D063 with the
> compact eight-destination directory from D090/D133/D166, and retained path-keyed
> project groups per D093 (which preserves D088's Temporary/exact-path boundary
> while restoring scoped project and conversation organization actions), and
> product branding/icon contract per D094/D160.

## 1. AppShell

### 1.1 Purpose

Outer frame that positions Topbar, Sidebar, MainChat, and WorkPanel. Owns resize logic, responsive collapse, and theme class.

### 1.2 Anatomy

```text
+------------------+------------------------------+------------------+
| Sidebar          | MainChat                     | WorkPanel        |
| (240–520px / 48px) | (flex-1)                   | (244–720px /     |
|                  |                              |  hidden)         |
+------------------+------------------------------+------------------+
| Titlebar row: 46px, traffic lights at {x:16,y:16} (D034/D070)      |
+--------------------------------------------------------------------+
```

### 1.3 States

| State | Behavior |
|---|---|
| Default | Sidebar expanded, work panel hidden |
| Narrow (<640px) | Sidebar auto-collapses to icon rail |
| Constrained work area with panel open | Work panel keeps its fixed committed width; MainChat absorbs any reservation shortfall |
| Fullscreen | Topbar remains; sidebar toggle and artifact-driven panel stay available |

### 1.4 Interactions

- Sidebar toggle: keyboard shortcut + icon button beside Search in the expanded
  sidebar header; the button moves to the main titlebar while collapsed. The
  collapse and expand use a mounted-then-animated dock transition (entrance
  `sidebar-in`, exit `sidebar-out` keyframes) that mirrors the work-panel dock:
  the aside stays in the tree through the exit keyframe, then unmounts
  (`is-exiting` flag + `animationend` guard, with a timeout fallback)
- Sidebar width resize: the right-edge `separator` handle follows horizontal
  pointer movement from the press position, clamps to 240–520px, and commits
  the preferred width on release. `Escape`, pointer cancellation, and unmount
  restore the press-time width. The focused handle supports ArrowLeft/Right
  (16px steps), Home, and End, and exposes the current width through ARIA.
  The 8px edge hit area stays transparent when the sidebar body is hovered;
  direct handle hover reveals only a centered compact marker, while focus and
  active dragging use the accent marker without changing layout.
- Work panel collapse: sole control lives in the session pane titlebar top-right
  while the panel is open, with its outer edge flush against the divider
  between the session pane and work panel so the work-panel content header is
  not occupied. On
  Windows/Linux, opening the work panel removes the main titlebar's native
  window-control clearance because those controls occupy the work-panel header
  at the outer window edge.
- Work panel resize: inner left-edge handle changes the base chat width; the
  outer right native edge changes the panel width (§5.4)
- Window resize: the outer right edge and right corners change the open work
  panel target while preserving MainChat width; the inner divider changes the
  MainChat target while preserving the panel width. Other native edges and
  corners change MainChat width only; responsive layout follows
  [07-ui-design-system.md](07-ui-design-system.md) §10.1

### 1.5 Accessibility

- Landmark roles: `<nav>` for sidebar, `<main>` for chat, `<aside>` for work panel, `<header>` for topbar
- Tab sequence: topbar → sidebar → main chat → work panel → composer

### 1.6 MVP constraints

- Sidebar width is adjustable from its right-edge handle within 240–520px
  (275px default), persists across launches, and remains independent from the
  collapsed icon-rail state; the work panel remains adjustable from its own
  divider
- The main pane renders one active transcript and one selected workspace while
  the sidebar may retain several project tabs/groups
- Sidebar and work-panel dock transitions animate their flex allocation as well
  as opacity/transform feedback, so MainChat reflows over the motion duration
  rather than jumping before the first painted frame.
- `AppShell` owns low-frequency shell/navigation state only. Streamed
  `messages`, active-turn rendering, inline chat errors, and active permission
  projection are subscribed inside a memoized `ChatSurface`, so a token update
  cannot rerender Sidebar, WorkPanel, window chrome, global dialogs, or toasts.
- Session selection exposes the destination row immediately, coalesces hover/
  focus prefetches, and keeps at most five recently visited transcripts in
  renderer memory. Transcript IO and required workspace alignment may run in
  parallel; navigation generations ensure that only the newest selection can
  project session, workspace, messages, and work-panel context.
- `ChatSurface` mounts one `SessionPane` per retained session, keyed by session
  id and bounded to three panes (the visible one plus the two most recent). Each
  pane owns its transcript DOM, scroll position, and mounted-row window for its
  lifetime, so a switch is a visibility swap rather than a rebuild. Inactive panes
  stay mounted but are hidden with `visibility: hidden` +
  `content-visibility: hidden` — never `display: none`, which would destroy the
  layout box and its scroll offset — and are `aria-hidden` and non-interactive.
  Evicting a pane makes its session behave like a cold open on the next visit.
- A pane renders the store's live `messages` while its session is the active one
  and its retained snapshot otherwise, so no pane can show another session's rows.
  While a session is running, its renderer-owned live cache is the lower-water
  mark for revalidation: a durable `session.get` result may add newer completed
  rows but must not erase an in-flight assistant/tool tail. Deleting a session
  releases its pane, snapshot, and live cache.
- While a destination with no retained pane is resolving, `ChatSurface` keeps the
  visible pane on its own session, exposes `aria-busy`, and shows a 2px progress
  track; the destination pane is revealed only once it has committed. A warm
  destination is revealed with no busy affordance at all. Nothing is dimmed and no
  skeleton-to-transcript animation is inserted (ADR 0137).
- Settings, Plugins, Pull requests, and Scheduled are route-level lazy modules.
  Chat and shell chrome stay in the initial renderer bundle; first entry to a
  secondary destination shows a compact localized status indicator until its
  local chunk resolves.
- No status bar (deferred)

### 1.7 Platform application chrome

| Platform | Top-level chrome | Application menu |
|---|---|---|
| macOS | Native inset traffic lights at `{x:16,y:16}`; expanded sidebar Search and Collapse controls share the row at right, with no logo/title; open work-panel collapse sits in the session pane top-right | System menu: PI-Desktop, File, Edit, View, Window, Help |
| Windows | Frameless 46px titlebar; sidebar actions at left, open work-panel collapse in session pane top-right ahead of minimize/maximize/close | None inside the window |
| Linux | Frameless 46px titlebar; sidebar actions at left, open work-panel collapse in session pane top-right ahead of minimize/maximize/close | None inside the window |

- macOS enables the native Electron `vibrancy: "sidebar"` material with
  `visualEffectState: "followWindow"` and a transparent window backing. Only the
  `.sidebar` and any rendered `.sidebar-rail` surface use a restrained,
  theme-derived translucent tint with a 1px edge seam. `.main-pane`,
  `.main-titlebar`, and `.conversation-topbar` remain opaque `bg-primary`
  surfaces, so vibrancy does not spread across the whole window. Windows/Linux
  retain their existing opaque background and frameless behavior.
- The macOS system menu exposes New Task, Open Project, Settings, Command
  Palette, Sidebar, standard editing, zoom/fullscreen, window, Help, Logs, and
  Check for Updates actions. Windows/Linux expose equivalent product actions
  through in-app controls and keyboard shortcuts, with update checks in
  Settings -> Info.
- When Settings -> Info -> Developer mode is enabled, the macOS View menu
  additionally exposes the native developer-tools role. All platforms expose
  F12, and Windows/Linux also expose Ctrl+Shift+I; the commands and Settings
  Open console action are unavailable while the mode is disabled.
- Window buttons have localized tooltips and accessible names. The maximize
  glyph reflects the initial native state plus later maximize/unmaximize
  events. Each Windows/Linux button is an explicit non-drag pointer target so
  the surrounding titlebar drag region cannot consume minimize, maximize,
  restore, or close clicks. Their shared 112×46px control band is opaque
  `bg-primary`, preventing destination content from bleeding through the
  reserved titlebar surface. The band uses the same 1px `border-subtle` rule
  on its leading and bottom edges as the adjacent titlebar, completing one
  continuous chrome separator rather than introducing a stronger box seam.
- Minimize uses the platform's normal window model: Windows/Linux renderer and
  native-menu actions call native minimize and keep the taskbar entry, while
  the macOS traffic light/Window menu role remains tray-resident. Clicking a
  focused Windows taskbar button also uses native minimize; a second click
  restores/focuses the same window, while clicking a covered window brings it
  to the front. Tray activation restores and focuses tray-hidden windows; Quit
  remains explicit. On macOS the tray uses a transparent monochrome template
  of the PI mark rather than the rounded application tile, so it remains
  readable in the menu bar.
- Windows/Linux do not render File/Edit/View/Window/Help in the titlebar and
  do not reserve left-side space for an application menubar. F10 and
  Shift+F10 remain available to focused content.
- macOS native commands that create or reload a window wait for the renderer's menu
  subscription acknowledgement instead of relying on a timing delay.
- Plugin panel windows use the same strict 46px drag-band metric on every
  platform. All three use a frameless window with one minimal fixed top-right
  capsule containing minimize, maximize/restore, and close. The capsule stays
  inside the 46px band; the band is not clickable outside the capsule, and
  development panels show a localized reminder. The host renders no title;
  the plugin owns its title, toolbar, and all other visible content. The
  transparent band supports light/dark page appearance and reduced motion,
  stays isolated from plugin styles in a closed Shadow DOM, and exposes
  `--pi-plugin-titlebar-height: 46px` for fixed/sticky plugin content.
  Plugin-owned toolbars may opt into `-webkit-app-region: drag` while their
  interactive controls use `no-drag`.

---

## 2. Topbar

### 2.1 Purpose

Global controls bar: task title and window actions. Project scope remains
available in the title tooltip. The active session's Agent/Plan/Goal control and
model selection belong to the Composer. (Settings is reached from the command
palette / application menu, not the top bar.)

### 2.2 Anatomy

```text
[☰ Sidebar] [Task title]                          [＋ New] [🔍 Search]
```

(Icons described functionally; actual render uses Lucide SVGs. The `[☰ Sidebar]`
toggle renders **only when the sidebar is collapsed**; when the sidebar is
expanded it owns that control, so the top bar does not duplicate it.)

The conversation top bar renders for the chat route only; Pull requests, Scheduled,
Plugins, and Settings keep the frameless drag band. It owns the task title and
window actions only. Project scope remains in the title tooltip instead of adding
another visible label. The Composer owns the Agent/Plan/Goal control and the
combined model × reasoning selection (§11).

### 2.3 Layout

- Height: `--ds-toolbar-height` (46px; Codex toolbar rhythm, D034; supersedes
  the old 44px)
- Background: bg-primary for the conversation bar and every route-owned
  frameless drag band
- Border: border-subtle bottom on every route-owned titlebar surface
- Position: absolute 46px frameless band; `-webkit-app-region: drag` with
  `no-drag` on interactive controls; macOS reserves the left ~76px for traffic
  lights (only when the sidebar is collapsed), Windows/Linux reserve the right
  120px for native window controls (112px hit targets plus an 8px visual
  buffer from adjacent work-panel actions)
- Title cluster (task title) flexes and shows at most the first 10 Unicode
  characters plus an ellipsis; the full title remains in the native tooltip.
  The right cluster (action icons) is `flex: 0 0 auto`
  and is never squeezed by a long title. The conversation surface keeps a
  `min-width` so its content is not crushed on narrow windows.
- Project scope is available from the title tooltip but is not rendered as a
  second visible label.
- macOS fullscreen resets the left reserve to 8px (mirrors the sidebar header).
- Sticky: `z-sticky`
- Items: left-aligned controls, right-aligned actions
- Shell consistency: the chat topbar, non-chat drag band, Settings drag band,
  sidebar header, work-panel header, and native window-control band all use
  `--ds-toolbar-height`. Windows/Linux keep the same `--ds-window-controls-width`
  reservation so the right boundary and native controls stay aligned when the
  route or work panel changes; the control band continues the titlebar's
  `border-subtle` bottom rule and uses the same token for its leading divider.
- Band reservation is platform-independent (D269). The band is opaque and
  absolutely positioned, so scrolling route content passes underneath it on
  every platform, macOS included. Every route surface that starts its own
  content at the top edge reserves the band: the transcript
  (`.thread-content`) and the destination-page frame (`.page-frame`, shared by
  Plugins, Scheduled, and Pull requests) both pad by `--ds-toolbar-height`.
  Without that reservation a page header renders behind the band and its title
  row is clipped. Only surfaces that stack above the band (the plugin detail
  sheet at `z-index: 60`) may skip it.

### 2.4 States

| Element | Default | Running | Error | No workspace |
|---|---|---|---|---|
| Task title | session title (or untitled), capped at 10 characters with an ellipsis when needed | same | same | same |
| New task / Search | icon buttons | same | same | same |
| Composer stop control | hidden | visible only when the running composer draft is empty | hidden | hidden |
| Project name | title tooltip only | same | same | omitted |

### 2.5 Accessibility

- Every control is keyboard-reachable with Tab
- Composer stop control has `aria-label="Stop generating"`
- The topbar does not render a separate running-state indicator; the Composer
  submit control and transcript working feedback remain the running-state cues.

### 2.6 MVP constraints

- No search field in topbar (deferred)
- Notification history is the bounded D117 inbox; scheduled reminders,
  permission-request notifications, and notification preferences remain out of
  scope

---

## 3. Sidebar

### 3.1 Purpose

Scoped project and session navigation, management, and notification access. The
expanded sidebar shows path-less conversations first under a compact `Sessions`
heading and retained project tabs under a following `Projects` heading; the
collapsed state is an icon rail. Retained tabs are renderer presentation state,
not additional host workspaces.
The sidebar body is reserved for Sessions and Projects; the footer exposes the
Plugins destination beside Settings. Projects is managed through Settings →
Project archive, while Pull requests and Scheduled are not rendered in the
sidebar.

Section-level create and sort controls stay visually quiet at rest and reveal
when the owning Sessions or Projects toolbar is hovered or keyboard-focused.
Project-group `+` and overflow controls follow the same hover/focus treatment;
their hit areas remain in the layout so revealing them does not shift labels.

### 3.2 Anatomy

```text
Expanded (~275px, D034/D070):
+---------------------------+
| [lights]          [⌕][◧] |  macOS
| [π] PI-Desktop    [⌕][◧] |  Windows/Linux
| SESSIONS         [msg+][↕]|
|   • Path-less session   ↕|
| PROJECTS            [dir+]|
| [v] project-A      [+] … |
|   • Project session      |
| project-B      [>] [+] … |
|                           |
| [⚙][plug][bell]          [version]|
+---------------------------+

Collapsed (48px):
+----+
| ──  |
| ses |
| ses |
| ──  |
| [⚙][plug][☾][bell] |
+----+
```

### 3.3 Typography

Primary left-rail chrome stays body-sized so destinations remain readable next
to the 14px chat body. Session and project/group titles use the adjacent compact
tier; weight, indentation, and disclosure icons preserve their hierarchy:

| Surface | Token | Notes |
|---|---|---|
| Footer action icons | `--text-base` (14px) | Settings, Extensions, notifications; left side of footer |
| Session / thread titles | `--text-md` (13px) | Compact list content |
| Project / group titles, empty copy | `--text-md` (13px) | Hierarchy comes from weight and indentation |
| Section labels (`SESSIONS`, `PROJECTS`) | `--text-sm` (12px) | Uppercase secondary labels |
| Footer profile name + profile menu items | `--text-base` (14px) | Identity cluster matches nav body |
| Footer status / version | `--text-sm` (12px) | Right-aligned build/version chip |

Do not render primary sidebar list content below `--text-md`. Keep row heights
(≈28–32px) so density stays WorkBuddy/Codex-like while primary actions remain
visually distinct from list content.

### 3.4 States

| State | Behavior |
|---|---|
| Expanded | Full session titles visible |
| Sidebar resizing | Right-edge handle is active; direct hover/focus reveals a compact marker, pointer movement previews width, and release commits it |
| Collapsed | Icon rail — hover shows tooltip with session title |
| Active session | Accent-blue outlined status ring plus active row background |
| Selecting session | Destination row receives the active treatment immediately while transcript/workspace resolution continues |
| Session in progress | Orange breathing dot; static under reduced motion |
| Session completed | Green check mark from the latest unread task notification when the row is not selected |
| Session failed | Red circled alert mark from the latest unread task notification when the row is not selected |
| Hover session | bg-tertiary background |
| Active project | Header carries active state; topbar follows that workspace; composer exposes no workspace identity |
| Collapsed project | Header remains visible; child conversations are hidden |
| Archived row | Hidden by default; visible in the explicit archived view |
| No retained project | Compact Open project entry; standalone Sessions rows remain available |
| Empty group | Muted one-line empty state; group create action remains available |
| Footer idle | Transparent 58px band; build and action controls remain visually quiet |
| Footer hover/focus | Only the targeted control receives the semantic hover/focus treatment |
| Profile menu open | Profile trigger is active; 280px menu opens 8px above the footer |

### 3.5 Interactions

- Click the project directory row (chevron, folder, label, or remaining
  disclosure hit area): activate its path when necessary, then toggle only
  that project's conversation group; retain the other project groups
- Click session: activate its bound project when necessary and switch the active
  session. A destination that still has a retained pane (warm switch) is revealed
  immediately with its own content and its own scroll position, so the first
  painted frame is already correct — no dim, no skeleton, no transcript remount.
  If that destination is still running, the warm frame uses its latest
  renderer-owned live snapshot and later durable revalidation cannot roll the
  partial reply back. A destination with no retained pane (cold switch) leaves
  the currently visible
  pane showing its own session until the destination commits; only a thin
  progress track marks the wait, and the composer stays non-interactive until the
  visible pane is the active session. No transcript is ever dimmed, and no stale
  transcript is relabeled with the destination session id. First activation of a
  session settles at its newest turn without flashing the transcript top; a
  revisited pane returns to the position the user left, and a pane still pinned
  re-anchors to the bottom (ADR 0137).
- Hovering a session row for 120ms or keyboard-focusing it starts one coalesced
  transcript prefetch. Selection reuses an in-flight or recent cached result,
  revalidates it in the background, and never waits for an older superseded
  session read before starting the latest read.
- On Windows/Linux, click the PI-Desktop brand to return the main pane to the
  chat home while preserving the active conversation and workspace; macOS
  intentionally omits this brand control from the sidebar header
- Click the footer Plugins icon immediately right of Settings to open the
  Extensions destination; the icon exposes the localized label on hover/focus
- The footer action group stays on the left and the build/version chip stays
  right-aligned; clicking the chip checks for updates or opens the available
  release in Settings
- Click Search or Collapse sidebar at the right of the header row to
  open global search or collapse the sidebar respectively
- Drag the expanded sidebar's right edge to adjust its width. The main pane
  reflows continuously, the press position remains anchored, and the final
  width is saved on release. Focus the edge handle and use ArrowLeft/Right,
  Home, or End for keyboard resizing; Escape cancels an active pointer resize.
- While the work panel is open, click the session-pane top-right panel collapse
  control to hide the panel without deleting tabs; the work-panel header keeps
  only dynamic tabs
- Click the `Projects` heading folder-plus action: open the project picker and
  retain the selected project
- Right-click the `Projects` heading or empty project-list chrome: open a
  single-item create menu that runs the same new-project picker action
- Click project `+`: activate that project, then select its most recent empty
  session or create a durable empty session bound to its exact path
- Click the `Sessions` heading message-plus action: clear the workspace, then
  select the most recent empty temporary session or create a durable empty one
- Sessions and Projects heading actions reveal together when their toolbar is
  hovered or keyboard-focused; the controls remain keyboard-reachable while
  visually hidden at rest
- Right-click the `Sessions` heading or empty standalone-list chrome: open a
  single-item create menu that applies the same temporary-group reuse rule
- Project overflow: switch, open folder, pin/unpin, archive/restore, close
  retained tab. Open folder reveals the project directory in the system file
  manager for the selected project row.
- Conversation overflow: pin/unpin, archive/restore, Create branch, delete.
  Create branch is disabled while that conversation is running; success
  activates the independent child session and focuses the composer.
- The `Sessions` toolbar places the sort button before the message-plus New Chat
  control. The sort menu and every other body-level sidebar menu remain
  content-sized and open 4px to the right of their trigger or pointer. Their
  left edge never flips to the trigger's left side; the surface has a viewport
  width cap for narrow windows. The sort choices remain Recently updated,
  Created date, Oldest first, and Name; pinned rows stay ahead of unpinned rows.
  A stored `manual` compatibility value requires no drag-reorder UI.
- Project groups use compact vertical spacing so adjacent directories and
  conversation rows read as one dense navigation list rather than detached
  cards. Directory `+` and overflow actions remain hidden until hover or
  keyboard focus, without changing the directory label's position.
- Sidebar toggle: expanded-header icon beside Search + keyboard shortcut; the
  collapsed main titlebar retains an Expand sidebar icon; when the work panel is
  open, the session-pane top-right hosts the sole panel collapse control
- Click the local profile trigger: open or close the identity menu containing
  Settings, Logs, and Theme
- Click the footer bell: open or close the durable notification inbox

### 3.6 Accessibility

- Projects and Sessions headings have localized names; each disclosure and
  create action has a scope-specific accessible name
- Under `lang=zh-CN`, section labels keep normal tracking and skip
  `text-transform: uppercase` so two-glyph labels are not letter-spaced apart
- Session groups use semantic `section` containers
- Active session: `aria-current="true"`
- Every visible session indicator has a localized accessible name and tooltip;
  color is reinforced by ring, dot, check, or alert geometry
- Project directory rows expose `aria-expanded` and `aria-controls`; menu
  check/radio items expose `aria-checked`
- Hover-hidden section and project actions remain in the tab order and reveal
  through `:focus-within`; keyboard focus never depends on pointer hover
- Collapsed state: each icon has `aria-label` with session title
- Keyboard: arrow keys navigate session list
- Footer Settings, Plugins, and notification controls expose localized
  accessible names and visible focus treatment
- The profile trigger exposes `aria-haspopup="menu"` and its expanded state;
  the menu has a stable accessible relationship to the trigger
- The notification trigger has a localized accessible name containing the
  unread count, exposes `aria-expanded`/`aria-controls`, and never relies on
  the badge color alone
- Profile and notification popovers portal to `document.body` with fixed
  positioning so the main chat pane cannot paint over them; work-panel tool
  context menus and the Settings font picker menu use the same body-level
  floating layer (the font menu is measured against its trigger, clamped to
  the viewport, and flips above the trigger when there is no room below);
  the font list is windowed (fixed row heights with absolute positioning,
  overscan buffer, and an exact-offset scroll-into-view, mirroring the
  virtual-scroller pattern DBX uses for its data grid) so only the visible
  slice of a long system list is ever in the DOM, and the menu reposition
  handler ignores scrolls inside the list, keeping the picker responsive when
  opened and scrolled


### 3.7 Brand and icon contract

- The visible shell name is `PI-Desktop`; Codex is not used as the renderer
  identity.
- `BrandLogo` imports the renderer-sized marks derived from the canonical
  masters through Vite: `src/assets/brand/logo-light.png` for light mode and
  `src/assets/brand/logo-dark.png` for dark mode (192x192, covering the 64 px
  splash at 3x; ADR 0125). The component subscribes to
  `document.documentElement[data-theme]` via a `MutationObserver` and swaps the
  source at runtime for the sidebar and startup splash without a reload. The
  empty-home hero uses `HomeMascotLogo` as a 100px inline SVG. The neutral
  agent mark combines a thin orbit and signal point with a compact core,
  antenna, face, and feet. The orbit rotates slowly, the core breathes gently,
  and the eyes blink occasionally. The motion is deterministic and does not
  change on pointer hover; reduced motion freezes all three effects. The
  expanded/collapsed sidebar remains 20px/18px and the startup splash 64px.
  Home and thread-docked composer prompt rows do not render a leading brand
  icon.
- Project and Temporary session creation controls render the dedicated
  message-plus session icon. Generic
  `IconPlus` remains reserved for adding non-session entities.
- Icons are decorative when a localized text label or accessible name is
  present; click, keyboard, and focus behavior remain unchanged.
- The expanded sidebar brand is a localized button with a 20px logo and the
  shell name on Windows/Linux; pointer or keyboard activation navigates to the
  chat home. macOS hides this brand and right-aligns Search then Collapse
  sidebar in the same 46px row as the native traffic lights. Fullscreen keeps
  the brand hidden while reclaiming the native-chrome padding.

### 3.8 MVP constraints

- Expanded sidebar search filters the visible session tree in place; the
  collapsed rail continues to use the global command palette
- No drag-to-reorder contract; `manual` is a persisted compatibility value
- Project tabs do not create another host workspace or a second main pane

### 3.9 Project group contract

Each retained project is one labeled `section` keyed by normalized full path.
The header owns project-level controls; the child list owns conversation-level
controls.

| Element | Contract |
|---|---|
| Group root | localized project name; hover and keyboard focus expose the full path in a portaled tooltip plus an accessible description without changing row geometry |
| Directory disclosure | single full-row target with `aria-expanded` / `aria-controls`; may activate an inactive project before toggling, but never archives |
| Project pin | presentation priority only; no host row deletion/move |
| Project archive | omitted from default view; restorable from archived view |
| Project close | removes retained tab only; durable project/sessions remain |
| Session list | exact-path matches only; no basename grouping |
| Active group | exactly one group reflects the selected host workspace |
| Task state | In-progress, selected, completed, and failed indicators update by session without replacing the visible transcript; precedence is in-progress, selected, then terminal outcome |

### 3.10 Local profile footer contract

The expanded sidebar ends with a WorkBuddy-inspired local identity cluster.
It borrows the compact avatar-and-actions grammar without implying a cloud
account, subscription, or collaboration backend.

| Element | Contract |
|---|---|
| Footer band | `58px` high, transparent, no top separator; remains outside the scrollable project/session region |
| Profile trigger | `44px` high, flexible width, rounded hover target; opens the profile menu |
| User glyph | `30px` circular local-user glyph; decorative when the text label names the control |
| Identity copy | Primary `Custom`; secondary `Local profile` or localized `本地配置`; two lines truncate independently |
| Chevron | Trailing disclosure indicator; reflects the menu's open state without motion when reduced motion is requested |
| Notification shortcut | Separate `32px` square Bell target with unread badge; opens the durable inbox above and to the right of the footer |
| Profile menu | `280px` wide, bottom anchored `8px` above the footer; opaque elevated surface |
| Identity header | Repeats the glyph and two-line local identity; non-interactive |
| Menu actions | Divider, then Settings, Logs, and Theme in that order; Theme retains its current-value metadata |

---

## 4. MainChat

### 4.1 Purpose

Primary chat area containing ChatTranscript and Composer. Scrollable, center of the workstation.

### 4.2 Anatomy

```text
+--------------------------------------+
| ChatTranscript (scrollable, flex-1)  |
|   MessageBubble (user/assistant)     |
|   ToolCallCard                       |
|   TurnOutcomeCard (one Continue)     |
|   InlineReviewCard · M App.tsx +8 −2 |
|   PermissionCard                     |
|   ...                                |
+--------------------------------------+
| Composer (docked in thread view;     |
| bottom-reserved on empty home, D204) |
+--------------------------------------+
```

### 4.3 Layout

- Background: bg-primary
- Max content width: 720px (messages), centered
- A failed TurnOutcomeCard exposes one primary **Continue** action and no
  regenerate action. It appends the current locale's continuation prompt to the
  same session and starts a new turn, preserving the failed turn and completed
  work in the transcript.
- Scroll behavior: auto-scroll to bottom on new message while pinned; the first
  upward manual movement pauses auto-scroll without a snap-back; send / retry /
  regenerate re-pins and positions the latest content during the layout phase,
  before the next painted frame, then keeps following streamed content
- Follow release is gesture-gated: only scroll events preceded by a user
  scroll input (wheel / trackpad / touch / scrollbar / keyboard) release
  follow. Layout clamps that fire after a follow `scrollTo` — the composer
  collapses when the draft clears, indicator rows mount or unmount — are
  re-baselined and never cancel follow, so a pinned send stays at the latest
  turn even when the bottom reserve changes mid-turn
- Destination entry uses one short opacity/translate transition. Streaming
  updates occur inside the mounted surface and never replay this transition.
- A pane bounds its own first commit to the newest entries and mounts the
  remaining history on the next frame. Because the first commit belongs to one
  pane, it happens when that session is first opened, not on every switch back to
  it. Both commits must present the transcript at the same position, and the
  expansion re-anchors the bottom during its own layout phase; correcting a
  guessed height after paint is visible as the transcript jumping, so it is not
  permitted. A user who scrolls up during the bounded frame keeps that position,
  and the pane keeps it across later switches. When the first commit is bounded,
  an opaque skeleton veil covers the scroller from that same commit until the
  scroller geometry has held still for consecutive frames (600ms cap), then
  fades out; the composer stays visible and usable above it (D287).
- The transcript's bottom reserve is **height-aware**, not a fixed gap. The
  docked composer measures its real rendered height (it grows with multi-line
  drafts) and publishes it as the `--composer-dock-height` custom property on
  `:root`; `.thread-content` reserves `calc(var(--composer-dock-height) + 16px)`
  so the last message sits ~16px above the box and is never overlapped even as
  the draft grows. `.jump-latest-btn` and `.minimap-rail` anchor to the same
  variable so they stay just above the composer.

### 4.4 States

| State | Behavior |
|---|---|
| Empty | Restrained hero + optional onboarding checklist in a scrollable content region, with a bottom-reserved home composer and no starter-card or contextual quick-action layer (D111/D204/D206) |
| Streaming | Auto-scroll follows while pinned; new tokens append |
| Active progress | Immediately after send, before the first assistant or tool event, a compact localized `Working…` status with elapsed time appears inline. It yields to concrete thinking, tool, and answer rows, while a permission card owns the approval state; no large generic progress card is rendered. |
| Turn outcome | After a failed turn, a session-scoped recovery card summarizes the interruption and tool evidence. Completed turns use the existing transcript and message-scoped InlineReviewCard without an extra success card; failed turns can continue through one localized prompt without losing the transcript. |
| Session switch | A first-opened session paints at its latest record; a revisited pane paints at its own retained position. Bounded first commit and full-history expansion show the same position: no post-paint height correction may shift the visible rows, in either direction |
| Turn start (send / retry / regenerate) | Re-pins and positions the latest content before paint, even if the user had scrolled up; the later persisted user-message event does not flash the transcript at its top, and the composer collapse / indicator layout clamps during the send never release follow mode |
| Idle (after stream) | Auto-scroll unlocked; user can scroll freely |
| Message-scoped review snapshot | Each successful workspace Write/Edit tool row is followed by one compact InlineReviewCard carrying that message's added/modified/deleted status and explicit addition/deletion totals. It renders as a single flat list row on the tool-row rhythm — disclosure caret, Git-style status letter (`A`/`M`/`D`), path, addition/deletion counts — with no card border, status rail, icon plate, or status pill; hover fill is the only row chrome, and a rolled-back change is struck through. Its hunks sit behind an expandable disclosure: every review card (inline and in the Review tab) is collapsed by default, and the user expands it on demand. The card remains after a Git commit, never becomes a bottom/global entry, and offers hash-guarded rollback without leaking into another session's transcript. |

### 4.5 Accessibility

- `role="log"` for transcript container
- `aria-live="polite"` on transcript for new message announcements
- Scroll-to-bottom button appears when user scrolls up during stream
- InlineReviewCard uses a native button with `aria-expanded` and
  `aria-controls`. Its localized accessible name includes the path, status,
  addition count, and deletion count — and the rolled-back state, which the row
  otherwise shows only as a strikethrough; the visible text and color are not
  the only status signal (the row carries a Git-style status letter).
- Empty-home task entry starts in the always-visible bottom composer. There is
  no starter-card or contextual quick-action layer between the hero and
  composer.
- The failed-turn recovery card is a labelled `role="status"` region with
  one explicit **Continue** action. It uses icon geometry plus text, never color
  alone. Continue sends the current locale's continuation prompt as a new user
  turn in the same session; no Regenerate action is present. Completed turns do
  not render this card.

### 4.6 MVP constraints

- No split-pane chat (single thread)
- No markdown editor preview split

---

## 5. WorkPanel

> Replaces the former ContextPanel overlay. The workspace/model/status
> summary it carried lives in the composer chips and Settings.

### 5.1 Purpose

Docked right work column for inspecting and steering the agent's workspace.
One host tool is launchable — Browser (embedded preview) — alongside the
views installed plugins contribute (ADR 0104), including the bundled `pi.files`
plugin that browsing the project now goes through. Review and `file:<path>` are
*artifact* surfaces: the host renders them, but the conversation opens them, so
they are absent from the tool list. There is no interactive terminal surface;
agent Bash output remains in the transcript.

### 5.2 Anatomy

```text
+---------------------------------------+
| ◫ App.tsx ⌄        drag      | [×][>] |  header, 46px
+---------------------------------------+
| Tools                       ¦ menu    |
|   ◎ Browser                 ¦         |
|  ------------------------   ¦         |
| Plugin views                ¦         |
|   ▤ Files                   ¦         |
|   ⑂ GitLens              [×]¦         |
|  ------------------------   ¦         |
| Open items                  ¦         |
|   ◫ Review               [×]¦         |
|   ▤ App.tsx              [×]¦         |
+---------------------------------------+
| Active resource body                  |
|  Review: recorded changes + diff      |
|  Browser: URL bar + preview           |
|  File: viewer for a transcript file   |
|  Plugin view: the plugin's own page   |
|  no resource: empty state + tool list |
+---------------------------------------+
 ▌ active row edge marker   • open, inactive
^ 10px transparent resize hit area on the left edge
```

The plugin-views group appears only when at least one loaded plugin
contributes a view that is in scope (ADR 0104). Its rows are structurally
identical to the tool rows — edge marker, open dot, reserved close slot — so a
plugin surface does not read as second-class beside a built-in one. A view
whose `icon` token this build does not know renders a lettered tile instead.

With no resource the body is an empty state — tiled icon, title, one line of
copy — followed by the same entries the header menu lists, as plain rows:

```text
+---------------------------------------+
|              ( ◫ )                    |  38px tiled icon
|         No resource open              |  title
|   Open a file or link from             |  body
|   the conversation — or pick a view.   |
|        ◎ Browser                       |
|        ▤ Files (plugin view)           |
+---------------------------------------+
```

### 5.2.1 Light-theme surface

- Panel body uses quiet inset paper (`#fafafa`); the 46px header band and tool
  chrome (review toolbar, browser chrome, file viewer header) stay white
- The header exposes one unified context trigger. Its menu lists the built-in
  host tools (Browser) first — each row
  showing its own open state and, once open, its own close control — then, after
  a divider, the plugin-contributed views in declared order, and after a second
  divider only the further resources the transcript opened. No entry appears
  twice. Rows use a neutral fill with a straight 2px left edge marker for the
  active row, never color alone; the trailing close slot is always reserved so
  labels and open dots never shift between rows. The menu fades in over ≤4px with
  `--motion-duration-fast` / `--motion-ease-out` and is static under
  `prefers-reduced-motion` (D173)
- The 46px header follows a "context left, actions right" model: the unified
  context trigger anchors the left and shows the active tool icon and ellipsized
  label; a right action cluster is pinned to the right edge behind a thin
  divider, so the close / collapse controls never shift with the label length.
  The gap between the two remains a window-drag region. The collapse control
  uses a right chevron so it reads as "push the panel away", not "open a panel"
- Active tabs, file-tree rows, diff headers, and the resize handle ease hover
  fills with `--motion-duration-fast` / `--motion-ease-out`
- Browser URL and empty-tool chrome share the light inset field treatment used
  by Settings controls (D148)
- Every empty state in the panel — the no-resource body and each tab's own —
  uses the proportions the rest of the app already uses (`.ext-empty`,
  `.projects-empty`): a 38px round tiled icon, a title at
  `--text-base-plus` / `--font-weight-medium-plus`, and muted `--text-md` copy.
  Copy wraps at 34ch rather than 48ch because the panel can be 244px wide. No
  hero art, cards, or marketing framing (design-system §14, D206)

### 5.2.2 Files plugin surface

The bundled `pi.files` view keeps the former Files tool's focused browsing
workflow while rendering entirely inside the plugin's isolated page:

- The compact toolbar identifies the active project and offers one explicit
  refresh action. Refresh disables itself and shows the same restrained spinner
  language used by the host while the root and expanded folders are reloaded.
  The tree loads one directory at a time, keeps directories
  above files, preserves expanded folders, and shows file sizes without
  walking the whole workspace up front.
- Directory rows use `role="treeitem"` with `aria-expanded`; Enter/Space opens
  the row and Arrow/Home/End keys move through visible rows. Hover and active
  fills are neutral theme surfaces, with the caret and folder/file SVGs carrying
  the hierarchy instead of emoji or text glyphs.
- Selecting a file switches to a focused viewer with a Back action, the
  root-relative path, file size, line numbers, and a bounded preview. The viewer
  also offers **Show in folder**, which reveals the selected existing file in the
  operating system's file manager through the scoped plugin bridge. Loading,
  read failures, binary content, image content, empty folders, and folders
  that fail to load each have a distinct localized state; a failed directory
  can be retried in place.
- The page follows `app.getAppearance` and `appearance:changed` for base theme
  and English/Simplified Chinese copy. Its only data access remains the public
  `workspace.get`, `fs.list`, `fs.readText`, and `fs.reveal` bridge, so the richer surface
  does not add host-only capabilities. Text previews are capped at 5,000 lines;
  images are reported as unavailable rather than sending binary data through a
  text-only channel. The palette stays monochrome like the main app rather than
  introducing a plugin-specific blue accent. A long-lived view rechecks
  `workspace.get` so switching projects cannot leave the previous project's tree
  visible.

### 5.3 States

| State | Behavior |
|---|---|
| Closed (default) | Not rendered; startup has no retained tabs. `Cmd/Ctrl + J` reveals the active session's panel context without creating a tab. Inline review cards remain available in the transcript because they are message-scoped and do not require the work panel. |
| Open | Docked flex row right of the main pane; opened by an artifact or `Cmd/Ctrl + J` at a fixed committed width of 244–720px (default 280px). `Cmd/Ctrl + J` again collapses it, retaining the session context. Its flex allocation eases from zero to the committed width so MainChat reflows continuously, while a matching native reservation keeps the chat width stable when possible (ADR 0122). |
| Multiple artifacts | The current-resource header keeps one readable label at the panel minimum; its bounded menu lists the tools first and then the transcript-opened resources in first-open order, with full-path tooltips and independent close controls |
| Session switch | The destination session's retained open state, tabs, active tab, and Browser resource replace the previous session's panel context atomically; neither context is deleted |
| Resizing | The inner left divider follows anchored pointer delta or keyboard input for the base chat target; pointer changes are frame-coalesced and bounded native requests are serialized. Escape, pointer cancellation, or lost capture restores the prior chat target. The outer right native edge/corners preview and commit the panel target; other native edges resize MainChat. The Electron recovery watchdog waits for stable bounds so it cannot interrupt a slow gesture. |
| No workspace | Each tab renders its own "open a project" empty state |
| Open with no resource | `Cmd/Ctrl + J` reveals the panel without creating a tab, so the body renders the no-resource empty state: title, one line of copy, and the available Browser/plugin-view entries. Activating an entry creates or selects that singleton view. The body is not a `role="tabpanel"` here because no tab labels it. |
| Constrained work area | The panel stays at its committed width; the native reservation is capped by the work area and MainChat absorbs the shortfall, possibly falling below its 360px target on small windows (ADR 0122) |
| Plugin view active | The body hosts the plugin's own isolated page as a native `WebContentsView`, positioned from the measured surface rect. It is hidden whenever the tab is inactive, the panel is animating or being resized, or a blocking overlay is open — the same rule the Browser preview follows, since both composite above renderer content. A view whose plugin is disabled, uninstalled, reloaded, or crashed is destroyed; the tab stays and re-opens the page on the next lifecycle event (ADR 0104) |
| Plugin out of scope | A view contributed by a plugin that is not active in the current project disappears from the menu when the project changes. Unlike contributed themes, which are one global setting and stay unfiltered, a view is scoped work |

### 5.4 Interactions

- Trigger: file/URL references and BrowserPreview create/activate their
  resource tab in the originating session's runtime context. BrowserPreview
  events carry `sessionId`, and the renderer retains that session's preview
  path/URL as its Browser resource. Successful workspace Write/Edit artifacts
  create/activate Review in the originating session.
  `Cmd/Ctrl + J` toggles the active session's retained panel context: it
  reveals the panel without creating a resource and collapses the visible panel
  without deleting one. With no active session it does nothing. The shortcut is
  ignored while Settings is the active page.
  Background artifacts may update that retained context but never reveal it,
  resize the window, or change visible selection/focus. The transcript does
  not create a global Review changes launcher: each successful workspace
  Write/Edit row owns only its adjacent InlineReviewCard, and another session
  cannot render that card in its transcript. Repeated resources deduplicate
  within the originating session.
- Review truth: host-core adds one bounded `details.review` record to each
  successful workspace Write/Edit result. The renderer reads that record from
  the owning transcript message, so status, counts, and hunks describe exactly
  what that row changed and remain available after a commit, restart, or
  workspace switch. The Review tab is the same session's chronological change
  history, not a current-worktree scan; it reuses the same message-owned cards
  as flat one-line rows under a borderless summary bar (`recorded N changes`
  plus the run's `+`/`−` totals), each collapsed by default until the user
  expands it. Its rollback action
  calls the host; the host compares the current content with the recorded
  post-tool hash and
  returns a conflict without overwriting later work.
- Unified context menu: while the panel is visible, one context trigger in the
  header opens a single dropdown. Its top section lists the open resources in
  first-open order (rows select a resource and retain per-resource close
  divider separates it from the create-new section listing Browser and
  in-scope plugin views. Activating a closed view creates it through
  `openWorkPanelTab`; activating an open view selects its singleton tab. The
  active view combines a neutral fill with a 2px edge marker, and open inactive
  views show a small status dot. The trigger disappears with the panel and
  remains available after `Cmd/Ctrl + J` reveals the panel. Artifact triggers
  still create and activate resources atomically; the shortcut only reveals the
  existing context.
- Empty-body view list: the available Browser and in-scope plugin-view rows
  appear only while the body has no tab at all, and disappear as soon as one
  exists. Each row calls the same create-or-select path as its header-menu
  counterpart, so a closed view gets a new singleton tab and an already-open
  one is selected rather than duplicated. `Cmd/Ctrl + J` itself still creates
  nothing — the rows are the user's choice, not the shortcut's side effect.
  The "open a project" empty states carry no action button: opening a project
  resets the panel context and hides the panel, so the button would undo the
  surface that offered it (D224).
- Resource header: the 46px header shows the active resource icon and
  ellipsized label. Its context chevron opens the bounded unified menu described
  above; the header's trailing close button closes the current resource
  directly. Arrow keys, Home, End, and Escape operate the menu; opening the menu
  hides the native Browser preview until it closes.
- Tab close: closing an active tab selects its right neighbor, then its left;
  closing the last tab hides the panel. The panel-level collapse control lives
  in the session pane top-right (not the work-panel content header) and hides the
  panel without deleting the runtime tab set; a later artifact reopens it.
- Context change: selecting another session atomically projects that session's
  retained `{open, tabs, activeTabId, browserResource}` state. The previous
  session's context remains in renderer memory and is restored when selected
  again. A workspace selection with no active conversation hides the panel.
  Every context remains bound to its originating session/workspace, so relative
  file and Browser resources are never reinterpreted against another workspace.
- Resize: the inner left-edge handle keeps the panel at its committed width and
  sends a bounded conversation-width target (`1040..10000px`) through Electron.
  `ArrowLeft` / `ArrowRight` adjust the chat target in 16px steps (`Shift` uses
  32px), and `Home` / `End` reach its limits. Pointer math is anchored to the
  press position and starting chat width, so grabbing the handle cannot jump
  the divider; move events are frame-coalesced and queued as one bounded native
  request at a time. Escape, pointer cancellation, and lost capture restore
  the press-time chat width. The 10px hit area keeps a global column-resize
  cursor and suppresses text selection during the gesture. The outer right
  native edge and right corners preview and commit the panel's fixed
  `244..720px` target while preserving the base chat width (ADR 0146).
- Persistence: all session contexts are renderer runtime state only. On app
  startup, open state, tabs, active-tab selection, file requests, and Browser
  resources reset; only the committed preferred `{width}` remains in
  localStorage `pi.desktop.workPanel`. Before presenting an open panel the
  renderer requests a native reservation equal to that width; collapse and
  final-tab close release the reservation after the exit animation. Target
  updates are idempotent. The panel reflows MainChat beside its reserved native
  column; on constrained work areas chat may fall below its 360px target.
  Maximized/fullscreen geometry is unaffected. Background session artifacts
  never update the visible panel or reservation. The renderer changes panel
  presentation only after the latest reservation request succeeds; a rejected
  or superseded request keeps the last confirmed presentation state
  (D163, D255, ADR 0122).

### 5.5 Accessibility

- `<aside>` landmark. The current-resource control exposes
  `aria-haspopup="menu"` / `aria-expanded` / `aria-controls`, keeps its visible
  label as its accessible name, and its `role="menu"` dropdown groups rows under
  labelled `role="group"` sections. Rows are `menuitemradio` / `aria-checked`
  buttons that take real DOM focus (`tabIndex={-1}`) inside `role="none"`
  wrappers, so ArrowDown/ArrowUp/Home/End move focus across rows only and never
  through the trailing close buttons; Delete/Backspace closes the focused row.
  Escape and Tab close the menu and return focus to the trigger. Each resource
  body remains a `role="tabpanel"`; the no-resource body is not one, since no
  tab exists to label it. Its tool rows are ordinary buttons inside a
  `role="group"` labelled "Tools", reachable by Tab in reading order
- Resize handle: focusable `role="separator"` with
  `aria-orientation="vertical"`, a localized label, dynamic
  `aria-valuemin` / `aria-valuemax` / `aria-valuenow`, visible focus, and
  Arrow/Home/End keyboard control. Escape cancels an active pointer gesture.
- Every resource close and the sole session-pane panel collapse button expose
  localized names

### 5.6 MVP constraints

- Tab content specs: Review has host-guarded rollback but no line comments;
  Browser is user-driven (no agent control); Files is read-only
- Single panel instance; no per-tab detach or split

---

## 6. SessionList

### 6.1 Purpose

List user sessions by execution context inside the sidebar. It exposes the
sessions for every retained project tab plus persistent sessions that have no
project. Pin/archive/collapse state is a presentation over durable host
sessions, not a replacement persistence model.

### 6.2 Anatomy

Groups and session items:

```text
[folder] current-project                         [+]
           Session title
[star] pinned-project                             [+]
           Session title
[folder] another-project                         [+]
           Session title
SESSIONS                                      [msg+][↕]
           Session title
```

### 6.3 States

| State | Appearance |
|---|---|
| Active | neutral-accent outlined ring, active bg highlight, text-primary |
| Inactive | bg-secondary, text-secondary |
| Hover (inactive) | bg-tertiary |
| In progress | warning-orange breathing dot; no motion under reduced-motion |
| Completed | success-green check mark |
| Failed | error-red circled alert mark |
| Pinned project | filled accent Star replaces the Folder glyph; ordered before unpinned projects within the selected sort |
| Pinned conversation | ordered before unpinned rows within the selected sort |
| Archived | omitted by default; shown only when archived view is enabled |

### 6.4 Interactions

- Click: activate session
- Project matching uses the normalized full project path, never only the folder
  basename.
- Sessions for retained paths appear beneath their corresponding project
  group. Sessions for closed paths remain discoverable from Settings → Project
  archive.
- Selecting a temporary session clears the active workspace so session and
  tool context do not imply project access.
- Rename opens a modal title editor from the session overflow menu or a
  project-archive task row. The editor trims the value, limits it to 80
  Unicode code points, focuses the field on open, traps focus, and supports
  Escape to cancel. Saving updates the task label across the sidebar,
  topbar, project archive, and search without changing transcript or recent
  activity metadata.
- Pin/archive actions update renderer presentation metadata; delete remains
  the explicit durable host operation.
- Create branch snapshots the idle conversation's complete current transcript
  into an independent session. The child stays in the same project or
  standalone Sessions section and becomes active; later transcript/configuration changes
  do not affect the source. The action is disabled for a running source.
- Selecting a conversation with a different project first activates that
  project's workspace. A running turn in the previously selected session is
  not aborted.
- Sidebar body-level menus opened from toolbar or row triggers remain
  content-sized and use the same fixed rule as right-click menus: open 4px to
  the anchor's right without flipping to the left. Their surface width is
  capped for narrow viewports. This includes the Sessions sort menu,
  session/project overflow menus, and section create menus.
- Keyboard: arrow up/down, Enter to select
- Rename: row menu or project-archive task action
- Delete: row menu

### 6.5 Accessibility

- Each group is a labeled `section`.
- Scope-specific create buttons expose localized `aria-label` values.
- Active rows expose the selected visual state and retain their full title in
  a tooltip.
- Archived state and every task status are announced rather than conveyed by
  color alone. The status slot also uses different geometry for selected, in
  progress, completed, and failed.

### 6.6 MVP constraints

- Search remains a local title filter; archive visibility and ordering are
  local view controls rather than host queries.
- Temporary means **not bound to a project**, not ephemeral storage; these
  sessions survive restart.
- The standalone Sessions body shows at most five compact 28px rows and
  scrolls internally when more rows exist. The Projects list uses the remaining
  sidebar height and scrolls independently; neither region scrolls the footer
  or primary navigation. Both list scrollbars remain 6px, trackless, and
  transparent at rest; the semantic-ink thumb appears when its list is hovered
  or focused and remains visible while dragging, so the independent regions
  stay available without becoming persistent visual rails.

---

## 7. ChatTranscript

### 7.1 Purpose

Scrollable container rendering the ordered sequence of user messages, assistant
turns, lightweight tool activity rows, and permission cards for a session.
Provider-level assistant fragments separated by tool calls remain distinct in
storage but compose into one assistant turn until the next user message.

### 7.2 Anatomy

```text
+----+-------------------------------------+
|map | [User MessageBubble]                |
|rail| [Thinking disclosure]               |
|    | [Assistant Turn]                    |
|    |   [Assistant fragment]              |
|    |   [ToolCallRow]                     |
|    |   [PermissionCard] (interrupt)      |
|    |   [Assistant fragment (resume)]     |
|    |   [Meta + one action toolbar]       |
|    | [User MessageBubble]                |
|    | ...                                 |
+----+-------------------------------------+
```

### 7.3 States

| State | Behavior |
|---|---|
| Session activation | First activation re-pins and positions at the last record during layout, before the pane's first painted frame; a revisited pane restores its own retained scroll position instead |
| Session transition | A warm destination pane is revealed immediately with its retained content and position. If it is running, its live renderer snapshot survives the durable revalidation read. A cold destination leaves the visible pane on its own session under a thin progress track until it commits; nothing is dimmed, hidden panes stay mounted and inert, and current stream updates are not deferred |
| Streaming | New tokens append; auto-scroll only while pinned to bottom |
| Turn start | Send / retry / regenerate re-pins follow mode and jumps to bottom |
| Thinking-only streaming | Transcript opens; disclosure stays open; no empty answer bubble or duplicate Working row |
| Idle | Scrollable; no auto-scroll |
| Permission pending | PermissionCard inserted inline; transcript continues after resolution |
| Context checkpoint | Existing transcript remains visible; compaction adds one divider row after the message it covers and one warning toast |
| Error | Error MessageBubble with actionable retry link |

### 7.4 Interactions

- Scroll: the first upward scroll movement immediately pauses auto-scroll,
  cancels pending follow work, and shows the "scroll to bottom" floating button;
  stream or resize updates cannot pull the viewport back down; send / retry /
  regenerate re-pins and jumps to bottom
- Hover message: copy action appears
- Assistant fragments emitted before and after tool calls compose into one
  `role="article"` turn. The turn exposes one trailing meta row and one action
  toolbar; Copy joins all contentful fragments in order, while Fork and
  Regenerate use the last contentful assistant message as the durable boundary.
- Toggle Thinking disclosure: expand/collapse reasoning independently from the
  final answer; streaming reopens it while reasoning is arriving. The expanded
  content's left rule is itself a pointer and keyboard-focusable collapse
  control.
- Hover code block: copy button appears
- Hover or focus a minimap marker: show the localized sender and a bounded
  plaintext preview; multiple assistant fragments produced within one user
  turn are combined into one AI-response marker and preview; nearby markers
  magnify horizontally without reflowing the rail
- Click a minimap marker: smoothly scroll its message near the top of the
  transcript viewport
- Scroll the transcript: update the active minimap marker against an anchor
  near the upper third of the viewport
- Show the minimap rail only while the transcript overflows one page; if
  content fits the viewport, hide the rail even when two or more markers exist.
  Exception (D269): while earlier history is withheld above the mounted window or
  an older page is still on the host, the rail stays visible with its
  earlier-history continuation regardless of marker count and overflow
- Click the earlier-history continuation: run the same grow-then-fetch
  escalation as reaching the top. It is labeled and disabled while a page loads,
  never shows a message preview, and disappears once the whole history is loaded
  and mounted
- Center the minimap stack inside the unobstructed vertical span below the
  46px titlebar and above the docked composer. As marker count grows, compress
  marker pitch and spacing so every marker remains inside that span rather
  than entering the native window drag region
- Follow-scroll requests from stream events and content resize are coalesced to
  at most one pending animation frame. A new token cannot cancel and recreate
  already scheduled follow work.
- An upward manual scroll takes priority over a pending follow frame, including
  sub-threshold trackpad movement that remains close to the bottom. Downward
  scrolling re-pins only after the viewport returns within 48px of the bottom.
- Minimap content resize checks only overflow. Message-position measurement is
  reserved for scrolling, marker identity changes, and viewport resize, so a
  streamed content height update does not scan every message twice.
- Context compaction never removes, collapses, or replaces visible message
  rows. It adds one non-message divider row per compaction, anchored after the
  last message that checkpoint covers; the row ends whatever assistant turn it
  falls inside, and a row whose anchor no longer exists is not drawn. The
  `new_context` tool is a normal tool call and reaches the processing group like
  any other.

### 7.5 Accessibility

- `role="log"` container
- `aria-live="polite"` for new content announcements
- Each user message and composed assistant turn: `role="article"` with
  `aria-label` describing sender
- Thinking uses a button disclosure with `aria-expanded` and `aria-controls`;
  the localized label distinguishes Show thinking from Hide thinking, and the
  collapsed panel is hidden from accessibility and focus traversal
- The minimap is a localized navigation landmark; every marker is a button
  labeled with its message sender
- The marker nearest the reading position exposes `aria-current="true"` and
  keyboard focus opens the same preview available on pointer hover

### 7.6 MVP constraints

- No message search within transcript
- No inline message branching tree; regenerate variants remain linear per user
  root turn. Session-level Create branch produces an independent conversation
  row instead of adding tree chrome inside the transcript.
- The minimap renders when at least two eligible turn markers exist **and** the
  transcript content overflows one viewport (scrollHeight > clientHeight), or
  whenever earlier history remains unmounted or unloaded (D269).
  Each visible user message creates one marker; all contentful assistant
  fragments until the next user message create one AI-response marker anchored
  to the first contentful fragment. Tool-only rows do not create markers or
  split an AI response, and a one-page transcript never shows the rail.
- Marker previews are capped at 280 source characters and are display-only
- Derived visible rows, minimap rows, and activity grouping are memoized by the
  `messages` snapshot. Completed message rows, composed assistant turns, and
  activity groups keep stable render boundaries while only the current stream
  fragment changes.

---

## 8. MessageBubble

### 8.1 Purpose

Single message render — either user (plaintext) or assistant (markdown streaming).

### 8.2 Anatomy

**User message:**

```text
+------------------------------------------+
| plaintext message content                |
|                    timestamp · edit icon  |
+------------------------------------------+
```

**Assistant message:**

```text
+------------------------------------------+
| [Thinking ▾]                             |
|   separate reasoning markdown (optional) |
| ──────────────────────────────────────── |
| [markdown rendered content]              |
|   code blocks: mono, bg-inset           |
|   inline code: mono, bg-inset           |
|                    timestamp             |
+------------------------------------------+
```

### 8.3 Layout

- Max content band: 760px thread column; assistant body max 720px
- When the sidebar is collapsed, the centered thread column and composer band
  use a 640px ceiling. The outer main pane remains fluid and the width
  transition follows the sidebar dock transition.
- User: right-aligned, theme-neutral soft plate (`color-mix` on primary ink,
  never a fixed accent tint), borderless, `radius-lg-plus` with a tighter
  bottom-right corner, capped at `min(82%, 600px)` so short prompts read as
  chat turns rather than full-width blocks. User body is plaintext with
  preserved hard newlines (`white-space: pre-wrap`);
  only trailing/leading composer trim is applied, never internal newline
  collapse. Previewable path and URL controls remain inline with that plaintext;
  long references wrap within the plate and continuation lines keep logical-start
  alignment instead of inheriting the browser's centered button text.
- Assistant: transparent surface, left-aligned, markdown rendered at full
  content width
- Thinking: separate lightweight disclosure above the answer with no card
  background or outer border. Its Sparkles/chevron trigger uses secondary text,
  and the expanded markdown is indented by a subtle theme-token left rule. It
  is never concatenated into answer markdown.
- Hover actions: quiet icon-only action chips under the bubble — Copy always;
  Fork and Regenerate on completed assistant turns; Edit and Delete on user
  turns. Assistant rows expose neither Delete nor Edit. Chips render the glyph
  alone: the label is carried by `aria-label` plus a themed hover/focus
  tooltip above the chip, never as visible caption text (D137). Right-aligned
  for user turns, left-aligned for
  assistant turns; visible on hover/focus-within. Regenerate truncates the
  durable transcript to the nearest preceding user prompt and re-runs that turn
  in place instead of appending a duplicate branch. When more than one
  variant exists, a ChatGPT-style `current / total` pager on the root user
  turn switches archived branches without losing history (D109). After
  Retry/Regenerate starts, the root user turn remains in the live transcript
  and owns the pager whenever `revisionCount > 1`; replacing the assistant/tool
  tail must not move or detach that pager from the user bubble. The pager is
  part of the message action toolbar: hidden by default and revealed together
  with Copy on row hover or keyboard focus.
  Fork creates and activates an independent session whose snapshot ends at the
  selected assistant response, requires an idle source, and leaves that
  source's transcript, live runtime, and provider cache state untouched (D134).
  Edit belongs to the user turn: it swaps the prompt bubble for a focused
  inline textarea (Escape cancels, Cmd/Ctrl+Enter retries; slash turns seed the
  typed `command` form so retrying re-expands the template), widens the user
  column to the assistant reading width while open, and hides the action
  toolbar. The inline controls are localized Retry and Cancel actions. Retry
  runs the Regenerate path with the current text in the same session, even when
  the text is unchanged, so the replaced prompt and its whole answer tail are
  archived as a D109 revision and the pager walks back to the original
  exchange (D274).
- Tool-mediated assistant output uses one visual turn from the preceding user
  message to the next user message. Intermediate provider message boundaries
  remain visible as ordered markdown fragments around activity disclosures but
  do not create additional meta rows or action toolbars. The single Copy action
  copies all contentful fragments in order; Fork and Regenerate target the last
  contentful fragment so existing durable transcript semantics remain intact
  (D157).
- Assistant meta: optional model badge + compact Codex-style context inspector
  under the answer. The inspector keeps a small remaining-capacity ring beside
  the `Context` label and percentage; low capacity changes the semantic color
  without making color the only signal. Clicking the trigger (or activating it
  from the keyboard) toggles a non-modal panel with the remaining-token header,
  used/window counts, and two unboxed turn/speed summary values. Model usage is
  compressed into one inline summary row that retains exact input/output/cache/
  reasoning values and the provider-reported cache hit rate when available.
  Tool usage is compressed into one aggregate row showing tool types, calls,
  and estimated tokens; per-tool rows, share bars, source badges, and the
  explanatory estimate note are intentionally omitted from the default view.
  Generation speed is a completed-turn value in tokens per second and is not
  updated while a response is streaming. The context-window total uses the
  same effective model window as the agent sidecar: a published models.dev
  `limit.context` replaces a legacy 128k generic binding seed, while a non-default
  per-model Advanced value remains explicit. Unknown models use the provider's
  generic default window. The panel is portaled to
  the document body as a fixed viewport overlay, flips above or below the
  trigger, clamps to viewport margins, and repositions on transcript scrolling
  or window resize so no transcript clipping ancestor can hide it (D103, D184,
  D244). When the active session has an installed context checkpoint, the
  panel adds one muted summary line for the compaction count and newest
  summary's estimated token cost; the transcript still shows one row per
  compaction (D203).
- Gap: 12px vertical padding between consecutive message rows (denser than
  consumer chat, closer to WorkBuddy task transcript); assistant turns add a
  little extra bottom air so a completed answer separates from the next prompt
- Font: text-base (14px) for body; text-sm (13px) mono for code
- Tool activity: tool-name classification selects a semantic 15px icon;
  `fork`, `fork_agent`, `fork_task`, and `fork_session` use the GitFork branch
  icon instead of the generic tool glyph.

### 8.4 States

| State | Appearance |
|---|---|
| Streaming | accent left rail along the whole assistant turn (fragments + tool rows); the rail's space is always reserved so it fading in/out never reflows text; content grows |
| Thinking streaming | disclosure open; answer bubble omitted until answer text exists |
| Complete | no streaming rule; full rendered markdown |
| Error | compact assistant error card in transcript; localized summary and stable code share one header with the details disclosure; details still opens to redacted provider response, provider/model IDs, and copy action; the card offers a localized Continue action that resends the continuation prompt; configuration failures show Open settings, while regenerate is provided by the session-scoped failed-turn recovery card |

### 8.4a Context compaction row

Not a bubble: a full-width divider between transcript rows, drawn after the last
message its checkpoint covers.

- One centered label — how many times the session has compacted — with a hairline
  rule filling the space on both sides, using `--ds-border-subtle`.
- A second muted segment states the summary's estimated token cost, or that no
  summary was generated (the no-summary family).
- `--ds-text-muted` at `--text-2xs` with tabular numerals; the detail segment
  steps up to `--ds-text-secondary`. Margins match the transcript's row rhythm.
- `role="separator"`. No actions, no hover state, no selection, no disclosure.
  Nothing about a checkpoint is editable, so the row is informational only.

### 8.5 Accessibility

- User: `aria-label="User message"`
- Assistant: `aria-label="Assistant message"`
- Thinking trigger exposes localized Show/Hide labels, `aria-expanded`, and an
  `aria-controls` relationship to the reasoning panel
- Context inspector trigger is keyboard focusable, exposes a localized
  remaining percentage and token count, carries `aria-haspopup="dialog"`,
  `aria-expanded`, and an `aria-controls` relationship to the panel, and opens
  the same compact summary on click or keyboard activation; Escape or a click
  outside closes it and returns focus to the trigger
- Timestamps: `aria-label` with full time string, visual shows relative time

### 8.6 MVP constraints

- No message reactions/annotations
- No edit user message (deferred)
- Copy assistant answer excludes thinking text

### 8.7 Markdown & code rendering (implemented)

Renderer: `apps/desktop/src/components/Markdown.tsx` + `apps/desktop/src/lib/shiki.ts`
+ prose styles under `.prose-chat` / `.code-block` in `styles/prose.css`.

- **Streaming without jank**: runtime content chunks render directly, without a
  second renderer-side typewriter or animation-frame state loop. Source splits
  into top-level blocks via `marked`'s lexer; each block renders through a
  memoized `<ReactMarkdown>`. While streaming only the tail block re-parses
  (incremental re-lex from the last block boundary), so cost stays linear in
  message length. A Mermaid fence stays in the normal source-code presentation
  until its matching closing fence arrives; partial streamed diagrams never
  enter the diagram parser.
- **Plugins**: `remark-gfm` (tables, task lists, strikethrough, autolinks),
  `remark-math` + `rehype-katex` (inline `$…$`, display `$$…$$`). Raw HTML is
  parsed by `rehype-raw` and immediately constrained by the extended
  `rehype-sanitize` default schema; only the renderer-owned audio/video/source
  additions are admitted. KaTeX's Vite-inlined WOFF2 fonts are allowed by the
  renderer's `font-src 'self' data:` CSP directive.
- **Mermaid diagrams (D165)**: a completed `mermaid` fenced block in assistant
  answer prose renders through the official Mermaid package. The dependency is
  dynamically imported only when a diagram approaches the viewport; Mermaid's
  global theme configuration and render calls are serialized. Diagram source
  is capped at 20,000 characters and graph edges at 500. Strict security,
  protected configuration keys, disabled HTML labels/links, and a second
  DOMPurify SVG-profile pass precede insertion. Unsafe external/media elements,
  `foreignObject`, event-capable links, and URL attributes are removed. Invalid
  or oversized input falls back to a readable source view. The toolbar toggles
  diagram/source and copies the original source; light/dark theme changes
  re-render the SVG. Thinking prose deliberately keeps `mermaid` fences as
  source code so a collapsed reasoning trace cannot start diagram layout.
- **Syntax highlighting**: Shiki singleton with the JavaScript regex engine
  (no wasm), themes `one-light`/`one-dark-pro` following `data-theme`.
  A coding-focused local catalog exposes 48 canonical grammars plus common
  aliases; each grammar lazy-loads on its first matching fence tag with a
  plain-mono fallback until ready. Tags outside that catalog remain readable
  plain text instead of pulling the full Shiki language distribution into the
  application. The canonical catalog is `astro`, `bat`, `c`, `cpp`, `csharp`,
  `css`, `dart`, `diff`, `docker`, `dotenv`, `go`, `graphql`, `groovy`, `hcl`,
  `html`, `ini`, `java`, `javascript`, `json`, `jsonc`, `jsonl`, `jsx`,
  `kotlin`, `lua`, `make`, `markdown`, `mdx`, `mermaid`, `nginx`, `php`,
  `powershell`, `prisma`, `proto`, `python`, `ruby`, `rust`, `scala`,
  `shellscript`, `sql`, `svelte`, `swift`, `terraform`, `toml`, `tsx`,
  `typescript`, `vue`, `xml`, and `yaml`. Streaming code re-tokenizes only
  changed lines by chaining GrammarState (per-line cache), so per-frame cost
  is constant regardless of block size.
- **Code block chrome**: `.code-block` single-surface card (radius-md-plus,
  hairline border; dark `#282c34`, light `#fafafa` — matching One Dark Pro /
  One Light editor bg). Header is transparent (language tag left, copy right);
  body `pre`/`code`/token spans have **no nested background**, so Shiki token
  colors sit on the one card surface. Body text at text-sm-plus /
  leading-relaxed with horizontal scroll and tab-size 2.
- **Prose**: calmer chat density — body at text-base / leading-prose with
  pretty wrapping; heading ramp h1 `text-xl` (hairline underline) → h2
  `text-lg-plus` → h3 `text-lg` → h4 `text-base-plus` → h5/h6 `text-base`
  secondary; blockquotes use a 3px neutral rule over a soft plate;
  hr is a faded center gradient; lists use quieter markers and flex task
  rows; inline code gets a hairline border + soft gray tint; tables wrap
  in `.table-wrap` (rounded shell, header row, even-row wash, hover wash);
  display math sits in a subtle inset plate. Thinking prose reuses the same
  hierarchy at text-sm-plus / secondary color.
- **Light theme**: paper-quiet surfaces — links use soft underlined ink
  (not hard black/blue), inline code `#f2f2f2`, fenced code cards use One
  Light `#fafafa` (no nested wash / drop shadow), blockquotes `#f6f6f6`,
  tables on white with `#f3f3f3` header / `#fafafa` zebra. Dark fenced code
  uses One Dark Pro `#282c34`.
- **Links**: plain click previews in the work panel; modified click keeps
  `target="_blank"` so main routes through `shell.openExternal`; in-window
  navigation stays blocked.
- **Long transcript behavior**: `.thread-scroll` sets `overflow-anchor: none`
  (pinned-follow owns the scroll position), `.message-row` and
  `.tool-activity-group` use `content-visibility: auto` with an intrinsic size so
  far-offscreen rows skip layout and paint, and offscreen Mermaid diagrams defer
  loading and layout until they approach the viewport.
- **Bounded first commit**: activating a session whose history exceeds the
  initial mount budget mounts only the newest entries in that commit, with a
  spacer holding the remaining scroll height, and expands to the steady-state
  window on the next frame. The gate is derived during render from the session
  being painted; deciding it from an effect instead makes the switch mount the
  whole history, discard it, and rebuild it. The bounded commit also raises the
  settle veil (D287): late row heights (Markdown, code blocks,
  `content-visibility` placeholders) are measured under it rather than painted.
- **Bounded mounted history**: the mounted history is a trailing window over the
  loaded history, not all of it. Reaching the top escalates in two stages —
  mount more of what is already loaded, and fetch an older page only once the
  window covers all of it. Both stages add height above the reading position, so
  both take the same pre-paint scroll anchor. The window resets per session, and
  the spacer stays scoped to the first commit: a permanent spacer under the
  steady-state window would make the user scroll a blank viewport to reach the
  growth trigger. `content-visibility` alone does not bound this cost — it skips
  layout and paint for offscreen rows while retaining their React trees, Markdown
  ASTs, and highlighting tokens.
- **Minimap describes mounted rows**: the minimap resolves a click by finding the
  marker's `data-minimap-id` node inside the scroller, so its message markers are
  built from the mounted entries. Built from every loaded message while the window
  withholds older rows, it would draw dashes whose click target does not exist.
- **Withheld history is stated, not hidden** (D269): message dashes stay
  mounted-only, and everything above the window is represented by one dotted
  continuation control that triggers the same escalation. Without it the rail
  disappeared exactly when navigation was most needed — a bounded tail holding a
  single tool-heavy turn has fewer than two markers and often does not overflow.
- **History advances on boundary visibility** (D269): the top loading row is
  observed inside the scroller with the same near-top threshold the scroll handler
  uses. An underfilled tail page, a page whose fetched rows all land outside the
  mounted window, and a window transition can leave `scrollTop` untouched, so a
  scroll-only trigger could never fire again.
- **Minimap hover cost**: dash magnification is applied by writing a custom
  property per dash, and dash centers are measured in a separate read-only pass.
  Reading a dash's geometry inside the same loop that writes to it forces one
  synchronous layout per dash on every hover frame. The measurement is refreshed
  when the marker set changes and whenever the rail's own box resizes: the rail's
  height derives from `--composer-dock-height`, which the composer republishes as
  its draft grows, so dashes move without a marker change or a window resize.

---

## 9. ToolCallRow

### 9.1 Purpose

Lightweight inline disclosure row showing a semantic tool action, its primary
argument hint, status, and a readable rendering of the result. It follows D071
and is intentionally not an elevated card.

Consecutive tool calls form one ChatGPT-style processing group. The group is
collapsed by default and its header shows `Processing · 12s` while active or
`Processed for 12s` after completion. Expanding it reveals the ordered tool
activity rows and their nested result disclosures. The group reports duration
and containment, not turn outcome: a failed child remains an error on its own
ToolCallRow but never changes the group header to a terminal failure. Terminal
agent errors remain owned by the assistant error and TurnOutcomeCard surfaces.

### 9.2 Anatomy

```text
[sparkle] Processed for 12s  3 steps        [›]
          ├─ [file] Read /src/foo.ts        [›]
          ├─ [search] Searched TODO  24 matches   [›]
          └─ [terminal] Ran pnpm test  exit 1  • Failed  [copy] [›]
             3 passing
             1 failing
```

- The leading Lucide icon reflects the action type: file, folder, search,
  edit, terminal, web, or generic tool.
- The group header owns the elapsed timer and step count. It stays in the
  transcript after completion and remains collapsed unless explicitly opened.
- The processing group spans the full available assistant column, so expanded
  result details keep a usable width even when the header or payload is short.
- The visible label is a natural-language action (`Read`, `Ran`, `Searched`),
  not the raw function name. Running actions use the progressive form.
- The primary argument is a clamped single-line monospace hint.
- Result chips follow the hint: exit code (error hue), match/file counts,
  replacement count, written or read size, `truncated`, `scratch`. A successful
  exit earns no chip — the row status already says so.
- The disclosure chevron is quiet until hover/focus or expansion.
- A `run` row's head carries two more controls than the others, because its
  command lives only there (D226, §9.10): the outcome with a toned dot, and a
  copy control beside the chevron. That outcome comes from the exit code the
  shell reported, not from the status of the call that carried it (D227).

### 9.3 Expanded blocks

The expanded body is a list of labeled blocks, never a JSON dump (D192). The
pi-ai result envelope carries the structured payload in `details` and repeats it
as text for the model; only the structured half is rendered, so no byte appears
twice.

| Tool | Blocks |
|---|---|
| Read | `File content` — syntax highlighted from the file extension |
| Write | `Written content` — highlighted from the target extension |
| Edit | `Changes` — compact diff, only when no ReviewChangeCard owns one |
| Bash | `Output`, `Errors` (error hue), unframed and unlabelled (D227, §9.10); empty channels omitted. The command stays in the head; a PermissionCard, which has no head, still shows it as `Command` (shell) |
| Glob | `Files` — clickable workspace paths |
| Grep | `Matches` — grouped by file with a `line` gutter and clickable path headings for `outputMode: content`; a clickable path list for `filesWithMatches`; `path` → hit count fields for `count` |
| any host `notice` | `Note` — neutral, after the blocks it qualifies (search scoping, clipped long lines, Read window) |
| any failure | `Error` — message plus code, listed first |
| unmapped payload | scalar entries as label/value fields; long or multi-line strings as their own labeled block; nested objects as JSON |

- Arguments appear as an `Input` field block only when the result blocks did not
  already carry them, or for opaque tools (`use`, `fork`, `fetch`) whose
  arguments are the interesting part. The argument already shown as the row hint
  is not repeated, and a command withheld from the body never returns as one:
  a run that printed nothing opens on an empty body, not on its arguments.
- Every block exposes a compact copy action that copies the full payload, not
  the visible slice.

### 9.4 Layout

- Outer row: transparent, borderless, shadowless, approximately 24px high
- Icon: 15–16px; disclosure chevron: 12px
- Header gap: 4px; expanded body inset: 24px
- Chips: monospace `--text-2xs`, hairline border, error hue for exit codes
- Code, file list, match list and field blocks: `font-mono text-sm`,
  independently copyable, capped at 260px with internal scrolling
- Diff blocks reuse the review card's `.diff-line` rails
- Only expanded content receives an inset surface and subtle border

### 9.5 States

| State | Header treatment | Expanded content |
|---|---|---|
| Running | Progressive action with readable text and a compact pulsing marker; a `run` row also shows its spinner and pulses the status dot beside `Working…` | Latest partial output (`details.output` is presented as the stdout channel) |
| Success | Past-tense action + result chips; no green success badge, except a `run` row's dot and `Done` | Result blocks, then arguments if not already shown |
| Error | Past-tense action + compact danger status; auto-expanded. A `run` row is in this state whenever its command exited non-zero, whatever the call reported (D227) | Error note first, then arguments |
| Denied | Muted `Denied` status | Permission result when available |

### 9.6 Interactions

- Click the row: expand/collapse the result blocks; successful rows default
  collapsed and failed rows open automatically.
- Click the processing header: expand/collapse the ordered activity list.
  Processing groups default collapsed, including while the turn is active.
- Click or keyboard-activate the left rule beside expanded thinking, tool
  details, delegated work, or processing steps: collapse that owning
  disclosure without changing adjacent expansion state.
- A failed child row remains auto-expanded and error-hued, while the containing
  group settles as `Processed for {elapsed}` even when a later tool recovered.
  Expansion uses a short height/opacity transition and keeps collapsed content
  inert.
- Running updates replace the latest partial output in place. Bash's cumulative
  `details.output` partial result is rendered through the stdout channel, while
  the completed `details.stdout` value wins when both are present. Blocks are
  built on expansion only and unchanged rows are memoized, so collapsed rows do
  not parse or rerender on streaming ticks.
- Results are presented before arguments so the primary result has higher
  information priority.
- File paths and Grep hit headings open in the work panel when they resolve
  under the workspace root; paths outside it stay plain text.
- Host truncation markers remain visible and cannot be bypassed by expansion.
  Rendered lists and diffs are capped and report the hidden remainder.
- Syntax highlighting is skipped above 100 KB or 800 lines.

### 9.7 Accessibility

- `role="region"` with `aria-label="Tool call: {toolName}"`
- Status announced through localized `aria-label` text
- Expand/collapse: `aria-expanded` + `aria-controls`
- Expanded-content left-rule collapse controls are native buttons with a
  localized accessible name and a visible keyboard focus ring.
- Copy actions carry `aria-label="Copy {block label}"`
- Keyboard focus uses the standard inset focus ring

### 9.8 MVP constraints

- No word-level diff refinement; the Edit diff is line-based
- No cross-row activity grouping until turn boundaries are available to the
  transcript component

### 9.9 Delegation cards and fan-out topology (D201, D265, D268, D271, ADR 0062)

A `Task` call is presented as a node of a delegation card, not as a compact tool
row — one delegation reads the same as a fan-out (D265). The node names the
delegate it ran, taken from the rows it produced or, before any arrived, from
the call's own `agent` argument, and carries the call's short `description`.

The lifecycle rows (`TaskWait`/`TaskList`/`TaskStop`) stay compact tool rows —
they are not topology nodes and must not inflate the subagent counts — but they
are presented as subagent rows rather than as generic tool calls (D269). A
lifecycle row is called with delegation ids, which read as bare UUIDs, so it
never summarizes from its own arguments:

```text
└─ [bot] Waited for subagents  2 subagents  explorer, fixer   Failed  [›]
   ├─ Notice
   │  ## explorer (d1) — completed …
   └─ Details
      explorer     completed · 3s · 6 turns
      fixer        failed
```

- **Its summary is the roster it reports on**, by agent name, read from
  `details.delegations[]` (`TaskWait`/`TaskList`) or `details.stopped[]`
  (`TaskStop`). A repeated agent is counted (`explorer ×2`) rather than listed
  twice, and a subagent count chip sits beside the label.
- **Its status badge rolls up that roster** using the same
  `chat.subagentStatus.*` vocabulary as a topology node: anything still running
  keeps the row running, a `failed`/`denied` member outranks a completed
  sibling, and otherwise a non-completed member (truncated, timed out, stopped)
  is surfaced ahead of `completed`.
- **Its label names the action on subagents**, not "Delegated": only `Task`
  delegates. The row carries the `delegate` bot icon in the subagent accent so
  it scans as belonging with the card it reports on.
- **Its body is the roster as a named table**, one line per subagent with status,
  runtime and turns, led by the joined reports as a notice — never the raw
  `delegations[]` JSON. A lifecycle row has no brief of its own, so the ids it
  was called with do not reappear as an argument block.

```text
[flow] Subagent completed   1 subagent · 1/1 finished · 40s        [›]
  ┌────────────────┐    ┌───────────────────────────────────────────┐
  │ (◎) Main agent │────│ [bot] code-reviewer      Completed · 32s  │
  │ Coordinating 1 │    │ check the store diff                      │
  │ delegated task │    │ 3 steps                             [›]   │
  └────────────────┘    └───────────────────────────────────────────┘
```

Opening a node reveals the blocks the call carries, then the delegate's own rows:

```text
└─ [bot] code-reviewer  check the store diff   Completed · 32s   [›]
   ├─ task                                        [copy]
   │  Review the changes in src/stores for …
   ├─ Details
   │  status  completed   turns  4   toolCalls  9
   └─ [bot] What code-reviewer did          3 steps
      ├─ [thinking] Thought for 2s                [›]
      ├─ [file] Read /src/stores/app-store.ts     [›]
      └─ The queue drops a request by id, so …
```

- A delegation is **always** expandable, even with no result blocks: the brief,
  the report and the delegate's own rows all live in the body.
- Block order is brief in, report out, counters last: the `task` argument as an
  `input` block, the report as the output block, then a `Details` block holding
  the counters pi handed back — `status`, `turns`, `toolCalls`, and `usage` when
  present. `agent` is omitted because the node title already shows it, and an
  `error` is rendered as the leading error block, not as a counter. The
  delegate's own rows follow the whole body, so the summary reads before the
  detail.
- A failed delegation shows its error instead of an empty report.
- The delegate's rows render inside a `.subagent-run` block, indented behind a
  hairline rail, headed by the agent name and a step count. They collapse with
  the node, so a transcript at rest reads as one card per activity group.
- **An expanded run scrolls in place rather than growing the transcript**
  (D271). A delegate that made forty tool calls would otherwise add forty rows
  the moment its node opens, pushing the reading position and the parent's next
  row out of view. The rows sit in a bounded `.subagent-run-rows` scroll area,
  `min(420px, 48dvh)` tall, with `overscroll-behavior-y: contain` so reaching
  its end does not start scrolling the transcript behind it. The scroll lives on
  that inner wrapper, never on `.subagent-run`, because the collapse rail is
  positioned outside the run's padding box and an overflow there would clip it.
  The run heading stays outside the scroll area, so the attribution cannot
  scroll away from the rows it labels, and the area is a labelled, focusable
  group so a keyboard reader can scroll what the pointer can.
- Every detail block is bounded the same way: `fields` tables cap at 260px like
  `content`, file lists and match lists, so a long roster or a plugin payload
  with thirty keys scrolls instead of stretching the page. A lifecycle row's
  joined reports render as an `output` block — bounded and copyable — rather
  than as a note, which has no height limit.
- Nesting is one level deep by construction: a delegate has no `Task` tool.
- Delegate rows are ordinary rows inside that block — tool rows with their own
  disclosures, thinking rows, and answer rows — so no new presentation is needed
  for what a delegate does.
- **The report is printed exactly once.** When the delegate produced an answer
  row, that row is the report and the body's output block is suppressed; when it
  produced none (aborted, capped, failed), the body prints it.
- Delegate rows never appear in the turn stream, the minimap, or a processing
  group of their own; grouping is by the parent's rows only
  (`03-runtime/04-data-storage.md` §4.7a).
- Runs are rebuilt from the message list on every render, so group memoization
  compares them by row identity and length rather than by object identity —
  otherwise a streaming delegate would freeze at its first row.
- Every `Task` call in an activity group becomes one full-width delegation card
  rather than a compact tool row, a lone delegation included (D265). Its header
  presents aggregate state, the number of subagents, the settled/total count and
  elapsed time; it keeps the standard disclosure caret. The aggregate state is
  count-aware, so a single delegation is not announced in the plural.
- The expanded card renders a low-noise dotted canvas with one main-agent root
  connected to the `Task` nodes in parent-row order. The runtime exposes no
  delegate dependencies and forbids nested `Task`, so the renderer must not
  invent delegate-to-delegate edges or a downstream summary node.
- Each node shows the definition name, short description, explicit outcome,
  runtime duration and step count. The duration uses the delegation registry's
  `startedAt`/`completedAt` timestamps (and ticks live while the node is
  running), not the immediate `Task` tool-call duration. Outcome prefers the
  structured `Task` result
  (`completed`, `truncated`, `timed_out`, `aborted`, `failed`) and falls back to transport
  state (`running`, `error`, `denied`, `success`). Clicking the node expands the
  existing brief/report/counters and nested rows; the report remains printed
  exactly once.
- A topology that first appears while the turn is active opens once so progress
  is visible, and does not auto-collapse when the turn settles. Reloaded history
  remains collapsed by default. The header and every node are keyboard
  disclosures with `aria-expanded`/`aria-controls`; status is written in text
  and reinforced visually rather than conveyed by color alone. At narrow chat
  widths the graph becomes a vertical flow without horizontal page overflow.

### 9.10 A run row's command lives in its head (D226)

A `run` row is the one row whose primary argument is the whole point of the
call. Its head already prints that command, so the body opens on the output
rather than on a `Command` block repeating what the reader just read. The two
things the body no longer offers move up into the head.

```text
└─ [terminal] Ran  pnpm test  exit 1   • Failed  [copy] [›]
   desktop test 648 tests
   1 failing: run head keeps its caret
```

- **The command appears once.** The body of a `run` row holds `Output`, `Errors`
  and any host `notice` — never the command. A PermissionCard has no head of its
  own, so it keeps showing the command it is asking about.
- **Copy sits beside the chevron** and yields the command as it was written,
  including newlines the one-line head hint had to squeeze out.
- **The body is the output, unframed** (D227). A `run` row's blocks drop their
  heading and their card — no border, no fill, no per-block copy button — so the
  expanded row reads like the terminal the text came from. The 260px height cap
  and its scroll stay: a long build must not bury the transcript. `Errors` keeps
  its tint, and each channel's name is carried for assistive technology in place
  of the heading that used to name it.
- **Streaming keeps one stdout channel.** While Bash is running, the renderer
  accepts the runtime's cumulative `details.output` partial result and presents
  it as stdout. The completed `details.stdout` value takes precedence when both
  fields are present, so the final result cannot regress to an older progress
  snapshot.
- **The outcome is what the command did, not what the call did** (D227). It is
  read from the exit code the shell reported: non-zero is `Failed` even when the
  tool call around it came back fine, and a killed shell that reports no code at
  all is `Failed` too. Tools that report no exit code fall back to the call's
  status; a row with neither states nothing rather than claiming `Done`.
- **The outcome is stated, success included**: a toned dot plus `Done`,
  `Failed`, `Denied`, or `Working…`. A `run` row shows no spinner; the running
  dot pulses instead, and holds still under `prefers-reduced-motion`. The label
  carries the meaning, so the dot's hue is never the only signal. A failing
  command opens its own row, whichever layer noticed the failure.
- Both new controls follow the chevron's quiet-until-needed rule: hidden at
  rest, revealed on row hover, on focus, and while the row is open. The status
  label is always visible — it is the outcome, not an affordance.
- The head is a flex row of three controls, so the hover fill belongs to the
  head rather than to the disclosure button inside it; a row that cannot expand
  takes no fill at all.
- The chevron is a pointer target beside the copy control and stays out of the
  reading order, because the head itself is already the keyboard disclosure. The
  visible status label doubles as the row's live region, so the outcome is
  announced once rather than twice.

---

## 10. PermissionCard

### 10.1 Purpose

Inline transcript card requesting user approval for a high-risk tool call. See
[03-permission-ux.md](03-permission-ux.md) for full policy.

### 10.2 Anatomy (inline card)

```text
+----------------------------------------------+
| ⚠ Permission Required                        |
| Tool: Write · Risk: high                     |
| Reason: Agent wants to modify a file         |
| ───────────────────────────                  |
| Args preview (redacted)                      |
| Workspace: /Users/dev/project                |
| ───────────────────────────                  |
| [Allow once] [Allow for session] [Deny]      |
| Timeout: 120s countdown                       |
+----------------------------------------------+
```

The redacted args preview uses the ToolCallRow block presentation (§9.3): a
command reads as shell, file content as code, everything else as label/value
fields. It is never a JSON dump.

### 10.3 Session scope

- The card renders after the originating session's latest activity group.
- Only the active session's pending request is mounted. Background requests
  stay in session-keyed renderer state without inserting content into the
  visible transcript or covering another destination.
- Different sessions may each hold one pending request. Resolution, timeout,
  abort, tool completion, and session deletion clear only the matching
  request.
- Countdown uses the request's absolute receipt time and does not restart when
  the user switches away and back.

### 10.4 States

| State | Appearance | Actions |
|---|---|---|
| Pending | warning accent, countdown visible | Allow once / Allow session / Deny buttons active |
| Resolving | pending appearance retained | All three buttons disabled until the request settles |
| Allowed once | success border, "Allowed (once)" label | No actions |
| Allowed session | success border, "Allowed (session)" label | No actions |
| Denied | error border, "Denied" label | No actions |
| Timeout denied | warning border, "Denied (timeout)" label | No actions |

### 10.5 Interactions

- Buttons: primary (Allow once), secondary (Allow session), danger (Deny)
- Countdown: visible timer decrementing from 120s
- The first action locks all buttons. Resolution errors use an error toast;
  successful or failed completion returns focus to the current composer.
- The originating session's composer cannot send during pending permission,
  while text remains editable (per [03-permission-ux.md](03-permission-ux.md) §7)
- Abort cancels pending permission

### 10.6 Accessibility

- `role="region"` with a localized accessible name; the static title supplies
  the polite live announcement so the per-second timer is not re-announced
- Buttons clearly labeled and reachable in normal transcript tab order; the
  card never traps or forcibly moves focus
- Countdown announced periodically (every 30s) or on request

### 10.7 MVP constraints

- Inline card only; no modal or backdrop fallback
- No "allow always" option (per [03-permission-ux.md](03-permission-ux.md))
- No risk-level customization

---

## 10A. ContractApprovalCard (Plan / Goal)

### 10A.1 Purpose

Inline approval surface for the exact Markdown bytes submitted by the same pi
Agent and preserved in a new immutable `.pi/<kind>/*.md` artifact. It is distinct
from `PermissionCard`: it approves a Plan or Goal → Agent transition and an explicit
execution permission mode, not an individual tool call.

### 10A.2 Content

The card renders the structured title and an opener for the exact
`.pi/<kind>/*.md` path. Opening the artifact reads the host-written file;
renderer edits do not change the approved bytes. The submitted question/
description, status, validity/deadline, inline Markdown, SHA-256, byte size,
and revision/feedback controls are not rendered card content.

### 10A.3 Actions and states

| State | Actions | Contract |
|---|---|---|
| Pending | Approve, Reject | request is live and proposal/session/turn/tool-call/version scoped |
| Resolving | all actions disabled | retain the proposal until host result |
| Approved | no actions | same Agent continues in Agent with selected permission mode |
| Queued / Running | no actions | approved execution is active and tied to the same approval row |
| Rejected | no actions | run stops and session remains in its contract mode |
| Expired / Interrupted | no actions | failed closed; a new contract must be submitted unless approval already committed, in which case session remains Agent |

Approve opens the explicit Ask / Accept edits / Auto choice with the last selected
mode remembered on this device. Reject carries no permission mode. The renderer keeps the latest proposal/execution snapshot per
session only for the current renderer lifetime from live Host events, while only
a pending snapshot has actions or gates the Composer. Renderer reload calls
`plans.pending` and restores a still-pending row with its original deadline while
the host remains alive. It does not rehydrate rejected, expired,
approved/completed, or interrupted terminal cards; a terminal card may remain
visible and non-actionable only until reload. Startup recovery interrupts
pending/queued/running fields before serving RPC, restores no actionable stale
approval, and never replays execution. Pending unapproved work remains Plan and
already-approved interrupted execution remains Agent; the UI is not required to
present the interrupted terminal snapshot after restart.

### 10A.4 Accessibility

- The card is a session-scoped `region` with a localized plan title.
- Approval, reject, and abort controls have explicit labels and
  keyboard focus.
- The selected permission mode exposes radio semantics and its Plan/Goal Bash
  consequence is available in the accessible description.
- Resolution does not navigate to another session or take focus from a
  different session.

---

## 11. Composer

### 11.1 Purpose

Input area at the bottom of MainChat for composing and sending prompts. Supports
multi-line input, mode/permission context, abort, and a combined model ×
reasoning-level control.

### 11.2 Anatomy

```text
+----------------------------------------------------------+
| [Agent/Plan/Goal] [permission mode]          | [model · reasoning ▾] |
| queued messages (optional; one row per item) | [⏹ Stop / → Send] (one submit slot) |
| textarea (auto-growing, 1 line → max 7)                         |
| placeholder: welcome → command/file hint → keyboard hint        |
| (advances only on page/session changes; native value stays accessible) |
+----------------------------------------------------------+
```

### 11.3 Layout

- Height: compact one-line shell by default; textarea auto-grows through seven
  visible lines, then the textarea scrolls internally
- Workspace context: no project, Local, or branch rail is rendered or
  reserved above the shell in either home or thread-docked mode (D095)
- Background: one solid semantic composer surface; no internal gradient,
  background image, or decorative wash
- Elevation: 20px radius with a hairline stroke and restrained soft shadow;
  the docked transcript fade is outside the composer shell
- The solid/near-opaque surface uses no `backdrop-filter`; focus-within adds a
  1px lift and token shadow without forcing transcript repaint through a blur
  layer.
- Border: border-default top
- Padding: px-4 py-3 inner textarea
- Font: text-sm for Agent, Plan, and Goal; mode changes semantics and tool
  controls, not the typography
- The Agent/Plan/Goal mode chip reserves one fixed 88px width, sized from the
  longest built-in label in English and zh-CN ("Agent" / "智能体"). Its label
  stays single-line and ellipsizes if a future locale exceeds that budget, so
  switching modes never reflows the adjacent Composer controls.
- The permission chip remains visible in Agent, Plan, and Goal for a stable
  toolbar rhythm. Agent and Plan expose the effective selectable permission;
  Goal displays the localized Auto label as a disabled, non-opening chip while
  the approval card remains the separate place for choosing execution policy.
- The right toolbar owns one combined model × reasoning-level chip immediately
  before the standalone prompt-enhancement action and the single Stop/Send
  submit slot. The chip shows Bot, the current model name, and the current
  reasoning level separated by `·`; `off` omits the level text. The prompt-
  enhancement action shows Sparkles while idle, uses the shared
  `.tool-spinner` and localized `Enhancing…` label while running, and remains
  a one-shot draft rewrite action.
- The combined chip opens one anchored menu above itself. The menu starts with
  only Model and Reasoning level entries, each showing its current value and a
  chevron. Selecting an entry replaces the menu contents in place with a back
  row and its submenu; selecting a model or level returns to the two-entry root
  without closing the popover. The menu is `min(300px, 100vw - 24px)`, uses the
  large radius/dialog shadow tokens, and enters with a short upward fade.
- The Model submenu establishes a clear provider → model hierarchy: sticky
  provider headings use the stronger `--text-md` section treatment, while
  indented model options use normal-weight `--text-sm` text. In zh-CN, provider
  headings remove uppercase transformation and wide tracking so localized labels
  remain readable.
- Width: Home and thread-docked composers share one `24px` horizontal gutter
  and a `768px` maximum content envelope. The left-edge conversation minimap
  is absolutely positioned outside that envelope, so its appearance or
  disappearance never changes the composer shell width.
- Visual parity: Home and thread-docked composers use the same
  `.composer-shell`, `.composer-input-wrap`, `.composer-input`, and
  `.composer-toolbar` spacing, minimum heights, theme surfaces, and controls.
  Only the parent placement and the localized placeholder copy differ between
  the empty home and a recorded conversation.
- Scroll stability: The thread scrollport reserves stable gutters on both
  inline edges, so the centered transcript does not shift when overflow and
  the minimap first appear.
- Bottom-anchored: fixed at bottom of MainChat area
- Placeholder guidance: home uses `chat.placeholderHome`,
  `chat.placeholderHomeHint`, and `chat.placeholderShortcut`; a session
  composer uses `chat.placeholder`, `chat.placeholderHint`, and the same
  shortcut hint. The selected copy stays stable while the page/session context
  is unchanged. Switching home/session views or active conversations advances
  to the next hint; there is no timer tied to focus, draft, or IME state. The
  visible copy is a keyed opacity fade while the native `placeholder` value
  remains in the textarea for assistive technology.
- Queue rows: while a session is running, each accepted prompt is held in a
  renderer-owned FIFO list above the shell. Rows show the visible prompt (or
  file-reference names), expose independent Remove and Send now actions, and
  increase the dock height measured by `--composer-dock-height`.

### 11.4 States

| State | Appearance | Actions |
|---|---|---|
| Idle (no model) | textarea active, send button disabled + tooltip "Configure a model first" | Agent link remains available in model menu |
| Idle (ready) | textarea active, send button enabled | Send active |
| Home/new-session initialization | textarea and mode/model × reasoning/permission triggers remain available while the durable empty session is loading; the session row is already present and the first configuration selection applies to that session | Configure the session, then send |
| New session (reasoning model) | Combined model × reasoning chip shows the model and its highest enabled level | User may select any level enabled in the model binding, including Off when enabled |
| New session / switch while another session is running | textarea active, send button enabled for the destination session's own run state | Send active, Stop hidden unless the destination session itself is running with an empty draft |
| Running | textarea and mode/model × reasoning/permission controls remain editable for the next turn; the single submit slot shows Stop for an empty draft and Send for a non-empty draft | Stop active when empty; Send active when non-empty; submitted prompts become queued |
| Context checkpoint | Same as Running until durable checkpoint completion; intermediate `turn_end` does not reactivate controls. A retained-tail fallback remains Running and shows a warning toast | Same single-slot Stop/Send behavior as Running |
| Permission pending | textarea disabled (per [03-permission-ux.md](03-permission-ux.md) §7) | Send disabled; Stop remains active whenever the running empty-draft condition is met |
| Plan / Goal / planning | textarea active while idle; contract badge and permission chip visible | inspect, send, or submit a contract |
| Plan / Goal / awaiting approval | approval surface shows only the title and artifact opener for the exact `.pi/<kind>/*.md` approval; draft is preserved read-only and composer controls remain blocked for that session | approve or reject |
| Plan / queued or running | Agent badge remains selected; queue/running state is visible; draft and next-turn controls remain editable | Stop; Send queues the next prompt; no replay control |
| Plan / Goal / planning after rejected, expired, or interrupted proposal | contract chip remains visible and editable | send a later prompt; submit a new contract; no execution action |
| No workspace | textarea active, warning banner "No project — tools limited" | Send enabled |

### 11.5 Interactions

- Enter: send message (configurable: Shift+Enter for newline)
- Send clears the box before the host round trip (D287): the draft leaves the
  textarea in the frame Enter is pressed, so a slow host cannot make a send look
  ignored or let a second Enter queue the same prompt twice. If the store
  rejects the send, the draft (text and file references) returns to the box
  with the caret at its end, unless the user has typed something new, which
  wins; a rejected send for a session the user has since left restores into that
  session's draft slot. The send reads the textarea's live value. A send refused
  because the model is not configured or a paste is still saving shows a toast
  instead of doing nothing.
- The sent prompt is in the transcript in that same frame (D288): the renderer
  inserts the user row under an id it minted and the host echoes the durable
  row under the same id, replacing it in place. File references show under
  their source paths until the echo brings the session-scoped refs; a slash
  prompt shows its typed form until the echo brings the expanded body and
  command chip. A send that never reaches the host withdraws the row again.
  Revalidation and older-page prepends are idempotent by message id, so leaving
  and re-entering a session cannot display a second copy of an existing user
  row.
- Shift+Enter: newline in textarea
- Placeholder guidance: the initially rendered context starts on its welcome copy and remains
  unchanged while the page/session context, draft, focus, and IME state change.
  Switching between home/session views or active conversations advances to the
  next localized command/file or keyboard hint with an opacity fade; there is no
  timer, and clearing or sending a draft never changes the guidance.
- Escape: when textarea focused, clears input or blurs (not abort)
- Send while running: clears the current draft and appends one FIFO row to the
  active session's in-memory queue when the draft has content. The row is sent
  as a new normal prompt only after the current run reaches `agent_end`; a
  different session's queue is not affected by switching sessions. Running
  with an empty draft changes this same submit slot to Stop, so clearing the
  draft is the way to expose the immediate-stop action.
- Send now: moves the selected row to the head, requests `agent/stop`, and
  releases it after the current reply/tool batch completes normally. It then
  starts before the remaining FIFO rows. When idle, Send now sends immediately.
- Stop: the single submit slot is shown only while a turn is running and the
  draft is empty. It stops the running turn and cancels pending permission.
  Before any
  assistant text, thinking, or tool row begins, it also removes the just-sent
  user row and restores the pre-serialization composer draft. Ordinary text
  returns to the textarea and file references return as leaf-name chips; their
  canonical paths never become textarea text. After a reply begins, Abort keeps
  the partial transcript and restores no draft.
- Stop never clears queued prompts. Removing a row is explicit, and queue state
  is renderer-local and intentionally not persisted across restart.
- `turn_end` is not an idle signal. Send and host persistence remain blocked
  through subsequent tool turns and blocking automatic checkpoint generation
  until `agent_end` or `error`; the draft and runtime selectors stay editable
  and hold the latest next-turn choice. A manual-only checkpoint becomes idle
  on its matching `compaction_end`.
- Auto-grow: textarea measures wrapped visual lines, starts at one visible
  line, expands through seven lines, then scrolls internally; deleting content
  shrinks it back to one line
- Resize writes are idempotent (D264): an unchanged height performs no DOM
  write, so `--composer-dock-height` is not republished and the document's
  style is not invalidated while typing inside one row. The `height: auto`
  measurement probe is taken only when the box may need to shrink.
- Draft text and file-reference chips are retained in renderer memory per
  session. Switching sessions saves the source draft and restores the target
  draft; an uncached target and every newly created session start empty. The
  no-active-session home composer has its own slot. A successful send clears
  only the submitting session's slot, including when navigation occurs while
  the request is in flight, and deleting a session drops its slot.
- Text correction off (D145): composer textarea sets `spellCheck={false}`,
  `autoCorrect="off"`, and `autoCapitalize="off"` so browser/OS spelling and
  autocorrect never rewrite coding prompts
- Runtime chips keep descenders fully visible (D150): the model × reasoning,
  permission, and mode triggers in the Composer use compact line-height rather
  than `leading-none` under overflow. The Composer model label ellipsizes long
  IDs.
- Mode, provider/model, thinking, and permission changes update the active
  session immediately while idle. During a turn, the renderer applies the
  latest selection optimistically as a next-turn choice and persists it only
  after `agent_end` or `error`; the host never mutates the running turn's pinned
  configuration. An active pending Plan or Goal approval still disables these
  controls. Approval actions are the exception while awaiting approval. The
  Composer-left Agent/Plan/Goal chip is the sole mode
  control and cycles Agent → Plan → Goal → Agent on click. The Composer-right
  model × reasoning chip owns both selections. Palette and Composer slash mode commands use the
  same active-session configuration path; after host confirmation resolves an
  approval, the approval surface is removed rather than remaining as a terminal
  action card.
- During project or session navigation, the home composer may briefly have no
  `activeSessionId`. Its idle mode, model × reasoning, and permission triggers remain
  enabled while the durable empty session is loading; once selected, the
  configuration applies directly to that session. A new task appears in the
  sidebar before it carries input, and a running turn or pending approval still
  gates those controls.
- While the home composer has no active session, its Thinking trigger resolves
  capabilities from the exact model selected in the model menu (using the
  cached catalog record), not from that provider's default model. Selecting a
  model therefore updates the draft Composer's available levels and strongest
  initial level immediately; the persisted session keeps the same exact-model
  capability after materialization.
- A new session whose inherited default model supports reasoning starts with
  Thinking enabled at that model's highest enabled level. Published levels seed
  a new binding; an explicit binding can opt into a level the catalog omits.
  Non-reasoning models and missing capability metadata start at `off` until a
  user enables a non-`off` level; reopening or reusing an existing session
  preserves its durable selection.
- The model menu lists only enabled, runnable providers with configured model
  bindings. Cached or freshly discovered rows may enrich those configured
  models, but unconfigured discovery results never appear in the conversation
  list; configured IDs remain visible when discovery is unavailable.
- The combined model × reasoning menu opens at `bottom: calc(100% + 8px)` with
  `role="menu"`. Its root has exactly two `role="menuitem"` entries. The Model
  submenu has a search input and sticky provider headings, while the Reasoning
  level submenu starts with `Current model <model> supports these reasoning
  levels` and lists the selected model binding's enabled levels in canonical
  order.
  Rows use `role="menuitemradio"`, `aria-checked`, active-row styling, and a
  trailing check. Selecting a concrete model or level persists the complete
  session config, clears model filtering, and returns to the root without
  dismissing the menu. Closing and reopening always starts at the root.
- Unknown Custom/OpenAI-compatible models remain at `off` until the user
  explicitly enables a level in Settings. The menu never auto-infers reasoning
  support; after an explicit binding selection it renders the configured level.
- Switching provider preserves an available level, otherwise uses the nearest
  supported level (upward first, then downward); a non-reasoning provider
  persists `off`.
- The combined menu closes on outside mousedown or Escape. In a submenu,
  Up/Down moves the highlighted row, Enter selects from the model search/list,
  and Left returns to the root.
- The permission chip remains visible beside the mode selector. Agent and Plan
  show the effective Ask / Accept edits / Auto posture. Goal keeps the same
  geometry but is fixed to the localized Auto label and cannot open a menu;
  its approval card remains the separate place for choosing execution policy.
  The control does not imply that Write/Edit/plugin tools are available.
- Goal shares the Plan approval surface (D198). The bar reads its copy from the
  proposal's `kind`, so a goal contract shows the matching approval label and
  artifact opener while the layout and remembered permission split-button stay
  identical.

### 11.6 Accessibility

- `role="textbox"` with `aria-label="Message input"`
- Editable text controls never enable browser spellcheck or autocorrect (D145)
- Send button: `aria-label="Send message"`
- Stop button: `aria-label="Stop generating"`
- Queued prompt list: `aria-label="Queued messages"`; each row has an
  accessible Remove button and a Send now button.
- Disabled send: `aria-disabled="true"` with tooltip explanation
- The combined model × reasoning chip exposes `aria-haspopup="menu"` and
  `aria-expanded`. Its root entries use `role="menuitem"`; model and reasoning
  rows use radio-menu semantics with `aria-checked="true"` on the selected row.
  Escape/outside click closes the menu; Up/Down, Enter, and Left provide list
  navigation and root return.

### 11.7 MVP constraints

- Pasting one or more OS clipboard files or images saves their bytes into the
  originating session's scratch directory and adds a compact leaf-name
  reference above the textarea. A text-only paste at or below the configured
  `largePasteThreshold` keeps the browser's native textarea behavior; a paste
  above it is saved as UTF-8 in the session's scratch `pasted/` directory and
  inserts an inline temporary-file token at the paste position (D197, D209,
  D262, ADR 0059, ADR 0070, ADR 0131)
- The compact chips retain structured kind/name/MIME metadata while keeping
  the textarea free of binary data. The selected model's models.dev
  capability controls dispatch when its exact models.dev record matches;
  unknown IDs use the generic conservative shape. Eligible images become
  transient visual input for a model whose models.dev `input` includes `image`;
  non-vision, unknown, and oversized images use the existing canonical
  `@<path>` file-tool fallback.
  There are no visual previews in MVP.
- No voice input

### 11.8 Slash commands, @ file references, and clipboard files (D123–D125, D197, D209, D262, ADR 0024, ADR 0059, ADR 0070, ADR 0131)

The composer owns an inline autocomplete menu — one component serving two
modes. Focus never leaves the textarea (D125).

Anatomy:

```text
┌──────────────────────────────────────────────┐
│  group label (sticky)                        │
│  ▸ item title      argument-hint   descr.    │  ← kb-active row
│  ▸ item title                      descr.    │
│  …                                           │
│  ↑↓ select · Enter confirm · Esc close       │  ← hint bar (footer)
└──────────────────────────────────────────────┘
[ image.png × ] [ another-file.ts × ]           ← when references exist
[ composer textarea                            ]
```

- Anchored above the input, spanning the full composer width; same elevated
  surface recipe as the model menu (opaque elevated background, dialog
  shadow, subtle hairline, `--radius-lg`); max-height caps with internal
  scroll and `scrollIntoView(nearest)` keyboard follow.
- Slash mode (`/` typed at position 0, cursor inside the first token, no
  whitespace yet): the placeholder teaches `Type / for commands · @ for files`
  (localized in zh-CN), and groups appear in order — prompt templates (name +
  `argument-hint` ghost text + description, project source before
  user-global), app commands (builtin slash aliases), plugin commands.
  The core aliases remain `/new`, `/compact`, `/agent-mode`, `/plan-mode`, and
  `/goal-mode`; matched characters highlight in accent.
- File mode (`@` token at cursor, boundary-preceded): rows persistently show
  only the leaf file or directory name; directories get a trailing `/` and
  continue completion on accept. The complete relative path remains available
  through the row tooltip and accessible name. Accepting a completed file adds
  a compact reference whose canonical value is the original `entry.path`;
  accepting a directory keeps the literal path in the textarea so completion
  can continue. Entries come from `fs/index` (D124, D209). A
  truncation footnote appears when the index is capped; without a workspace the
  menu shows an "open a project" empty state.
- Accepting commands and directories inserts text (`/name ` / `@dir/`);
  accepting a completed file creates a renderer-owned reference. Immediately
  before dispatch, ordinary references serialize in stable order after the
  visible draft as complete `@path` text using D124's quoting. A generated
  large-paste token is resolved in place to its canonical scratch path exactly
  once; it is not also sent as a structured attachment or appended basename.
  Pasted OS file/image references continue to travel as structured attachments;
  main selects image blocks or path fallbacks from the exact model capability.
  Reference-only drafts are sendable. Builtin/plugin dispatch still bypasses
  the model-ready gate when no prompt text or file reference is sent.
- The Agent/Plan/Goal mode aliases can prefix a prompt in the same draft:
  `/agent-mode <prompt>`, `/plan-mode <prompt>`, and `/goal-mode <prompt>` apply
  the mode first, then send `<prompt>` plus any serialized references through
  the normal prompt path so the user turn remains in the transcript.
  An alias-only mode command remains local. The composer is cleared only after
  the local action or prompt dispatch is accepted; a failed dispatch retains
  the complete visible draft and references for retry.
- Accepted prompt dispatch retains a renderer-only, session/turn-scoped
  structured undo snapshot while the turn remains unanswered. Smart Stop
  restores that snapshot in its original reference order instead of copying
  serialized message paths back into the textarea. Stop after reply start does
  not restore or duplicate the submitted draft.
- A paste containing files is intercepted only when the clipboard exposes at
  least one `File`. The renderer transfers bounded file bytes, name, and MIME
  metadata to Electron main with the durable session id. Main validates the
  session, writes unique sanitized files under
  `<data_dir>/scratch/<sessionId>/pasted/`, and returns each UUID-backed
  absolute path with its sanitized original leaf name and kind. The composer
  displays the leaf name, keeps the structured reference in session-scoped
  transient state, and submits it separately from visible text. Main stores
  image bytes under `attachments/<sha256>` and sends visual input only when the
  selected models.dev model accepts images and the 20 MiB inline bound is met;
  otherwise it appends a safe `@path` fallback. Removing a chip does not delete
  scratch bytes. A text-only paste longer than `largePasteThreshold` follows
  the same bounded session bridge with generated `text/plain` UTF-8 bytes,
  inserts `@<sanitized-name>` plus a trailing space at the original selection,
  and keeps its canonical path mapping in the renderer draft. The default
  threshold is 600 characters and is persisted in app settings. Pasting either
  files or oversized text counts as input, so the home composer materializes the
  startup-only home draft into a durable session before saving when no active
  session is available. The scratch lifecycle removes pasted files with the
  session and never dirties the workspace git tree.
- Reference chips wrap within the prompt area, expose the canonical path in
  their tooltip and accessible name, and provide a focus-visible localized
  remove button that restores textarea focus. Duplicate leaf labels remain
  separate because identity and dispatch use the canonical path, not the name.
  Image and file references use the same compact chip treatment; no separate
  explanatory vision-status row is rendered.
- Sent template invocations render in the transcript as a monospace command
  chip from the message's `command` field instead of the expanded body.
- States: keyboard-active row uses the shared `kb-active` treatment; empty
  query lists everything (slash) / recently indexed order (file); zero
  matches renders the localized empty row and the menu counts as closed for
  key handling.

---

## 12. Model selection

### 12.1 Purpose

Model selection is part of the Composer's combined model × reasoning menu in §11;
there is no separate top-bar model selector.

### 12.2 Anatomy

```text
[✨ model-name · reasoning level ▾]
```

### 12.3 States

| State | Appearance |
|---|---|
| Configured | shows the current model and reasoning level, clickable from the Composer |
| No provider | muted model text with a settings entry in the Composer menu |
| Running | remains available for next-turn configuration |
| Dropdown open | model and reasoning entries open in-place submenus |

### 12.4 Interactions

- Click: opens the Composer menu with model and reasoning entries
- Cached provider models are available on the first open after restart; a
  background refresh updates the list without clearing it first
- Select: switches model for current session
- On the home/new-session draft, selecting a model also updates the Composer's
  Thinking capability and level from that exact catalog model before the first
  message creates the session.
- Keyboard: up/down arrow in dropdown, Enter to select, Escape to close
- Long option labels may ellipsize inside the compact menu; each option renders
  one display name only, falling back to the model ID when no display name is
  available. The native hover tooltip exposes that complete display name
  without resizing or reflowing the menu; the model ID is not rendered as a
  second visible label.

### 12.5 Accessibility

- The Composer model × reasoning chip exposes `aria-haspopup="menu"` and
  `aria-expanded`; its current value is announced via `aria-label`
- Model and reasoning rows: `role="menuitemradio"` with `aria-checked`

### 12.6 MVP constraints

- No model favorites/pinning
- No custom model creation from selector (use settings)
- Dropdown shows model bindings configured for enabled providers only;
  provider discovery enriches those rows but does not expose additional
  conversation models.

---

## 13. ProjectPicker

### 13.1 Purpose

Control in Topbar showing current workspace. Allows opening or clearing a project folder.

### 13.2 Anatomy

```text
[folder icon] /path/to/project   or   "No project"   [open button]
```

### 13.3 States

| State | Appearance |
|---|---|
| Active project | folder name shown, clickable path |
| No project | "No project" muted text + "Open folder" link |
| Opening | disabled, "Opening..." spinner |

### 13.4 Interactions

- Click path: opens system file dialog to select folder
- "Open folder": same action, explicit button
- "Clear project": explicit clear button

### 13.5 Accessibility

- Current project: `aria-label="Current project: /path/to/project"`
- "No project": `aria-label="No project open"`
- Open button: `aria-label="Open project folder"`

### 13.6 MVP constraints

- Project selection may activate a retained tab or add a new local project
  tab; the host still exposes one selected workspace
- No project status indicators beyond path display

---

## 14. StatusBar

### 14.1 Purpose

Optional bottom bar showing runtime status indicators. **Deferred from MVP** — mentioned in IA but not implemented in M1–M3.

### 14.2 MVP constraints

- Not implemented in MVP
- Status indicators (running/error/idle) shown in Topbar instead
- Future: separate spec when implemented

---

## 15. Empty states

### 15.1 Purpose

Guidance surfaces when key data is absent. Must always provide an **action link**, not just a message.

### 15.2 States

| Context | Message | Action |
|---|---|---|
| No sessions | "Start your first conversation" | "New Task" button → focus composer |
| No provider | "No model provider configured" | "Add provider" link → Settings → Agent → Providers |
| No project (Agent, Plan, or Goal) | "No project open — workspace tools unavailable" | "Open folder" button → ProjectPicker |
| Session empty (first message) | Contextual placeholder guidance (`chat.placeholder`, command/file hint, or keyboard hint) | N/A |
| Home empty (first message) | Contextual placeholder guidance (`chat.placeholderHome`, home command/file hint, or keyboard hint) | N/A |

### 15.3 Layout

- Chat home empty: single scrollable stack (hero → optional checklist) centered
  in MainChat, with a bottom-reserved composer sibling; task entry starts
  directly in that composer without a starter-card or quick-action layer
- Other empty surfaces: text-xl heading + text-sm description + primary action
- Icon (48px Lucide / brand mark) above heading where applicable
- Background: bg-primary (transparent, not a card)

### 15.4 Accessibility

- Action buttons are keyboard-focusable
- `aria-label` on icon providing context description

### 15.5 MVP constraints

- No animated empty-state illustrations
- No product tour overlays (per [05-onboarding.md](05-onboarding.md) §6)

---

## 16. Command palette surface

### 16.1 Purpose

**Status: merged into the global search surface.** The command palette overlay was removed; its command list (built-in + plugin commands) now renders as the "Commands" section inside `SearchDialog` (opened with Cmd/Ctrl+K or Cmd/Ctrl+Shift+P). Defined in [04-builtin-commands.md](04-builtin-commands.md) and surfaced by the global search component spec.

### 16.2 Anatomy

```text
+----------------------------------------------+
| [search input]                               |
| ───────────────────────────                  |
| Results list (scrollable)                    |
|   Category: Session                          |
|     ▸ New Task                               |
|     ▸ Delete Current Session                 |
|   Category: Mode                             |
|     ▸ Switch to Plan                         |
|     ▸ Switch to Goal                         |
|     ▸ Switch to Agent                        |
|   Category: Turn                             |
|     ▸ Abort Active Turn                      |
| ...                                          |
+----------------------------------------------+
```

### 16.3 Layout

- Position: centered overlay, max-width 480px, max-height 360px
- Background: bg-elevated-opaque (elevated floating surface, consistent with `.dialog` / `.search-dialog`), radius-lg-plus, shadow-dialog
- Z-index: `z-command-palette` (60)
- Backdrop: semi-transparent bg-primary (0.5 opacity)

### 16.4 Interactions

- Search: filters commands by title and keywords
- Keyboard: arrow up/down navigate, Enter execute, Escape close
- Click: execute command

### 16.5 Accessibility

- The standalone palette overlay no longer exists; commands are part of the global search dialog (`role="dialog"`, `aria-label` from `nav.search`).
- The "Commands" section uses the same `role="listbox"` / `role="option"` semantics as the other search result groups.
- Search input auto-focused on open; arrow up/down navigate, Enter executes, Escape closes.

### 16.6 MVP constraints

- No sub-command nesting (flat list)
- No command history/recents
- Plugin commands appear alongside builtin commands

---

## 17. Toast

### 17.1 Purpose

Transient, non-blocking feedback for completed actions and failures that have no inline surface (background events, cross-page confirmations). One global stack — never per-page toast markup.

### 17.2 Anatomy

```text
                        ┌  toast-viewport (fixed top-center, z-toast) ┐
                        │  ┌──────────────────────────────────────┐ │
   newest, at anchor →  │  │ (✓)  Provider saved               ✕  │ │
                        │  ├──────────────────────────────────────┤ │
   oldest, pushed down →│  │ (i)  Message text                 ✕  │ │
                        │  └──────────────────────────────────────┘ │
                        └───────────────────────────────────────────┘
```

- `ToastHost` (in `components/Toast.tsx`) renders the stack; mounted once per shell branch in `App.tsx`
- Each card: 16px variant icon (semantic tint) · message · X dismiss button
- Surface: `bg-elevated-opaque` + 1px `border-subtle` + `shadow-dialog`, radius-md-plus — same floating family as menus; metrics in [07-ui-design-system.md §11.8](07-ui-design-system.md#118-toast)

### 17.3 API

State lives in the app store (`useAppStore`):

```ts
showToast(message: string, options?: {
  variant?: "info" | "success" | "warning" | "error"; // default "info"
  duration?: number; // ms; default 4000 (error 8000); 0 = sticky
});
dismissToast(id: number); // ToastHost internal / tests
```

### 17.4 Usage rules

| Rule | Detail |
|---|---|
| Variant semantics | `success` = a user action completed (saved, created, loaded). `error` = an operation failed (every `catch` path). `warning` = degraded/at-risk state that self-resolves. `info` = neutral notice (context echo, "not available yet"). |
| Errors always toast as `error` | `showToast(e instanceof Error ? e.message : String(e), { variant: "error" })` — never the default variant |
| No caller timers | Auto-dismiss is owned by the toast system; callers must not `setTimeout`-clear |
| i18n | Messages come from the i18n catalog (D073); raw host/provider error strings pass through unchanged |
| Not for blocking flows | A tool decision uses the inline PermissionCard, not a toast |
| Not for inline validation | Field-level errors render next to the field; message-bound provider failures render as assistant error messages in the transcript |
| Host-pushed toasts | Plugin/main-process toasts arrive via `api.onToast` and render as `info` |

### 17.5 Behavior

- Auto-dismiss 4s (error 8s, `duration: 0` sticky); hovering a card pauses its timer, leaving resumes with remaining time
- Stack caps at 4 — oldest drops first; re-raising an identical message+variant restarts the existing toast instead of stacking a twin
- Newest toast enters at the top-center anchor (slide-down 200ms ease-out) pushing older cards down; exit is a 150ms ease-in fade
- Dismiss X always available; every card is an explicit non-drag pointer target
  so hover pause and dismissal remain interactive where the top-center stack
  overlaps frameless titlebar drag chrome
- Reduced motion keeps animations near-zero-duration so removal (bound to
  `animationend`) still fires

### 17.6 Accessibility

- Viewport is `aria-live="polite"`; `success`/`info` cards are `role="status"`, `warning`/`error` are `role="alert"`
- Dismiss button labeled with `toast.dismiss` catalog key
- Icons are `aria-hidden`; the variant is conveyed by the announced role, not color alone

### 17.7 MVP constraints

- No action buttons inside toasts (post-MVP; use the inline error banner for actionable errors)
- No progress/loading toasts — running state belongs to the working indicator
- No toast history surface

---

## 18. SessionImportPanel

### 18.1 Purpose

Scan supported local agent stores, review discovered sessions in manageable
groups, select candidates, and start an explicit import.

### 18.2 Anatomy

```text
[Found N sessions]  [Group by: Source ▾]  [Import selected (N)]
──────────────────────────────────────────────────────────────────
[ ] [›] Claude Code                                      N sessions
[ ] [›] Codex                                            N sessions
```

- The grouping control supports **Project path** and **Source**.
- Source is the default grouping.
- In project-path mode, exact paths remain visible in group headers.
- Sessions without a project path appear in a final **No project** group.
- Each group header includes group selection, disclosure, label, and count.
- Import source names, grouping controls, counts, results, and accessible names
  come from the shared i18n catalog. Candidate dates use the active app locale.

### 18.3 States and interactions

- A successful scan replaces the prior candidate set, clears selection, and
  leaves every group collapsed.
- A successful import creates or reuses one durable Projects-index entry for
  each distinct non-empty project path and refreshes sessions/projects.
- Path-less imports create no project entry and remain under Temporary
  sessions. Import never creates a physical filesystem directory.
- Re-importing an existing source session skips it without duplicating its
  project entry.
- Changing the grouping mode preserves candidate selection but collapses every
  newly formed group.
- Expanding or collapsing one group does not affect the others.
- Group and global checkboxes support checked, unchecked, and indeterminate
  selection states as applicable.
- Candidates inside each group and groups themselves are ordered newest first;
  the path-less group remains last in project-path mode.

### 18.4 Accessibility

- Each disclosure button exposes `aria-expanded` and references its body with
  `aria-controls`.
- Global and group checkboxes have localized accessible names.
- The grouping selector has a visible label and is keyboard-operable.
- Projects-row disclosure and action-menu buttons expose localized,
  project-specific accessible names.

---

## 19. ProviderStudio (Settings → Agent)

### 19.1 Purpose
Modern model-configuration surface for adding OpenAI-compatible providers,
reviewing readiness, and managing connection/default behavior without a dense
form dump. Vendor-account identity and default-model editing live in the same
surface, while model metadata remains owned by models.dev and transport
compatibility remains owned by pi-ai.

### 19.2 Anatomy
1. **Defaults card** — a compact settings row reusing the shared
   14px/16px row geometry; the Default model label sits above the provider name
   and exact model ID, while a quiet Change action opens the picker without
   duplicating the current value. The floating listbox is anchored to that
   action rather than expanding the card in place: the surface portals to
   `document.body` as a fixed layer so the panel's overflow cannot clip it,
   groups model-level options by provider, marks the exact current entry, bounds
   its own height so many configured models scroll instead of stretching the
   card, flips above the trigger when there is no room below, and closes on
   Escape, an outside press, or the trigger scrolling out of view;
   global operating mode, command shell, and Enter-to-send live in the Settings
   AI destination
2. **Vendor accounts** — section title + primary Add account action and one
   single-level list panel using the same row surface as AI services; one row
   per OAuth account, including duplicate vendors, with account label, Edit,
   Test connection, and Remove actions; the default model is edited in the
   account dialog and selected from Defaults
3. **Providers head** — section title + primary Add provider action; its
   button treatment matches Add account
4. **Dialogs** — both the vendor-account edit dialog and the provider dialog
   render the same model picker component (D270): the account dialog carries the
   account label plus that picker, and the provider dialog adds the connection
   fields (name, base URL, API style, API key). In both, the picker is a
   fixed-position searchable multi-select model picker with free-form custom
   model entry and a compact configuration list. Each selected model is a
   scannable row with its ID, source, capabilities, and token limits; the row
   expands in place to expose context window, max output, seven thinking-level
   chips, and a constrained default-thinking select. The thinking label and
   optional catalog hint sit above one compact, keyboard-operable grouped
   control; its options wrap only when the pane is narrow. The first row starts
   expanded and additional rows start collapsed so large model sets do not
   become a wall of repeated forms.
5. **Provider cards** — avatar initials, badges (default / secret state), host + first model, Test / Make default / Delete

### 19.3 States
| State | Presentation |
|---|---|
| Empty | Defaults shows No default; empty panels expose their primary add actions |
| Populated | Accounts and AI services list their rows; add/edit flows open modal dialogs |
| Account editor | The account label plus the shared model picker (D270): the account's models, per-model limits, and thinking levels are all editable here, with suggestions coming from the authenticated account's entitlements when available, free-form IDs still accepted, and the picker's fixed layers not changing dialog layout or getting clipped by dialog overflow |
| Default provider | Card gets subtle accent wash + default badge; Make default hidden |
| Secret missing | Warning badge "No API key"; test may fail closed |
| Busy row | Test/update/delete actions disabled for that card |

### 19.4 Interactions
- Add provider opens a modal dialog; Cancel/close resets fields and dismisses the dialog
- The model picker searches and toggles multiple models without using a native
  multiple select. Its portaled menu closes on outside press, Escape, scroll,
  and resize; model selection immediately adds or removes its configuration
  row. Configuration rows stay compact until expanded; expanding one row does
  not expand or collapse any other row.
- Adding a custom model validates non-empty and duplicate IDs, adds it to the
  top-level option list, selects it, and applies 128,000 context / 8,192 max
  output / no thinking defaults. Removing its selection does not delete the
  custom option.
- Save creates or updates the provider with `models: ModelBinding[]`, stores
  the secret, sets the first configured model as the legacy/default model for
  older consumers, and refreshes the list
- Test connection calls `providers.testConnection` and toasts success/failure
- Edit account saves `oauthAccountLabel`, `defaultModelId`, and the full
  `models: ModelBinding[]` with explicit thinking selections through
  `providers.update`, exactly like the provider dialog; the account's default
  model remains the head binding, and when the account is the global default,
  its model selection updates with it
- Test connection on an account resolves that account's OAuth authorization and toasts success/failure
- Context, output, thinking-level, and default-thinking edits persist per model
  through `providers.create` / `providers.update`; runtime callers continue to
  use the first configured model until multi-model conversation selection is
  implemented
- Make default updates `defaultProviderId` / `defaultModelId` only

### 19.5 Accessibility
- Segmented controls expose `aria-pressed`
- Enter-to-send uses `role="switch"` + `aria-checked`
- Model configuration rows expose `aria-expanded` and reference their details
  with `aria-controls`; collapsed details are removed from the tab order
- Card actions keep visible text labels; thinking select has an accessible name
- Empty regions and account actions expose localized labels

### 19.6 MVP constraints
- OpenAI-compatible path only in the provider composer (vendor marketplace deferred)
- No raw secret redisplay after save
- No catalog browser yet; custom model id remains first-class

---

## 20. NotificationInbox (D117)

### 20.1 Purpose

Expose the bounded, host-owned history of task completion and failure events
the user did not already see in the focused current chat, without turning
transient toasts into history. The inbox is local-only and durable across app
restarts.

### 20.2 Anatomy

```text
Sidebar footer                                        Popover (360px max)
[Bell (12)]  ->  [Notifications]       [All | Unread] [Mark all read] [Clear]
                 ------------------------------------------------------------
                 [unread dot] [check] Task completed              2m
                                      Session title
                 ------------------------------------------------------------
                              [x]     Task failed                  9m
                                      Session title · ERROR_CODE
```

- Trigger: 32px Lucide `Bell` icon button at the right of the expanded sidebar
  footer, replacing the former Help shortcut. The main titlebar has no
  duplicate. A compact badge renders `1`–`99` and `99+`; its accessible label
  retains the exact count (the durable store is capped at 200).
- Popover: width `min(360px, calc(100vw - 24px))`, opens above and to the right
  of the footer, and is no taller than the available window, with one internally
  scrollable row list.
- Header: localized title, `All` / `Unread` segmented filter, Lucide
  `CheckCheck` mark-all-read button, and Lucide `Trash2` clear button. Icon-only
  actions carry localized tooltips and accessible names.
- Row: unread dot, semantic completion/failure icon, localized event label,
  snapshotted session title, optional stable failure code, and localized
  relative time. Rows are dense list items separated by hairlines, not cards.
- Display title/body are derived at render time from `kind`, `sessionTitle`,
  and optional `errorCode`; no localized title/body string is persisted.

### 20.3 States

| State | Behavior |
|---|---|
| No unread | Bell has no badge; Mark all read is disabled |
| Unread | Badge shows count; unread rows carry dot and stronger label weight |
| All empty | Centered compact “No notifications” empty state; list actions disabled |
| Unread empty | “You're all caught up”; All filter remains available |
| Loading/refresh | Preserve current rows and filter; disable mutations until refresh settles |
| Mutation failure | Keep the existing list and announce an error toast; do not optimistically lose rows |

### 20.4 Interactions

- Bell toggles the popover. Opening does not implicitly mark anything read.
- `All` shows the newest retained rows; `Unread` filters to `readAt == null`.
- Selecting a row first calls `notification.markRead`, closes the popover, then
  activates the row's durable session (including its project when applicable)
  and scrolls the transcript to its latest content.
- Mark all read is idempotent and preserves rows. Clear deletes every inbox
  row but never deletes a session, transcript, or turn.
- `notification.changed` updates the visible list and badge. Opening the
  popover also refreshes the bounded list from host-core. A
  `notification.activated` event from Electron follows the same session
  activation path as a row click.
- Completion/failure enters the durable inbox unless the main window is
  visible/focused and the exact finishing session is the current chat. A
  focused background session still enters the inbox without a native banner;
  an unfocused current session enters the inbox and receives a native banner.
  Clicking the banner restores/shows and focuses the main window before
  emitting `notification.activated` for the matching session.
- Aborted turns, permission requests, scheduled reminders, and plugin
  notifications do not enter this inbox.

### 20.5 Accessibility

- Popover is a labelled, non-modal `role="dialog"`; the row collection is a
  semantic list and every row is one button with a complete localized name.
- Opening focuses the first unread row, otherwise the first row, otherwise the
  `All` filter. `ArrowUp` / `ArrowDown`, `Home`, and `End` move among rows;
  `Enter` / `Space` activate the focused row.
- `Tab` follows DOM order through filters, header actions, and rows without a
  focus trap. `Escape` or outside press closes the popover; Escape restores
  focus to the bell.
- Badge changes are announced through one polite status region using the exact
  unread count. Completion/failure meaning uses icon, text, and accessible
  name, never color alone.
- Native notification accessibility and activation semantics use the platform
  API; the renderer does not recreate native banners.

### 20.6 Constraints

- The list contains only `task.completed` and `task.failed` records produced
  from unseen terminal agent turns. Visible-current results and `aborted` turns
  are intentionally silent.
- At most 200 newest rows are retained globally. There is no pagination,
  scheduled notification source, permission-notification source, preferences
  page, notification permission prompt, or cloud sync.

---

## 21. Acceptance criteria (all components)

1. All components use semantic color tokens from [07-ui-design-system.md](07-ui-design-system.md) — no raw hex
2. All interactive elements have visible focus rings (2px accent, offset 2px)
3. Layout shell metrics (46px titlebar row, ~275/48 sidebar, 280 context,
   compact composer with 1–7-line draft growth) match spec
4. Chat messages constrained to 720px max width
5. ToolCallCard shows status, args preview, result preview, duration per [01-ui-ia.md](01-ui-ia.md) §5
6. PermissionCard shows tool name, risk, args, countdown, and three action buttons per [03-permission-ux.md](03-permission-ux.md)
7. Composer: Enter sends, Shift+Enter newline, draft grows from one through
   seven visible lines then scrolls, and the single submit slot shows Send for
   a non-empty draft or an idle/empty draft, and Stop only for a running empty
   draft
8. Composer model × reasoning chip shows the provider/model pair; remains
   available for next-turn configuration during a stream; links to settings
   when unconfigured
9. Command palette opens at z-index 60, traps focus, supports keyboard navigation
10. Empty states always provide an actionable next step, not just a message
11. All components have correct ARIA roles and labels
12. Responsive collapse works at 800px and 640px breakpoints
13. Toasts stack top-center with variant icon + dismiss, auto-dismiss 4s/8s, pause on hover, and announce via `role="status"`/`role="alert"` per §17
14. Session import defaults to source grouping, offers project-path grouping, collapses all groups after scan/group changes, and exposes accessible group disclosure state per §18
15. Imported project paths materialize exactly once in the durable Projects index; path-less imports remain Temporary sessions and no filesystem directory is created
16. ProviderStudio shows compact defaults, vendor-account rows with edit/test/delete actions, add/edit dialogs, and AI service cards; secrets never render raw; every action remains keyboard reachable
17. NotificationInbox exposes All/Unread views, exact unread badge semantics,
    row activation, mark-all-read and clear actions; it is keyboard-operable
    and never treats a visible-current or aborted turn as a notification
18. The outer right native edge resizes the fixed work-panel target while the
    inner divider resizes the MainChat target; other native edges reflow MainChat
    without compressing the panel. Panel visibility, outer-edge commits, and
    inner-divider chat requests update their own target, and cancelled divider
    gestures restore the prior chat target (ADR 0146)
19. Expanded sidebar session titles, project/group titles, and empty-state copy
    use the 13px compact token while primary sidebar actions remain at 14px
