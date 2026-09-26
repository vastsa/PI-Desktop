# 08. Component Spec

> Layout and IA reference: [01-ui-ia.md](01-ui-ia.md)  
> Design tokens and foundations: [07-ui-design-system.md](07-ui-design-system.md)  
> Interaction behavior: [09-interaction-patterns.md](09-interaction-patterns.md)


> Shell layout is Codex-aligned: left thread sidebar (240–520px, default 275px), main transcript, floating bottom composer with runtime mode/permission/model controls, and a compact action-only top bar. Prefer neutral charcoal surfaces over blue-slate chrome.
>
> **Precedence rule**: where a metric or copy string below disagrees with a
> Codex parity decision in [decisions-log §D](../08-meta/decisions-log.md)
> (D034+), the decision log wins — it tracks the live gold captures. Known
> updated values: sidebar 240–520px (default 275px), toolbar 46px (not 44px),
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
| (240–520px / 48px) | (flex-1)                   | (≥244px / dynamic|
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
| Work panel open in a fixed client area | Work panel keeps its committed width while MainChat keeps its 450px hard floor; the expanded sidebar yields first when the budget is exhausted |
| Preview (maximize) | MainChat is unmounted and the work panel fills the client area beside the sidebar; a window-level chrome row keeps shell actions and native window controls available |
| Fullscreen | Topbar remains; sidebar toggle and artifact-driven panel stay available |

### 1.4 Interactions

- Sidebar toggle: keyboard shortcut + icon button in the expanded
  sidebar header; the button moves to the main titlebar while collapsed. The
  collapse and expand use a mounted-then-animated dock transition (entrance
  `sidebar-in`, exit `sidebar-out` keyframes) that mirrors the work-panel dock:
  the aside stays in the tree through the exit keyframe, then unmounts
  (`is-exiting` flag + `animationend` guard, with a timeout fallback).
  Entrance requires an explicit `is-entering` phase from a collapsed-to-expanded
  change on the presented main shell. Initial mounting and return from Settings
  restore the full retained layout directly. Entering Settings cancels either
  pending phase, including during rapid navigation; no hidden shell is kept
  mounted solely to suppress animation.
- Sidebar width: the expanded column is user-resizable from 240px to 520px
  (default 275px) via the right-edge handle. Dragging below 160px collapses
  the sidebar and preserves the preferred expanded width (ADR 0141 / ADR 0290).
- Work panel collapse: the sole control is the viewport-fixed toggle in the
  window's top-right corner, available on every non-Settings route whether the
  panel is open or closed. It does not sit in the work-panel content header.
  Opening and collapsing change only the shell's internal flex allocation; the
  native window bounds stay unchanged.
- Work panel preview: the header maximize action temporarily unmounts MainChat
  and expands the panel across the client area beside the sidebar. A window-level
  46px chrome row keeps New Task/sidebar and native window controls, with
  pointer passthrough and no drag/no-drag rectangle outside its controls.
  The panel header alone owns dragging in the preview pane; its border box
  excludes the shell action lane in both sidebar states on every platform.
  On macOS, collapsed-sidebar preview reserves 88px in windowed mode and 8px
  in fullscreen through the shared `--ds-window-lead-inset` token — the
  traffic-light cluster's right edge (76px, from `@pi-desktop/shared`) plus a
  12px gap. The main process uses that same shared geometry.
- Work panel resize: its inner left-edge handle changes the committed panel
  width in the renderer, so dragging left gives the panel more internal space
  and dragging right returns space to MainChat (§5.4)
- Window resize: native edges and corners resize the fixed application window;
  they never resize or reserve the work panel. Responsive layout follows
  [07-ui-design-system.md](07-ui-design-system.md) §10.1

### 1.5 Accessibility

- Landmark roles: `<nav>` for sidebar, `<main>` for chat, `<aside>` for work panel, `<header>` for topbar
- Tab sequence: topbar → sidebar → main chat → work panel → composer

### 1.6 MVP constraints

- Sidebar width is user-resizable from 240px to 520px (default 275px) and
  remains independent from the collapsed icon-rail state; the work panel remains adjustable from its own divider
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
  While a session is running, or still holds live rows the durable page has
  not caught up to, its renderer-owned live cache is the lower-water mark for
  revalidation: a durable `session.get` result may add newer completed rows
  but must not erase an in-flight or not-yet-flushed assistant/tool tail, and
  must keep live rows that the bounded page dropped in chronological order so
  the newest turn stays in the mounted trailing window (D317, D324). Deleting
  a session releases its pane, snapshot, and live cache.
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
| macOS | Native inset traffic lights at `{x:16,y:16}`; expanded sidebar Collapse control at right, with no logo/title; work-panel toggle is viewport-fixed at the window's top-right | System menu: PI-Desktop, File, Edit, View, Window, Help |
| Windows | Frameless 46px titlebar; sidebar actions at left; work-panel toggle then minimize/maximize/close stay viewport-fixed at the window's top-right | None inside the window |
| Linux | Frameless 46px titlebar; sidebar actions at left; work-panel toggle then minimize/maximize/close stay viewport-fixed at the window's top-right | None inside the window |

- macOS enables the native Electron `vibrancy: "sidebar"` source-list material
  with `visualEffectState: "followWindow"` and a transparent window backing
  (D348). `nativeTheme.themeSource` follows the app theme preference (`system` /
  `light` / `dark` / plugin base) so the material's light or dark plate matches
  the renderer. Vibrancy is re-applied only when that source changes; a missing
  plugin theme falls back to `system`. Main and settings navigation share the
  `.sidebar-surface` material, alongside any rendered `.sidebar-rail`; the
  settings shell ancestry is transparent but its content pane and titlebar stay
  opaque. The renderer adds a thin theme tint
  (`--ds-sidebar-glass-tint`, 40% dark / 55% light) plus a top/bottom sheen.
  The dock carries no seam or hairline: the glass meets the opaque main pane
  flush, so the only edge cue is the tint's natural change against the pane.
  The material carries the blur, so the tint must stay thin — the sheen is what
  keeps the surface reading as glass rather than a painted panel.
  `.main-pane`, `.main-titlebar`, and `.conversation-topbar` remain opaque
  `bg-primary` surfaces, so vibrancy does not spread across the whole window.
  Windows/Linux retain their existing opaque background and frameless behavior.
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
  remains explicit and, except for automated probes, confirms with a native
  warning before shutdown (D363). On macOS the tray uses a transparent monochrome template
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

### Native tray session menu

The Main-owned native menu contains Open, non-empty Running/Unread/Pinned
sections, and Quit. Each section has a disabled localized heading, single-line
session rows up to the share allocated to that group, and View more only when
it overflows that share. Session rows are globally deduplicated before
truncation. View more expands session navigation;
session rows enter their original conversation. The menu follows active locale
changes and never marks a result read merely by opening. macOS single-click
opens the attached menu; Open and double-click restore/focus the window.
See [ADR tray-session-shortcuts](/adr/tray-session-shortcuts).

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
expanded it owns that control, so the top bar does not duplicate it. The
`[🔍 Search]` control is the chrome search entry; the expanded sidebar header
does not duplicate it. Keyboard shortcuts and the application menu remain
available.)

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
  `no-drag` on interactive controls; macOS reserves the left 88px for traffic
  lights (only when the sidebar is collapsed), Windows/Linux reserve the right
  120px for native window controls (112px hit targets plus an 8px visual
  buffer). The conversation titlebar also reserves the 28px work-panel toggle
  while the panel is closed. While the panel is open, that 120px band plus the
  toggle overlay the panel header instead, and the header ends its box before
  the band so the panel tab strip and `+` stay clear of the native control band.
  In preview mode the header's left border box starts after the shell actions
  plus an 8px gap, including expanded-sidebar New Task, on every platform.
  The left inset is 8px except collapsed-sidebar windowed macOS (88px through
  the shared lead-inset token). Fullscreen retains the action lane.
  Header-height background paint fills the excluded lane without an opaque
  overlay hiding tabs or panel actions.
  Resource close actions stay in their tabs so a second header `×` does not echo
  the native Windows close control (D357).
- Title cluster (task title) flexes to the remaining width after toolbar
  reservations (sidebar lead-in, action icons, work-panel toggle, and
  platform window controls). The visible title uses CSS ellipsis only when
  that width overflows; the full title remains in the native tooltip.
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
  for the viewport-fixed control band; when the work panel opens, that
  reservation moves from the conversation titlebar onto the panel header so the
  controls do not travel with MainPane (D357). The panel header carries it by
  ending its own box before the band — a margin, not padding — because the
  native drag rectangle is the border box. The control band continues the
  titlebar's `border-subtle` bottom rule and uses the same token for its
  leading divider.
- Every chrome icon control is one 28px square (`--ds-work-panel-toggle-size`)
  with one transparent seat: the topbar's dock toggle, the viewport-fixed
  work-panel toggle, the preview/route-band lane actions, and the work-panel
  header's `+` and maximize/restore controls. A control matches its siblings
  instead of rendering at a size or on a surface of its own, so the icon alone
  carries it until the semantic hover wash paints a surface. The panel header's
  lane reserve is derived from that same control size rather than from a
  literal, and the toggle's open state is its glyph swap plus the engaged ink —
  no control in this family paints a filled or raised "on" pill.
  With the sidebar collapsed, Plugins, Pull requests, and Scheduled render their
  sidebar/New Task actions inside `.main-titlebar`, not the preview-only
  `.window-chrome-row`. Both containers must share the same geometry, rest,
  hover, and disabled rules; route actions must not duplicate those declarations.
- Band reservation is platform-independent (D269). The band is opaque and
  absolutely positioned, so scrolling route content passes underneath it on
  every platform, macOS included. Every route surface that starts its own
  content at the top edge reserves the band: the transcript
  (`.thread-content`) and the destination-page frame (`.page-frame`, shared by
  Plugins, Scheduled, and Pull requests) both pad by `--ds-toolbar-height`.
  Destination pages scroll in a route-owned content container separate from the
  chat transcript scroller; Composer-specific occlusion and follow behavior must
  not fade or hide destination rows at the bottom of the page.
  Without that reservation a page header renders behind the band and its title
  row is clipped. The plugin detail sheet reserves it too (D296): the sheet is
  mounted on the viewport overlay host, so its fixed layer is independent of
  the route scroller and the titlebar band.

### 2.4 States

| Element | Default | Running | Error | No workspace |
|---|---|---|---|---|
| Task title | session title (or untitled), uses the available width, with an ellipsis only on overflow | same | same | same |
| New task / Search | icon buttons | same | same | same |
| Composer stop control | hidden | visible only when the running composer draft is empty | hidden | hidden |
| Project name | title tooltip only | same | same | omitted |

### 2.5 Accessibility

- Every control is keyboard-reachable with Tab
- Composer stop control has `aria-label="Stop generating"`
- The Composer renders no transcription or speech control; the host speech
  capability is reachable only from IPC and plugins (ADR 0291).
- The topbar does not render a separate running-state indicator; the Composer
  submit control and transcript working feedback remain the running-state cues.

### 2.6 MVP constraints

- No search field in topbar (deferred)
- Notification history is the bounded D117 inbox; scheduled reminders,
  durable permission-request history, and notification preferences remain out
  of scope. Interactive prompt notifications are native-only and do not enter
  the inbox.

---

## 3. Sidebar

### 3.1 Purpose

Scoped project and session navigation, management, and notification access. The
expanded sidebar shows a global `Pinned` section when pins exist, followed by
path-less history under `Sessions` and retained project tabs under `Projects`; the
collapsed state is an icon rail. Retained tabs are renderer presentation state,
not additional host workspaces.
The sidebar body is reserved for Pinned, Sessions, and Projects; the footer exposes the
Plugins and Scheduled destinations beside Settings. Scheduled uses a clock
action with a localized accessible name and active state. Projects is managed
through Settings → Project archive; Pull requests is not rendered in the sidebar.

Section-level create and sort controls stay visually quiet at rest and reveal
when the owning Sessions or Projects toolbar is hovered or keyboard-focused.
Project-group `+` and overflow controls follow the same hover/focus treatment;
their hit areas remain in the layout so revealing them does not shift labels.

### 3.2 Anatomy

```text
Expanded (~275px, D034/D070):
+---------------------------+
| [lights]             [◧] |  macOS
| [π] PI-Desktop       [◧] |  Windows/Linux
| PINNED                   |
|   • Pinned task  project-A|
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
| Section labels (`PINNED`, `SESSIONS`, `PROJECTS`) | `--text-sm` (12px) | Uppercase secondary labels; global pin project context uses the same size |
| Footer profile name + profile menu items | `--text-base` (14px) | Identity cluster matches nav body |
| Footer status / version | `--text-sm` (12px) | Right-aligned build/version chip |

Do not render primary sidebar list content below `--text-md`. Keep row heights
(≈28–32px) so density stays WorkBuddy/Codex-like while primary actions remain
visually distinct from list content.

### 3.4 States

| State | Behavior |
|---|---|
| Expanded | Full session titles visible |
| Sidebar width | 240–520px (default 275px); drag below 160px collapses |
| Collapsed | Icon rail — hover shows tooltip with session title |
| Active session | Accent-blue outlined status ring plus active row background |
| Selecting session | Destination row receives the active treatment immediately while transcript/workspace resolution continues |
| Session in progress | Orange breathing dot; static under reduced motion |
| Session completed | Green check mark from the latest unread task notification when the row is not selected |
| Session failed | Red circled alert mark from the latest unread task notification when the row is not selected |
| Hover row | Project headers and all conversation rows share one full-row `--ds-bg-hover` surface, radius and transition; selected conversation fill takes precedence |
| Current workspace | Project header shows the workspace dot, never a persistent selection fill; topbar follows that workspace; composer exposes no workspace identity |
| Navigation selection | Only the selected conversation on the chat page uses `--ds-bg-active`, including pinned and standalone rows; folding its group never transfers selection to the header. No conversation or a non-chat page means no selected conversation row |
| Keyboard focus | The focused control keeps its visible outline; the project title stays transparent and independent action buttons retain their own hover feedback |
| Collapsed project | Header remains visible; unpinned child conversations are hidden; global pins remain visible |
| Archived row | Hidden by default; visible in the explicit archived view |
| No retained project | Compact Open project entry; standalone Sessions rows remain available |
| Empty group | Muted one-line empty state; group create action remains available |
| Default session title | New task/New chat (localized where applicable) until the first prompt |
| First prompt title | A normalized 48-character prompt fallback appears immediately; after the first turn, a successful background summary replaces it |
| Manual session title | User-defined title remains stable across refresh and renderer restart; automatic summary never overwrites it |
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
  If that destination is still running or still holds a completed reply the
  durable page has not caught up to, the warm frame uses its latest
  renderer-owned live snapshot and later durable revalidation cannot roll the
  partial or just-finished reply back or move the newest user/assistant rows
  out of chronological order by appending a longer live history after the
  bounded durable page (D317, D324). A destination with no retained pane (cold switch) leaves
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
  Extensions destination; while Plugins is active, click it again to go back
  one entry in the existing navigation history. If no previous entry exists,
  open chat instead. The pressed state reflects the current page and the
  localized label remains available on hover/focus.
- This shortcut reuses the existing Back action (also bound to `Cmd/Ctrl+[`),
  including its session selection and loading behavior. It does not skip
  Settings entries or track a separate return destination. Settings navigation
  is unchanged; its existing Back to app control opens chat. Both footer
  destination buttons report their active state to assistive technology.
- Reopening Plugins retains its Installed/Marketplace tab, both search inputs,
  and category filter in renderer memory. Detail/settings/permission dialogs,
  transient menus, and pending-operation UI are not retained. The page still
  unmounts normally, releasing listeners, and an operation already in flight
  still completes and reports through the normal toast channel; this is not a
  hidden live workbench or durable preference across application restart.
- Plugin detail, settings, permission-review, template, and install-progress
  surfaces are viewport-wide overlays. Their backdrops and surfaces mount on
  `#pi-desktop-overlays`, outside the route scroll container and sidebar
  stacking contexts, so an expanded sidebar cannot cover the surface or its
  close/cancel controls.
- The footer action group stays on the left and the build/version chip stays
  right-aligned; clicking the chip checks for updates or opens the available
  release in Settings
- Click Collapse sidebar at the right of the header row to collapse the sidebar.
  Global search opens from the conversation topbar, shortcuts, and application
  menu; the expanded sidebar header does not host a search control
- Drag the expanded sidebar's right edge to adjust its width. The main pane
  reflows continuously, the press position remains anchored, and the final
  width is saved on release. Focus the edge handle and use ArrowLeft/Right,
  Home, or End for keyboard resizing; Escape cancels an active pointer resize.
  Double-click the handle to restore the default 275px width, clamped by the
  live three-column budget so the reset never breaches the MainChat floor.
- Click the viewport-fixed work-panel toggle to reveal or hide the panel
  without deleting tabs; the work-panel header keeps its tab strip and fixed `+`
  menu, while each tab owns resource closing
- Click the `Projects` heading folder-plus action: open the Create project
  dialog. The dialog accepts an optional project name and one or more local
  folders, lists every selected folder with a remove action, and marks the
  first folder as Primary. The name field seeds from the picked source until
  the user types their own name: the first selected folder names a local pick
  and the repository name names a git checkout. Create falls back to the same
  derived name, so an empty name field never blocks creation. Creation makes
  one logical project group: the primary folder is activated and names the
  group, while every other selected folder is retained as a group root and is
  shown in Project archive details, not as an open project tab. Group chats,
  instructions, and memory use the same group identity. A source selector
  offers This computer and Git repository: the git source swaps the folder
  list for a repository URL field plus a clone destination row and creates
  the project by cloning into the chosen folder first. The dialog follows
  the shell's neutral gray surfaces, with a 480px maximum width,
  `--radius-lg-plus` (18px) corners, and the shared `--ds-shadow-dialog`
  elevation. Its compact type hierarchy uses `--text-lg` for the title,
  `--text-base` for the name field, and `--text-sm-plus` or smaller for labels
  and metadata. The header and action row use the shared 18px dialog gutter,
  while distinct sections use a 16px gap and shared button/input metrics. One
  Create project title leads into an explicitly labeled filled name field and
  the workspace list with a softly filled Add folder action; the field does not
  repeat its label as placeholder text and uses the shared field well plus the
  accent-tinted focus ring, not an outline stroke. Edit project reuses the same
  surface, loads the host-owned group, allows the name and non-primary folders
  to be adjusted, keeps Primary first and non-removable, and rejects removal of
  a folder that still owns chats. Background session or run-status updates
  must preserve unsaved name and folder edits in the open editor. The source selector offers This computer and
  Git repository as equal filled tiles without strokes (D297); the active source
  uses a deeper tile, not a selected border. A repository URL reuses the clone
  rules of ADR 0247 and its checkout becomes the primary root of the same group.
  Repeated clicks on Add folder or the clone destination while a native folder
  picker is open are ignored; only one project folder picker can be active.
  The dialog does not add explanatory copy for durable memory or multi-selection.
  The surface has no outer stroke, section rules, footer divider, source-option
  stroke, field stroke, or dashed picker border. The action row stays fixed
  while the content scrolls; narrow
  windows retain a single column and reachable actions. Light and dark themes
  preserve readable filled surfaces and visible keyboard focus, and transitions
  respect reduced motion.
- Right-click the `Projects` heading or empty project-list chrome: open a
  single-item create menu that runs the same Create project dialog action
- Click project `+`: activate that project, then select its most recent empty
  session or create a durable empty session bound to its exact path
- Click the `Sessions` heading message-plus action: clear the workspace, then
  select the most recent empty temporary session or create a durable empty one
- Sessions and Projects heading actions reveal together when their toolbar is
  hovered or keyboard-focused; the controls remain keyboard-reachable while
  visually hidden at rest
- Right-click the `Sessions` heading or empty standalone-list chrome: open a
  single-item create menu that applies the same temporary-group reuse rule
- Project overflow: open folder, rename, pin/unpin, archive/restore, close
  retained tab. Project activation remains on the directory row rather than
  in its overflow menu. Rename edits the local display name only; open folder
  reveals the project directory in the system file manager for the selected
  project row.
- Conversation overflow: pin/unpin, archive/restore, Create branch, delete.
  Create branch is disabled while that conversation is running; success
  activates the independent child session and focuses the composer. When
  developer mode is on, the menu also offers Copy conversation ID (clipboard)
  and Open session path (the session scratch directory in the system file
  manager).
- Pinned conversations appear once in a global section above Sessions and
  Projects, independent of date buckets, project collapse, retained tabs, and
  each project's ten-row history limit. Each pin shows its project display
  name (full path on hover), or Temporary space for a path-less conversation.
  The section is omitted when empty and scrolls within `min(233px, 30vh)` when
  needed. Its rows reuse normal selection, status, hover, and overflow actions.
- Pinning moves the existing row into that section; unpinning returns it to
  normal project or temporary history, subject to existing folding and closed
  tab visibility. Keyboard focus follows the relocated row's overflow control,
  or returns to the Sessions sort control if the row becomes hidden. Archived
  conversations and pins in archived projects stay hidden until Show archived
  is enabled. Closing a project does not remove its global pins.
- The `Sessions` toolbar places the sort button before the message-plus New Chat
  control. The sort menu and every other body-level sidebar menu remain
  content-sized and open 4px to the right of their trigger or pointer. Their
  left edge never flips to the trigger's left side; the surface has a viewport
  width cap for narrow windows. The sort choices remain Recently updated,
  Created date, Oldest first, and Name; the chosen session sort orders global
  pins internally without date headers. Pinned projects still precede unpinned
  projects within the project sort.
  Project rows have no reorder grip. Pressing the project title and moving
  8px starts a pointer reorder and selects the persisted `manual` project order without changing the session sort.
- When a session hover card is revealed for the active project, the renderer
  re-reads the host workspace metadata before displaying the card so an
  externally changed Git branch is current. This refresh does not activate a
  project or change the selected conversation; if the read is unavailable, the
  last cached branch remains usable.
- Collaboration creator and created-session links in the hover card show a
  localized running indicator only while the referenced session has an active
  runtime; non-running related sessions remain title-only.
- Project groups use compact vertical spacing so adjacent directories and
  conversation rows read as one dense navigation list rather than detached
  cards. Directory `+` and overflow actions remain hidden until hover or
  keyboard focus, without changing the directory label's position.
- Sidebar toggle: expanded-header icon + keyboard shortcut; the
  collapsed main titlebar retains an Expand sidebar icon; the work-panel
  toggle stays viewport-fixed in the window's top-right corner on every
  non-Settings route
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
- Each project title exposes `aria-grabbed` during a reorder drag and
  ArrowUp/ArrowDown keyboard reordering; there is no separate grip control
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
  positioning so the main chat pane cannot paint over them; the Settings font
  picker menu uses the same body-level floating layer and clamps to the
  viewport. The work-panel `+` action is not a floating layer: it creates a
  New launcher tab in the panel body;
  the font list is windowed (fixed row heights with absolute positioning,
  overscan buffer, and an exact-offset scroll-into-view, mirroring the
  virtual-scroller pattern DBX uses for its data grid) so only the visible
  slice of a long system list is ever in the DOM, and the menu reposition
  handler ignores scrolls inside the list, keeping the picker responsive when
  opened and scrolled


### 3.7 Brand and icon contract

- The visible shell name is `PI-Desktop`; Codex is not used as the renderer
  identity.
- A control with no label states `.icon-btn-square`, which pins both axes to
  `--ds-control-size` (28px). `.icon-btn` on its own takes its width from its
  glyph plus 8px of side padding — right for a label-driven pill, wrong for a
  control that carries no label — which is why the sidebar collapse control, the
  conversation topbar toggle, and the composer's add/enhance/undo controls all
  render the same 28px square target as the topbar and work-panel actions
  instead of a wider-than-tall pill.
- `BrandLogo` imports the renderer-sized marks derived from the canonical
  masters through Vite: `src/assets/brand/logo-light.png` for light mode and
  `src/assets/brand/logo-dark.png` for dark mode (192x192, covering the 64 px
  splash at 3x; ADR 0125). The component subscribes to
  `document.documentElement[data-theme]` via a `MutationObserver` and swaps the
  source at runtime for the sidebar and startup splash without a reload. The
  empty-home hero uses `HomeMascotLogo` as a 100px eight-frame GIF. Light and
  dark themes each have a dedicated GIF plus still PNG. CSS follows
  `document.documentElement[data-theme]` without a reload; anything other than
  `light` uses the dark artwork. The mascot loops a processed wave with a
  short idle hold on the first frame. Playback is native to the GIF and does
  not change on pointer hover; reduced motion swaps to the matching still
  first-frame PNG. The expanded/collapsed sidebar remains 20px/18px and the
  startup splash 64px.
  Home and thread-docked composer prompt rows do not render a leading brand
  icon.
- Project and Temporary session creation controls render the dedicated
  message-plus session icon. Generic
  `IconPlus` remains reserved for adding non-session entities.
- Icons are decorative when a localized text label or accessible name is
  present; click, keyboard, and focus behavior remain unchanged. Every
  icon-only action must also expose that localized purpose on hover and focus:
  use the native `title` together with `aria-label`, or the existing themed
  `data-tip` pattern when a custom tooltip is required.
- The expanded sidebar brand is a localized button with a 20px logo and the
  shell name on Windows/Linux; pointer or keyboard activation navigates to the
  chat home. macOS hides this brand and right-aligns Collapse sidebar in the
  same 46px row as the native traffic lights. Fullscreen keeps the brand hidden
  while reclaiming the native-chrome padding.

### 3.8 MVP constraints

- Global search opens from the conversation topbar, keyboard shortcuts, and
  the application menu; the expanded sidebar header does not host a search
  control
- Project drag/manual reorder is renderer-local and changes presentation only;
  it never moves an on-disk directory or changes the host-selected workspace
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
| Project reorder | press-and-move on the title (8px), or ArrowUp/ArrowDown on that title, writes contiguous normalized-path order to sidebar preferences; accent insertion line; no visible grip |
| Project archive | omitted from default view; restorable from archived view |
| Project close | removes retained tab only; durable project/sessions remain |
| Project delete | row-menu danger action behind a second confirmation that names the project and the number of its sessions; refused with a message while any of those sessions is running; removes the durable project row, those sessions, their transcripts, and its project memory; never deletes the folder on disk; a path owned by a multi-folder project group is refused with a message, and a path the host no longer knows is still removed from the list |
| Project memory | row-menu editor reads and saves a compact list of titled or untitled memory cards for the exact project path; cards can be added, edited, and removed, the context is available in later chats, and it is never a higher-priority instruction |
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

Primary chat area containing ChatTranscript and Composer. Scrollable, focused
reading surface of the workstation.

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
- Max content width: 760px default, user-resizable (D439); assistant rows follow the band. User plates stay `min(82%, 600px)`.
- Each process, activity group, delegation card, and single tool row spans the
  conversation band. Its activity header is a full-width row with an
  ellipsizing label and trailing caret, never a content-sized chip, so it
  follows the dragged width instead of its own text. Content inside a
  delegation node and its dock process is width-aware and wraps long task,
  path, command, and answer text.
- The transcript keeps one stable scrollbar gutter on the trailing edge. It
  never reserves a matching left gutter, so the minimap and first message do
  not leave a decorative blank strip beside the session.
- A failed TurnOutcomeCard without a structured assistant error exposes one
  primary **Continue** action and no regenerate action. It appends the current
  locale's continuation prompt to the same session and starts a new turn,
  preserving the failed turn and completed work in the transcript. When the
  failed turn already has a structured assistant error, that inline error card
  owns the summary, details, and **Continue** action; the TurnOutcomeCard is not
  rendered, so the same failure is not presented twice. Continue remains
  available after a terminal parent error (including HTTP 429) even if leftover
  subagents were still running; those delegates are aborted and must not leave
  the session `AGENT_BUSY` (D352).
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
- The tail runtime status owns one reserved lane. The transcript reserves the
  height of a single `Working…` / planning / run-activity row for the whole
  running turn, so the status appearing between two tool rows, or clearing when
  the model answers, cannot change the content height and move the rows the user
  is already reading. The lane stays reserved, empty, and invisible while a
  concrete row, a permission card, or the answer owns the tail; after the
  status clears the slot is still reserved, and an idle transcript renders no
  lane at all so its layout is unchanged
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

### Turn process and thinking display

Both Detailed and Compact project each loaded assistant turn into one whole-process
disclosure containing reasoning, tools, hosted searches and intermediate assistant
text in transcript order. The trailing answer streams outside that disclosure;
later activity can reclassify provisional answer text into the process without
changing the stored message. Assistant errors and stopped trailing partial answers
also stay outside it. User/system messages and compaction boundaries are unchanged.

Within the process, an ordinary activity group represents one contiguous
tool/search/thinking segment between progress paragraphs. It renders a group header
only when the current mode has two or more visible items. A singleton uses its item
disclosure directly, compact-hidden thinking never creates an empty wrapper, and
the existing Task topology remains the container for delegated work.

Detailed starts active and completed whole-process disclosures open. The ordinary
group owning the active execution segment starts open, then closes on completion
only if untouched; other completed groups start closed. Compact starts the process
and ordinary groups closed. Its untouched active process remains open when any
failed or denied tool has been recorded, through later successful recovery, and
closes on completion if still untouched. Group headers summarize count, running
state and issue count without treating a failed child as a failed turn.

In Detailed, only the literal final item of the last activity group receives the
leaf auto-open default when it is an eligible tool-call or hosted-search row.
Failed and denied rows remain closed, and a final thinking item does not cause a
backward scan for an earlier tool. Compact keeps all tool/search payloads closed and
suppresses reasoning text and excerpts; only its active thinking indicator remains.

Whole process, group and item are independent controls. Closing an ancestor keeps
descendant choices and reopening restores them; opening a parent never expands all
children. User interaction with a child claims its ancestors without toggling them,
so completion cannot close around opened, focused or selected content. Choices use
stable turn/group/item identities and remain while the retained session pane lives,
including mode changes and row remounts; pane eviction, deletion or renderer restart
reapplies defaults rather than persisting disclosure state to messages or settings.

Search/navigation reveals the process and the activity group that own the named
message, and applies each reveal request once. Item-level targeting is not part
of this change. Compact reasoning stays hidden until
the user selects Detailed. Permission, question, plan/goal approval and other
pending action cards remain reachable outside a hidden process. See
[ADR turn-process-and-thinking-display](../../adr/turn-process-and-thinking-display.md).

### 4.4 States

| State | Behavior |
|---|---|
| Empty | Restrained hero + optional onboarding checklist in a scrollable content region, with a bottom-reserved home composer and no starter-card or contextual quick-action layer (D111/D204/D206). A project-bound empty session underlines the project name; the control opens a searchable switcher of the sidebar's open projects, with clone-git-project and open-project actions. |
| Streaming | Auto-scroll follows while pinned; new tokens append |
| Active progress | Immediately after send, before the first assistant or tool event, a compact localized `Working…` status with elapsed time appears inline. Its model and subagent elapsed labels use the carried-unit format in §9.1. When the runtime names a quiet interval, that same row identifies starting, waiting for the model, preparing the next request, compacting context, recovering an empty response, retrying, or waiting for delegated work (with each running subagent's latest coarse action). It remains visible through thinking, tool execution, completed-tool gaps, and partial answers until the turn ends. Runtime phases take precedence over the Planning/Goal or Working fallback. Pending permissions, questions, and plan/goal approvals suppress the row; history reading never shows live status; no large generic progress card is rendered. The row lives in the reserved tail lane, so it appears and clears mid-turn without changing the transcript's content height. A retrying row remains compact at rest; hovering or focusing it reveals an error-styled tooltip with the localized error summary, stable code/HTTP status, and bounded provider message. The tooltip mixes the error tint over `--ds-bg-elevated-opaque` so transcript text does not show through. |
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
Launchable surfaces are the host-owned Review row and plugin views (ADR 0104),
including the vendored file manager `pi.file-manager` (project browsing and
editing) and bundled `pi.browser`
(work-panel browser chrome; the guest page stays host-owned, ADR 0170). File
resources are *artifact* surfaces: the host renders them, but the conversation
opens them, so they are absent from the launcher. There is no interactive
terminal surface; agent Bash output remains in the transcript.

### 5.2 Anatomy

```text
+---------------------------------------+
| [◫ App.tsx] [▤ Files]       | [+]     |  header, 46px
+---------------------------------------+
| scrollable tab strip        | fixed + |
|   x closes; middle click    | new page |
+---------------------------------------+
| Active resource body                  |
|  Review: recorded changes + diff      |
|  Browser: plugin chrome + host guest  |
|  File: viewer for a transcript file   |
|  Plugin view: the plugin's own page   |
|  no resource: empty state + tool list |
+---------------------------------------+
 ▌ active tab              • open, inactive
^ 10px transparent resize hit area on the left edge
```

The header is a horizontally scrollable `tablist`. Each open New launcher,
Review, file, or plugin view is one tab with an icon, an ellipsized label, and a
close button shown on hover, focus, or the active tab. Middle-click closes a
tab. The `+` button sits outside the scroller and remains visible when tabs
overflow. Clicking it creates and activates a unique New launcher tab. The
launcher body contains host-owned Review followed by every in-scope
`contributes.views` entry as buttons; Files and Browser are not hardcoded in
the renderer (ADR 0104). The header reserves a tokenized 44px right-side safe
lane for the viewport-fixed work-panel toggle: the 28px control, its 12px
viewport inset, and the header's own 4px control gap
(`--ds-work-panel-control-gap`). That one gap spaces the whole row — the tab
strip to the action group, `+` to maximize, and maximize to the viewport-fixed
toggle — so the three panel buttons read as one group instead of a rail behind
a divider. Because maximize sits between them, the `+` trigger still keeps a
distinct hit target with more than 24px of visual gap on every supported
platform. All three are the same control as every other chrome icon: 28px
square with a transparent seat, so the header reads as quiet icons rather than
filled squares. `+` and maximize take their geometry and hover wash from the
shared chrome-control group in `chrome.css`, not from a rule of their own, and
the viewport-fixed toggle's `aria-pressed` state changes ink and glyph only —
never a background or a raised shadow.

With no resource the body remains open and becomes a concise **New** launcher.
An explicit New tab uses the same data-driven tool list, so selecting a row
replaces that launcher tab with the destination or activates the existing
singleton without duplicating it:

```text
+---------------------------------------+
|                 New                   |  launcher title
|        ◫ Review   ▤ Files              |
|        ◉ Browser                       |  tool rows
+---------------------------------------+
```

### 5.2.1 Light-theme surface

- Panel body uses quiet inset paper (`#fafafa`); the 46px header band and tool
  chrome (review toolbar, browser chrome, file viewer header) stay white
- The 46px header is a clipped tab strip plus a tight `+` trigger. Tabs keep a
  stable `92px–180px` width and a visible gap, so labels do not shrink into
  each other; only the strip scrolls when there are more tabs than the panel
  can show. The trigger is outside it and never scrolls away. A New launcher
  tab carries the concise **New** title and the same data-driven tool rows as
  the former entry point. Shortcut labels are rendered only for real bindings.
- Tab close uses a hover/focus/active `×` affordance and middle-click. The
  active tab uses the normal active fill, while overflow is handled by the
  strip rather than by a second resource list. Launcher rows use the same
  fast hover/focus feedback as other panel rows.
- Active tabs, file-tree rows, and diff headers ease hover fills with
  `--motion-duration-fast` / `--motion-ease-out`. The resize handle matches the
  sidebar: a 32px centered 2px grip that appears on direct hover/focus, with
  the solid accent reserved for keyboard focus and an in-progress drag
- Browser URL and empty-tool chrome share the light inset field treatment used
  by Settings controls (D148)
- Every empty state in the panel — the no-resource body and each tab's own —
  uses the proportions the rest of the app already uses (`.ext-empty`,
  `.projects-empty`): a 38px round tiled icon, a title at
  `--text-base-plus` / `--font-weight-medium-plus`, and muted `--text-md` copy.
  Copy wraps at 34ch rather than 48ch because the panel can be 244px wide. No
  hero art, cards, or marketing framing (design-system §14, D206)

### 5.2.2 File manager plugin surface

The vendored `pi.file-manager` view browses, opens, and edits the project
entirely inside the plugin's isolated page:

- The tree loads one directory at a time, keeps directories above files,
  preserves expanded folders, and shows per-file-type icons and file sizes
  without walking the whole workspace up front. Search (`fs.glob`-equivalent
  filename matching) lists hits without expanding the tree, and refresh
  disables itself while it reloads the root and the expanded folders.
- A context menu on a row offers create, rename/move, **Open with default app**,
  and **Show in folder**. The last two are offered for files only: the host
  refuses them for directories.
- Selecting a file replaces the tree with a focused viewer: syntax-highlighted
  editing with save, a Markdown preview toggle, image and audio/video viewing,
  CSV/TSV tables with paging and sorting, a JSON tree, and read-only SQLite
  browsing with a SQL query box. Binaries report that they cannot be previewed
  rather than being decoded, and every viewer names its own bound — 2 MiB for
  text, 8 MiB for images, 24 MiB for media, none for databases, whose bytes stay
  out of the page.
- Saving is atomic and refuses to overwrite a file that changed on disk since it
  was opened until the user confirms. Loading, read failures, unsupported
  binaries, oversized files, empty folders, and folders that fail to load each
  have a distinct localized state, and a failed directory can be retried in
  place.
- The view chooses which folder of the open project it browses from a control in
  its own top-left area: the project's primary folder by default, its other
  folders after that in group order (ADR 0249), remembered per project and
  independently of what the app shows as the workspace. The switch is
  plugin-local — it changes neither the visible workspace, nor the agent's tool
  roots, nor a session's primary path, nor project instructions or memory
  (ADR 0263). Its own context-menu actions follow that choice: a file of a sibling
  folder is handed to the host as an absolute path, so opening it with the system
  default app or revealing it reaches the file in the folder being browsed
  (ADR 0264).
- The page follows `app.getAppearance` and `appearance:changed` for base theme
  and English/Simplified Chinese copy, and `workspace:changed` for the open
  project and its folder list. `workspace.get`, `app.getAppearance`,
  `fs.openDefault`, and `fs.reveal` are the only host channels it calls; its own
  reads and writes go through its host process, which keeps the jail of the one
  folder the view is browsing — never the whole group — refuses credential
  paths, and records writes to its own audit log (ADR 0241, ADR 0263).

- During a Browser session switch, Main hides the previous page immediately.
  A retained destination page is shown without reloading; a new destination
  stays hidden until its current main-frame navigation commits. Root lookup or load
  completion from a superseded request cannot navigate, reveal, or publish the
  old session as current. A session without a remembered preview stays empty;
  closing the panel or disposing the guest wins over pending work. Normal
  navigation within the same session retains that session's visible content.
  The address bar immediately shows loading feedback. A current main-frame commit
  reveals the page without waiting for images or subframes; those continue to
  drive the loading/stop control. A failed switch or one exceeding the 15-second
  main-frame wait shows a retryable error, with the old guest hidden. Superseded
  and cancelled requests cannot publish over the new navigation. A local file
  address or absolute path that does not resolve to an existing file inside
  the session workspace is rejected before loading and shows a specific
  workspace-boundary message in the browser chrome, including on a blank tab.

- Opening an HTTP(S) link in the work panel creates an additional Browser
  resource tab instead of replacing the previous URL. Each tab owns a host-retained WebContents, address, title and navigation
  history. Switching hides/shows pages without reloading, preserving live form,
  scroll and JavaScript state. Hidden pages use background throttling. Closing
  tabs releases their page/CDP resources; no automatic suspension or restart DOM
  recovery is promised. Address-bar and
  ordinary in-page navigation stay in the current tab. Website new-window links
  follow Link open destination: another work-panel tab, or the system browser.

- BrowserPreview creates its resource tab before navigating and never rewrites
  the prior tab. A background navigation is retained for its session's selected
  tab (or consumed once by its first tab). A new blank tab reports empty state.

- Main-frame same-document navigation (fragment links and History API routes) updates
  the browser address, history controls, and loading state without requiring a
  full document load. Subframe events and events from an invalidated session or
  replaced main frame must not publish browser state.

### 5.3 States

| State | Behavior |
|---|---|
| Closed (default) | Not rendered; startup has no retained tabs. The viewport-fixed toggle or `Cmd/Ctrl + J` reveals the active session's panel context without creating a tab. Inline review cards remain available in the transcript because they are message-scoped and do not require the work panel. |
| Open | Docked flex row right of the main pane; opened by an artifact, the viewport-fixed toggle, or `Cmd/Ctrl + J` at a committed preferred width of at least 244px (new-profile default 360px), capped by the live three-column budget. The toggle or `Cmd/Ctrl + J` again collapses it, retaining the session context. |
| Preview (maximize) | MainChat is unmounted and the panel fills the client area beside the sidebar. The mode is transient and restores the prior panel width and sidebar state when left. |
| Multiple artifacts | The header keeps a horizontally scrollable tab strip. The fixed `+` action creates a new launcher tab; its buttons open Review and all in-scope plugin views without duplicating open resource tabs. |
| Session switch | The destination session's retained open state, tabs, active tab, and Browser resource replace the previous session's panel context atomically; neither context is deleted |
| Resizing | The inner left divider follows anchored pointer delta or keyboard input for the panel target; pointer changes are frame-coalesced and committed in the renderer. Escape, pointer cancellation, or lost capture restores the prior panel width. Native window edges resize only the fixed application window. |
| No workspace | Each tab renders its own "open a project" empty state |
| Open with no resource | `Cmd/Ctrl + J` reveals the panel without creating a tab, so the body renders the New launcher. Clicking `+` creates an explicit, closable New tab with the same launcher rows. Activating a row from that tab replaces it with or selects the singleton view. Closing the final tab leaves the panel open in the no-resource state. |
| Constrained work area | The panel is capped by the shared three-column budget inside the existing client area; MainChat never drops below its 450px floor and the expanded sidebar yields at the threshold |
| New launcher active | The body hosts concise Review and plugin-view buttons. Each row replaces the launcher tab with its destination or activates the existing singleton; the page is independently closeable. |
| Plugin view active | The body hosts the plugin's own isolated page as a native `WebContentsView`, positioned from the measured surface rect. It remains visible at its full rect while the divider is being resized or a New launcher tab is created; creating a page never pushes the plugin body down or changes its bounds. It is hidden whenever the tab is inactive, the panel is animating, or a panel-wide blocking overlay is open — the same rule the Browser preview follows, since both composite above renderer content. A view whose plugin is disabled, uninstalled, reloaded, or crashed is destroyed; the tab stays and re-opens the page on the next lifecycle event (ADR 0104) |
| Plugin out of scope | A view contributed by a plugin that is not active in the current project disappears from the New launcher when the project changes. Unlike contributed themes, which are one global setting and stay unfiltered, a view is scoped work |

### 5.4 Interactions

- Trigger: file/URL references and BrowserPreview create/activate their
  resource tab in the originating session's runtime context. BrowserPreview
  events carry `sessionId`, and the renderer retains that session's preview
  path/URL as its Browser resource. Review is never triggered by a tool
  result: it opens only from the `+` launcher row or from the retained panel
  context the viewport-fixed toggle and `Cmd/Ctrl + J` reveal, so a successful
  workspace Write/Edit cannot open, activate, or resize the panel in any
  session.
  The plan/goal approval artifact still creates or activates a tab in its
  originating session, but the host picks its surface: the bundled file view when
  that view is launchable, otherwise the host file tab (D452).
  The viewport-fixed toggle and `Cmd/Ctrl + J` both toggle the active session's
  retained panel context: they reveal the panel without creating a resource and
  collapse the visible panel without deleting one. With no active session the
  toggle is disabled and the shortcut does nothing. Both are ignored while
  Settings is the active page.
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
- Header tabs: the strip is a `tablist` containing one `tab` for every open
  Review, file, or plugin view. Clicking a tab activates it; the active tab is
  scrolled into view. Its close button and middle-click close it, selecting the
  right neighbor and then the left. ArrowLeft/ArrowRight/Home/End move between
  tabs and Delete/Backspace closes the focused tab. Pressing and moving a tab
  by 8px starts reordering; dropping on either half of another tab inserts the
  source before or after it. Holding the pointer near either edge auto-scrolls
  the strip toward off-screen tabs. `Alt+ArrowLeft`/`Alt+ArrowRight` reorders
  the focused tab without changing its active state. The `+` trigger remains
  fixed beside the strip and creates a new launcher tab.
- New launcher: each `+` click creates a unique, active New tab. Its body uses
  the Review-plus-plugin tool list as buttons. Selecting a row replaces the
  launcher tab with that destination or activates its existing singleton.
  `Cmd/Ctrl + J` itself still creates nothing — it reveals the panel's current
  context, while `+` is the explicit new-page action.
  The "open a project" empty states carry no action button: opening a project
  resets the panel context and hides the panel, so the button would undo the
  surface that offered it (D224).
- Resource header: the 46px header shows the scrollable active tab and fixed
  `+` button. A subagent detail uses a back arrow in the header. Arrow keys,
  Home, End, and Escape operate the tablist; creating a launcher page never
  changes a native plugin surface's bounds.
- Tab close: closing an active tab selects its right neighbor, then its left;
  closing the last tab leaves the panel open on the New launcher. The
  panel-level collapse control is the viewport-fixed shell toggle (not in the
  work-panel content header) and hides the panel without deleting the runtime
  tab set; a later artifact reopens it.
- Context change: selecting another session atomically projects that session's
  retained `{open, tabs, activeTabId, browserResource}` state. The previous
  session's context remains in renderer memory and is restored when selected
  again. A workspace selection with no active conversation hides the panel.
  Every context remains bound to its originating session/workspace, so relative
  file and Browser resources are never reinterpreted against another workspace.
- Resize: the inner left-edge handle changes the panel's committed width in the
  renderer. Moving it left grows the panel into MainChat's internal space until
  the shared budget is exhausted; when the 450px floor is reached the expanded
  sidebar collapses immediately, and moving it right gives that space back to
  MainChat. `ArrowLeft` / `ArrowRight`
  adjust the panel width in 16px steps (`Shift` uses 32px), and `Home` / `End`
  reach the current dynamic minimum and maximum. Pointer math is anchored to the press position
  and starting panel width, so grabbing the handle cannot jump the divider;
  moves are frame-coalesced. Escape, pointer cancellation, and lost capture
  restore the press-time panel width. The 10px hit area keeps a column-resize
  cursor and suppresses text selection during the gesture. A double-click on
  the divider restores the default 360px width, clamped by the same live
  minimum and three-column budget, so a reset never breaches the MainChat
  floor.
- Persistence: all session contexts are renderer runtime state only. On app
  startup, open state, tabs, active-tab selection, file requests, and Browser
  resources reset; only the committed preferred `{width}` remains in
  localStorage `pi.desktop.workPanel`. Opening and collapsing never request a
  positive native reservation and never change native window bounds. The panel
  flexes inside the existing client area, so MainChat reflows beside it while
  retaining its 450px hard minimum; the expanded sidebar is the column that
  yields, and closing the panel restores a sidebar the layout collapsed.
  Background session artifacts never update the
  visible panel or window geometry.

### 5.5 Accessibility

- `<aside>` landmark. The header exposes a `role="tablist"` with one
  `role="tab"` per open New launcher or resource, `aria-selected`,
  `aria-controls`, roving `tabIndex`, and localized close buttons.
  ArrowLeft/ArrowRight/Home/End move through tabs; Delete/Backspace and
  middle-click close the focused tab. The `+` button is a direct action with a
  localized label and no popup state. A New tab's body is a labelled
  `role="tabpanel"` containing a labelled `role="group"` of ordinary buttons;
  the legacy no-tab reveal remains a plain labelled group. Each resource body
  remains a `role="tabpanel"`.
- Resize handle: focusable `role="separator"` with
  `aria-orientation="vertical"`, a localized label, dynamic
  `aria-valuemin` / `aria-valuemax` / `aria-valuenow`, visible focus, and
  Arrow/Home/End keyboard control. Escape cancels an active pointer gesture.
- Every resource close and the viewport-fixed panel toggle expose localized
  names. The toggle uses `aria-pressed` for open versus closed.

### 5.6 MVP constraints

- Tab content specs: Review has host-guarded rollback but no line comments;
  Browser is user-driven (no agent control); Files is read-only
- Single panel instance; no per-tab detach or split

### 5.7 Subagent task conversation

A topology node opens the selected delegate in the same right-side dock as the
work panel. The dock is an inset grouped side sheet: a sticky identity header,
the task description as a full-width card, and the delegate's live process.
It does not render separate Details or Output tabs.

- The selection is renderer-local and session-scoped: it stores only the
  `sessionId` and delegation id, then re-finds the current Task and its
  `parentToolCallId` rows from the live/retained transcript. The header and
  process therefore update as thinking, tool calls, and answer fragments stream
  in.
- The task description is the Task call's `task` argument, rendered as one
  selectable inset grouped card. The delegate's thinking, tool rows,
  and answer fragments reuse the same components and styling as the main
  conversation. Task/node titles, descriptions, and step summaries use the
  available width and wrap or clamp to multiple lines; long paths, commands,
  and tool summaries in the live process wrap inside the dock instead of
  becoming one-line ellipses. Reports and counters remain omitted from this
  compact surface.
- The dock has one scroll owner, the panel body. The scroll owner is
  keyboard-focusable and exposed as a polite `role="log"` so streamed rows
  remain discoverable without forcing focus changes. The live process is
  rendered in normal content flow without a nested `.subagent-run-rows`
  scrollbar, so a long process cannot create a second scrollbar or leave a long
  empty tail. The detail column and its process wrapper must opt out of flex
  min-content sizing, so long commands, paths, and tool summaries stay inside
  the committed panel width instead of expanding the side sheet beyond the
  client area.
  While pinned to the latest output, the panel body follows new process rows;
  a real upward gesture pauses follow and exposes the standard jump-to-latest
  control.
- The selected delegate uses a sticky identity header: a 36px avatar with a
  status dot, the agent name as the title, and the effective model plus a
  concrete non-`off` thinking level as a caption (for example, `GPT-5.6-Luna
  Max`). `off`, `omit`, and models without reasoning support add no suffix. A
  tinted status capsule and elapsed time sit on the same row, trailing the
  identity, and never wrap onto a second line; the name ellipsizes first. The
  same caption appears on every delegation topology node, and its accessible
  name and hover title contain the complete model/level label.
  The task is an inset grouped card
  under a **Task** section label, left-aligned and full-width, not a transcript
  bubble. The card shows at most four lines by default; longer tasks expose an
  inline Show more / Show less control with a disclosure chevron. The live
  process uses an **Activity** section label (it does not repeat the agent
  name), a trailing step count, and one subtle vertical timeline with no nested
  card, so unused panel space reads as one continuous work surface.
- A delegate that settles without completing explains why, because the process
  alone does not: a `Failed`, `Timed out`, or `Aborted` capsule with no reason
  is all a reader gets, and a delegate that dies before emitting a message row
  has no other carrier for its failure. When the delegation roster entry
  reports `error: { code, message }` (ADR 0089), the panel closes with an error
  card in the transcript's error visual language — the localized
  `errors.<code>` sentence when that code is registered and the localized
  `chat.subagentStatus.*` outcome otherwise, the stable code, and the raw
  message behind a Show details / Hide details disclosure with a copy action.
  The disclosure control sits in the card's heading so it stays reachable while
  the details are collapsed, and the card follows a **non-success** terminal
  outcome, so a completed or still-running delegate never shows one.
- The dock header identifies the view as **Subagent** and offers close and
  collapse controls. Closing returns to the previously selected work-panel
  resource, if any; `Cmd/Ctrl + J` hides the whole dock. Selecting another node
  replaces the task and process in place without changing panel width or the
  conversation scroll position.
- A session switch or leaving the chat route hides the selection. A stale or
  deleted delegation shows a localized unavailable state and never displays
  another session's rows.

## 6. SessionList

### 6.1 Purpose

List user sessions inside the sidebar: global pinned shortcuts, followed by
unpinned history for retained project tabs and path-less sessions.
Pin/archive/collapse state is a presentation over durable host
sessions, not a replacement persistence model.

### 6.2 Anatomy

Groups and session items:

```text
PINNED
           Pinned session title             project-name
[folder] current-project                         [+]
           Session title
[star] pinned-project                             [+]
           Session title
[folder] another-project                         [+]
           Session title
SESSIONS                                      [msg+][↕]
           Session title
```

Rows inside a project group are dated. The today bucket draws no header;
yesterday, the previous 7 days, the previous 14 days, and everything older each
draw a muted uppercase label above their rows, and only a bucket that holds rows
draws one:

```text
[folder] current-project                         [+]
           YESTERDAY
           Session title
           Session title
```

That label is an ordinary row of the list rhythm — no disclosure, no state, no
`aria-expanded` — unlike a project header, which is a real collapsible group.

Spacing ladder in the sidebar lists (`space-0.25` / `space-0.5` / `space-2` per
`04-ux/07-ui-design-system.md` §6.1):

| Relation | Gap |
|---|---|
| Row to row, including a date label and the load-more row | 1px |
| Project group header to its first row | 2px |
| Last row of an expanded group to the next group | 8px |
| Collapsed group to the next group | 1px |
| Section label to its first row | 2px |
| Sidebar section to sidebar section | 8px |

The 8px tail belongs to the expanded group itself, so the spacing is decided by
the preceding group alone: an expanded group is followed by 8px whether the next
group is expanded or collapsed, and a collapsed group is followed by 1px either
way.

The fold is one motion, not two. A collapsed group is a single grid row that
animates `1fr` → `0fr` over the 200ms normal duration, so every frame is a real
fraction of the group's measured height instead of a `max-height` clamp that
spends most of its curve above the content and then snaps. The rows are clipped
by an inner box with `min-height: 0`, never faded — opacity stays 1 for the whole
fold — and the 2px / 7px inset lives on the list inside that clip, so it travels
with the rows instead of holding the closed row open. Under
`prefers-reduced-motion: reduce` the fold keeps both endpoints and runs in a
near-zero duration. A folded group keeps its rows mounted, `aria-hidden`, and
`inert`, so they leave the tab order as well as the accessibility tree.

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
| Pinned conversation | shown once in the global Pinned section, with project context and the selected session sort |
| Archived | omitted by default; shown only when archived view is enabled |

### 6.4 Interactions

- Click: activate session
- Project matching uses the normalized full project path, never only the folder
  basename.
- Unpinned sessions for retained paths appear beneath their corresponding
  project group. Global pins remain available when their project is collapsed
  or closed; all sessions for closed paths remain discoverable from Settings →
  Project archive.
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
- Copy conversation ID writes the durable session id to the clipboard. Open
  session path opens `<data_dir>/scratch/<sessionId>/` in the system file
  manager, creating the directory if it does not exist yet. Both actions
  appear only while developer mode is on.
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
- The standalone Sessions body is a 146px window over five compact 28px rows,
  their 1px row gaps, and the 2px label inset; it
  scrolls internally when more rows exist. The Projects list uses the remaining
  sidebar height and scrolls independently; neither region scrolls the footer
  or primary navigation. Both list scrollbars use the same global 6px,
  trackless, transparent-at-rest rule as the conversation and work-panel
  scrollbars; the semantic-ink thumb appears when its list is hovered, focused,
  or scrolling and remains visible while dragging, so the independent regions
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
| Session transition | A warm destination pane is revealed immediately with its retained content and position. If it is running or still holds a not-yet-flushed completed reply, its live renderer snapshot survives the durable revalidation read. A cold destination leaves the visible pane on its own session under a thin progress track until it commits; nothing is dimmed, hidden panes stay mounted and inert, and current stream updates are not deferred |
| Streaming | New tokens append; auto-scroll only while pinned to bottom |
| Turn start | Send / retry / regenerate re-pins follow mode and jumps to bottom |
| Thinking-only streaming | Transcript opens; the latest thinking disclosure opens unless the user has taken it over; no empty answer bubble; the tail status continues to identify the running turn |
| Running fallback | Compact animated-dot Working row throughout the running turn when no specific runtime phase or planning state is known, including pauses after partial output or completed tools |
| Running planning | Compact animated-dot Planning / Goal row in that same slot throughout the planning turn; a runtime phase takes precedence, and pending user interaction or turn completion hides it. The Composer mode chip pulses |
| Idle | Scrollable; no auto-scroll |
| Permission pending | PermissionCard inserted inline; transcript continues after resolution |
| Context checkpoint | Existing transcript remains visible; compaction adds one divider row after the message it covers and one warning toast |
| Error | Error MessageBubble with actionable retry link |

### 7.4 Interactions

- Scroll: the first upward scroll movement immediately pauses auto-scroll,
  cancels pending follow work, and shows the "scroll to bottom" floating button;
  stream or resize updates cannot pull the viewport back down; send / retry /
  regenerate re-pins and jumps to bottom
- Hover message: its action row appears — Copy and the row's other per-turn
  actions.
- Assistant fragments emitted before and after tool calls compose into one
  `role="article"` turn. The turn exposes one trailing meta row and one action
  toolbar; Copy joins all contentful fragments in order, while Fork and
  Regenerate use the last contentful assistant message as the durable boundary.
  The toolbar mounts only when those actions are available: active turns and
  turns with assistant errors reserve no empty toolbar box. Running feedback
  stays adjacent to the last output instead of sitting below invisible buttons.
  Preserve the normal 14px assistant bottom padding and the runtime lane's
  full reserve (24px from a plain-text fragment to its status label at the
  default scale). User messages retain their real hover-action row and normal
  spacing, including before the first assistant output. Opacity hides those
  buttons without removing their space, so hover does not shift content.
- Toggle Thinking disclosure: expand/collapse reasoning independently from the
  final answer. The latest reasoning row opens while it streams and closes when
  the turn settles only if the user has not interacted with it. The expanded
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

### 7.5a Global session content search

- The existing global search input matches session titles, project metadata,
  and indexed user/assistant message text across all host-visible sessions.
- Group matches by session, show the complete matching-message count, and
  preview up to two snippets with localized sender labels, timestamps, and
  literal keyword highlighting. Metadata matches have a distinct badge.
- Each body preview shows the sentence or line containing the first match,
  using Chinese/English sentence punctuation and line breaks as boundaries.
  Preserve the complete sentence when it fits 180 characters; longer sentences
  use an ellipsized window that always includes the entire query. Render the
  whole bounded preview with normal wrapping, including on narrow windows;
  line clamping must never hide the matching text. Matches have a clearly
  visible background highlight in both light and dark themes.
- Keep archived sessions hidden in empty-query recents and discoverable through
  an explicit query. Exclude deleted sessions. Body-bearing untitled sessions
  remain discoverable through their content.
- Load more continues host session pagination; a renderer's loaded sessions or
  the old 50-session/100-message limits cannot truncate discovery.
- Clicking a message snippet closes search, opens its original conversation,
  and scrolls to the clicked message's matching rendered text with a visible
  literal highlight. A heading with body matches selects its first snippet;
  metadata-only headings use ordinary session navigation. Mouse and keyboard
  must select the same target ID, including individual assistant fragments.
- Old targets load a bounded 60-line original `UiMessage` window centered on
  their stable ID. The selected message keeps complete text beyond the usual
  display cap. Render the same transcript, Markdown, message actions, and
  composer; do not open a separate reader. Preserve the live cache separately.
  Upward paging and Load later messages extend the reading window. The existing
  latest-message control and a new turn return to live output. Actions on an
  old message prepare canonical input before editing, retrying, or branching.
- Ordinary history and search use one retained-session reading view, shared
  with subagent details. A nested answer reveals its owning Task and opens the
  existing details dock at the answer, even when the parent is outside the page.
  Do not silently ignore targets that have no top-level transcript row.
- Hidden Markdown URLs, syntax, and file-chip paths map to their visible source
  owner. Highlight and scroll to that element when the raw query has no literal
  rendered text. Preserve normal Markdown and file/link interactions.
- Canonical changes with unchanged IDs must invalidate stale reading content.
  Preparing edit/retry/branch inputs must also account for partial history and
  display-limited text, even when the selected message is already visible.
- Release bottom following on a search jump. Brief layout corrections may keep
  the selected text visible, but stop on a real reading gesture. Composer focus
  must not move the transcript. A missing target reports failure without jumping
  to an unrelated message; stale requests must not override a newer target.
- Preserve the query in memory when closing/reopening search. Debounce queries
  and reject stale results and errors after a new query, closure, or navigation.
  Loading and failure states must not masquerade as an empty result.
- Keep page, settings, and command results available. Arrow keys and Enter
  navigate session headings, snippets, Load more, and the existing result
  types. IME composition Enter must not activate a result; Escape during
  composition must not close search, including events bubbling from its input.

### 7.6 MVP constraints

- Global search locates a matching message inside its original conversation
  (ADR session-content-search). An independent in-transcript find bar remains
  outside this scope.
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

- Max content band: 760px default, user-resizable via dual edge handles
  (D439 / ADR 0277). Assistant, tool, decision, and structured assistant-error
  rows follow the band; error cards fill their message column without a second
  fixed width cap. User plates stay `min(82%, 600px)`.
- The live band is `min(available pane, preferred)`. Collapsing the sidebar
  no longer tightens a 640px ceiling; the outer pane stays fluid and the
  width transition follows the sidebar dock.
- Dual 12px handles sit on the band edges: invisible at rest; hover/focus
  reveals a short 2×40px capsule mixed from `--ds-text-primary` (18% dark /
  12% light). Dragging lengthens it to 56px at a slightly stronger mix.
  Double-click resets to 760px. Arrow keys step the width; Home restores the
  default; End fills the pane.

- User: right-aligned, theme-neutral soft plate (`color-mix` on primary ink,
  never a fixed accent tint), borderless, `radius-lg-plus` with a tighter
  bottom-right corner, capped at `min(82%, 600px)` so short prompts read as
  chat turns rather than full-width blocks. The plate shrinks to the
  prompt's max-content rather than stretching to that ceiling; inline file
  chips use a definite 240px name cap so a pasted file plus a short prompt
  stays compact. User body is plaintext with
  preserved hard newlines (`white-space: pre-wrap`);
  only trailing/leading composer trim is applied, never internal newline
  collapse. Serialized `@path` file references render as compact leaf-name
  chips matching the composer node (icon + ellipsized name; canonical path in
  the tooltip and accessible name). Image attachments that are not already
  inlined as `@path` chips render as bounded thumbnails (data URL from
  `fs/readImageDataUrl`); unresolved loads keep the chip. Bare path tokens in
  message text recognize Unicode letters and digits. In user-message prose,
  these are candidates only: show a chip after the existing `fs/resolveRef`
  lookup confirms a real file. Pending, missing, or failed lookups preserve
  the exact original text, including `使用llama.cpp`. Explicit `@path` refs
  and structured attachments retain their existing chips without speculative
  lookup. At most 32 unique candidates per message are checked, with four
  concurrent lookups across visible rows; additional candidates remain text.
  Confirmation is scoped to the message text, workspace path, and session; changing
  any of these discards old results and cancels queued work. Newly created
  files are reconsidered when the message remounts or its scope changes, not
  by polling. Non-ASCII filenames remain supported. Absolute and `~/` tokens are matched whole,
  and one outside the workspace (or any home path) stays plain text rather
  than rendering a chip that could never open — containment is unchanged
  (D322). Clicking a chip
   completes the reference through `pi-desktop/fs/resolveRef` — the whole open
   project is searched, its group's folders primary first (ADR 0263) — and opens
   where it resolved: a project file in the bundled `pi.file-manager` work-panel
   view (the host `file:` tab when that view is unavailable), a session-scratch
   or attachment file in the host `file:` tab, and a `.html`/`.htm` page of the
   primary folder in the side browser. A primary-folder file is addressed to the
   view as a project-relative path and a sibling-folder file as an absolute one,
   which is also how scratch and attachment files are addressed. A resolved
   image thumbnail resolves and opens the same way. A chip whose reference
   matches nothing opens nothing and reports itself; the OS default application
   is no longer what this click does.
  HTTP(S) URLs remain inline text links. Bare URLs preserve balanced parentheses
  in paths, queries, and fragments; an unmatched closing parenthesis wrapping
  the URL in prose stays outside the link. Sentence punctuation immediately
  after a closing URL parenthesis stays outside as well; suffixes such as
  `(draft).html` remain part of the URL. Plain clicks — including markdown
  links, autolinked URLs, inline-code URLs, and remote images — follow the
  persisted Link open destination setting (Work panel browser by default, or
  the system default browser). Right-clicking a link opens a body-level
  context menu with Open in default browser, Open in work panel, and Copy
  link address. Modifier clicks (Ctrl/Cmd/Shift/Alt) continue to open
  externally. Long URL links wrap
  within the plate and keep logical-start alignment instead of inheriting the
  browser's centered button text.
- Assistant: transparent surface, left-aligned, markdown rendered at full
  content width. Workspace file paths in that markdown are previewable:
  inline code, markdown links, and bare path tokens (with a known
  extension) complete and open like a chip against every folder of the open
  project (ADR 0263): the resolved file in the bundled
  `pi.file-manager` view (the host `file:` tab without it), a `.html`/`.htm`
  page of the primary folder in the side browser, and nothing plus a report when
  the reference matches no file. Local markdown images render
  inline via the same contained data-URL channel, with a chip fallback.
  Unprefixed relative paths
  resolve from the workspace root; `./` and `../` resolve from the workspace
  root in chat, and from the viewed file's directory when previewing a
  markdown document in the files tab. Parent escapes stay inert.
- Thinking: separate lightweight disclosure above the answer with no card
  background or outer border. Its Sparkles/chevron trigger uses secondary text,
  and the expanded markdown is indented by a subtle theme-token left rule. It
  is never concatenated into answer markdown.
- Hover actions: quiet icon-only action chips under the bubble — Copy on idle
  assistant turns; Fork and Regenerate on completed assistant turns; Edit and
  Delete on user turns. A streaming assistant turn omits its Copy action until
  the response settles. Assistant rows expose neither Delete nor Edit. Chips
  render the glyph
  alone: the label is carried by `aria-label` plus a themed hover/focus
  tooltip 8px above the chip (compact raised shadow, not the composer glow),
  never as visible caption text (D137). Right-aligned
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
  with Copy on row hover or keyboard focus. Right-clicking a user message or
  an assistant turn opens the same action vocabulary as a body-level
  pointer-anchored menu (Copy, Select text, and the row's own Edit / Delete /
  Regenerate / Branch / revision items). Right-clicking empty transcript
  space, a system row, or a permission/outcome card opens a conversation
  menu: Copy conversation, Select conversation text, Scroll to top, Jump to
  latest. Quote, Annotate, and Open side chat stay retired (ADR 0268). A
  streaming or empty assistant turn that would produce no items opens
  nothing. Copy on a speaking-turn menu writes the live selection in that
  turn captured when the menu opened; a collapsed caret, or a selection
  outside the row, falls back to the whole turn.
  Copy conversation reads the complete session on demand, including unloaded
  history and untruncated message text, and preserves the visible in-flight
  tail. It does not change the reading window or scroll position. A failed
  read reports an error without copying partial history. Copying from the
  menu reports through the toast host because the surface closes as soon
  as the item runs.
  Fork creates and activates an independent session whose snapshot ends at the
  selected assistant response, requires an idle source, and leaves that
  source's transcript, live runtime, and provider cache state untouched (D134).
  Opening a user-message editor must hydrate canonical history before seeding the
  draft when the loaded transcript is partial or display-limited. Never seed an
  editable draft from clipped display text. Failed reads keep the editor closed
  and show an error; stale reads after navigation or a new turn cannot open it.
  Slash invocations still seed their original typed command.
  Edit belongs to the user turn: it swaps the prompt bubble for a focused
  composer-radius editor filled with `--ds-tile-deep` (the same 8% mix as a
  user bubble) so it stays distinct from the pane without an outer shadow.
  Transcript rows paint-contain and the scroller clips overflow, so a
  composer lift would be cut off at the plate edges (D297: in-flow surfaces
  use tone, not stroke). Focus paints an inset 2px accent ring. The textarea
  is unboxed inside that plate; localized Retry and Cancel sit in a 28px footer
  (Escape cancels, Cmd/Ctrl+Enter retries; both shortcuts are ignored during
  IME composition, preserving the draft; slash turns seed the typed
  `command` form so retrying re-expands the template). Opening it widens the
  user column to the assistant reading width and hides the action toolbar.
  Retry runs the Regenerate path with the current text in the same session,
  even when the text is unchanged, so the replaced prompt and its whole
  answer tail are archived as a D109 revision and the pager walks back to
  the original exchange (D274).
- Tool-mediated assistant output uses one visual turn from the preceding user
  message to the next user message. Intermediate provider message boundaries
  remain visible as ordered markdown fragments around activity disclosures but
  do not create additional meta rows or action toolbars. The single Copy action
  copies all contentful fragments in order; Fork and Regenerate target the last
  contentful fragment so existing durable transcript semantics remain intact
  (D157).
- Assistant meta: optional model badge under the answer. The compact
  Codex-style context inspector lives in the composer right toolbar,
  immediately left of the model × reasoning chip, and always mirrors the
  newest assistant turn that reported usage (D347). Occupancy, remaining
  capacity, used/window counts, turn total, and provider
  input/output/cache/reasoning/hit-rate are that turn's newest usage-bearing
  assistant message (the last model request), using
  `input + output + reasoning + cacheRead + cacheWrite` (D355). They are not
  the sum of every model call in the visual tool-loop. It is hidden until that
  usage exists. The trigger keeps a small capacity ring beside the
  percentage and omits the redundant `Context` label; the leading figure
  (ring arc, percentage, token label, popover heading, tooltip, and
  `aria-label`) follows `settings.contextUsageDisplay` — `"remaining"`
  (default) or `"used"` — so the ring fills by `remainingRatio` or
  `usedRatio` accordingly. Low capacity changes the semantic color based
  on remaining capacity (remaining ≤ 25 % warning, ≤ 10 % critical)
  regardless of display mode, without making color the only signal.
  Clicking the trigger (or activating it from the keyboard) toggles a
  non-modal panel whose heading follows the same display-mode figure,
  followed by used/window counts and two
  unboxed turn/speed summary values. Model usage is compressed into one
  inline summary row that retains exact last-request
  input/output/cache/reasoning values
  and the provider-reported cache hit rate when available. Tool usage is
  compressed into one aggregate row showing tool types, calls, and estimated
  tokens; per-tool rows, share bars, source badges, and the explanatory
  estimate note are intentionally omitted from the default view. Rows below
  the heading share one muted-label / tabular-value rhythm separated by
  spacing; the popover keeps its floating-layer edge and draws no inner
  section rules (D297). Generation speed is a completed-turn value in tokens
  per second and is not updated while a response is streaming. The
  context-window total uses the same effective model window as the agent
  sidecar: a published models.dev `limit.context` replaces a legacy 128k
  generic binding seed, while a non-default per-model Advanced value remains
  explicit. Unknown models use the provider's generic default window. The
  panel is portaled to the document body as a fixed viewport overlay, flips
  above or below the trigger, clamps its horizontal bounds to the
  conversation pane — the work panel's native browser/plugin surfaces
  composite above every renderer layer, so anything crossing the pane's
  right edge would be covered regardless of z-index (D357) — and
  repositions on scroll, window resize, or conversation-pane geometry
  changes (sidebar and work-panel toggle, resize, and entrance animation
  are observed through a pane `ResizeObserver`, since none of them emit
  resize or scroll events) so no clipping ancestor or native surface can
  hide it (D103, D184, D244, D347). When the active session has an
  installed context checkpoint,
  the panel adds one muted summary line for the compaction count and newest
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
| Streaming | transparent like a completed turn — no left rail, no reserved inset, no whole-turn `--ds-tile` (D323); content grows. The tile belongs only to a subagent/delegation card (D319) |
| Thinking streaming | disclosure open; answer bubble omitted until answer text exists |
| Complete | transparent full-width markdown; no streaming chrome |
| Error | Compact assistant error card in transcript; localized summary and stable code share one header with the details disclosure; details still opens to redacted provider response, provider/model IDs, and copy action; the card offers localized Continue and accessible Dismiss actions. Dismiss affects renderer-only visibility keyed by message id and preserves the original UiMessage/host transcript. Configuration failures show Open settings. The session-scoped failed-turn recovery card is a fallback for terminal failures without a structured assistant error, so both cards never render for one turn |

### 8.4a Context compaction row

Not a bubble: a full-width divider between transcript rows, drawn after the last
message its checkpoint covers.

- One centered label — how many times the session has compacted — with no
  hairline on either side (D297); the label and its vertical spacing alone
  mark the checkpoint.
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
- Context inspector trigger (composer toolbar) is keyboard focusable, exposes a
  localized remaining percentage and token count, carries `aria-haspopup="dialog"`,
  `aria-expanded`, and an `aria-controls` relationship to the panel, and opens
  the same compact summary on click or keyboard activation; Escape or a click
  outside closes it and returns focus to the trigger
- The inspector panel is portaled to the document body and positioned in
  viewport coordinates, but its horizontal clamp is the conversation pane: the
  work panel's native browser and plugin surfaces composite above every
  renderer layer, so a panel that reached the panel column would be covered
  whatever its z-index. When the pane is narrower than the panel, the popover
  narrows with the pane instead of crossing that edge.
- Timestamps: `aria-label` with full time string, visual shows relative time
- Right-click menus are `role="menu"` with `role="menuitem"` rows, arrow /
  Home / End navigation, Escape / Tab / outside-press / scroll-behind
  dismissal, and an accessible name (`chat.messageMenu` or
  `chat.conversationMenu`). Focus returns to whatever the right-click
  interrupted. While editing a user message, Copy uses the selected draft text
  (or the whole draft if the caret is collapsed), and Select message text selects
  the draft. Saved-message Edit, Delete, and revision actions are not offered
  until editing ends.

### 8.6 MVP constraints

- No message reactions
- No edit user message (deferred)
- Copy assistant answer excludes thinking text

### 8.7 Markdown & code rendering (implemented)

Renderer: `apps/desktop/src/components/Markdown.tsx` + `apps/desktop/src/lib/shiki.ts`
+ prose styles under `.prose-chat` / `.code-block` in `styles/prose.css`.

- **Streaming without jank**: runtime content chunks render directly, without a
  second renderer-side typewriter or animation-frame state loop. Source splits
  into top-level blocks via the same remark/GFM/math grammar used for rendering;
  raw source slices preserve CRLF and offsets. Each block renders through a
  memoized `<ReactMarkdown>`. While streaming only the tail block re-parses
  (incremental parsing from the last block boundary); an unclosed math fence
  retains its entire body in that tail, including blank lines. A Mermaid fence stays in the normal source-code presentation
  until its matching closing fence arrives; partial streamed diagrams never
  enter the diagram parser. Splitting is skipped entirely for a message that
  declares a link or footnote definition, wherever it sits: definitions resolve
  across the whole message, and footnotes also number, reuse and back-link
  across it, so the message renders as one parse context and gives up per-block
  memoization for as long as it streams.
- **Plugins**: `remark-gfm` (tables, task lists, strikethrough, autolinks),
  `remark-math` + `rehype-katex` (inline `$…$` or `\(…\)`, display `$$…$$`
  or `\[…\]`). Raw HTML is
  parsed by `rehype-raw` and immediately constrained by the extended
  `rehype-sanitize` default schema; only the renderer-owned audio/video/source
  additions and the `math-inline`/`math-display` classes on `code` (which keep
  TeX `\[…\]` in display layout) are admitted. KaTeX's Vite-inlined WOFF2 fonts
  are allowed by the renderer's `font-src 'self' data:` CSP directive.
- **Copying a formula (D619)**: a selection that covers rendered math reaches
  the clipboard as the TeX it was written in — `$…$` inline, `$$…$$` on its own
  lines, each run widened past any run inside the formula the way a code span's
  fence is, so a formula carrying a literal `$` still reads whole. Inline stays
  the narrow run because an inline formula's TeX can carry a newline, and a
  `$$` run at the start of a line opens a flow block and swallows the
  paragraph. KaTeX paints every formula twice (a MathML tree and a visual one), so
  the platform's own copy wrote both renderings and never the source
  (issue #414). `lib/selection-tex.ts` reads the TeX back out of the MathML
  `annotation` and grows a cut that lands inside a formula to the whole formula;
  `hooks/use-copy-tex.ts` is the single document `copy` listener the shell owns,
  and the transcript's right-click Copy reads the same selection through the
  same module. Only the formulas are rewritten: the reduced clone is read back
  through `Selection.toString()`, the serializer a copy itself runs, and read
  inside the element the selection came from, so the cascade deciding that
  reading is the live one. The prose, lists, tables and code blocks that share
  the selection therefore read exactly as the platform already read them — the
  chrome a copy leaves behind included, whether `base.css` marks it
  `user-select: none` by selector or it is inert only by inheriting the shell's
  default. A selection with no formula in it is left to the platform entirely;
  nothing else is tested, because Chromium raises a copy inside the selection
  it derived the event from, so a whole selection reaches the clipboard as its
  source however deep in it the event was raised. The copy writes one flavour,
  `text/plain`: taking
  the event over drops the platform's `text/html` too, and none is written back
  — the reduced clone is app markup, so it would carry the `user-select: none`
  chrome the text reading drops, and carrying the rendering instead would paste
  every formula twice, KaTeX's stylesheet being the only thing that hides the
  MathML tree. A rich paste target falls back to the plain text.

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
  no border since D297 — a `--ds-tile` plate; dark `#282c34`, light `#fafafa` — matching One Dark Pro /
  One Light editor bg). Header is transparent (language tag left, copy right);
  body `pre`/`code`/token spans have **no nested background**, so Shiki token
  colors sit on the one card surface. Body text at text-sm-plus /
  leading-relaxed with horizontal scroll and tab-size 2.
- **Prose**: calmer chat density — body at text-base / leading-prose with
  pretty wrapping; heading ramp h1 `text-xl` (no underline since D297) → h2
  `text-lg-plus` → h3 `text-lg` → h4 `text-base-plus` → h5/h6 `text-base`
  secondary; blockquotes are a soft `--ds-tile` plate with no rule (D297);
  hr is pure spacing; lists use quieter markers and flex task
  rows; inline code gets a soft gray tint and no border; tables drop cell
  borders for a `--ds-tile-deep` header and zebra `--ds-tile` rows and wrap
  in `.table-wrap` (rounded shell, header row, even-row wash, hover wash).
  The wrap and table fill the transcript width; cell text wraps
  (`overflow-wrap: anywhere`) so many columns or long tokens do not force a
  horizontal scrollbar. `overflow-x: auto` remains only for unbreakable
  content.
  Display math sits in a subtle inset plate. Thinking prose reuses the same
  hierarchy at text-sm-plus / secondary color.
- **Light theme**: paper-quiet surfaces — links use soft underlined ink
  (not hard black/blue), inline code `#f2f2f2`, fenced code cards use One
  Light `#fafafa` (no nested wash / drop shadow), blockquotes `#f6f6f6`,
  tables on white with `#f3f3f3` header / `#fafafa` zebra. Dark fenced code
  uses One Dark Pro `#282c34`.
- **Links**: plain click previews in the work panel; modified click keeps
  `target="_blank"` so main routes through `shell.openExternal` after the
  http(s)/mailto allowlist (D330); in-window navigation stays blocked.
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
  scroll-only trigger could never fire again. A collapsed scroller and a pinned
  overflowing transcript whose `scrollTop` has been reset to 0 are not treated as
  "at the top", so opening or revealing a session cannot page back to the start.
- **Minimap hover cost**: dash magnification is applied by writing a custom
  property per dash, and dash centers are measured in a separate read-only pass.
  Reading a dash's geometry inside the same loop that writes to it forces one
  synchronous layout per dash on every hover frame. The measurement is refreshed
  when the marker set changes and whenever the rail's own box resizes: the rail's
  height derives from `--composer-dock-height`, which the composer republishes as
  its draft grows, so dashes move without a marker change or a window resize.

#### Markdown table actions

Every rendered Markdown table has its own compact toolbar: Copy as Markdown,
Download as CSV, and Expand table. Copy preserves inline Markdown and column
alignment and produces a standalone table even inside a quote or list. CSV
contains the displayed cell text, UTF-8 with BOM, quoted fields, and CRLF rows;
quotes and cell line breaks are escaped, and formula-leading nonnumeric cells
are exported as text. Clipboard failures produce an error toast.

The expanded view uses a modal dialog with the existing theme tokens, a scrollable
table and opaque sticky headers, and copy/download controls. Columns retain
readable minimum widths; narrow previews scroll horizontally instead of crushing
short labels. It follows streamed rows,
contains keyboard focus, closes with Escape or Close, and restores focus to its
trigger. Native work-panel surfaces remain hidden while the modal is open.
Tables retain their existing inline layout and link/file actions. No editing,
sorting, new settings, persistence, or host protocol is introduced.

---

## 9. ToolCallRow

### 9.1 Purpose

Lightweight inline disclosure row showing a semantic tool action, its primary
argument hint, status, and a readable rendering of the result. It follows D071
and is intentionally not an elevated card.

One contiguous tool/search/thinking segment between progress paragraphs becomes an
ordinary processing group only when it has two or more visible items. A singleton
uses its item disclosure directly, and Task topology keeps its existing container.
While the turn is active, the ordinary group owning the execution segment opens in
Detailed and remains closed in Compact; when it settles, an untouched Detailed
group closes. Detailed auto-opens a leaf payload only when the literal final item
of the last activity group is an eligible tool-call or hosted-search row. Earlier,
failed and denied rows remain closed, and a final thinking item does not select an
earlier tool. Compact keeps every tool/search payload closed.

The group header shows `Processing · 12s` while active or `Processed for 12s`
after completion, plus bounded item and issue counts. Expanding it reveals the
ordered activity rows and their independent result disclosures. A failed child
remains an error on its own ToolCallRow but does not make the group or whole turn
terminally failed; terminal agent errors remain owned by the assistant error or
TurnOutcomeCard surface. A user action on a group, item, or collapse rail claims
that level and its ancestors without toggling them, so streaming and completion
never reverse the chosen state or close around focused/selected content.
Elapsed labels use compact automatically carried units: seconds below one
minute, minutes plus seconds below one hour, and hours plus minutes (and
seconds when non-zero) from one hour onward. Zero-value units are omitted, so
`90m` is rendered as `1h 30m`.

### 9.2 Anatomy

```text
[sparkle] Processing · 12s  3 steps                 [›]
          ├─ [file] Read /src/foo.ts        [›]
          ├─ [search] Searched TODO  24 matches   [›]
          └─ [terminal] Ran pnpm test  exit 1  • Failed  [copy] [›]
             3 passing
             1 failing
```

- The leading Lucide icon reflects the action type: file, folder, search,
  edit, terminal, web, or generic tool.
- A multi-item group header owns elapsed time plus item and issue counts and stays
  in the transcript after completion. In Detailed the active group starts open and
  closes on completion only if untouched; completed groups otherwise start closed.
  Compact groups start closed. A singleton has no group header.
- Tool/search payloads remain collapsed in Compact. In Detailed, only an eligible
  literal final item of the last activity group starts expanded; failed/denied
  items remain closed, and a final thinking item does not select an earlier tool.
  Live thinking follows its own disclosure policy and never opens sibling payloads.
- The processing group spans the full available assistant column, so expanded
  result details keep a usable width even when the header or payload is short.
- The visible label is a natural-language action (`Read`, `Ran`, `Searched`),
  not the raw function name. Running actions use the progressive form.
- The primary argument is a clamped single-line monospace hint.
- Result chips follow the hint: exit code (error hue), match/file counts,
  replacement count, Write byte size, Read line count plus its 1-based closed
  line range (`{lineCount},L{offset+1}-L{offset+lineCount}`), `truncated`, and
  `scratch`. Read uses `offset` and `lineCount` from the returned window rather
  than `fileBytes`; if those fields are unavailable, it omits the read-size
  chip instead of presenting the whole-file size as the amount read. A
  successful exit earns no chip — the row status already says so. The
  `truncated` chip follows `details.truncated` and therefore appears only when
  this result was cut short, not when a Read window of a longer file was filled
  (D306).
- Live activity remains in the processing group, its latest row, or the
  dedicated runtime indicator; no additional status capsule is rendered.
  Long paths remain in the row summary and are ellipsized.
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
- Header gap: 4px; expanded tool-call details align with the row's own content
  start and do not add a second horizontal inset. The collapse rail remains
  available beside the expanded body. Thinking disclosures and subagent
  topology nodes retain their dedicated hierarchy insets.
- Chips: monospace `--text-2xs`, `--ds-tile-deep` fill (no border, D297), error hue for exit codes
- Code, file list, match list and field blocks: `font-mono text-sm`,
  independently copyable, capped at 260px with internal scrolling
- File-list paths are block-level, start-aligned rows (same box as Grep path
  headings). A full-width `<button>` must not justify the path's characters
  across the block.
- Diff blocks reuse the review card's `.diff-line` rails
- Only expanded content receives an inset surface and subtle border

### 9.5 States

| State | Header treatment | Expanded content |
|---|---|---|
| Running | Progressive action with readable text and a pulsing marker; a `run` row also shows its spinner and pulses the status dot beside `Working…` | Detailed opens the active multi-item group; only an eligible literal-final tool/search payload opens. Compact payloads stay closed; live thinking follows its own indicator/disclosure policy |
| Success | Past-tense action + result chips; no green success badge, except a `run` row's dot and `Done` | Result blocks, then arguments if not already shown; an untouched active group closes on completion, while manual group/item choices and the detailed literal-final leaf state are retained |
| Error | Past-tense action + compact danger status; details remain collapsed by default and open only on user request. A `run` row is in this state whenever its command exited nonzero, whatever the call reported (D227) | Error note first, then arguments |
| Denied | Muted `Denied` status; payload remains closed until requested | Permission result when available |

### 9.6 Interactions

- Click the row: expand/collapse only that result payload. Compact payloads start
  closed. Detailed starts a payload open only when the row is the eligible literal
  final item of the last activity group; earlier, failed and denied rows remain
  closed until the user opens them.
- A file path that a row or its result names is a link, not decoration: clicking
  the summary path of a `Read`, `Write`, `Edit`, or `fetch` row, or a path in a
  result's file list or match groups, completes the reference through the same
  opener a chat chip uses (`pi-desktop/fs/resolveRef`) and opens where it
  resolved — a project file in the bundled `pi.file-manager` view, a
  session-scratch or attachment file in the host `file:` tab, and a `.html` /
  `.htm` page of the project's primary folder in the side browser (ADR 0262,
  ADR 0263). Such a click opens the file instead of toggling the row's
  disclosure, and a reference that matches nothing reports itself without
  opening a panel. A tool surface picks no destination of its own.
- Click the processing header: expand/collapse only that ordered activity list.
  Detailed opens the active group and closes it on settlement only if untouched;
  completed groups otherwise start closed. Compact groups start closed. Opening a
  group does not expand every item, and sibling groups remain independent.
- Click or keyboard-activate the left rule beside expanded thinking, tool details,
  delegated work, or processing steps: collapse that owning disclosure without
  changing adjacent expansion state. Item interaction also claims its containing
  group and whole process as user-owned without toggling them; automatic stream or
  completion transitions never reverse those states.
- A failed child row remains error-hued and reports its failure in the row header,
  but its payload is not auto-expanded. The containing group settles as
  `Processed for {elapsed}` with an issue count even when a later tool recovered.
  Expansion uses a short height/opacity transition and keeps collapsed content inert.
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

### 9.9 Delegation cards and fan-out topology (D201, D265, D268, D271, D302, D319, D323, ADR 0062)

A `Task` call is presented as a node of a delegation card, not as a compact tool
row — one delegation reads the same as a fan-out (D265). The node names the
delegate it ran, taken from the rows it produced or, before any arrived, from
the call's own `agent` argument, and carries the call's short `description`. The
resolved model id is shown immediately after the delegate name, from the
structured `Task` result details.

The topology node is width-aware at every panel size. Its title may occupy up
to two lines, its description is clamped to two readable lines, and its step
summary can wrap rather than forcing the user to resize the divider. Complete
descriptions remain available through the node's accessible name/hover title;
the node and its live process never create horizontal overflow.

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
  │ (◎) Main agent │────│ [bot] code-reviewer  claude-sonnet-4-5 · Completed · 32s │
  │ Coordinating 1 │    │ check the store diff                      │
  │ delegated task │    │ 3 steps                                   │
  └────────────────┘    └───────────────────────────────────────────┘
```

Clicking a topology node opens a dedicated `subagent` tab in the work panel —
the same tab strip that hosts Review, files, and plugin views — instead of
expanding the transcript. Re-opening the same delegation activates its tab;
parallel delegates coexist as independent tabs. The tab renders the delegation
as a conversation:

```text
┌──────────────────────────────────────────────┐
│ [bot] [code-reviewer] [✕]  [bot] [explorer#2] [✕]   [+] ⤢ │
├──────────────────────────────────────────────┤
│                    ┌──────────────────────┐ │
│                    │ Review the changes   │ │
│                    │ in src/stores.       │ │
│                    └──────────────────────┘ │
│ ● Thinking …                                │
│ ● Read store.ts                             │
│ The store diff looks consistent. …          │
│                    ┌──────────────────────┐ │
│                    │ Now check the tests. │ │
│                    └──────────────────────┘ │
│ ● Edit composer.tsx                         │
├──────────────────────────────────────────────┤
│ [ Subagents are driven by the main agent… ] │
└──────────────────────────────────────────────┘
```

- The tab is a message list, not a card: every `Task` call of the resume
  chain renders its `task` argument as a user row (the main transcript's user
  bubble), and the delegate's thinking, tool, and answer rows under that call
  render with the same message-list language, so a follow-up prompt reads as
  the next user turn.
- The composer at the foot is a disabled two-row textarea whose placeholder
  says subagents are driven by the main agent and cannot take input; the tab
  is display-only and has no send path.
- Tab labels carry the agent name captured when the tab opened, with a
  strip-order `#n` suffix when the same name occurs more than once; a
  localization fallback covers a delegate with no name.
- Tabs are never opened automatically when a delegate starts. They persist
  after the delegate settles until the user closes them and are scoped to
  their session like every other tab.
- The conversation is re-found from the session's live/retained messages, so
  streaming rows keep arriving in the open tab while the delegate runs.
- A delegation whose Task calls are missing renders a localized unavailable
  state. Delegation rows remain excluded from the parent turn stream and
  minimap.

- Runs are rebuilt from the message list on every render, so group memoization
  compares them by row identity and length rather than by object identity —
  otherwise a streaming delegate would freeze at its first row.
- Every `Task` call in an activity group becomes one full-width delegation card
  rather than a compact tool row, a lone delegation included (D265). Its header
  presents aggregate state, the number of subagents, the settled/total count and
  elapsed time; it keeps the standard disclosure caret. The aggregate state is
  count-aware, so a single delegation is not announced in the plural.
- **The card contains only those `Task` calls** (D319). Consecutive `Task`
  starts stay in one topology group so a fan-out still reads as one card.
  Parent thinking, workspace tools (`Read`/`Grep`/`Bash`/…), and lifecycle rows
  (`TaskWait`/`TaskList`/`TaskStop`) are a separate processing group — before
  the card, after it, or both — so the parent's own work is not painted as
  subagent work. The tile, the “Subagent working” header, and the topology
  canvas belong only to that Task group. The parent turn itself stays
  transparent while streaming — no whole-turn tile wrapping thinking, tools, or
  answer fragments (D323). The card keeps 16px inset from its
  tile edge so the graph and any leftover rows do not sit on the border.- Runs are rebuilt from the message list on every render, so group memoization
  compares them by row identity and length rather than by object identity —
  otherwise a streaming delegate would freeze at its first row.
- Every `Task` call in an activity group becomes one full-width delegation card
  rather than a compact tool row, a lone delegation included (D265). Its header
  presents aggregate state, the number of subagents, the settled/total count and
  elapsed time; it keeps the standard disclosure caret. The aggregate state is
  count-aware, so a single delegation is not announced in the plural.
- **The card contains only those `Task` calls** (D319). Consecutive `Task`
  starts stay in one topology group so a fan-out still reads as one card.
  Parent thinking, workspace tools (`Read`/`Grep`/`Bash`/…), and lifecycle rows
  (`TaskWait`/`TaskList`/`TaskStop`) are a separate processing group — before
  the card, after it, or both — so the parent's own work is not painted as
  subagent work. The tile, the “Subagent working” header, and the topology
  canvas belong only to that Task group. The parent turn itself stays
  transparent while streaming — no whole-turn tile wrapping thinking, tools, or
  answer fragments (D323). The card keeps 16px inset from its
  tile edge so the graph and any leftover rows do not sit on the border.
- A delegate's terminal Task snapshot updates its topology node, settled count,
  elapsed time, and open detail dock immediately, even while siblings or the
  parent remain active. A completed delegate is green and stops spinning.
  Terminal Task state takes precedence over older lifecycle polling snapshots
  that still say `running`; the same outcome survives transcript reload.
- A topology group stays live — open once, ticking elapsed, labelled working —
  while any of *its* delegates is still running, even when the parent has
  already moved on to a later processing group in the same turn. Elapsed time
  uses that card's own delegation `startedAt`/`completedAt`, not the immediate
  `Task` tool-call duration and not a later fan-out in the same turn. After
  the parent turn has ended, leftover `running` nodes reconstruct as
  `aborted` (the runtime aborts them at run end) unless a `TaskStop` row
  already marked them `stopped`. `TaskStop`'s `details.stopped[]` is a
  lifecycle status source, same as `TaskWait`/`TaskList` `delegations[]`; a
  snapshot that still says `running` is presented as `stopped`. A finished
  session therefore never keeps a live “Subagent working” card.
- The brief spawn window before a delegate settles is presented as a creating
  state rather than a generic running one. Because the parent `Task` returns
  its structured handle (`delegationId`, `startedAt`) only at its own
  `tool_end` (ADR 0089), a `Task` row that is `running` with no delegation
  payload is identified as still being created: its node and dock badge read
  `chat.subagentCreating` (“Starting subagent…”), the status icon pulses in
  the subagent accent, and the elapsed clock ticks from the call's own
  `createdAt` instead of waiting for the handle — so the creation phase never
  reads as stalled. Once the result arrives the node transitions to the normal
  `running` presentation and continues from its real `startedAt`.
- The expanded card renders a low-noise dotted canvas with one main-agent root
  connected to the `Task` nodes in parent-row order. The runtime exposes no
  delegate dependencies and forbids nested `Task`, so the renderer must not
  invent delegate-to-delegate edges or a downstream summary node.
- Each node shows the definition name, effective model id, short description,
  explicit outcome, runtime duration and step count. The duration uses the
  delegation registry's
  `startedAt`/`completedAt` timestamps (and ticks live while the node is
  running), not the immediate `Task` tool-call duration, and uses the same
  automatically carried `h`/`m`/`s` format as the processing-group header.
  Outcome prefers the
  structured `Task` result
  (`completed`, `truncated`, `timed_out`, `aborted`, `stopped`, `failed`) and falls back to transport
  state (`running`, `error`, `denied`, `success`). Clicking the node expands the
  existing brief/report/counters and nested rows; the report remains printed
  exactly once.
- A topology that first appears while the turn is active opens once so progress
  is visible, then closes when its activity settles if the user has not
  interacted with the card. Reloaded history remains collapsed by default. A
  user click on the card header or its collapse rail owns the card disclosure;
  later lifecycle updates never reverse that choice. The header and every node
  are keyboard disclosures with `aria-expanded`/`aria-controls`; status is
  written in text and reinforced visually rather than conveyed by color alone.
  At narrow chat widths the graph becomes a vertical flow without horizontal
  page overflow.

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
`.pi/<kind>/*.md` path; the opener prefers the bundled file view and falls back
to the host file tab when that view is not launchable (D452). Opening the
artifact reads the host-written file; renderer edits do not change the approved
bytes. The submitted question/description, status, validity/deadline, inline
Markdown, SHA-256, byte size, and revision/feedback controls are not rendered
card content.

Because the bundled file view can edit and save the file it opened (ADR 0241),
an artifact changed before Approve no longer matches the recorded hash: the host
fails that approval closed with `PLAN_ARTIFACT_HASH_MISMATCH` until the proposal
is rejected and resubmitted.

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
| [Agent/Plan/Goal] [permission mode]     | [ring %] [model · reasoning ▾] |
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
- Elevation: 20px radius with the restrained soft shadow alone; the hairline
  stroke was removed in D297;
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
  switching modes never reflows the adjacent Composer controls. Cycling the
  chip cross-fades the icon and label in place. While the live turn is
  `planning`, the chip pulses on its icon (purple) instead of leaving a
  second status row parked above the composer; a staged mode choice still
  updates the chip immediately and does not start that pulse until the
  in-flight turn actually projects `planning`.
- The permission chip remains visible in Agent, Plan, and Goal for a stable
  toolbar rhythm. Agent and Plan expose the effective selectable permission;
  Goal displays the localized Auto label as a disabled, non-opening chip while
  the approval card remains the separate place for choosing execution policy.
  The permission menu stays 120px wide; its Chinese Composer short label for
  Accept edits is `允许编辑` / `允許編輯` so the option remains single-line
  beside its selection indicator.
- The right toolbar owns the remaining-capacity context inspector (when the
  newest assistant turn has usage) immediately left of one combined model ×
  reasoning-level chip, then the standalone prompt-enhancement action and the
  single Stop/Send submit slot (D347). The inspector trigger shows the ring
  and percentage only. The chip shows Bot, the current model name, and the
  current canonical reasoning level value separated by `·`; `off` omits the
  level text. The canonical value is rendered as-is (`low`, `high`, `xhigh`,
  or `max`) and is not localized. The
  prompt-enhancement action shows Sparkles while idle, uses the shared
  `.tool-spinner` and localized `Enhancing…` label while running, and remains
  a one-shot draft rewrite action. Inline file-reference chips, including
  pasted image chips, do not disable this action and remain in the draft.
- MainPane and the chat surface keep a 450px hard minimum. The composer toolbar
  remains a single, non-wrapping row as its container narrows: the mode and
  permission labels stay on one line and ellipsize within their chips, while
  the combined model × reasoning trigger progressively gives up detail. At
  560px it hides the reasoning level label, at 480px it tightens the model label
  cap, and at the 450px floor it becomes a 32px icon-only trigger. The trigger's
  menu and accessible name retain the complete model/reasoning selection. The
  context inspector hides its percentage at the floor and the enhancement
  loading state becomes icon-only, preserving the action hit targets without
  clipping or overlapping toolbar content. Home and thread-docked composers
  use the same responsive rules.
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
  the empty home and a recorded conversation. In a recorded conversation,
  `.composer-dock-docked` paints no backing of its own: `.thread-scroll` masks
  its own content out across the trailing reserve the transcript holds below
  the Composer's measured height, so rows fade at the Composer boundary instead
  of remaining visible beneath the floating shell or through its rounded outer
  corners, and the conversation pane's own surface stays visible behind the
  dock (issue #728, D624).
- Empty draft height: `.composer-input` uses `min-height: 3lh`, so an idle
  composer shows three lines of input before it grows with the draft.
- Scroll stability: The thread scrollport reserves one stable trailing gutter,
  so the transcript does not shift when overflow appears while the minimap
  does not create a matching blank strip on the left.
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
| Idle (ready) | textarea active; Send requires draft content | Send active when content exists |
| Home/new-session initialization | textarea and mode/model × reasoning/permission triggers remain available while the durable empty session is loading; the session row is already present and the first configuration selection applies to that session | Configure the session, then send |
| New session (reasoning model) | Combined model × reasoning chip shows the model and its binding default thinking level | User may select any level enabled in the model binding, including Off when enabled |
| New session / switch while another session is running | textarea active, send button enabled for the destination session's own run state | Send active, Stop hidden unless the destination session itself is running with an empty draft |
| Running | textarea and mode/model × reasoning/permission controls remain editable for the next turn; the single submit slot shows Stop only with an empty draft | Send queues text or attachments; Stop when both are empty |
| Context checkpoint | Same as Running until durable checkpoint completion; intermediate `turn_end` does not reactivate controls. A retained-tail fallback remains Running and shows a warning toast | Same single-slot Stop/Send behavior as Running |
| Permission pending | textarea disabled (per [03-permission-ux.md](03-permission-ux.md) §7) | Send disabled; Stop remains active whenever the running empty-draft condition is met |
| Plan / Goal / planning | textarea active while idle; contract badge and permission chip visible; mode chip pulses while the live turn projects `planning` | inspect, send, or submit a contract |
| Plan / Goal / awaiting approval | approval surface shows only the title and artifact opener for the exact `.pi/<kind>/*.md` approval; draft is preserved read-only and composer controls remain blocked for that session | approve or reject |
| Plan / queued or running | Agent badge remains selected; queue/running state is visible; draft and next-turn controls remain editable | Stop; Send queues the next prompt; no replay control |
| Plan / Goal / planning after rejected, expired, or interrupted proposal | contract chip remains visible and editable | send a later prompt; submit a new contract; no execution action |
| No workspace | textarea active, warning banner "No project — tools limited" | Send enabled |

### 11.5 Interactions

- Enter: send message when Enter-to-send is on; insert a newline when it is off
- Native file-system drop: while a file or folder is dragged over the Composer
  shell, prevent the browser default and show an accent outline without
  changing layout. Regular files are saved through the existing bounded
  session-scratch paste flow and appear as removable leaf-name chips in drop
  order. Folders are not traversed or copied; insert the complete native path
  at the caret as the literal `@<path>/` directory form. Mixed drops preserve
  item order and restore focus/caret after file materialization.
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
- Shift+Enter: newline in textarea. Cmd/Ctrl+Enter sends when Enter-to-send is off. IME composition and an open autocomplete menu still take precedence over send.
- Placeholder guidance: the initially rendered context starts on its welcome copy and remains
  unchanged while the page/session context, draft, focus, and IME state change.
  Switching between home/session views or active conversations advances to the
  next localized command/file or keyboard hint with an opacity fade; there is no
  timer, and clearing or sending a draft never changes the guidance.
- Escape: when textarea focused, clears input or blurs (not abort)
- Send while running: clears the current draft and appends one FIFO row to the
  active session's Host-owned queue when the draft has content. The row is sent
  as a new normal prompt only after the current run reaches `agent_end`; a
  different session's queue is not affected by switching sessions. Running with
  an empty draft changes this same submit slot to Stop. Clear the draft to
  expose the immediate-stop action.
- Queued row: the text, then move up, move down, Send now, edit, and remove.
  Move up/down swaps the row with its adjacent waiting neighbour and mirrors the
  Host's durable `position`; at the waiting-block boundary it is a no-op and
  never crosses into the promoted block. Edit removes the row and returns its
  captured draft — text plus inline file-reference chips — to the composer;
  after an app restart, when that in-memory draft is unavailable, restore the
  Host-stored content and image/file attachments without rewriting the content;
  while the input is non-empty (or holds attachments) the action is refused with
  a toast and nothing changes. Remove drops the row immediately.
- Send now: promotes the row to the end of the session's priority block, so a
  second Send now leaves behind the first instead of replacing it at the head.
  It then requests `agent/stop`, and the promoted block is released after the
  current reply/tool batch completes normally, before every waiting row. The
  first promoted row starts the turn and the rest join it as adjacent user
  messages, so the block is answered once. When idle it starts immediately.
- A pending queue row is locked until Host admission returns its durable id: move
  up/down, Send now, edit, and remove are disabled. All five tooltips explain
  that it is saving; Send now also displays the localized Saving label. Direct edit/remove actions leave the pending row and draft
  unchanged; after admission, ordinary waiting-row actions become available.
- A promoted row fixes order: move up/down and edit are disabled with
  their tooltip and `aria-disabled` state intact, and the Send now button reads
  as waiting for the current task (`chat.sendNowPending`). Remove remains
  available until delivery and waits for Host acknowledgement. If delivery
  already started, show a conflict message directing the user to Stop.
  The row carries a distinct
  promoted surface so it is not mistaken for another waiting row.
- Stop: the single submit slot is shown only while a turn is running and the
  draft is empty. It stops the running turn and cancels pending permission.
  Before any
  assistant text, thinking, or tool row begins, it also removes the just-sent
  user row and restores the pre-serialization composer draft. Ordinary text
  returns to the textarea and file references return as leaf-name chips; their
  canonical paths never become textarea text. After a reply begins, Abort keeps
  the partial transcript and restores no draft.
- Stop never clears queued prompts. Removing a row is explicit; the queue itself
  is Host-owned and durable (D386 / ADR 0213, ADR 0265), so a restart restores it
  in delivery order, held until the desktop attaches as the owner.
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
  session (D301). The cache is module-scoped, not instance state, so a remount
  — empty-home ↔ docked, chat ↔ Settings/Plugins/other pages, or the window
  hiding and showing — restores the same slot. Switching sessions saves the
  source draft and restores the target draft. Restoring a composer in the same
  workspace must retain relative `@` file references as well as absolute scratch
  attachments; workspace-reference cleanup runs only when the workspace changes.
  An uncached target and every newly created session start empty. A pending paste
  retains the source draft's existing file references even if saving finishes
  after a session switch. The no-active-session home composer has
  its own slot. A successful send clears only the submitting session's slot,
  including when navigation occurs while the request is in flight, and
  deleting a session drops its slot. If the contenteditable DOM is wiped while
  the window is in the background, the next focus or visibility restore paints
  the cached value back.
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
  configuration. An optimistic model or thinking pin must not keep capability
  fields computed for an unpinned or previous model. The Composer falls back to
  the selected model's catalog/binding levels whenever the session snapshot has
  no usable thinking menu (`supportsReasoning: false`, a missing level list, or
  an empty list), so changing a level during a turn cannot collapse the submenu
  to Off-only. An active pending Plan or Goal approval still disables these
  controls. Approval actions are the exception while awaiting approval. The
  Composer-left Agent/Plan/Goal chip is the sole mode
  control and cycles Agent → Plan → Goal → Agent on click. The Composer-right
  model × reasoning chip owns both selections. Palette and Composer slash mode commands use the
  same active-session configuration path; after host confirmation resolves an
  approval, the approval surface is removed rather than remaining as a terminal
  action card.
- New Task reveals the empty home on the first frame, so the previous
  conversation does not linger while the durable row is created. The home
  composer may briefly have no `activeSessionId` during that create. Its idle
  mode, model × reasoning, and permission triggers remain enabled; once
  selected, the configuration applies directly to that session. A new task
  appears in the sidebar from the `session.create` summary before it carries
  input, and a running turn or pending approval still gates those controls.
- While the home composer has no active session, its Thinking trigger resolves
  capabilities from the exact model selected in the model menu (using the
  cached catalog record), not from that provider's default model. Selecting a
  model therefore updates the draft Composer's available levels and binding
  default thinking level immediately; the persisted session keeps the same
  exact-model capability after materialization.
- A new session whose inherited default model supports reasoning starts with
  Thinking enabled at that model's stored default thinking level, clamped onto
  the enabled set. When the binding has no default, it falls back to the
  highest enabled level. Published levels seed a new binding; an explicit
  binding can opt into a level the catalog omits. Non-reasoning models and
  missing capability metadata start at `off` until a user enables a non-`off`
  level. Reopening an existing session preserves its durable selection;
  explicitly switching to a different model applies that binding's default,
  while selecting the already-active model preserves a manually chosen level.
- The model menu lists only enabled, runnable providers with configured model
  bindings. Cached or freshly discovered rows may enrich those configured
  models, but unconfigured discovery results never appear in the conversation
  list; configured IDs remain visible when discovery is unavailable.
- Opening the combined menu starts model hydration before the Model submenu is
  entered. The first visible rows use cached metadata or configured bindings;
  live discovery updates them in the background without replacing a configured
  alias with the wire ID or a second visible name.
- The combined model × reasoning menu opens at `bottom: calc(100% + 8px)` with
  `role="menu"`. Its root has exactly two `role="menuitem"` entries and, when
  the menu lists more than one level, a drag slider with one labeled stop per
  level directly beneath the Reasoning level entry (D458). The slider shows a
  rail with one track dot per stop and a label under each stop; every label
  stays visible and ellipsizes inside its column. The dots row and the labels
  row are full-width n-column grids and the range input overlays the rail at
  full width, inset on both sides by half a column minus the thumb radius, so
  the track dot, the thumb and the label all land on the same column center
  for every stop count. The selected stop's dot and label use the accent
  token, the rest a muted token; the thumb covers the selected dot. Tick
  labels are clickable but not tab stops; the range input is the accessible
  control.
  Hovering either a stop or its label highlights the corresponding label.
  Only unfilled dots brighten and scale to 1.3x; filled stops and the selected
  thumb have no hover effect. Leaving
  the slider clears the preview without selecting or persisting a level.
  A decorative, non-interactive thumb and the filled rail share the range's
  gapless column geometry. The fill starts at the first dot's outer left edge
  and ends at the selected thumb's center, covering the starting dot fully.
  Clicks and keyboard changes move the thumb and
  fill over `--motion-duration-normal` (200ms); a new click retargets from
  the current visual position. Native pointer dragging bypasses transitions.
  Only the requested levels are persisted, never interpolated animation
  positions. Pending selection is optimistic; failure restores the confirmed
  level, and stale completions cannot overwrite a newer choice. Reopening
  starts directly at the current level. Reduced motion disables travel.
  This replaces the earlier timer-driven settle pulse.
  The Model submenu has a search input and sticky provider headings, while
  the Reasoning level submenu starts with `Current model <model> supports
  these reasoning levels` and lists `omit` then the selected model binding's
  enabled levels as the classic radio rows. `omit` persists as the session
  thinking level and sends no provider thinking override (ADR 0295).
  Model-row reasoning badges use published reasoning metadata; vision badges
  use the effective image-input capability for the row's provider binding
  (`supportsImages` when explicitly set, published image input otherwise).
  Rows use `role="menuitemradio"`, `aria-checked`, active-row styling, and a
  trailing check. Selecting a concrete model, or a level from the radio list,
  persists the complete session config, clears model filtering, and returns
  to the root without dismissing the menu; slider and tick commits persist
  the last pending level while the menu stays where it is. Closing and
  reopening always starts at the root.
- The model/reasoning trigger shrinks within its toolbar slot. Switching
  reasoning labels, including `off`, must not move the menu horizontally when
  the toolbar bounds are unchanged. Long model names truncate within the
  trigger; the menu continues to follow its anchor on viewport changes.
  This positioning trigger does not scale on pointer press: its measured
  bounds stay stable while opening, including before the first selection
  and after closing and reopening the menu.
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
  identical. The bar sits in the transparent composer dock, so it paints
  `--ds-bg-composer` with `--ds-shadow-composer` like queued prompt rows rather
  than the in-flow `--ds-tile` wash.

### 11.6 Accessibility

- `role="textbox"` with `aria-label="Message input"`
- Editable text controls never enable browser spellcheck or autocorrect (D145)
- Send button: `aria-label="Send message"`
- Stop button: `aria-label="Stop generating"`
- Queued prompt list: `aria-label="Queued messages"`; each row has an
  accessible Remove button and a Send now button.
- Native file-system drag-over highlights the complete Composer shell with an
  outline that does not change layout; dropping a folder leaves its complete
  path visible in the editable draft, and dropping regular files exposes the
  existing removable chip labels and full paths through their title and
  accessible name.
- Disabled send: `aria-disabled="true"` with tooltip explanation
- The combined model × reasoning chip exposes `aria-haspopup="menu"` and
  `aria-expanded`. Its root entries use `role="menuitem"`; model and reasoning
  rows use radio-menu semantics with `aria-checked="true"` on the selected row.
  Escape/outside click closes the menu; Up/Down, Enter, and Left provide list
  navigation and root return.

### 11.7 MVP constraints

- Clipboard representation selection precedes the rules below: non-whitespace
  `text/plain` takes precedence over accompanying `image/*` copies only when
  all files lack native paths. This keeps Word text editable. Native files,
  any non-image file, and image-only/whitespace-plus-image pastes remain
  attachments. Selected text uses the same large-paste threshold (ADR 0059).
- Pasting one or more OS clipboard files or images saves their bytes into the
  originating session's scratch directory and adds a compact leaf-name
  reference above the textarea. A text-only paste at or below the configured
  `largePasteThreshold` keeps the browser's native textarea behavior; a paste
  above it is saved as UTF-8 in the session's scratch `pasted/` directory and
  inserts an inline temporary-file token at the paste position (D197, D209,
  D262, ADR 0059, ADR 0070, ADR 0131)
- The Composer `+` button opens one native file picker with no type-choice menu.
  While that picker or its import is in flight, repeated clicks are ignored so
  only one composer picker can be active at a time.
  The picker accepts regular files, and the importer classifies each selected
  item as an image or file from its MIME/extension metadata before copying it
  into the active session's scratch `pasted/` directory and adding its compact
  chip; the original absolute picker paths never enter the prompt. Native
  drag-and-drop additionally accepts regular files and folders: file bytes use
  the same bounded paste bridge, while folders remain visible as literal full
  paths and are never copied or traversed.
- The compact chips retain structured kind/name/MIME metadata while keeping
  the textarea free of binary data. The selected model's published record
  supplies the baseline, then the exact binding's `supportsImages` override
  controls effective dispatch. Absent or `null` follows the published value;
  `true` or `false` explicitly enables or disables image input. Eligible images
  become transient visual input when that effective capability is enabled;
  unknown/custom models without an explicit override, disabled image input, and
  oversized images use the existing canonical `@<path>` file-tool fallback.
  There are no visual previews in MVP.
- No voice input

### 11.8 Slash commands, @ file references, and clipboard files (D123–D125, D197, D209, D262, D362, D397, ADR 0024, ADR 0059, ADR 0070, ADR 0131, ADR 0221, ADR 0222)

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
- A whitespace-delimited `/` later in the draft offers active Skills only.
  Completion replaces only the token under the cursor, so several Skills and
  ordinary text can coexist in one prompt.
- Command descriptions use the space left after the slash name and optional
  title/argument hints. A long description truncates before it can squeeze a
  short command name to an ellipsis, including in narrow composers. Names and
  hints can still truncate when they themselves exceed the available row width;
  neither command rows nor file rows overflow the menu.
- File mode (`@` token at cursor, boundary-preceded): rows persistently show
  only the leaf file or directory name; directories get a trailing `/` and
  continue completion on accept. The complete relative path remains available
  through the row tooltip and accessible name. Accepting a completed file
  (Enter, Tab, or click) replaces the `@` token with an inline leaf-name chip
  at the caret — the same sentinel-backed chip as a pasted file — whose
  canonical value is the original `entry.path`; the menu closes and that Enter
  does not send. Accepting a directory keeps the literal path in the draft so
  completion can continue. Entries come from `fs/index` (D124, D209, D362). A
  truncation footnote appears when the index is capped; without a workspace the
  menu shows an "open a project" empty state.
- Accepting commands and directories inserts text (`/name ` / `@dir/`);
  accepting a completed file inserts the inline chip rather than deleting the
  trigger. Immediately
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
- After the representation selection in §11.7, a file paste requires at least
  one `File`. The renderer transfers bounded file bytes, name, and MIME
  metadata to Electron main with the durable session id. Main validates the
  session, writes unique sanitized files under
  `<data_dir>/scratch/<sessionId>/pasted/`, and returns each UUID-backed
  absolute path with its sanitized original leaf name and kind. The composer
  displays the leaf name, keeps the structured reference in session-scoped
  transient state, and submits it separately from visible text. Main stores
  image bytes under `attachments/<sha256>` and sends visual input only when the
  selected model's effective binding capability accepts images and the 10 MB
  inline bound is met; otherwise it appends a safe `@path` fallback. SVG inputs
  (`image/svg+xml` or `.svg` extension) are always classified as files, never
  as model images, regardless of vision capability (see
  `03-runtime/svg-attachment-input.md`). Removing
  a chip does not delete
  scratch bytes. A text-only paste longer than `largePasteThreshold` follows
  the same bounded session bridge with generated `text/plain` UTF-8 bytes,
  inserts a sentinel-backed `pasted-text-*.txt` chip at the original selection,
  and keeps its canonical path mapping in the renderer draft. Clicking the chip
  or activating it with Enter/Space reads the bounded text file, replaces the
  sentinel with editable text at that position, removes the reference, and
  places the caret after the inserted content; a failed or unsupported read
  leaves the chip unchanged. The default threshold is 600 characters and is
  persisted in app settings. Pasting either files or oversized text counts as
  input, so the home composer materializes the startup-only home draft into a
  durable session before saving when no active session is available. The scratch
  lifecycle removes pasted files with the session and never dirties the
  workspace git tree.
- A `+` picker selection follows the same session ownership and chip flow: the
  renderer materializes a home draft when needed, sends a one-shot picker token
  through `composer/importFiles`, and keeps only the returned scratch
  references. The native file picker accepts regular files only; Electron main
  owns the selected paths and applies the same size limits before copying.
- Reference chips wrap within the prompt area, expose the canonical path in
  their tooltip and accessible name, and provide a focus-visible localized
  remove button that restores textarea focus. Duplicate leaf labels remain
  separate because identity and dispatch use the canonical path, not the name.
  Text/plain and `.txt` chips are also keyboard-focusable buttons: clicking or
  pressing Enter/Space expands their bounded contents into editable draft text;
  binary, image, oversized, or failed reads keep the chip. Ordinary files stay
  compact chips. Unsent images render in a left-aligned attachment row above and
  outside the input shell, never within editable text. Their existing detached
  reference metadata survives text selection, editing, undo, and session
  switching; restored inline-image tokens are removed from text while keeping
  the attachment. Image-only drafts enable Send; a rejected send restores both
  text and attachments even when rejection precedes the next render. The
  attachment row is height-limited and scrolls vertically so every image remains
  reachable in a narrow chat pane. Thumbnails have an independent
  remove button shown on hover/focus (always visible for touch input). No
  separate explanatory vision-status row is rendered.
  Clicking an image or pressing Enter/Space opens a modal image preview, without
  sending the draft or changing the work-panel tabs. Inside the dark viewport,
  the image is horizontally and vertically centered, keeps its aspect ratio,
  and initially fits available space without upscaling small images. The
  preview supports zoom, fit reset, original-image download, and previous/next
  navigation across the draft's images. Dragging with the primary pointer or
  scrolling pans the image at any zoom; pointer capture keeps a drag continuous
  outside the image, and release/cancel ends it without dismissing the modal.
  A visible portion remains in bounds. Fit reset and switching images recenter
  the image; switching images also resets zoom. Escape,
  the close button, or a blank-area click dismisses it and restores the prior
  input focus/caret. Focus remains inside the modal, and native plugin surfaces
  are hidden while it is open. The remove button never opens or submits.
  Thumbnails and previews use the bounded, contained `fs/readImageDataUrl`
  bridge, including allowed scratch files when no project is open. Missing,
  unsupported, oversized, or undecodable images show a retry state and retain
  the draft. Session/project changes or removal of the selected attachment
  dismiss the preview; late reads cannot replace a newer image.
- Sent template invocations render in the transcript as a monospace command
  chip from the message's `command` field instead of the expanded body.
- Sent `@path` file references (quoted or unquoted) render as the same compact
  leaf-name chip as the draft. Clicking one completes the reference through
  `pi-desktop/fs/resolveRef` — against the whole open project, its group's
  folders primary first (ADR 0263) — and opens where it resolved: a project file
  in the bundled `pi.file-manager` view (the host `file:` tab when that view is
  unavailable), a session-scratch or attachment file in the host `file:` tab,
  and a `.html`/`.htm` page of the primary folder in the side browser. A
  primary-folder file is addressed to the view as a project-relative path and a
  sibling-folder file as an absolute one, which is also how scratch and
  attachment files are addressed. A reference that matches no file opens nothing
  and reports itself, as does right-clicking it: the file-reference menu offers
  that file's own folder in the system file manager and copies its full path or
  its project-relative path. The same items are offered on a sent `@path` chip,
  an inline code span, a markdown link, a local image, a tool row's file path,
  and a path in a tool result's file or match list, through the same completion
  and the same address; a file outside the project has no relative path to copy
  and says so instead.
  The OS default application is no longer what this click does. HTTP(S)
  URLs stay text links. Plain clicks follow the Link open destination setting,
  and right-clicking a URL exposes the same external, work-panel, and copy
  actions.
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
- Cached provider models are available on the first open after restart; opening
  the menu begins hydration before the Model submenu is entered, and a
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
  second visible label. A configured model alias is applied from the persisted
  binding on both the initial and refreshed row. For an OAuth provider, the
  group heading uses its non-secret account label when present, so duplicate
  vendor accounts remain distinguishable without appending the label to a
  model row.

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
  directly in that composer without a starter-card or quick-action layer. The
  underlined project name in a project-bound hero is a switcher, not a folder
  picker; extra actions clone a git repository or open another local folder.
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

## 18. Import destination

### 18.1 Purpose

Scan supported local agent stores for the four things this machine can hand
over — sessions, provider/model configuration, skills, and MCP servers — then
review the candidates, select them, and start an explicit import.

### 18.2 Anatomy

One workbench per kind behind a segmented kind switcher; every kind owns its
own scan, selection, and import action.

```text
[ Sessions | Models | Skills | MCP ]                   ← kind switcher
[ ] Found 12 · 6 selected   Group by: Source ▾   [Scan] [Import selected (6)]
───────────────────────────────────────────────────────────────────────────
CLAUDE CODE              ~/code/pi                                  4
[ ] Refactor the importer   12 messages · Jan 5, 2026   [Claude Code]
```

- The switcher reuses the labels the sidebar and the settings rail already ship
  (`nav.sessions`, `settings.nav.models`, `settings.nav.skills`,
  `settings.nav.mcp`), so the page adds no catalog entries of its own.
- Each kind carries its own toolbar: the select-all checkbox with both the
  "found" sentence and the selected count, the kind's own option (session
  grouping, skills import mode), re-scan, and Import selected.
- Before a kind's first scan its panel shows a quiet next-action state: what the
  scan reads plus the Scan action. Switching tabs never starts a scan
  (D007 / D342).
- Group headers are quiet label lines — source or project name, the resolved
  path in mono, and a count pill — not tinted bands; the candidates below them
  are individual tiles.
- The grouping control supports **Project path** and **Source**. Source is the
  default. In project-path mode, exact paths remain visible in group headers,
  and sessions without a project path appear in a final **No project** group.
- Import source names, grouping and mode controls, counts, results, and
  accessible names come from the shared i18n catalog. Candidate dates use the
  active app locale.

### 18.3 States and interactions

- A successful scan replaces the prior candidate set, clears selection, and
  shows every group expanded: the found candidates are the answer to the scan,
  so they are not hidden behind a second click.
- Codex session discovery walks `~/.codex/sessions/YYYY/MM/DD` newest-path-first
  and stops after 250 `.jsonl` files. That order is folder-date lexicographic,
  not `updatedAt`. When the cap hits, `session/importScan` returns
  `truncated.codex = 250` and the sessions toolbar shows the localized cap note;
  older Codex files are absent from the candidate list.

- Every kind scans on its own: a session scan never starts a model-config,
  skills, or MCP scan, and switching tabs preserves the result and the
  selection of the kind left behind (inactive panels stay mounted and hidden).
- A successful import creates or reuses one durable Projects-index entry for
  each distinct non-empty project path and refreshes sessions/projects.
- When a successful core or plugin import adds a project-bound session under an
  archived project, the renderer restores that project's presentation state
  after the refresh so the project and imported session are visible in the
  default sidebar. This applies only to newly added bound sessions; ordinary
  refreshes, pathless sessions, and skipped imports preserve archive state.
- Path-less imports create no project entry and remain under Temporary
  sessions. Import never creates a physical filesystem directory.
- Re-importing an existing source session skips it without duplicating its
  project entry.
- Changing the grouping mode preserves candidate selection and shows every
  newly formed group expanded.
- Expanding or collapsing one group does not affect the others.
- Group and global checkboxes support checked, unchecked, and indeterminate
  selection states; the global checkbox reports a partial selection as
  indeterminate.
- Candidates inside each group and groups themselves are ordered newest first;
  the path-less group remains last in project-path mode.

### 18.4 Accessibility

- The kind switcher is a `tablist` of `tab` controls, each carrying
  `aria-selected` and `aria-controls` that names its panel. Every panel is a
  `tabpanel` labelled by its tab, and an inactive panel is `hidden` rather than
  visually covered.
- Each disclosure button exposes `aria-expanded` and references its body with
  `aria-controls`.
- Global and group checkboxes have localized accessible names and carry the
  indeterminate state.
- The grouping and import-mode selectors are the shared in-app menu selects
  with visible labels and keyboard operation, never a platform-drawn
  `<select>`.
- Group count pills carry the localized count sentence as their title.
- Projects-row disclosure and action-menu buttons expose localized,
  project-specific accessible names.

### 18.5 ModelConfigImportPanel

Scan the same local agent stores for provider and model settings, review
candidates grouped by source, select them, and start an explicit import.

```text
[ ] Found 3 · 1 selected                        [Scan] [Import selected (1)]
───────────────────────────────────────────────────────────────────────────
CLAUDE CODE                                                                1
[ ] acme-gateway   4 models · api.acme.dev    [API key]
```

- The kind is independent of session import: its own scan, selection, and
  Import selected action. A session scan never starts a model-config scan, and
  the two are shown one at a time behind the switcher.
- Source grouping is the only grouping. A successful scan replaces the prior
  candidate set, clears selection, and shows every group expanded.
- Each row shows the provider name, model count, host, an API key / No API
  key badge, and the source. The raw secret never reaches the renderer.
- Import creates one `providers.create` row per selected candidate. An
  existing provider with the same normalized base URL, API style, and
  credential is skipped; different credentials at one endpoint create
  independent rows. OAuth-only source accounts are omitted from the scan.
  CC Switch is a fifth source (`~/.cc-switch/cc-switch.db`); a live tool
  file that matches a CC Switch endpoint and credential is not listed twice;
  a different credential remains visible.
- If `settings.defaultProviderId` is empty after a successful create, the
  first new provider becomes the global default.
---

## 19. ProviderStudio (Settings → Agent)

### 19.1 Purpose
Modern model-configuration surface for adding OpenAI-compatible providers,
reviewing readiness, and managing connection/default behavior without a dense
form dump. Vendor-account identity and default-model editing live in the same
surface, while model metadata remains owned by models.dev and transport
compatibility remains owned by pi-ai.

### 19.2 Anatomy

Each AI service card can be dragged from its non-interactive surface. After a
small movement threshold, the card follows the pointer and surrounding cards
animate into the proposed slot. Dragging near the list edge scrolls it. Releasing
saves the previewed order; Escape, pointer cancellation, focus loss, unmount or
catalog changes cancel the drag. Buttons and form controls retain their actions.
There is no separate drag handle. A focused card accepts Up/Down to move one visible row. Saving blocks further
moves; a failed save shows an error and restores the accepted order. Late catalog
responses cannot restore an earlier order. The default-model picker and Composer
model groups follow the persisted order. Sorting changes neither the selected
default nor provider configuration. OAuth accounts remain in their separate section.

1. **Defaults card** — a compact settings row reusing the shared
   14px/16px row geometry; the Default model label sits above the provider name
   and exact model ID, while a quiet Change action opens the picker without
   duplicating the current value. The floating listbox is anchored to that
   action rather than expanding the card in place: the surface portals to
   `document.body` as a fixed layer so the panel's overflow cannot clip it,
   groups model-level options by provider, marks the exact current entry, bounds
   its own height so many configured models scroll instead of stretching the
   card, flips above the trigger when there is no room below, and closes on
   Escape, an outside press, or the trigger scrolling out of view.
   A provider is named here the way the Composer model menu names it: an OAuth
   row uses its non-secret account label when present, so two accounts of one
   vendor do not collapse into identical group headings, summary lines, or
   option names; the search matches the account label and the vendor name.
   Global operating mode, command shell, and Enter-to-send live in the Settings
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
   expands in place to a compact sheet: optional alias (hint as a title
   tooltip), context window and max output as a two-column numeric pair
   without native spinners, seven thinking-level chips, a constrained
   default-thinking select on the thinking label row, and one wrapping row
   for attachment and delegation checkboxes. The seven thinking controls use
   the canonical values as-is and are not localized. Each numeric limit is
   topped by a preset ladder of five compact chips (context window
   128k/256k/312k/500k/1M, max output 4k/8k/16k/32k/128k) in the thinking
   chips' segmented-track language: clicking a chip writes its token count
   into the input, the input stays hand-editable, and the chip matching the
   current value is highlighted; the labels use the canonical values as-is
   and are not localized. The thinking label,
   optional catalog hint, and default selector sit above one compact,
   keyboard-operable
   grouped control that spans the pane; its seven options share the width
   equally and wrap only when the pane is narrow. The first row starts
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
- Add provider opens a modal dialog on a full-window overlay portaled to `#pi-desktop-overlays` on the document element (it can shrink below its 1040px preferred width). Focused credential fields keep their 2px accent ring fully visible: the scrolling body reserves that gutter instead of clipping the ring. Cancel/close resets fields and dismisses the dialog
- The model picker searches and toggles multiple models without using a native
  multiple select. Its portaled menu closes on outside press, Escape, scroll,
  and resize; model selection immediately adds or removes its configuration
  row. Configuration rows stay compact until expanded; expanding one row does
  not expand or collapse any other row.
- The left-pane list header carries a checkbox that selects or clears every
  currently visible row. A search filter narrows which rows "all" means;
  already-chosen bindings keep their advanced overrides. The checkbox is
  checked when every visible row is chosen, unchecked when none are, and
  indeterminate when the visible set is mixed.
- The same header has a compact Fetch list action that re-probes the service
  immediately. It stays disabled when no discoverable endpoint is ready, while
  a probe is in flight, or while saving. Idle-with-a-valid-URL (the edit
  debounce) stays enabled so the action can skip that window. Current rows
  stay on screen until the live answer replaces them.
- The right-pane header carries its own search field that filters the
  configured models as the user types. It matches the model id, its alias, and
  the catalog display name case-insensitively, so a friendly name finds the id
  it stands for. The count beside the title still reports every configured
  model; a filter that matches nothing shows its own message rather than the
  "nothing chosen yet" one. A model that is added — by checkbox, select-all, or
  hand-typed id — keeps that field only while the filter still shows it; an
  emptied list drops the filter, so a new row never arrives out of view and no
  query is stranded in a field the user can no longer clear.
- Adding a custom model validates non-empty and duplicate IDs, adds it to the
  top-level option list, selects it, and applies 128,000 context / 8,192 max
  output / no thinking defaults. Removing its selection does not delete the
  custom option.
- Model IDs and names are selectable text inside the otherwise non-selectable
  shell. A click that carries a text selection does not toggle the row
  checkbox, so drag-to-copy and click-to-toggle coexist (ADR 0192).
- The alias is a display label only: a non-empty alias names the model in the
  composer chip and the picker, while the configuration row and the transcript
  badge keep the real ID. Clearing the field restores the catalog's published
  display name.
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
- Optional OAuth text prompts keep Continue enabled for an empty value and
  submit the trimmed value so vendor-defined defaults remain usable; secret and
  manual-code prompts still require non-empty input
- Context, output, thinking-level, and default-thinking edits persist per model
  through `providers.create` / `providers.update`; runtime callers continue to
  use the first configured model until multi-model conversation selection is
  implemented
- Make default updates `defaultProviderId` / `defaultModelId` only

### 19.5 Accessibility
- Segmented controls expose `aria-pressed`
- The discovered-list header checkbox has a localized accessible name
  (Select all / Deselect all) and an indeterminate state when only some
  visible rows are chosen
- Enter-to-send uses `role="switch"` + `aria-checked`
- Model configuration rows expose `aria-expanded` and reference their details
  with `aria-controls`; collapsed details are removed from the tab order
- Card actions keep visible text labels; thinking select has an accessible name
- Both model-list search fields carry a localized accessible name, and the
  chosen-list one is disabled while saving or when nothing is configured
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
  relative time. Rows are dense `--radius-sm` tiles stacked with a 2px gap
  (D297), not cards and not hairline-separated.
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
  and scrolls the transcript to its latest content. The successful read also
  dismisses the matching task-native banner before a late activation can
  surface it again.
- Restoring/focusing the app from its taskbar or Dock while an unread terminal
  outcome's session is already visible in the chat marks that session's
  matching durable notifications read; it does not mark outcomes belonging to
  other sessions.
- Mark all read is idempotent and preserves rows; it dismisses every outstanding
  task-native banner. Clear deletes every inbox row, dismisses all task-native
  banners, and leaves sessions, transcripts, and turns intact. These actions
  remain available for successful completions hidden from the failure-only
  bell list, so the taskbar unread badge can be cleared from the popover.
- `notification.changed` updates the visible list and badge only for a new
  durable id. A duplicate id, or a delayed event for an acknowledged/cleared
  row, is ignored. Opening the
  popover also refreshes the bounded list from host-core. A
  `notification.activated` event from Electron follows the same session
  activation path as a row click.
- Completion/failure enters the durable inbox unless the main window is
  visible/focused and the exact finishing session is the current chat. A
  focused background session still enters the inbox without a native banner;
  an unfocused current session enters the inbox and receives a native banner.
  Clicking the banner restores/shows and focuses the main window before
  emitting `notification.activated` for the matching session.
- Aborted turns, interactive permission/ask/Plan prompts, scheduled reminders,
  and plugin notifications do not enter this inbox. Interactive prompts may
  use the source-aware native surface while the app is focused on a different
  session.

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
  scheduled notification source, durable permission-notification source,
  preferences page, notification permission prompt, or cloud sync. Interactive
  prompt banners are transient native surfaces outside the inbox.

---

## 21. Acceptance criteria (all components)

1. All components use semantic color tokens from [07-ui-design-system.md](07-ui-design-system.md) — no raw hex
2. All interactive elements have visible focus rings (2px accent, offset 2px)
3. Layout shell metrics (46px titlebar row, ~275/48 sidebar, 280 context,
   compact composer with 1–7-line draft growth) match spec
4. Chat content band defaults to 760px and is user-resizable; user plates stay compact
5. ToolCallCard shows status, args preview, result preview, duration per [01-ui-ia.md](01-ui-ia.md) §5
6. PermissionCard shows tool name, risk, args, countdown, and three action buttons per [03-permission-ux.md](03-permission-ux.md)
7. Composer: Enter sends when Enter-to-send is on; when it is off, Cmd/Ctrl+Enter
   sends and Enter inserts a newline; Shift+Enter always inserts a newline;
   draft grows from one through seven visible lines then scrolls, and the single
   submit slot shows Send for a non-empty draft or an idle/empty draft, and Stop
   only for a running empty draft
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
15a. Model-configuration import scans the same local stores independently, never sends secrets to the renderer, skips only equivalent providers (normalized endpoint, API style, and credential), preserves different credentials at one endpoint, and does not copy OAuth/subscription logins per §18.5
16. ProviderStudio shows compact defaults, vendor-account rows with edit/test/delete actions, add/edit dialogs, and AI service cards; secrets never render raw; every action remains keyboard reachable
17. NotificationInbox exposes All/Unread views, exact unread badge semantics,
    row activation, mark-all-read and clear actions; it is keyboard-operable
    and never treats a visible-current or aborted turn as a notification
18. The work panel opens and collapses as an in-flow right column without
    changing native window bounds; its inner divider resizes the panel target
    between 244px and the live budget, and cancelled divider gestures restore the prior
    panel width (ADR 0151)
19. Expanded sidebar session titles, project/group titles, and empty-state copy
    use the 13px compact token while primary sidebar actions remain at 14px


### Native deletion beside composer file chips

Deleting text before an inline file reference must not add a blank line or move
the chip to the next line. Keep native editing and undo/redo. Before a native
deletion, record the browser's target range and existing BR nodes; after input,
remove a newly created BR only when removing that exact node makes the draft
match the requested deletion. Never trim leading newlines or normalize all BRs.
Remember proven placeholder nodes weakly so native redo cannot restore them.
Explicit line breaks, IME composition, file references, and chip deletion retain
their normal behavior. Native undo of chip deletion restores its file-reference metadata
as well as its DOM, so submission and draft caching retain the path. Deleted
reference history is local to the current draft/workspace and is cleared on send;
pasting a private-use character alone must not restore an attachment. The input owns and disposes the native event listeners.

### Dialog long-text containment

Extension prompts keep the 420px rename-dialog width. Their heading column
can shrink beside the close button, full source paths wrap within that column,
and unbroken titles, labels, confirmation text and radio options wrap. Content
taller than the viewport scrolls inside the prompt, leaving actions reachable.
Input, selection, submission and dismissal semantics remain unchanged.

Project-delete descriptions and plugin dialog headings/outcomes also wrap long
project or plugin names instead of overflowing their existing widths. Project
instructions, memory and OAuth dialogs retain their existing bounded layouts.
